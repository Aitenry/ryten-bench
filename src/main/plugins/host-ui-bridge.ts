import logger from 'electron-log'

/**
 * Renderer host UI bridge (main-process side; pairs with src/renderer/src/plugin-host/host-ui.ts).
 *
 * A plugin package's renderer module is ESM. At bundle time its `@renderer/**` sources and
 * third-party vendor modules are rewritten to `plugin://host/ui.js?m=<key>`; those URLs are served
 * by the `plugin://` protocol handler (`./protocol.ts`), which uses this module to generate the
 * source. The generated module takes the host's single instance from `globalThis.__RB_HOST_UI__`:
 *
 *   const m = globalThis.__RB_HOST_UI__["<key>"]
 *   export default m.default ?? m
 *   export const useState = m["useState"]      // one line per non-default export name
 *
 * Why the "key -> export name" table is needed: ESM requires `export const X = ...` to name its
 * bindings **statically**, and the bridge cannot reflect over the host namespace with `export *`.
 * The renderer's `installHostUi()` reports each key's export names (over the
 * `plugin-host-ui-exports` channel) when it installs the table, so the main process still knows
 * no host module by name.
 */
export interface HostUiExports {
  [key: string]: string[]
}

/** Reported "key -> export name" map (reported once at the earliest renderer startup) */
let reported: HostUiExports | null = null

/** Whether a report has been received (for tooling / diagnostics) */
export function hasHostUiExports(): boolean {
  return reported !== null
}

/**
 * The reported host UI key list (`null` = the renderer has not reported yet).
 *
 * The consumer is the **plugin workshop**'s acceptance battery: it must decide whether the host
 * UI table recognizes the host specifiers retained in a plugin bundle. Returning `null` instead of
 * an empty array is deliberate: "not reported yet" and "no keys at all" are different things - the
 * former can only skip the check (the app just started and the UI is not up yet), the latter means
 * something is genuinely broken.
 */
export function hostUiExportKeys(): string[] | null {
  return reported === null ? null : Object.keys(reported)
}

/** Record the host UI export names reported by the renderer (overwrite: reported again after HMR reload) */
export function setHostUiExports(map: unknown): void {
  if (typeof map !== 'object' || map === null) return
  const out: HostUiExports = {}
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    out[key] = value.filter((n): n is string => typeof n === 'string')
  }
  reported = out
}

/** Valid JS identifier (invalid export names are skipped; ESM does not allow `export const a-b = …`) */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Reserved words cannot be used as named export binding names (`export const default = …` is a syntax error) */
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
 * Bridge module path.
 *
 * Note that `plugin://host/ui.js` follows the generic `plugin://<id>/<relPath>` form: `host` is the
 * **id segment in the protocol**, while `ui.js` is the relPath matched here (`parsePluginUrl`
 * yields `{ id: 'host', relPath: 'ui.js' }`).
 */
export const HOST_UI_BRIDGE_PATH = 'ui.js'

/** Parse the module key from `?m=<key>` (unencoded `@` and `/` are accepted; falls back to the raw text when decoding fails) */
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
 * Generate the ESM bridge source for a host UI key.
 *
 * Every failure returns a **readable throwing module** (rather than a 500): the plugin's blob
 * import receives a Chinese error message and the panel shows it as "plugin failed to load", so
 * nothing goes blank.
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
      logger.warn(`[Plugins] Host UI bridge skipped invalid export name '${key}.${name}'`)
      continue
    }
    lines.push(`export const ${name} = m[${JSON.stringify(name)}];`)
  }
  return lines.join('\n') + '\n'
}
