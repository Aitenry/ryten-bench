import type { PluginManifest } from '@shared/plugin/types'
import { pluginUrl } from '@shared/plugin/protocol'
import { hostUiKeys } from './host-ui'
import type { Plugin } from './types'

/**
 * 插件渲染模块加载（方案 6.4 方案 B）：
 * `fetch('plugin://<id>/<entry>')` → **重写宿主说明符** → blob URL → 动态 import。
 *
 * 不直接用 `import('plugin://...')`：Chromium 对自定义 scheme 的 ESM import 支持不可靠。
 *
 * 为什么要重写说明符（P1 起，方案见 src/main/workshop/README.md）：
 * 插件包在打包时把宿主能力（core 与宿主 UI 的 `@host/renderer/**`、以及 react/antd/图标这类
 * vendor）**保留成原来的说明符**，交给宿主在运行期提供——否则每个插件包都会自带第二份
 * React（hooks 直接崩）、第二份 i18n。blob 模块无法解析裸说明符，所以这里在 import 之前
 * 把它们改写成 `plugin://host/ui.js?m=<key>`：那是主进程按宿主 UI 表动态生成的 ESM 桥，
 * 桥里的具名导出都指向宿主自己的那一份实例。
 */

/** 需要改写成宿主桥的说明符：显式 `@host/**`，以及第三方裸模块（react/antd/…） */
const HOST_BRIDGE_BASE = 'plugin://host/ui.js'

/**
 * 静态 import/export 的说明符。
 *
 * 匹配两种形态，且都**不做宽松的 `import` 单词匹配**（2026-09-26 实测踩坑）：
 *   A) `from "s"`：覆盖 `import x from` / `import * as x from` / `import { a } from` /
 *      `export … from`（含 `export * from`）——全部以 `from` 收尾；
 *   B) `import "s"`：只有副作用导入没有 `from`，用语句起始锚点把它和普通表达式区分开。
 * 早先的 `\bimport\b\s*(?!\()` 会命中**属性名/方法名里含 import 的代码**
 * （`onImportDocToDirectory(`、`exportDocument: (id) => invoke(` …），于是把大段源代码
 * 当成说明符改写，产出一个语法坏掉的模块（表现为 `Unexpected identifier 'plugin'`）。
 * 收紧之后：`import` 后面只允许 `{` / `*` / 引号 / 空白+标识符，绝不会是 `.` 或 `(`。
 */
const STATIC_SPEC_G = /\bfrom\s*(['"])([^'"]+)\1|(^|[;}\n])\s*import\s*(['"])([^'"]+)\3/gm

/** 动态 import("x") 的说明符 */
const DYNAMIC_SPEC_G = /(\bimport\s*\(\s*)(['"])([^'"]+)\2/g

/**
 * 同一套规则、**保留 `g` 标志**的实例（用于事后断言扫描）。
 *
 * 为什么必须保留 `g`（2026-09-26 实测：渲染进程 100% CPU 空转，调试器都插不进去）：
 * 断言段用的是 `while ((m = re.exec(code)) !== null)`。非全局正则的 `exec` **永远返回同一个
 * 匹配且不推进 `lastIndex`**，于是这个 while 成了死循环——`if (m.index === re.lastIndex)`
 * 那句零长度保护也救不了（`lastIndex` 恒为 0）。带上 `g` 后 `exec` 会自动推进，配合那句
 * 保护即可正常收敛。
 */
const STATIC_SPEC = new RegExp(STATIC_SPEC_G.source, 'gm')
const DYNAMIC_SPEC = new RegExp(DYNAMIC_SPEC_G.source, 'g')

/**
 * 该说明符是否需要走宿主桥。
 *
 * **判定必须以上帝视角的宿主表为准，不能靠「看起来像裸模块」**（2026-09-26 实测）：
 * 插件包里的裸说明符分两类——宿主提供的（react/antd/`@host/**`…）与插件自带的
 * （echarts/d3/codemirror…，已打进包但**动态 import** 会以裸说明符形式留在产物里）。
 * 只按形态判断会把 echarts 也改写成桥 URL，而宿主表里没有它 → 运行期报
 * 「宿主 UI 表里没有 'echarts/charts'」。所以：
 * - 键在 `hostUiKeys()` 里 → 走桥；
 * - 其它裸模块 → 原样保留（打包器已经把代码打进包里，或由运行时自己解析）；
 * - `@host/**` 但不在表里 → **仍然报错**（打包器的改写规则与宿主表不一致，是硬错误）。
 */
function needsBridge(spec: string, hostKeys: ReadonlySet<string>): boolean {
  if (spec.startsWith('@host/')) return true
  if (spec.startsWith('.') || spec.startsWith('/')) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)) return false // data:/blob:/plugin://…
  return hostKeys.has(`@host/vendor/${spec}`)
}

/** 说明符 → 宿主桥 URL（`@host/...` 直接是键；裸模块包成 `@host/vendor/<spec>`） */
function bridgeUrl(spec: string): string {
  const key = spec.startsWith('@host/') ? spec : `@host/vendor/${spec}`
  return `${HOST_BRIDGE_BASE}?m=${encodeURIComponent(key)}`
}

/** 从静态/动态匹配里取说明符（两套分支共用） */
function specOf(match: RegExpExecArray): string {
  return match[2] ?? match[5] ?? match[8] ?? ''
}

/** 从匹配里取说明符的引号字符 */
function quoteOf(whole: string): string {
  const last = whole[whole.length - 1]
  return last === `'` ? `'` : `"`
}

/**
 * 把插件包里的宿主说明符改写成宿主桥 URL。
 *
 * 只动「宿主表里真的有的」说明符；改完之后**断言代码里不再有 `@host/**` 形态的残留**——
 * 打包器写出来的 `@host/**` 必须全部能在宿主表里找到，找不到就是构建/运行时不同步，
 * 要立刻抛可读错误，而不是等浏览器给一句没有上下文的「Failed to resolve module specifier」。
 */
export function rewriteHostSpecifiers(id: string, source: string): string {
  const hostKeys = new Set(hostUiKeys())

  // 说明符总是出现在匹配段的**末尾**，所以按尾部 `"spec"` 整体替换即可保留前缀
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
  // 宿主 UI 表未安装 → 桥模块取不到任何东西，会得到一堆 "does not provide an export"
  // 的点名错误。在入口就给出明确原因（而不是白屏）。
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
    // 动态 URL：构建期无需解析
    const mod = (await import(/* @vite-ignore */ blobUrl)) as {
      default?: unknown
      install?: unknown
    }
    // 兼容两种 ESM 产出形态：
    // - esbuild `format: 'esm'` 时 default 就是 install 函数（宿主 UI 桥把 default 也 re-export 了）；
    // - minify + 桥模块的具名导出也可能让插件源码走 `export { install }`，
    //   此时 default 是模块命名空间对象，真正的 install 在其 `.install` 上。
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
