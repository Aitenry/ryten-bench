/**
 * 把内置插件打成「可安装的插件包」（物理卸载方案的第一步）。
 *
 * 产物（随应用分发，electron-builder extraResources 的 `resources/plugins`）：
 *
 *   resources/plugins/<id>/plugin.json   清单（由插件的 manifest.ts 生成，单一真源）
 *   resources/plugins/<id>/main.cjs      主进程入口（CJS，install(ctx) 契约）
 *   resources/plugins/<id>/renderer.mjs  渲染层入口（ESM，default export { manifest, install(ctx) }）
 *
 * 关键约束（方案见 src/plugins/PACKAGING.md）：
 * - **宿主能力一律经宿主运行时取**：插件源码里指向 core 的导入（`../../main/**`）、宿主 UI 的导入
 *   （`@renderer/**`）以及第三方裸模块（react/antd/electron/zod/drizzle…）在打包时都被解析成
 *   **虚拟模块**，`onLoad` 生成一句 `宿主运行时解析("<原 spec>")`——主进程是
 *   `globalThis.__RB_HOST_RESOLVE__(spec)`（`src/main/plugins/runtime.ts` 挂载，返回宿主自己那份
 *   实例），渲染层是 `plugin://host/ui.js?m=<key>` 的 ESM 桥（`src/renderer/src/plugin-host/host-ui.ts`）。
 *   这样既能避免把 PGlite 连接 / React / i18n 打成两份，又**不用改 288 处 import**，
 *   源码仍按真实 core 类型检查。
 * - **不再标记 external**：external 会让产物里留一条裸的 `require("@host/main/x")`，而在
 *   `userData/plugins/<id>/` 下没有 node_modules、也没有解析 `@host/*` 的办法（CJS 里加 require
 *   垫片又会因为产物已是 ESM/严格模式而 SyntaxError）。改成虚拟模块后，产物里只有对
 *   `__RB_HOST_RESOLVE__` 的调用与静态 ESM import。
 * - 渲染层自己的依赖（codemirror 等）仍然打进包。
 *
 * 跑法：node scripts/build-plugins.mjs [--plugin music] [--out resources/plugins] [--dev]
 */
import { build } from 'esbuild'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync
} from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// harness / notes 已是系统级功能，不再打包为插件。
// 目前没有随应用分发的内置插件；第三方插件由 ryten-plugins 仓库自行构建。
const PLUGIN_IDS = []

const args = process.argv.slice(2)
const onlyIndex = args.indexOf('--plugin')
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null
const outIndex = args.indexOf('--out')
const OUT_DIR = resolve(ROOT, outIndex >= 0 ? args[outIndex + 1] : 'resources/plugins')
const isDev = args.includes('--dev')

/** 插件源码里被解析到这些目录的导入 → 交给宿主运行时 */
const HOST_MAIN_DIR = resolve(ROOT, 'src/main')
const HOST_RENDERER_DIR = resolve(ROOT, 'src/renderer/src')
const SHARED_DIR = resolve(ROOT, 'src/shared')
const PLUGINS_DIR = resolve(ROOT, 'src/plugins')

/** tsconfig 里的路径别名（与 tsconfig.web/node 的 paths 保持一致） */
const ALIASES = [
  [/^@renderer\/(.*)$/, HOST_RENDERER_DIR],
  [/^@plugins\/(.*)$/, PLUGINS_DIR],
  [/^@shared\/(.*)$/, SHARED_DIR]
]

/**
 * 渲染层交给宿主 UI 桥的第三方 vendor（宿主里已有唯一实例，插件包不得自带第二份）。
 *
 * 这份名单必须与 `src/renderer/src/plugin-host/host-ui.ts` 的 `@host/vendor/*` 键**一致**：
 * 打包器把命中的说明符改成桥引用，运行时渲染层 loader 再按 host-ui 表判断哪些说明符
 * 真的走桥（表里没有的裸模块保持原样，由 esbuild 打进包）。
 *
 * dayjs 也在名单里（P2 实测）：宿主 `@renderer/i18n` 已经 import 了 dayjs 并**全局设过 locale**，
 * 插件自带第二份会得到另一个 Dayjs 类——`isDayjs()` 判定、antd DatePicker 的受控值互操作、
 * 以及 locale 设置都会因此分裂（planner 未走桥时打包产物里确实带了一份 dayjs）。
 */
const RENDERER_VENDOR = [
  'react',
  'react-dom',
  'antd',
  '@remixicon/react',
  '@ant-design/icons',
  'dayjs'
]

/** Node 内置模块（含 `node:` 前缀形式）：保持 external，运行期由 Node 自己解析 */
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  'node:test',
  'node:sea',
  'node:sqlite'
])

/** 虚拟模块命名空间：onResolve 落到这里，onLoad 生成「去向宿主运行时取」的源码 */
const HOST_MODULE_NS = 'host-runtime'

/** 主进程：`module.exports = globalThis.__RB_HOST_RESOLVE__("<spec>")`（CJS 产物，require 即可） */
const cjsHostModule = (spec) =>
  `module.exports = globalThis.__RB_HOST_RESOLVE__(${JSON.stringify(spec)});\n`

/**
 * 渲染层：把宿主说明符指向宿主 UI 桥模块。
 *
 * 两句话，各有原因：
 * - `export * from "<桥 URL>"` 重新导出桥的全部具名导出，并把它标记为 external——这样
 *   esbuild **不需要**知道宿主模块有哪些具名导出（真实导出面在运行期由桥决定，桥的内容由
 *   主进程按渲染层上报的宿主 UI 表生成，见 src/main/plugins/host-ui-bridge.ts）。
 *   之前生成 `import * as m …` 再逐名 re-export，esbuild 会因为拿不到静态导出表而报
 *   "No matching export for import useState"（antd/图标这类上千个导出的包无法穷举）。
 * - **默认导出必须自己补**：ESM 的 `export *` **不转发 default**，而插件源码里
 *   `import React from 'react'` / `import antd from 'antd'` 依赖默认导出（CJS 互操作），
 *   少了它就会在运行期变成 `Cannot read properties of undefined (reading 'memo')`。
 *   这里让 default 指向「桥模块自己的 default，缺失时退回整个命名空间」，与
 *   webpack/esbuild 对 CJS 模块的默认导出语义一致。
 */
const esmHostModule = (spec) => {
  const url = `plugin://host/ui.js?m=${encodeURIComponent(spec)}`
  return (
    `import * as __hostNs from ${JSON.stringify(url)};\n` +
    `export * from ${JSON.stringify(url)};\n` +
    `export default __hostNs.default ?? __hostNs;\n`
  )
}

const isAbsoluteSpec = (spec) => /^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith('/')
const isBare = (spec) => !spec.startsWith('.') && !isAbsoluteSpec(spec) && !spec.startsWith('@host/')

/**
 * 解析插件里的导入：
 * - `@renderer/**`（宿主 UI）、`../../main/**`（core）、`@shared/**` → `@host/<side>/<相对路径>`
 *   虚拟模块，运行期由宿主运行时给实例；
 * - `@plugins/**` 与插件内部相对导入 → 正常打进包；
 * - 其它裸模块（react/antd/langchain/zod/drizzle/electron…）：
 *   主进程侧统一 `@host/main/...` 之外的原样 spec（宿主用应用根的解析路径 require）；
 *   渲染层侧的 vendor 换成 `@host/vendor/<spec>`，其余（插件自己的依赖）打进包；
 * - `node:*` / Node 内置 → external。
 */
const hostRuntimePlugin = (side) => ({
  name: 'host-runtime',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args_) => {
      const spec = args_.path

      // 0) Node 内置：交给 esbuild 默认的 external 判定（node: 前缀会原样留在产物里）
      if (NODE_BUILTINS.has(spec)) return { path: spec, external: true }

      // 0.5) plugin:// 的桥模块（本插件生成的虚拟模块 import 它）：原样留给运行时
      if (spec.startsWith('plugin://')) return { path: spec, external: true }

      // 1) 先判 tsconfig 别名（否则 @renderer/* 会被当成裸模块直接外置，路径就漏给了宿主）
      let abs = null
      for (const [re, base] of ALIASES) {
        const m = re.exec(spec)
        if (m) {
          abs = join(base, m[1])
          break
        }
      }

      // 2) 显式写死的 @host/*（理论上插件源码不会写，防御性处理）→ 直接进宿主运行时
      if (!abs && spec.startsWith('@host/')) {
        return { path: spec, namespace: HOST_MODULE_NS }
      }

      // 3) 第三方裸模块
      if (!abs && isBare(spec)) {
        if (side === 'renderer') {
          if (!RENDERER_VENDOR.some((v) => spec === v || spec.startsWith(v + '/'))) {
            return null // 插件自己的依赖（codemirror 等）：打进包
          }
          return { path: `@host/vendor/${spec}`, namespace: HOST_MODULE_NS }
        }
        // 主进程：spec 原样交给宿主运行时（宿主按应用根解析，拿同一实例）
        return { path: spec, namespace: HOST_MODULE_NS }
      }

      // 4) 相对/绝对路径 → 绝对路径
      if (!abs) {
        const from = args_.importer ? dirname(args_.importer) : ROOT
        abs = resolve(from, spec)
      }
      const withSep = (dir) => abs.startsWith(dir + sep)
      if (withSep(PLUGINS_DIR)) return null // 插件自己的代码：打进包

      if (withSep(HOST_MAIN_DIR)) {
        return { path: '@host/main/' + relOf(HOST_MAIN_DIR, abs), namespace: HOST_MODULE_NS }
      }
      if (side === 'renderer' && withSep(HOST_RENDERER_DIR)) {
        return { path: '@host/renderer/' + relOf(HOST_RENDERER_DIR, abs), namespace: HOST_MODULE_NS }
      }
      if (withSep(SHARED_DIR)) {
        return { path: '@host/shared/' + relOf(SHARED_DIR, abs), namespace: HOST_MODULE_NS }
      }
      return null
    })

    build.onLoad({ filter: /.*/, namespace: HOST_MODULE_NS }, (args_) => ({
      contents: side === 'renderer' ? esmHostModule(args_.path) : cjsHostModule(args_.path),
      loader: 'js'
    }))
  }
})

const relOf = (base, abs) =>
  relative(base, abs)
    .replace(/\\/g, '/')
    .replace(/\.(ts|tsx|js|jsx)$/, '')

/**
 * 把多文件渲染产物里的**相对说明符**绝对化成 `plugin://<id>/<文件>`，返回改写处数。
 *
 * 为什么必须绝对化：插件的渲染入口是 `fetch` 下来再以 **blob URL** import 的
 * （见 src/renderer/src/plugin-host/external-loader.ts），blob 模块没有可用的相对基准——
 * `./chunk-x.mjs` 会被解析成 `blob:.../chunk-x.mjs`，取不到任何东西。宿主 UI 桥用的是
 * 绝对 URL（`plugin://host/ui.js?m=…`），所以 P1/P2 的单文件产物一直没暴露这个问题。
 *
 * 只改写**确实指向本次产物文件**的相对说明符（按目标文件名比对），避免误伤字符串字面量。
 */
function absolutizeChunkSpecifiers(id, outDir) {
  const emitted = new Set(readdirSync(outDir).filter((f) => f.endsWith('.mjs')))
  /** 三种形态：`from "s"`、`import("s")`、语句起始的副作用导入 `import "s"` */
  const REL_SPEC = /(\bfrom\s*|\bimport\s*\(\s*|(?:^|[;}\n])\s*import\s*)(['"])(\.{1,2}\/[^'"]+)\2/gm
  let count = 0
  for (const file of emitted) {
    const full = join(outDir, file)
    const source = readFileSync(full, 'utf-8')
    const next = source.replace(REL_SPEC, (whole, prefix, quote, spec) => {
      const target = relative(outDir, resolve(dirname(full), spec)).replace(/\\/g, '/')
      if (!emitted.has(target)) return whole
      count += 1
      return `${prefix}${quote}plugin://${id}/${target}${quote}`
    })
    if (next !== source) writeFileSync(full, next)
  }
  return count
}

/** 由 manifest.ts 生成 plugin.json（单一真源，不手写第二份） */
async function emitManifest(id, outDir) {
  const entry = join(ROOT, 'src/plugins', id, 'manifest.ts')
  const built = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
  const code = built.outputFiles[0].text
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  const mod = await import(dataUrl)
  const manifest = mod.default ?? mod[Object.keys(mod)[0]]
  const json = { ...manifest, entry: { renderer: 'renderer.mjs', main: 'main.cjs' } }
  writeFileSync(join(outDir, 'plugin.json'), JSON.stringify(json, null, 2) + '\n')
  return json
}

async function buildPlugin(id) {
  const srcDir = join(ROOT, 'src/plugins', id)
  const outDir = join(OUT_DIR, id)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const manifest = await emitManifest(id, outDir)

  // 主进程入口：CJS；宿主能力（@host/** + 第三方裸模块）经虚拟模块转成 __RB_HOST_RESOLVE__ 调用
  const mainEntry = join(srcDir, 'main/index.ts')
  if (existsSync(mainEntry)) {
    await build({
      entryPoints: [mainEntry],
      outfile: join(outDir, 'main.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      plugins: [hostRuntimePlugin('main')],
      minify: !isDev,
      sourcemap: isDev ? 'inline' : false,
      logLevel: 'warning'
    })
  }

  // 渲染层入口：ESM 多文件（blob import 加载入口，懒加载 chunk 由 plugin:// 直接取）；
  // 宿主 UI 与 vendor 经 plugin://host/ui.js 桥
  const rendererEntry = join(srcDir, 'renderer/plugin.tsx')
  let chunkCount = 0
  if (existsSync(rendererEntry)) {
    await build({
      entryPoints: { renderer: rendererEntry },
      outdir: outDir,
      entryNames: 'renderer',
      chunkNames: 'chunk-[hash]',
      outExtension: { '.js': '.mjs' },
      bundle: true,
      /**
       * **必须开 splitting**（P3 实测）：不开时 esbuild 会把插件自己的动态 import 内联进入口，
       * home 的 `lazy(() => import('./graph/GraphView'))` 于是把 ~1MB 的 echarts 并进
       * `renderer.mjs`（首页是默认落点，等于每次启动都解析一份 echarts）。
       * 开了之后：入口 + `chunk-<hash>.mjs`，懒加载 chunk 在真正 mount 时才由
       * `plugin://<id>/chunk-<hash>.mjs` 取（绝对化见 absolutizeChunkSpecifiers）。
       */
      splitting: true,
      platform: 'browser',
      format: 'esm',
      target: 'chrome120',
      jsx: 'automatic',
      plugins: [hostRuntimePlugin('renderer')],
      loader: { '.css': 'css', '.svg': 'dataurl' },
      minify: !isDev,
      sourcemap: isDev ? 'inline' : false,
      logLevel: 'warning'
    })
    chunkCount = absolutizeChunkSpecifiers(id, outDir)
  }

  const size = (f) => (existsSync(join(outDir, f)) ? readFileSync(join(outDir, f)).length : 0)
  const chunkFiles = readdirSync(outDir).filter((f) => f.endsWith('.mjs') && f !== 'renderer.mjs')
  const chunkKB = chunkFiles.reduce((sum, f) => sum + size(f), 0) / 1024
  console.log(
    `  ${id.padEnd(8)} manifest=${manifest.id} main.cjs=${(size('main.cjs') / 1024).toFixed(1)}KB ` +
      `renderer.mjs=${(size('renderer.mjs') / 1024).toFixed(1)}KB ` +
      `chunks=${chunkFiles.length} 个 ${chunkKB.toFixed(1)}KB（改写 ${chunkCount} 处说明符）`
  )
}

console.log(`打包内置插件 → ${relative(ROOT, OUT_DIR)}${isDev ? '（dev：不压缩 + inline sourcemap）' : ''}`)
mkdirSync(OUT_DIR, { recursive: true })
for (const id of only ? [only] : PLUGIN_IDS) {
  try {
    await buildPlugin(id)
  } catch (err) {
    console.error(`  ${id} 打包失败：${err.message}`)
    process.exitCode = 1
  }
}
