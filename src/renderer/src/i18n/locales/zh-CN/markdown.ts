/* 「markdown」模块词条（编辑器 / 只读预览 / 斜杠菜单 / Mermaid / 数学公式）。
   命名约定：t('markdown.<group>.<key>')，键名一律 camelCase，不写中文。
   键名对应源代码里的字面量键联合类型（slash-menu.ts / TipTapMarkdownEditor.tsx），
   改名时须同步收窄类型，否则 t() 编译报错。 */
export const zhCNMarkdown = {
  editor: {
    placeholder: '输入内容，支持 Markdown 语法（# 标题、**加粗**、- 列表、``` 代码块…）',
    /* <mono> 只包数字：等宽族缺中文字形，中文落进去会回退成宋体 */
    charCount_one: '<mono>{{count}}</mono> 字',
    charCount_other: '<mono>{{count}}</mono> 字',
    linkPlaceholder: '粘贴链接地址（留空则移除链接）'
  },
  toolbar: {
    undo: '撤销',
    redo: '重做',
    paragraph: '正文',
    heading1: '标题 1',
    heading2: '标题 2',
    heading3: '标题 3',
    heading4: '标题 4',
    bold: '加粗 Ctrl+B',
    italic: '斜体 Ctrl+I',
    underline: '下划线 Ctrl+U',
    strike: '删除线',
    inlineCode: '行内代码',
    highlight: '高亮',
    link: '链接 Ctrl+K',
    unlink: '移除链接',
    blockquote: '引用',
    bulletList: '无序列表',
    orderedList: '有序列表',
    taskList: '任务列表',
    codeBlock: '代码块',
    horizontalRule: '分割线',
    boldShort: '加粗',
    italicShort: '斜体',
    underlineShort: '下划线',
    clearFormat: '清除格式'
  },
  toc: {
    title: '目录'
  },
  search: {
    placeholder: '搜索...'
  },
  copy: {
    copied: '已复制',
    code: '复制代码',
    clickToCopy: '点击复制'
  },
  slash: {
    noMatch: '无匹配块',
    footer: '↑↓ 选择 · Enter 插入 · Esc 关闭',
    paragraph: '正文',
    paragraphDescription: '普通文本段落',
    heading1: '标题 1',
    heading1Description: '一级标题',
    heading2: '标题 2',
    heading2Description: '二级标题',
    heading3: '标题 3',
    heading3Description: '三级标题',
    bulletList: '无序列表',
    bulletListDescription: '• 项目符号列表',
    orderedList: '有序列表',
    orderedListDescription: '1. 编号列表',
    taskList: '任务列表',
    taskListDescription: '☑ 待办复选框',
    blockquote: '引用',
    blockquoteDescription: '> 引用块',
    codeBlock: '代码块',
    codeBlockDescription: '``` 语法高亮代码',
    inlineMath: '公式',
    inlineMathDescription: '$…$ 行内 LaTeX 公式',
    blockMath: '块级公式',
    blockMathDescription: '$$…$$ 独立 LaTeX 公式块',
    mermaid: '图表',
    mermaidDescription: 'Mermaid 流程图 / 时序图 / 甘特图',
    /* 插入到文档里的起始模板，跟随界面语言 */
    mermaidTemplate: 'graph TD\n  A[开始] --> B[结束]',
    table: '表格',
    tableDescription: '3×3 表格（含表头）',
    horizontalRule: '分割线',
    horizontalRuleDescription: '--- 水平分割线',
    /* 斜杠菜单检索词（空格分隔）：属界面词条，随语言切换 */
    keywords: {
      paragraph: '正文 文本 text paragraph',
      heading1: '标题1 标题一 h1 heading heading1 title',
      heading2: '标题2 标题二 h2 heading heading2 title',
      heading3: '标题3 标题三 h3 heading heading3 title',
      bulletList: '列表 无序 ul bullet list unordered point',
      orderedList: '列表 有序 ol ordered list numbered number',
      taskList: '任务 待办 todo task check checkbox checklist',
      blockquote: '引用 quote blockquote quotation',
      codeBlock: '代码 代码块 code block snippet fence',
      inlineMath: '公式 数学 行内 math latex katex formula inline',
      blockMath: '公式 数学 块级 math latex katex formula equation',
      mermaid: '图表 图 流程图 mermaid diagram flow chart sequence gantt',
      table: '表格 table grid cell',
      horizontalRule: '分割线 水平线 hr divider rule separator'
    }
  },
  mermaid: {
    label: 'Mermaid',
    editSource: '编辑源码',
    backToDiagram: '返回图表',
    centerCanvas: '居中画布',
    fullscreen: '全屏窗口预览',
    errorWithReason: '图表语法错误：{{reason}}',
    empty: '（空图表，点击「编辑源码」输入 Mermaid 语法）',
    placeholder: '输入 Mermaid 语法（如 graph TD; A --> B）',
    loading: '图表渲染中…'
  },
  math: {
    placeholder: '输入 LaTeX 公式，回车完成'
  }
}
