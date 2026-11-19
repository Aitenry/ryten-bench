import type { zhCNMarkdown } from '../zh-CN/markdown'

export const enUSMarkdown: typeof zhCNMarkdown = {
  editor: {
    placeholder: 'Type here — Markdown is supported (# heading, **bold**, - list, ``` code block…)',
    charCount_one: '<mono>{{count}}</mono> characters',
    charCount_other: '<mono>{{count}}</mono> characters',
    linkPlaceholder: 'Paste a link address (leave empty to remove the link)'
  },
  toolbar: {
    undo: 'Undo',
    redo: 'Redo',
    paragraph: 'Paragraph',
    heading1: 'Heading 1',
    heading2: 'Heading 2',
    heading3: 'Heading 3',
    heading4: 'Heading 4',
    bold: 'Bold Ctrl+B',
    italic: 'Italic Ctrl+I',
    underline: 'Underline Ctrl+U',
    strike: 'Strikethrough',
    inlineCode: 'Inline code',
    highlight: 'Highlight',
    link: 'Link Ctrl+K',
    unlink: 'Remove link',
    blockquote: 'Blockquote',
    bulletList: 'Bullet list',
    orderedList: 'Numbered list',
    taskList: 'Task list',
    codeBlock: 'Code block',
    horizontalRule: 'Divider',
    boldShort: 'Bold',
    italicShort: 'Italic',
    underlineShort: 'Underline',
    clearFormat: 'Clear formatting'
  },
  toc: {
    title: 'Contents'
  },
  search: {
    placeholder: 'Search...'
  },
  copy: {
    copied: 'Copied',
    code: 'Copy code',
    clickToCopy: 'Click to copy'
  },
  slash: {
    noMatch: 'No matching block',
    footer: '↑↓ select · Enter insert · Esc close',
    paragraph: 'Paragraph',
    paragraphDescription: 'Plain text paragraph',
    heading1: 'Heading 1',
    heading1Description: 'Top-level heading',
    heading2: 'Heading 2',
    heading2Description: 'Second-level heading',
    heading3: 'Heading 3',
    heading3Description: 'Third-level heading',
    bulletList: 'Bullet list',
    bulletListDescription: '• Bulleted list',
    orderedList: 'Numbered list',
    orderedListDescription: '1. Numbered list',
    taskList: 'Task list',
    taskListDescription: '☑ To-do checkboxes',
    blockquote: 'Blockquote',
    blockquoteDescription: '> Quoted block',
    codeBlock: 'Code block',
    codeBlockDescription: '``` Syntax-highlighted code',
    inlineMath: 'Formula',
    inlineMathDescription: '$…$ inline LaTeX formula',
    blockMath: 'Block formula',
    blockMathDescription: '$$…$$ standalone LaTeX formula block',
    mermaid: 'Diagram',
    mermaidDescription: 'Mermaid flowchart / sequence / gantt',
    mermaidTemplate: 'graph TD\n  A[Start] --> B[End]',
    table: 'Table',
    tableDescription: '3×3 table (with header row)',
    horizontalRule: 'Divider',
    horizontalRuleDescription: '--- horizontal divider',
    keywords: {
      paragraph: 'paragraph text plain',
      heading1: 'heading1 heading h1 title',
      heading2: 'heading2 heading h2 title',
      heading3: 'heading3 heading h3 title',
      bulletList: 'bullet list unordered point',
      orderedList: 'ordered list numbered number',
      taskList: 'todo task check checkbox checklist',
      blockquote: 'quote blockquote quotation',
      codeBlock: 'code block snippet fence',
      inlineMath: 'math latex katex formula inline',
      blockMath: 'math latex katex formula equation block',
      mermaid: 'diagram flow chart sequence gantt',
      table: 'table grid cell',
      horizontalRule: 'hr divider rule separator'
    }
  },
  mermaid: {
    label: 'Mermaid',
    editSource: 'Edit source',
    backToDiagram: 'Back to diagram',
    centerCanvas: 'Center canvas',
    fullscreen: 'Preview fullscreen',
    errorWithReason: 'Diagram syntax error: {{reason}}',
    empty: '(Empty diagram — click "Edit source" to enter Mermaid syntax)',
    placeholder: 'Enter Mermaid syntax (e.g. graph TD; A --> B)',
    loading: 'Rendering diagram…'
  },
  math: {
    placeholder: 'Enter a LaTeX formula, press Enter to finish'
  }
}
