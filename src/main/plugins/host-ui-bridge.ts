import logger from 'electron-log'

/**
 * 渲染层宿主 UI 桥（主进程侧，配合 src/renderer/src/plugin-host/host-ui.ts）。
 *
 * 插件包的渲染模块是 ESM，源码里的 `@renderer/**` 与第三方 vendor 在打包时被改写成
 * `plugin://host/ui.js?m=<key>`；这些 URL 由 `plugin://` 协议处理器（`./protocol.ts`）
 * 用本模块生成源码。生成出来的模块从 `globalThis.__RB_HOST_UI__` 取宿主那一份实例：
 *
 *   const m = globalThis.__RB_HOST_UI__["<key>"]
 *   export default m.default ?? m
 *   export const useState = m["useState"]      // 每个非 default 导出名一条
 *
 * 为什么要「键 → 导出名」这份表：ESM 的 `export const X = ...` 必须**静态**写死名称，
 * 桥无法用 `export *` 反射宿主命名空间。渲染层 `installHostUi()` 在挂表的同时把
 * 每个键的导出名报过来（`plugin-host-ui-exports` 通道），主进程因此仍然不认识任何 host 模块。
 */
export interface HostUiExports {
  [key: string]: string[]
}

/** 已上报的「键 → 导出名」（渲染层启动最早期一次上报） */
let reported: HostUiExports | null = null

/** 是否已收到上报（工装/诊断用） */
export function hasHostUiExports(): boolean {
  return reported !== null
}

/**
 * 已上报的宿主 UI 键清单（`null` = 渲染层还没上报）。
 *
 * 消费方是**插件工坊**的验收电池：它要判断「插件产物里保留的宿主说明符，
 * 宿主 UI 表到底认不认」。返回 `null` 而不是空数组是刻意的——「还没上报」
 * 与「一个键都没有」是两件事，前者只能跳过检查（应用刚启动、界面还没起来），
 * 后者是真的坏了。
 */
export function hostUiExportKeys(): string[] | null {
  return reported === null ? null : Object.keys(reported)
}

/** 记录渲染层上报的宿主 UI 导出名（覆盖式：HMR 重载后重新上报） */
export function setHostUiExports(map: unknown): void {
  if (typeof map !== 'object' || map === null) return
  const out: HostUiExports = {}
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    out[key] = value.filter((n): n is string => typeof n === 'string')
  }
  reported = out
}

/** 合法 JS 标识符（非法导出名跳过；ESM 不允许 `export const a-b = …`） */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** 保留字不能作为具名导出绑定名（`export const default = …` 是语法错误） */
const RESERVED = new Set([
  'default',
  'import',
  'export',
  'class',
  'function',
  'var',
  'let',
  'const',
  'new',
  'delete',
  'typeof',
  'in',
  'instanceof',
  'void',
  'return',
  'this',
  'super',
  'extends',
  'with'
])

/**
 * 桥模块路径。
 *
 * 注意 `plugin://host/ui.js` 走的是 `plugin://<id>/<relPath>` 的通用形态：`host` 是
 * **协议里的 id 段**，`ui.js` 才是这里要匹配的 relPath（`parsePluginUrl` 的结果是
 * `{ id: 'host', relPath: 'ui.js' }`）。
 */
export const HOST_UI_BRIDGE_PATH = 'ui.js'

/** 解析 `?m=<key>` 里的模块键（未编码的 `@` `/` 也接受，decode 失败时退回原文） */
export function parseHostUiKey(search: string): string | null {
  const raw = /[?&]m=([^&]*)/.exec(search)?.[1]
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * 生成某个宿主 UI 键的 ESM 桥源码。
 *
 * 失败一律返回**可读的抛错模块**（而不是 500）：插件的 blob import 会拿到一条中文
 * 错误信息，面板里显示为「插件加载失败」，不会白屏。
 */
export function hostUiBridgeSource(key: string): string {
  const fail = (message: string): string =>
    `throw new Error(${JSON.stringify(`[plugin-host] ${message}`)});\n`

  if (reported === null) {
    return fail(
      `宿主 UI 桥尚未就绪：渲染层还没有上报宿主 UI 表（请求的键 '${key}'）。` +
        `通常意味着渲染层启动失败或 preload 未注入 window.api.plugin.reportHostUi。`
    )
  }

  const names = reported[key]
  if (!names) {
    return fail(
      `宿主 UI 表里没有 '${key}'。请检查打包产物里的说明符是否与 ` +
        `src/renderer/src/plugin-host/host-ui.ts 的键一致。`
    )
  }

  const lines = [
    `const m = globalThis.__RB_HOST_UI__?.[${JSON.stringify(key)}];`,
    `if (!m) throw new Error(${JSON.stringify(
      `[plugin-host] 宿主 UI 表未安装（缺 '${key}'）：请确认渲染层启动时调用了 installHostUi()。`
    )});`,
    `export default m.default ?? m;`
  ]
  for (const name of names) {
    if (!IDENT_RE.test(name) || RESERVED.has(name)) {
      logger.warn(`[Plugins] 宿主 UI 桥跳过非法导出名 '${key}.${name}'`)
      continue
    }
    lines.push(`export const ${name} = m[${JSON.stringify(name)}];`)
  }
  return lines.join('\n') + '\n'
}
