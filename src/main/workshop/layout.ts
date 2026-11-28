import * as fs from 'fs'
import * as path from 'path'
import { listDraftFiles, readDraftFile } from './store'

/**
 * **Layout and theme health check** for the plugin UI (the `layout.scan` item of the
 * verification battery).
 *
 * Why a dedicated module: the three most common "installs fine but the UI is broken" problems
 * in plugins are neither compile errors nor host-contract violations, but **styling
 * convention** mistakes —
 *
 * 1. **Full-page scrollbar**: the plugin root node carries `overflow-auto` (especially
 *    `h-full overflow-auto`). The host's plugin page is mounted inside `.frame-body-center`
 *    (`flex:1; overflow:auto; min-height:0`) and its height is fixed; a scrolling root drags
 *    the title and tabs out of the window, which looks like "the whole app is scrolling".
 * 2. **All tabs stacked on top of each other**: `display` is set on antd 6 Tabs'
 *    `styles.content`. antd hides inactive tabs via the `.ant-tabs-content-hidden` **class
 *    selector**, and inline styles have higher priority — once flex/block is written the
 *    hiding stops working, and every visited pane (each a `.ant-tabs-content`) is absolutely
 *    positioned over the whole body and painted at the same time, so "the content is all
 *    crammed together".
 * 3. **Dark theme does not apply**: the Tailwind `dark:` variant is used. The plugin's compiled
 *    `plugin.css` has no `@custom-variant dark`, so `dark:` lands as
 *    `@media (prefers-color-scheme: dark)` (following the **operating system** color scheme),
 *    while the host switches themes via the `.dark` class on `document.documentElement` plus
 *    antd's `darkAlgorithm`; the two do not match: app dark + system light = plugin still
 *    paints light.
 *
 * These are all **source-level** criteria (no need to run the UI), so they fit into the offline
 * verification battery; real-device evidence still comes from the probe and a real install. The
 * check is **read-only**: the report says "which file, which line, how to fix", and never
 * modifies the user's code.
 */

export type LayoutFindingKind =
  | 'page-scroll-root'
  | 'tabs-pane-display'
  | 'tabs-content-flex'
  | 'dark-variant'
  | 'modal-no-height'

export interface LayoutFinding {
  kind: LayoutFindingKind
  /** Relative path within the draft */
  file: string
  line: number
  excerpt: string
  /** Criterion and fix (goes verbatim into the verification report) */
  message: string
}

/** Scan only source files with these extensions (the renderer is where the UI is drawn) */
const RENDERER_EXT = /\.(tsx|jsx|ts|js)$/

/**
 * Strip comments while **preserving line numbers** (comments become equal-length blank space).
 *
 * Why comments must be stripped first: templates and real plugins habitually paste
 * counter-examples in comments ("do not write `h-full overflow-auto`"); without stripping, the
 * documentation that teaches people not to do this would itself be flagged as a violation.
 * String literals are preserved as-is — class names live in strings. A small state machine
 * handles `'` / `"` / backticks and `//` / slash-star.
 */
export function stripComments(source: string): string {
  let out = ''
  let quote: string | null = null
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1] ?? ''
    if (quote) {
      if (char === '\\') {
        out += char + next
        index += 1
        continue
      }
      if (char === quote) quote = null
      out += char
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out += ' '
        index += 1
      }
      out += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        out += source[index] === '\n' ? '\n' : ' '
        index += 1
      }
      index += 1
      out += '  '
      continue
    }
    out += char
  }
  return out
}

/** Renderer source texts (a draft has no node_modules; everything is a plain text file) */
function rendererSources(draft: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  for (const entry of listDraftFiles(draft)) {
    const rel = entry.path.replace(/\\/g, '/')
    if (!rel.startsWith('renderer/')) continue
    if (!RENDERER_EXT.test(rel)) continue
    try {
      out.push({ file: rel, text: stripComments(readDraftFile(draft, rel)) })
    } catch {
      // Skip files that cannot be read (being deleted / permission issues): the health check should not break the whole verification because of that
    }
  }
  return out
}

/** Scan line by line (the report needs jumpable line numbers) */
function eachLine(
  text: string,
  visit: (line: string, index: number) => LayoutFinding | null
): LayoutFinding[] {
  const out: LayoutFinding[] = []
  text.split(/\r?\n/).forEach((line, index) => {
    const finding = visit(line, index)
    if (finding) out.push(finding)
  })
  return out
}

/** Class names at `className` attribute positions (double quotes / single quotes / string literals inside JSX expressions all count) */
function classNameTextOf(line: string): string[] {
  const out: string[] = []
  const re = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g
  let match: RegExpExecArray | null
  while ((match = re.exec(line)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3] ?? ''
    let found = false
    for (const literal of raw.match(/['"`]([^'"`]*)['"`]/g) ?? []) {
      out.push(literal.slice(1, -1))
      found = true
    }
    if (raw && !found) out.push(raw)
  }
  return out
}

const hasClass = (text: string, name: string): boolean =>
  new RegExp('(^|[\\s\'"`{])' + name + '($|[\\s\'"`}])').test(text)

/** Rule 1: a container that fills the height must not scroll itself (the source of full-page scrollbars) */
function scanScrollRoot(file: string, text: string): LayoutFinding[] {
  return eachLine(text, (line, index) => {
    const offender = classNameTextOf(line).find(
      (value) => hasClass(value, 'overflow-auto') || hasClass(value, 'overflow-scroll')
    )
    if (!offender) return null
    // It is that kind of full-page scrollbar only when the container also fills the height; local scroll blocks (inside some panel) are not flagged
    const fullHeight =
      hasClass(offender, 'h-full') ||
      hasClass(offender, 'h-screen') ||
      hasClass(offender, 'min-h-full')
    if (!fullHeight) return null
    return {
      kind: 'page-scroll-root' as const,
      file,
      line: index + 1,
      excerpt: line.trim(),
      message:
        '撑满高度的容器又带 overflow-auto：宿主的插件页面容器高度是确定的，这里滚会把标题/页签一起滚出窗口（用户看到的是「整页滚动条」）。改成 flex h-full min-h-0 flex-col overflow-hidden，要滚只让内部的内容块滚（flex-1 min-h-0 overflow-y-auto）'
    }
  })
}

/** Rule 2: do not set display on a Tabs pane (`styles.content`) — hiding relies on a class selector */
function scanTabsPane(file: string, text: string): LayoutFinding[] {
  const out: LayoutFinding[] = []
  const lines = text.split(/\r?\n/)
  // Only look at what is inside the braces of the `content:` key itself:
  // a sibling key `body: { display: 'flex' }` (which must be written to fill the height) must not be counted here.
  const re = /(^|[\s{,])(?:content|contentStyle)\s*:/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    let index = match.index + match[0].length
    while (index < text.length && /\s/.test(text[index])) index += 1
    if (text[index] !== '{') continue
    let depth = 0
    let end = index
    for (; end < text.length; end += 1) {
      if (text[end] === '{') depth += 1
      else if (text[end] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const block = text.slice(index, end + 1)
    if (!/display\s*:/.test(block)) continue
    const line = text.slice(0, match.index).split('\n').length
    out.push({
      kind: 'tabs-pane-display',
      file,
      line,
      excerpt: (lines[line - 1] ?? '').trim(),
      message:
        'antd 6 Tabs 的 styles.content（每个页签各自是一个 .ant-tabs-content）里不能写 display：antd 用 .ant-tabs-content-hidden 这个类隐藏非激活页签，内联 display 优先级更高会让隐藏失效，访问过的页签会全部叠在一起同时画出来（症状「内容都挤在一堆」）。content 只给 position:absolute; inset:0; minHeight:0; overflow:hidden（模板 full 的 pageTabsProps 就是正确写法）'
    })
  }
  return out
}

/** Rule 2b: do not set flex:1 on a pane (panes would divide the height) */
function scanTabsContentFlex(file: string, text: string): LayoutFinding[] {
  return eachLine(text, (line, index) => {
    if (!/(^|[\s{,])content\s*:\s*\{[^}]*flex\s*:\s*1/.test(line)) return null
    return {
      kind: 'tabs-content-flex' as const,
      file,
      line: index + 1,
      excerpt: line.trim(),
      message:
        'antd 6 里每个页签各自是一个 .ant-tabs-content，是 flex 项时它们会一起瓜分高度（访问 6 个页签时当前页只剩 1/6 高，内容被裁）。content 用 position:absolute; inset:0 铺满 body，而不是 flex:1'
    }
  })
}

/** Rule 3: the Tailwind dark: variant must not be used (it follows the system color scheme, not the app theme) */
function scanDarkVariant(file: string, text: string): LayoutFinding[] {
  return eachLine(text, (line, index) => {
    const offenders = classNameTextOf(line).filter((value) => /(^|\s)dark:/.test(value))
    if (offenders.length === 0) return null
    return {
      kind: 'dark-variant' as const,
      file,
      line: index + 1,
      excerpt: line.trim(),
      message:
        'Tailwind 的 dark: 变体在插件里跟的是**操作系统**配色（plugin.css 里落成 prefers-color-scheme），而应用主题是宿主自己的一套（.dark 类 + antd darkAlgorithm，还可能按时间自动切）——两者对不上，暗色主题会画成浅色。颜色取 antd token（theme.useToken()），或按宿主 useTheme() 的 effectiveTheme 给两份语义色（模板 full 的 renderer/components/ui.tsx 的 usePluginPalette()）'
    }
  })
}

/** Rule 4: a Modal must have a height cap (otherwise a full-page scrollbar appears in short windows) */
function scanModalHeight(file: string, text: string): LayoutFinding[] {
  const out: LayoutFinding[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (!/<Modal\b/.test(line)) return
    // The opening tag may span multiple lines: take up to the first '>' (self-closing tags too)
    const window = lines.slice(index, index + 8).join('\n')
    const end = window.indexOf('>')
    const openTag = end >= 0 ? window.slice(0, end + 1) : window
    if (
      /formModalProps|createModalProps|styles\s*=/.test(openTag) ||
      /maxHeight|max-height/.test(openTag)
    ) {
      return
    }
    out.push({
      kind: 'modal-no-height',
      file,
      line: index + 1,
      excerpt: line.trim(),
      message:
        '这个 Modal 没有高度上限：内容一多，滚动容器就变成铺满视口的 .ant-modal-wrap（窗口右边缘一条「整页」滚动条），标题与底部按钮会被一起滚出视口、点不到。展开 renderer/components/ui.tsx 的 formModalProps（字段多、需要内部滚动）或 createModalProps（短弹窗）'
    })
  })
  return out
}

/** All health-check results for a single source file */
export function scanRendererSource(file: string, text: string): LayoutFinding[] {
  const code = stripComments(text)
  return [
    ...scanScrollRoot(file, code),
    ...scanTabsPane(file, code),
    ...scanTabsContentFlex(file, code),
    ...scanDarkVariant(file, code),
    ...scanModalHeight(file, code)
  ]
}

/**
 * Scan the renderer sources of a draft.
 *
 * The return value contains only hits that are "definitely a pitfall"; each entry carries the
 * file, line number, and fix, and the verification report shows them directly to the user/model.
 */
export function scanWorkshopLayouts(draft: string): LayoutFinding[] {
  const out: LayoutFinding[] = []
  for (const source of rendererSources(draft)) {
    out.push(...scanRendererSource(source.file, source.text))
  }
  return out
}

/** Whether the draft directory has renderer sources to scan (verify must not throw after the draft is deleted) */
export function layoutScanAvailable(draft: string): boolean {
  try {
    return fs.statSync(path.join(draft, 'renderer')).isDirectory()
  } catch {
    return false
  }
}
