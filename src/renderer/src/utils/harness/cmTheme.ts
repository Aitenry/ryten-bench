import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

/**
 * Editor theme (light / dark).
 *
 * Syntax palette follows VS Code Dark+ / Light+ official values: keyword blue `#569CD6`,
 * control-flow purple `#C586C0`, type teal `#4EC9B0`, function yellow `#DCDCAA`, variable /
 * property light blue `#9CDCFE`, string orange `#CE9178`, number light green `#B5CEA8`, comment
 * green `#6A9955`. The chrome (tabs, line-number gutter, scrollbar) uses the same values, while
 * the base colors still follow the app theme tokens.
 */

export interface EditorPaletteInput {
  dark: boolean
  /** Editor background (= panel background, so it blends seamlessly with the tab bar) */
  background: string
  /** Body text color */
  foreground: string
  /** Secondary text (line numbers, placeholders) */
  muted: string
  /** Separator line */
  border: string
  /** Accent color (cursor / active line number / selected completion) */
  accent: string
}

/** Syntax highlight palette (VS Code Dark+ / Light+) */
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

/** Theme extension: editor chrome + diff view + search panel + autocomplete popup */
export function editorTheme(input: EditorPaletteInput): Extension {
  const c = syntaxColors(input.dark)
  const { dark, background, foreground, muted, border, accent } = input

  const activeLine = dark ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.028)'
  const selection = dark ? 'rgba(122,170,255,0.24)' : 'rgba(80,130,220,0.18)'
  const selectionMatch = dark ? 'rgba(217,176,106,0.22)' : 'rgba(217,176,106,0.34)'
  const searchMatch = dark ? 'rgba(224,138,112,0.28)' : 'rgba(224,138,112,0.3)'
  /** Gutter shares the body background (VS Code's gutter has no separator line and no background difference) */
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
      // Native scrollbars are hidden: EditorScrollbars draws floating ones above the content
      // area instead (VS Code look). A native scrollbar takes 10px of width and looks like
      // "another gutter outside the editor" — exactly what users reported across two rounds of
      // feedback. Wheel/keyboard/touchpad still scroll natively; only the painting is hidden.
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
      // Panel (search/replace) and popups
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
      // Diff view
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
       * Per-chunk accept/reject buttons (see utils/cmChunkActions.ts): drawn above the
       * line-number / change gutter, one group per diff chunk (keep ✓ / revert ✕), **icons
       * only** — the same language as the toolbar and status bar.
       *
       * They used to be @codemirror/merge's built-in text buttons, squeezed inside the deleted
       * block via `insetInlineEnd: 5px`: scrolling with the block, covering the right edge of
       * the body text, and still two lumps of text. This layer now owns them.
       */
      '.cm-chunkActionLayer': {
        position: 'absolute',
        top: 0,
        bottom: 0,
        // Align with the right edge of the change gutter: too wide a layer covers the clickable
        // body area, too narrow and the buttons drift onto the line numbers
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
      // Semantic colors only on hover: neutral at rest, so dozens of diffs on one screen don't
      // look busy
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
      // Inline SVG (remixicon) in the fold gutter, vertically aligned with line numbers
      '.cm-foldGutter .cm-gutterElement svg': { display: 'block' }
    },
    { dark }
  )

  return [theme, syntaxHighlighting(editorHighlightStyle(input.dark, foreground))]
}

/**
 * Syntax colors (exported separately so offline tests can measure with real components which
 * tokens actually get colored).
 *
 * Two rules that must be followed:
 * 1. **Only write concrete tags, never ancestor tags like `t.name` / `t.variableName`**: Lezer
 *    tag sets include ancestors (propertyName's tag set is [propertyName, name]), so an ancestor
 *    rule fires together with the concrete rule; at equal priority the later one in the
 *    stylesheet wins — a single `t.name → body color` rule pulls property names, type names and
 *    class names back to body color.
 * 2. **Tokens matched by no rule never produce a span at all** (CodeMirror just outputs plain
 *    text), so "looks unhighlighted" is often not a wrong color but a **missing rule**:
 *    Markdown especially — miss one rule for headings/inline code/quotes/list markers and the
 *    whole document is a sea of ink.
 */
export function editorHighlightStyle(dark: boolean, foreground: string): HighlightStyle {
  const c = syntaxColors(dark)
  return HighlightStyle.define([
    // ── General code (values follow VS Code Dark+ / Light+) ──
    {
      tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.quote],
      color: c.comment
    },
    // Declaration keywords (const/let/function/class/interface/import…) and type primitives: blue
    { tag: [t.keyword, t.operatorKeyword, t.self, t.unit, t.definitionKeyword], color: c.keyword },
    // Control-flow and module keywords (if/return/await/export/from…): purple
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

    // ── Markdown (source view): headings bold, inline code type teal, links blue and underlined ──
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
