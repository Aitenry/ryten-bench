import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

/**
 * 编辑器主题（浅色 / 深色）。
 *
 * 语法色板对齐参考设计（VS Code Dark+ / Light+ 的官方取值）：
 * 关键字蓝 `#569CD6`、控制流紫 `#C586C0`、类型青 `#4EC9B0`、函数黄 `#DCDCAA`、
 * 变量/属性浅蓝 `#9CDCFE`、字符串橙 `#CE9178`、数字浅绿 `#B5CEA8`、注释绿 `#6A9955`。
 * 外壳（页签、行号槽、滚动条）同样按参考设计的取值走，底色仍跟随应用主题 token。
 */

export interface EditorPaletteInput {
  dark: boolean
  /** 编辑器底色（= 面板底色，保证与页签栏无缝） */
  background: string
  /** 正文颜色 */
  foreground: string
  /** 次要文字（行号、占位） */
  muted: string
  /** 分隔线 */
  border: string
  /** 强调色（光标 / 选中行号 / 补全选中项） */
  accent: string
}

/** 语法高亮色板（VS Code Dark+ / Light+） */
function syntaxColors(dark: boolean): Record<string, string> {
  return dark
    ? {
        comment: '#6A9955',
        keyword: '#569CD6',
        control: '#C586C0',
        string: '#CE9178',
        number: '#B5CEA8',
        type: '#4EC9B0',
        func: '#DCDCAA',
        prop: '#9CDCFE',
        variable: '#9CDCFE',
        constant: '#4FC1FF',
        op: '#D4D4D4',
        punct: '#D4D4D4',
        regexp: '#D16969',
        escape: '#D7BA7D',
        meta: '#9CDCFE',
        invalid: '#F44747',
        link: '#569CD6'
      }
    : {
        comment: '#008000',
        keyword: '#0000FF',
        control: '#AF00DB',
        string: '#A31515',
        number: '#098658',
        type: '#267F99',
        func: '#795E26',
        prop: '#001080',
        variable: '#001080',
        constant: '#0070C1',
        op: '#000000',
        punct: '#000000',
        regexp: '#811F3F',
        escape: '#EE0000',
        meta: '#001080',
        invalid: '#CD3131',
        link: '#0000FF'
      }
}

/** 主题扩展：编辑器外壳 + 差异视图 + 查找面板 + 补全弹层 */
export function editorTheme(input: EditorPaletteInput): Extension {
  const c = syntaxColors(input.dark)
  const { dark, background, foreground, muted, border, accent } = input

  const activeLine = dark ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.028)'
  const selection = dark ? 'rgba(122,170,255,0.24)' : 'rgba(80,130,220,0.18)'
  const selectionMatch = dark ? 'rgba(217,176,106,0.22)' : 'rgba(217,176,106,0.34)'
  const searchMatch = dark ? 'rgba(224,138,112,0.28)' : 'rgba(224,138,112,0.3)'
  /** 行号槽与正文同底（VS Code 的 gutter 没有分隔线、没有底色差） */
  const gutterBg = 'transparent'
  const lineNumber = dark ? '#858585' : '#9a9a9a'
  const lineNumberActive = dark ? '#c6c6c6' : '#3b3b3b'
  const panelBg = dark ? '#232323' : '#fbfaf8'
  const tooltipBg = dark ? '#2a2a2a' : '#ffffff'
  const insertedBg = dark ? 'rgba(120,200,120,0.13)' : 'rgba(60,150,90,0.10)'
  const deletedBg = dark ? 'rgba(230,110,95,0.13)' : 'rgba(190,70,55,0.08)'
  const changedGutter = dark ? 'rgba(224,138,112,0.55)' : 'rgba(168,68,42,0.45)'

  const theme = EditorView.theme(
    {
      '&': {
        color: foreground,
        backgroundColor: background,
        height: '100%',
        fontSize: '13px'
      },
      '&.cm-focused': { outline: 'none' },
      // 原生滚动条隐藏：改由 EditorScrollbars 悬浮绘制在内容区之上（VS Code 观感）。
      // 原生滚动条会占掉 10px 宽度、看起来像「编辑器外面的另一条槽」——用户两轮反馈的正是这个。
      // 滚轮/键盘/触控板仍然走原生滚动，这里只隐藏「绘制」。
      '.cm-scroller': {
        fontFamily:
          "'Cascadia Code', 'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace",
        lineHeight: '1.65',
        overflow: 'auto',
        scrollbarWidth: 'none'
      },
      '.cm-scroller::-webkit-scrollbar': { width: 0, height: 0, display: 'none' },
      '.cm-content': { caretColor: accent, padding: '8px 0' },
      '.cm-line': { padding: '0 16px 0 6px' },
      '&.cm-focused .cm-cursor, .cm-dropCursor': {
        borderLeftColor: accent,
        borderLeftWidth: '2px'
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: selection
      },
      '.cm-selectionMatch': { backgroundColor: selectionMatch, borderRadius: '2px' },
      '.cm-searchMatch': { backgroundColor: searchMatch, outline: `1px solid ${c.keyword}55` },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: `${accent}44` },
      '.cm-activeLine': { backgroundColor: activeLine },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: lineNumberActive },
      '.cm-gutters': {
        backgroundColor: gutterBg,
        color: lineNumber,
        border: 'none',
        fontSize: '12.5px',
        paddingRight: '6px'
      },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 16px', minWidth: '38px' },
      '.cm-foldGutter .cm-gutterElement': {
        padding: '0 4px',
        color: lineNumber,
        opacity: '0.75',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      },
      '.cm-foldGutter .cm-gutterElement:hover': { opacity: '1', color: foreground },
      '.cm-foldPlaceholder': {
        backgroundColor: 'transparent',
        border: `1px solid ${border}`,
        borderRadius: '3px',
        color: muted,
        padding: '0 4px',
        margin: '0 4px'
      },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: `${accent}26`,
        outline: `1px solid ${accent}66`,
        borderRadius: '2px'
      },
      '.cm-nonmatchingBracket': { color: c.invalid },
      // 面板（查找/替换）与弹层
      '.cm-panels': { backgroundColor: panelBg, color: foreground },
      '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${border}` },
      '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${border}` },
      '.cm-panel.cm-search': { padding: '6px 8px', fontSize: '12px' },
      '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-textfield': {
        fontFamily: 'inherit',
        fontSize: '12px',
        backgroundColor: background,
        color: foreground,
        border: `1px solid ${border}`,
        borderRadius: '4px',
        padding: '2px 6px',
        outline: 'none'
      },
      '.cm-panel.cm-search button': { cursor: 'pointer' },
      '.cm-panel.cm-search button:hover': { borderColor: accent },
      '.cm-panel.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '3px' },
      '.cm-panel.cm-search [name=close]': { color: muted, fontSize: '16px' },
      '.cm-tooltip': {
        backgroundColor: tooltipBg,
        border: `1px solid ${border}`,
        borderRadius: '6px',
        color: foreground,
        overflow: 'hidden'
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul': {
        fontFamily: 'inherit',
        fontSize: '12.5px',
        maxHeight: '220px'
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px' },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: `${accent}22`,
        color: foreground
      },
      '.cm-completionLabel': { fontSize: '12.5px' },
      '.cm-completionDetail': { color: muted, fontStyle: 'normal', marginLeft: '8px' },
      // 差异视图
      '&.cm-merge-b .cm-changedLine': { backgroundColor: insertedBg },
      '&.cm-merge-b .cm-changedLineGutter, .cm-changeGutter': { backgroundColor: changedGutter },
      '&.cm-merge-b .cm-changedText': {
        background: `linear-gradient(${c.string}55, ${c.string}55) bottom/100% 2px no-repeat`
      },
      '.cm-deletedChunk': {
        backgroundColor: deletedBg,
        paddingLeft: '6px',
        borderTop: `1px solid ${border}`,
        borderBottom: `1px solid ${border}`
      },
      '.cm-deletedChunk .cm-deletedText': {
        background: `linear-gradient(${c.keyword}55, ${c.keyword}55) bottom/100% 2px no-repeat`
      },
      '.cm-deletedLine del': { textDecoration: 'none', opacity: '0.85' },
      /**
       * 逐处取舍按钮（见 utils/cmChunkActions.ts）：画在行号槽 / 改动槽之上，
       * 一处差异一组（保留 ✓ / 撤销 ✕），**只有图标**——与工具条、状态条同一套语言。
       *
       * 之前是 @codemirror/merge 自带的文字按钮，被 `insetInlineEnd: 5px` 塞在删除块内部：
       * 随块滚动、压在正文右端、还是两坨文字。现在由本层接管。
       */
      '.cm-chunkActionLayer': {
        position: 'absolute',
        top: 0,
        bottom: 0,
        // 与改动槽右缘对齐：层过宽会盖住正文的可点区域，过窄按钮会飘到行号上
        insetInlineStart: 0,
        insetInlineEnd: 'calc(100% - 48px)',
        zIndex: 4,
        pointerEvents: 'none',
        userSelect: 'none'
      },
      '.cm-chunkActionGroup': {
        position: 'absolute',
        insetInlineEnd: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        height: 18,
        pointerEvents: 'auto'
      },
      '.cm-chunkAction': {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        padding: 0,
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        background: dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)',
        color: foreground,
        transition: 'background 0.12s, color 0.12s'
      },
      // 悬停才上语义色：平时保持中性，一屏几十处差异时才不会花
      '.cm-chunkAction-accept:hover': { background: insertedBg, color: c.string },
      '.cm-chunkAction-reject:hover': { background: deletedBg, color: c.keyword },
      '.cm-chunkAction:focus-visible': { outline: `1px solid ${accent}`, outlineOffset: 1 },
      '.cm-collapsedLines': {
        color: muted,
        backgroundColor: dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.022)',
        fontSize: '11.5px',
        padding: '3px 10px',
        cursor: 'pointer'
      },
      '.cm-collapsedLines:hover': { color: foreground },
      // 折叠槽里的内联 SVG（remixicon）与行号垂直对齐
      '.cm-foldGutter .cm-gutterElement svg': { display: 'block' }
    },
    { dark }
  )

  return [theme, syntaxHighlighting(editorHighlightStyle(input.dark, foreground))]
}

/**
 * 语法配色（单独导出，便于离线测试用真实组件量「哪些 token 真的上了色」）。
 *
 * 两条必须遵守的规则：
 * 1. **只写具体标签，绝不写 `t.name` / `t.variableName` 这类祖先标签**：
 *    Lezer 的标签集包含祖先（propertyName 的标签集是 [propertyName, name]），
 *    祖先规则会和具体规则一起命中，同优先级下样式表里后者胜——
 *    一条 `t.name → 正文色` 就能把属性名、类型名、类名一起拉回正文色。
 * 2. **没被任何规则命中的 token 根本不会生成 span**（CodeMirror 直接输出纯文本），
 *    所以「看起来没高亮」往往不是颜色错，而是**规则漏了**——Markdown 尤其明显：
 *    标题/行内代码/引用/列表标记漏一条，整篇就是一片墨色。
 */
export function editorHighlightStyle(dark: boolean, foreground: string): HighlightStyle {
  const c = syntaxColors(dark)
  return HighlightStyle.define([
    // ── 通用代码（取值对齐 VS Code Dark+ / Light+）──
    {
      tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.quote],
      color: c.comment
    },
    // 声明类关键字（const/let/function/class/interface/import…）与类型原语：蓝
    { tag: [t.keyword, t.operatorKeyword, t.self, t.unit, t.definitionKeyword], color: c.keyword },
    // 控制流与模块关键字（if/return/await/export/from…）：紫
    { tag: [t.controlKeyword, t.moduleKeyword], color: c.control },
    { tag: [t.string, t.special(t.string), t.character, t.docString], color: c.string },
    { tag: [t.number, t.bool, t.null, t.atom], color: c.number },
    { tag: [t.constant(t.variableName)], color: c.constant },
    {
      tag: [t.typeName, t.className, t.namespace, t.tagName, t.standard(t.variableName)],
      color: c.type
    },
    {
      tag: [
        t.function(t.variableName),
        t.function(t.propertyName),
        t.function(t.definition(t.variableName)),
        t.definition(t.function(t.variableName)),
        t.labelName
      ],
      color: c.func
    },
    { tag: [t.propertyName, t.attributeName, t.definition(t.propertyName)], color: c.prop },
    { tag: [t.variableName], color: c.variable },
    { tag: [t.definition(t.variableName), t.local(t.variableName)], color: c.variable },
    { tag: [t.attributeValue, t.color], color: c.string },
    { tag: [t.operator, t.compareOperator, t.logicOperator, t.arithmeticOperator], color: c.op },
    { tag: [t.punctuation, t.separator, t.bracket], color: c.punct },
    { tag: [t.regexp], color: c.regexp },
    { tag: [t.escape], color: c.escape },
    { tag: [t.meta, t.processingInstruction, t.annotation], color: c.meta },
    { tag: [t.invalid], color: c.invalid },

    // ── Markdown（源码视图）：标题加粗、行内代码用类型青、链接蓝且带下划线 ──
    { tag: [t.heading, t.heading1], color: c.keyword, fontWeight: '700' },
    {
      tag: [t.heading2, t.heading3, t.heading4, t.heading5, t.heading6],
      color: c.keyword,
      fontWeight: '600'
    },
    { tag: [t.strong], color: foreground, fontWeight: '700' },
    { tag: [t.emphasis], fontStyle: 'italic' },
    { tag: [t.strikethrough], textDecoration: 'line-through', opacity: '0.7' },
    { tag: [t.monospace], color: c.type },
    { tag: [t.list], color: c.control },
    { tag: [t.contentSeparator], color: c.meta },
    { tag: [t.link, t.url], color: c.link, textDecoration: 'underline' }
  ])
}
