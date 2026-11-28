import type { PluginManifest } from '@shared/plugin/types'
import { pluginUrl } from '@shared/plugin/protocol'
import { hostUiKeys } from './host-ui'
import type { Plugin } from './types'

/**
 * Plugin renderer module loading: `fetch('plugin://<id>/<entry>')` → **rewrite host specifiers**
 * → blob URL → dynamic import.
 *
 * Not using `import('plugin://...')` directly: Chromium's ESM import support for custom schemes is
 * unreliable.
 *
 * Why specifiers are rewritten (since P1): when packaging, plugin bundles keep host capabilities
 * (`@host/renderer/**` for core and host UI, plus vendors such as react/antd/icons) **as their
 * original specifiers** and let the host provide them at runtime — otherwise every plugin bundle
 * would carry a second copy of React (hooks crash outright) and a second copy of i18n. A blob
 * module cannot resolve bare specifiers, so before importing we rewrite them to
 * `plugin://host/ui.js?m=<key>`: an ESM bridge generated dynamically by the main process from the
 * host UI table, whose named exports all point at the host's own instance.
 */

/** Specifiers that must be rewritten to the host bridge: explicit `@host/**`, plus third-party bare modules (react/antd/…) */
const HOST_BRIDGE_BASE = 'plugin://host/ui.js'

/**
 * Specifiers of static imports/exports.
 *
 * Two forms are matched, and neither does loose `import` word matching (measured pitfall,
 * 2026-09-26):
 *   A) `from "s"`: covers `import x from` / `import * as x from` / `import { a } from` /
 *      `export … from` (including `export * from`) — all end with `from`;
 *   B) `import "s"`: side-effect-only imports have no `from`, so anchoring at statement start
 *      keeps them apart from ordinary expressions.
 * The earlier `\bimport\b\s*(?!\()` also matched code whose property/method names contain import
 * (`onImportDocToDirectory(`, `exportDocument: (id) => invoke(` …), so large chunks of source
 * were treated as specifiers and rewritten, producing a syntactically broken module
 * (`Unexpected identifier 'plugin'`). After tightening: after `import` only `{` / `*` / a quote /
 * whitespace+identifier is allowed, never `.` or `(`.
 */
const STATIC_SPEC_G = /\bfrom\s*(['"])([^'"]+)\1|(^|[;}\n])\s*import\s*(['"])([^'"]+)\3/gm

/** Specifier of a dynamic import("x") */
const DYNAMIC_SPEC_G = /(\bimport\s*\(\s*)(['"])([^'"]+)\2/g

/**
 * Instances of the same rules that **keep the `g` flag** (used for the post-hoc assertion scan).
 *
 * Why `g` must be kept (measured 2026-09-26: the renderer process spun at 100% CPU and even the
 * debugger could not attach): the assertion section uses
 * `while ((m = re.exec(code)) !== null)`. A non-global regex's `exec` **always returns the same
 * match and never advances `lastIndex`**, turning the loop into an infinite loop — the zero-length
 * guard `if (m.index === re.lastIndex)` cannot save it (`lastIndex` stays 0). With `g`, `exec`
 * advances automatically, and together with that guard it converges normally.
 */
const STATIC_SPEC = new RegExp(STATIC_SPEC_G.source, 'gm')
const DYNAMIC_SPEC = new RegExp(DYNAMIC_SPEC_G.source, 'g')

/**
 * Whether a specifier should go through the host bridge.
 *
 * **The decision must follow the authoritative host table, not "looks like a bare module"**
 * (measured 2026-09-26): bare specifiers in plugin bundles come in two kinds — those provided by
 * the host (react/antd/`@host/**`…) and those shipped with the plugin (echarts/d3/codemirror…,
 * already bundled but left in the output as bare specifiers by **dynamic import**). Judging by
 * shape alone would rewrite echarts to a bridge URL too, and the host table has no such key →
 * a runtime error "the host UI table has no 'echarts/charts'". Therefore:
 * - key present in `hostUiKeys()` → go through the bridge;
 * - other bare modules → keep as-is (the bundler already inlined the code, or the runtime resolves
 *   it itself);
 * - `@host/**` but not in the table → **still an error** (the bundler's rewrite rules and the host
 *   table disagree, which is a hard error).
 */
function needsBridge(spec: string, hostKeys: ReadonlySet<string>): boolean {
  if (spec.startsWith('@host/')) return true
  if (spec.startsWith('.') || spec.startsWith('/')) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)) return false // data:/blob:/plugin://…
  return hostKeys.has(`@host/vendor/${spec}`)
}

/** Specifier → host bridge URL (`@host/...` is used as the key as-is; bare modules are wrapped as `@host/vendor/<spec>`) */
function bridgeUrl(spec: string): string {
  const key = spec.startsWith('@host/') ? spec : `@host/vendor/${spec}`
  return `${HOST_BRIDGE_BASE}?m=${encodeURIComponent(key)}`
}

/** Extract the specifier from a static/dynamic match (shared by both branches) */
function specOf(match: RegExpExecArray): string {
  return match[2] ?? match[5] ?? match[8] ?? ''
}

/** Extract the quote character of the matched specifier */
function quoteOf(whole: string): string {
  const last = whole[whole.length - 1]
  return last === `'` ? `'` : `"`
}

/**
 * Rewrite host specifiers in a plugin bundle to host bridge URLs.
 *
 * Only specifiers that really exist in the host table are touched; afterwards it **asserts that no
 * `@host/**`-shaped specifier is left** — every `@host/**` the bundler emits must be found in the
 * host table; if one is missing, build and runtime are out of sync and a readable error must be
 * thrown right away, instead of waiting for the browser's contextless "Failed to resolve module
 * specifier".
 */
export function rewriteHostSpecifiers(id: string, source: string): string {
  const hostKeys = new Set(hostUiKeys())

  // Specifiers always appear at the **end** of the match, so replacing the trailing "spec" keeps the prefix
  const replaceIn = (re: RegExp, code: string): string =>
    code.replace(re, (whole, ...groups: unknown[]) => {
      const spec = specOf([whole, ...groups] as unknown as RegExpExecArray)
      if (!spec || !needsBridge(spec, hostKeys)) return whole
      const quote = quoteOf(whole)
      return whole.slice(0, whole.length - (spec.length + 2)) + quote + bridgeUrl(spec) + quote
    })

  let code = replaceIn(STATIC_SPEC_G, source)
  code = replaceIn(DYNAMIC_SPEC_G, code)

  const leftover: string[] = []
  for (const re of [STATIC_SPEC, DYNAMIC_SPEC]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(code)) !== null) {
      const spec = specOf(m)
      if (spec && spec.startsWith('@host/')) leftover.push(spec)
      if (m.index === re.lastIndex) re.lastIndex += 1
    }
  }
  if (leftover.length > 0) {
    const missing = [...new Set(leftover)].filter((s) => !hostKeys.has(s))
    throw new Error(
      `插件 '${id}' 的产物里还有未改写的宿主说明符：${[...new Set(leftover)].join(', ')}。` +
        (missing.length > 0
          ? `其中 ${missing.join(', ')} 不在宿主 UI 表里——请确认 src/renderer/src/plugin-host/host-ui.ts 是否覆盖了插件用到的宿主模块。`
          : `打包器输出的说明符形态可能变了，请检查工坊的产物改写规则与本文件的改写规则是否一致。`)
    )
  }
  return code
}

export async function loadExternalPlugin(manifest: PluginManifest): Promise<Plugin> {
  // Host UI table not installed → the bridge module resolves nothing, producing a pile of
  // "does not provide an export" errors. State the reason at the entry point (instead of a blank
  // screen).
  if (!(globalThis as typeof globalThis & { __RB_HOST_UI__?: unknown }).__RB_HOST_UI__) {
    throw new Error(
      `宿主 UI 表未安装，无法加载插件 '${manifest.id}'：` +
        `渲染层启动时必须先调用 installHostUi()（见 src/renderer/src/main.tsx）。`
    )
  }

  const entry = manifest.entry?.renderer ?? 'renderer.js'
  const url = pluginUrl(manifest.id, entry)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`插件 '${manifest.id}' 入口加载失败: HTTP ${res.status}`)
  }
  const code = rewriteHostSpecifiers(manifest.id, await res.text())
  const blob = new Blob([code], { type: 'text/javascript' })
  const blobUrl = URL.createObjectURL(blob)
  try {
    // Dynamic URL: no resolution needed at build time
    const mod = (await import(/* @vite-ignore */ blobUrl)) as {
      default?: unknown
      install?: unknown
    }
    // Handle both ESM output shapes:
    // - with esbuild `format: 'esm'`, default is the install function (the host UI bridge re-exports
    //   default as well);
    // - with minify + the bridge module's named exports, plugin source may also use
    //   `export { install }`, in which case default is the module namespace object and the real
    //   install lives on its `.install`.
    const candidates: unknown[] = [
      mod?.default,
      (mod?.default as { install?: unknown } | undefined)?.install,
      mod?.install
    ]
    const install = candidates.find((c) => typeof c === 'function')
    if (typeof install !== 'function') {
      throw new Error(
        `插件 '${manifest.id}' 渲染入口需导出 install(ctx)（default 或具名 install）；` +
          `实际导出：${Object.keys(mod ?? {}).join(', ') || '无'}`
      )
    }
    return { manifest, install: install as Plugin['install'] }
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}
