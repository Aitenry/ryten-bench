/**
 * 自研 AI 层自测运行器：用 esbuild 把测试入口打成 CJS，再交给 node:test 跑。
 *
 * 两个套件：
 * - test/ai/selftest.ts        —— AI 层单元/协议测试（消息、工具、解析、图引擎、各供应商 mock 协议）；
 * - test/ai/agent-graph.test.ts —— 真实 Agent 图集成测试（electron 相关模块用 stub 替换）。
 *
 * 为什么不在 tsc/tsx 里直接跑：项目没有 ts-node/tsx 依赖，而 esbuild 已经是构建期依赖；
 * 这样测试代码可以用 TS + 源码路径导入，运行时仍是普通 node 进程，失败会以非零码退出。
 *
 * 跑法：pnpm test:ai
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(ROOT, '.tmp')
const STUB_NS = 'rb-test-stub'
const PROVIDER_STUB_NS = 'rb-provider-stub'

/** electron 主进程 API 的最小替身（只覆盖被测试代码用到的部分） */
const ELECTRON_STUB = `
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const userData = path.join(os.tmpdir(), 'rb-ai-selftest-' + process.pid)
fs.mkdirSync(userData, { recursive: true })
const app = {
  getPath: (name) => (name === 'temp' ? os.tmpdir() : userData),
  getLocale: () => 'zh-CN',
  isReady: () => true,
  getVersion: () => '0.0.0-test',
  getName: () => 'ryten-bench-test',
  setName: () => {},
  setPath: () => {},
  getAppPath: () => process.cwd(),
  on: () => {},
  once: () => {},
  whenReady: () => Promise.resolve()
}
module.exports = {
  app,
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null, fromWebContents: () => null, fromId: () => null },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, emit: () => {} },
  dialog: { showMessageBox: async () => ({ response: 0 }), showErrorBox: () => {} },
  shell: { openExternal: async () => {} },
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) }
}
`

/** electron-store 的内存替身 */
const ELECTRON_STORE_STUB = `
class Store {
  constructor(options = {}) { this.name = options.name || 'config'; this.data = {} }
  get(key, defaultValue) {
    if (key === undefined) return this.data
    const value = this.data[key]
    return value === undefined ? defaultValue : value
  }
  set(key, value) {
    if (key && typeof key === 'object') Object.assign(this.data, key)
    else this.data[key] = value
  }
  has(key) { return key in this.data }
  delete(key) { delete this.data[key] }
  clear() { this.data = {} }
  get store() { return this.data }
  set store(value) { this.data = value }
  on() { return this }
  off() { return this }
}
module.exports = Store
module.exports.default = Store
`

/** electron-log 替身（测试不关心日志落盘） */
const ELECTRON_LOG_STUB = `
const logger = { info() {}, warn() {}, error() {}, debug() {}, verbose() {}, silly() {}, log() {} }
logger.transports = { file: { level: 'info', maxSize: 0 }, console: { level: 'info' } }
logger.initialize = () => {}
logger.default = logger
module.exports = logger
`

/** fs 工具后端替身：集成测试只用自定义工具，不需要真实文件系统工具链 */
const FS_BACKEND_STUB = `
function formatOutput(value) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}
module.exports = {
  formatOutput,
  buildFsTools: () => [],
  buildFsPromptSection: () => '',
  fsToolNames: []
}
`

/** 工坊工具替身：builders.ts 会静态 import ./workshop，而真模块用了 import.meta.glob（CJS 测试包跑不了） */
const WORKSHOP_STUB = `
module.exports = { workshopToolBuilders: {}, workshopToolInfos: [] }
`

/** 供应商 mapper 替身：测试通过 globalThis.__RB_TEST_PROVIDERS__ 注入配置 */
const PROVIDER_MAPPER_STUB = `
function list() { return globalThis.__RB_TEST_PROVIDERS__ || [] }
module.exports = {
  LlmProviderConfig: {},
  getProviderById: async (id) => list().find((p) => p.id === id) ?? null,
  getDefaultProvider: async () => list().find((p) => p.is_default) ?? null,
  getEnabledProviders: async () => list().filter((p) => p.is_enabled)
}
`

/** 主进程 i18n 替身：错误文案模板保留占位符，断言只看关键片段 */
const I18N_STUB = `
const messages = {
  error: {
    modelNotSelected: 'modelNotSelected',
    providerNotFound: 'providerNotFound {{id}}',
    modelNameMissing: 'modelNameMissing {{name}}',
    noProviderConfigured: 'noProviderConfigured'
  },
  modelFailure: {},
  modelRecovery: {}
}
module.exports = {
  mainMessages: () => messages,
  mainToolMessages: () => ({}),
  mainFormat: (template, vars) =>
    String(template).replace(/\\{\\{(\\w+)\\}\\}/g, (_, key) => String((vars || {})[key] ?? ''))
}
`

/**
 * electron-vite 的 `xxx?asset` 导入替身。
 *
 * 主进程里托盘图标 / 菜单 HTML 这类资源是 `import x from './a.png?asset'`，
 * 由 electron-vite 在构建期处理；esbuild 直接打包测试入口时没有对应的 loader，
 * 会让「只要依赖图里出现托盘模块」的套件直接构建失败。测试不关心资源内容，
 * 统一替换成空字符串即可。
 */
const assetStubPlugin = {
  name: 'rb-asset-stub',
  setup(buildApi) {
    buildApi.onResolve({ filter: /\?asset$/ }, (args) => ({
      path: args.path,
      namespace: 'rb-asset-stub'
    }))
    buildApi.onLoad({ filter: /.*/, namespace: 'rb-asset-stub' }, () => ({
      contents: 'module.exports = ""',
      loader: 'js'
    }))
  }
}

/** 把 electron / 存储 / 文件工具替换成 stub（只对 agent-graph 集成测试启用） */
const stubPlugin = {
  name: 'rb-test-stubs',
  setup(buildApi) {
    const map = {
      electron: ELECTRON_STUB,
      'electron-store': ELECTRON_STORE_STUB,
      'electron-log': ELECTRON_LOG_STUB,
      'fs-backend': FS_BACKEND_STUB,
      workshop: WORKSHOP_STUB
    }
    buildApi.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: STUB_NS }))
    buildApi.onResolve({ filter: /^electron-store$/ }, () => ({
      path: 'electron-store',
      namespace: STUB_NS
    }))
    buildApi.onResolve({ filter: /^electron-log$/ }, () => ({
      path: 'electron-log',
      namespace: STUB_NS
    }))
    buildApi.onResolve({ filter: /harness[\\/]fs-backend$/ }, () => ({
      path: 'fs-backend',
      namespace: STUB_NS
    }))
    buildApi.onResolve({ filter: /^\.\/workshop$/ }, () => ({
      path: 'workshop',
      namespace: STUB_NS
    }))
    buildApi.onLoad({ filter: /.*/, namespace: STUB_NS }, (args) => ({
      contents: map[args.path] ?? 'module.exports = {}',
      loader: 'js'
    }))
  }
}

/** provider/service.ts 用到的数据库 mapper 与 i18n（只在 provider-service 套件里替换） */
const providerStubPlugin = {
  name: 'rb-provider-stubs',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^\.\.\/database\/mapper\/provider$/ }, () => ({
      path: 'mapper-provider',
      namespace: PROVIDER_STUB_NS
    }))
    buildApi.onResolve({ filter: /^\.\.\/i18n$/ }, () => ({
      path: 'i18n',
      namespace: PROVIDER_STUB_NS
    }))
    buildApi.onLoad({ filter: /.*/, namespace: PROVIDER_STUB_NS }, (args) => ({
      contents:
        args.path === 'mapper-provider'
          ? PROVIDER_MAPPER_STUB
          : args.path === 'i18n'
            ? I18N_STUB
            : 'module.exports = {}',
      loader: 'js'
    }))
  }
}

const suites = [
  {
    name: 'ai',
    entry: resolve(ROOT, 'test', 'ai', 'selftest.ts'),
    outfile: resolve(OUT_DIR, 'ai-selftest.cjs'),
    plugins: []
  },
  {
    name: 'agent-graph',
    entry: resolve(ROOT, 'test', 'ai', 'agent-graph.test.ts'),
    outfile: resolve(OUT_DIR, 'ai-agent-graph.cjs'),
    plugins: [stubPlugin]
  },
  {
    name: 'provider-service',
    entry: resolve(ROOT, 'test', 'ai', 'provider-service.test.ts'),
    outfile: resolve(OUT_DIR, 'ai-provider-service.cjs'),
    plugins: [stubPlugin, providerStubPlugin]
  },
  {
    name: 'notes-tools',
    entry: resolve(ROOT, 'test', 'ai', 'notes-tools.test.ts'),
    outfile: resolve(OUT_DIR, 'ai-notes-tools.cjs'),
    plugins: []
  },
  {
    name: 'materials-schema',
    entry: resolve(ROOT, 'test', 'ai', 'materials-schema.test.ts'),
    outfile: resolve(OUT_DIR, 'ai-materials-schema.cjs'),
    plugins: [stubPlugin]
  },
  {
    name: 'weather-tool',
    entry: resolve(ROOT, 'test', 'ai', 'weather-tool.test.ts'),
    outfile: resolve(OUT_DIR, 'ai-weather-tool.cjs'),
    plugins: [stubPlugin]
  },
  {
    // 真实 shell 集成（非 Windows / 无 pwsh 时用例内部 skip）
    name: 'terminal-sessions',
    entry: resolve(ROOT, 'test', 'ai', 'terminal-sessions.test.ts'),
    outfile: resolve(OUT_DIR, 'ai-terminal-sessions.cjs'),
    plugins: [stubPlugin]
  },
  {
    // 危险工具的档位门禁（terminal/run_code）：拒绝路径与只读桥接
    name: 'gated-tools',
    entry: resolve(ROOT, 'test', 'ai', 'gated-tools.test.ts'),
    outfile: resolve(OUT_DIR, 'ai-gated-tools.cjs'),
    plugins: [stubPlugin]
  },
  {
    // 定时任务存储层：旧 JSON 迁移计划 + store 门面委托
    name: 'schedule-store',
    entry: resolve(ROOT, 'test', 'ai', 'schedule-store.test.ts'),
    outfile: resolve(OUT_DIR, 'ai-schedule-store.cjs'),
    plugins: [stubPlugin]
  },
  {
    // 联网搜索后端：响应归一化与密钥掩码
    name: 'search-backend',
    entry: resolve(ROOT, 'test', 'ai', 'search-backend.test.ts'),
    outfile: resolve(OUT_DIR, 'ai-search-backend.cjs'),
    plugins: [stubPlugin]
  },
  {
    // 会话级运行选择（工具/技能/MCP）的合并语义
    name: 'agent-config',
    entry: resolve(ROOT, 'test', 'ai', 'agent-config.test.ts'),
    outfile: resolve(OUT_DIR, 'ai-agent-config.cjs'),
    plugins: [stubPlugin]
  }
]

mkdirSync(OUT_DIR, { recursive: true })

let failures = 0
for (const suite of suites) {
  await build({
    entryPoints: [suite.entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: suite.outfile,
    // zod 由 node_modules 提供（与运行期同一份），不打进测试包
    // 官方 SDK 只在主进程运行期使用；测试包不打包它（否则会卷进 kerberos 等可选依赖）
    external: ['zod', '@tavily/core'],
    plugins: [assetStubPlugin, ...suite.plugins],
    logLevel: 'warning'
  })
  console.log(`\n=== ${suite.name} ===`)
  const result = spawnSync(process.execPath, [suite.outfile], { stdio: 'inherit', cwd: ROOT })
  if (result.error) {
    console.error(result.error)
    failures += 1
  } else if ((result.status ?? 1) !== 0) {
    failures += 1
  }
}

if (failures > 0) {
  console.error(`\n${failures} test suite(s) failed`)
  process.exit(1)
}
console.log('\nAll AI test suites passed')
