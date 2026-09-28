import * as fs from 'fs'
import * as path from 'path'
import { listDraftFiles, readDraftFile } from './store'

/**
 * 插件界面的**布局与主题体检**（验收电池的 `layout.scan` 项）。
 *
 * 为什么单独做这一块：插件最常见的三类「装上去能用、但界面是坏的」问题，
 * 都不是编译错误、也不是宿主契约错误，而是**样式约定**错误——
 *
 * 1. **整页滚动条**：插件根节点写了 `overflow-auto`（尤其 `h-full overflow-auto`）。
 *    宿主的插件页面挂在 `.frame-body-center`（`flex:1; overflow:auto; min-height:0`）里，
 *    它的高度是确定的；根节点自己滚会把标题、页签一起滚出窗口，看起来就是「整个应用在滚」。
 * 2. **页签全部叠在一起**：给 antd 6 Tabs 的 `styles.content` 写了 `display`。
 *    antd 靠 `.ant-tabs-content-hidden` 这个**类选择器**隐藏非激活页签，而内联样式优先级更高
 *    —— 写成 flex/block 之后隐藏失效，访问过的每个 pane（各自是一个 `.ant-tabs-content`）
 *    都绝对定位铺满 body，同时画出来，症状是「内容都挤在一堆」。
 * 3. **暗色主题不生效**：用了 Tailwind 的 `dark:` 变体。插件编出来的 `plugin.css` 没有
 *    `@custom-variant dark`，`dark:` 落成的是 `@media (prefers-color-scheme: dark)`（跟**操作系统**
 *    配色），而宿主是靠 `document.documentElement` 的 `.dark` 类 + antd `darkAlgorithm` 切主题的，
 *    两者对不上：应用暗色 + 系统亮色 = 插件仍画浅色。
 *
 * 这些都是**源码级**判据（不需要跑界面），所以能放进离线验收电池里；
 * 真机取证仍然靠探针与真装（见 README 的回归表）。检查是**只读**的：
 * 报告给「哪个文件、哪一行、怎么改」，绝不改用户的代码。
 */

export type LayoutFindingKind =
  | 'page-scroll-root'
  | 'tabs-pane-display'
  | 'tabs-content-flex'
  | 'dark-variant'
  | 'modal-no-height'

export interface LayoutFinding {
  kind: LayoutFindingKind
  /** 草稿内相对路径 */
  file: string
  line: number
  excerpt: string
  /** 判据与改法（会原样进验收报告） */
  message: string
}

/** 只扫这些后缀的源码（渲染层才是画界面的地方） */
const RENDERER_EXT = /\.(tsx|jsx|ts|js)$/

/**
 * 去掉注释，**保留行号**（把注释放成等量空白）。
 *
 * 为什么必须先去注释：模板与真实插件都习惯在注释里贴反例（「不要写 `h-full overflow-auto`」），
 * 不去注释就会把「教人别这么写」的文档本身判成违规。字符串字面量原样保留——
 * 类名就在字符串里。小状态机处理 `'` / `"` / 反引号与 `//` / 斜杠星号。
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

/** 渲染层的源码文本（草稿里没有 node_modules，全部是纯文本文件） */
function rendererSources(draft: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  for (const entry of listDraftFiles(draft)) {
    const rel = entry.path.replace(/\\/g, '/')
    if (!rel.startsWith('renderer/')) continue
    if (!RENDERER_EXT.test(rel)) continue
    try {
      out.push({ file: rel, text: stripComments(readDraftFile(draft, rel)) })
    } catch {
      // 读不到的文件跳过（正在被删 / 权限问题）：体检不该因此炸掉整条验收
    }
  }
  return out
}

/** 逐行扫描（报告里要给出可跳转的行号） */
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

/** `className` 属性位置上的类名（双引号 / 单引号 / JSX 表达式里的字符串字面量都算） */
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

/** 规则 1：撑满高度的容器不能自己滚（整页滚动条的来源） */
function scanScrollRoot(file: string, text: string): LayoutFinding[] {
  return eachLine(text, (line, index) => {
    const offender = classNameTextOf(line).find(
      (value) => hasClass(value, 'overflow-auto') || hasClass(value, 'overflow-scroll')
    )
    if (!offender) return null
    // 只有「同时又撑满高度」时才是那类整页滚动条；局部滚动块（某个面板内部）不点
    const fullHeight =
      hasClass(offender, 'h-full') || hasClass(offender, 'h-screen') || hasClass(offender, 'min-h-full')
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

/** 规则 2：不要给 Tabs 的 pane（`styles.content`）写 display —— 隐藏靠的是类选择器 */
function scanTabsPane(file: string, text: string): LayoutFinding[] {
  const out: LayoutFinding[] = []
  const lines = text.split(/\r?\n/)
  // 只看 `content:` 键自己那一对花括号里的东西：
  // 兄弟键 `body: { display: 'flex' }`（撑满高度必须写的那条）不能被算进来。
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

/** 规则 2b：不要给 pane 写 flex:1（pane 会瓜分高度） */
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

/** 规则 3：不能用 Tailwind 的 dark: 变体（跟的是系统配色，不是应用主题） */
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

/** 规则 4：Modal 必须有高度上限（否则矮窗口下冒出整页滚动条） */
function scanModalHeight(file: string, text: string): LayoutFinding[] {
  const out: LayoutFinding[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (!/<Modal\b/.test(line)) return
    // 开标签可能跨多行：取到第一个 `>` 为止（自闭合也一样）
    const window = lines.slice(index, index + 8).join('\n')
    const end = window.indexOf('>')
    const openTag = end >= 0 ? window.slice(0, end + 1) : window
    if (/formModalProps|createModalProps|styles\s*=/.test(openTag) || /maxHeight|max-height/.test(openTag)) {
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

/** 单份源码的全部体检结果 */
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
 * 扫一份草稿的渲染层源码。
 *
 * 返回值只包含「确定是坑」的命中；每一条都带文件、行号与改法，验收报告直接展示给用户/模型。
 */
export function scanWorkshopLayouts(draft: string): LayoutFinding[] {
  const out: LayoutFinding[] = []
  for (const source of rendererSources(draft)) {
    out.push(...scanRendererSource(source.file, source.text))
  }
  return out
}

/** 草稿目录里有没有可扫的渲染层源码（草稿被删后 verify 不该抛） */
export function layoutScanAvailable(draft: string): boolean {
  try {
    return fs.statSync(path.join(draft, 'renderer')).isDirectory()
  } catch {
    return false
  }
}
