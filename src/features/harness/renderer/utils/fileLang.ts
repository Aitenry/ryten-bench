import type { Extension } from '@codemirror/state'

/**
 * 文件路径 → CodeMirror 语言扩展。
 *
 * 与 Monaco 时代的区别：语言**按需动态加载**（每个 import 一个独立 chunk）。
 * 之前的 monaco chunk 约 6MB，一次全量下载并在主线程求值；现在首屏只有编辑器内核，
 * 打开 .ts 才去取 TypeScript 语法，打开 .py 才去取 Python 语法。
 * 加载结果按语言缓存，同一个语言第二次打开零开销。
 */

/** 语言标识（状态栏展示用） */
const LANG_LABELS: Record<string, string> = {
  plaintext: 'Plain Text',
  javascript: 'JavaScript',
  jsx: 'JSX',
  typescript: 'TypeScript',
  tsx: 'TSX',
  json: 'JSON',
  html: 'HTML',
  vue: 'Vue',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  markdown: 'Markdown',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  cpp: 'C/C++',
  ruby: 'Ruby',
  php: 'PHP',
  sql: 'SQL',
  shell: 'Shell',
  powershell: 'PowerShell',
  yaml: 'YAML',
  toml: 'TOML',
  ini: 'INI',
  xml: 'XML',
  dockerfile: 'Dockerfile'
}

/** 扩展名 → 语言标识 */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  py: 'python',
  pyw: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'cpp',
  h: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  rb: 'ruby',
  php: 'php',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  env: 'ini',
  xml: 'xml',
  svg: 'xml',
  plist: 'xml',
  dockerfile: 'dockerfile',
  // 暂无对应语法包的语言一律按纯文本渲染（不做半吊子的假高亮）
  cs: 'plaintext',
  graphql: 'plaintext',
  gql: 'plaintext',
  prisma: 'plaintext',
  lock: 'plaintext',
  log: 'plaintext',
  txt: 'plaintext'
}

/** 文件名（无扩展名）→ 语言标识 */
const NAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  '.gitignore': 'plaintext',
  '.env': 'ini',
  makefile: 'plaintext'
}

/** 取路径的语言标识 */
export function getLanguageId(filePath: string): string {
  const name = (filePath.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (NAME_LANG[name]) return NAME_LANG[name]
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  return EXT_LANG[ext] ?? 'plaintext'
}

/** 状态栏展示的语言名 */
export function getLanguageLabel(filePath: string): string {
  return LANG_LABELS[getLanguageId(filePath)] ?? 'Plain Text'
}

/** 语言扩展加载器（惰性：只有真正用到的语言才会被打包进下载的 chunk） */
const LOADERS: Record<string, () => Promise<Extension | null>> = {
  plaintext: async () => null,
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript(),
  jsx: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  typescript: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  tsx: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }),
  json: async () => (await import('@codemirror/lang-json')).json(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  vue: async () => (await import('@codemirror/lang-vue')).vue(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  scss: async () => {
    const [{ StreamLanguage }, { sCSS }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/css')
    ])
    return StreamLanguage.define(sCSS)
  },
  less: async () => {
    const [{ StreamLanguage }, { less }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/css')
    ])
    return StreamLanguage.define(less)
  },
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  php: async () => (await import('@codemirror/lang-php')).php(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  ruby: async () => {
    const [{ StreamLanguage }, { ruby }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/ruby')
    ])
    return StreamLanguage.define(ruby)
  },
  shell: async () => {
    const [{ StreamLanguage }, { shell }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/shell')
    ])
    return StreamLanguage.define(shell)
  },
  powershell: async () => {
    const [{ StreamLanguage }, { powerShell }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/powershell')
    ])
    return StreamLanguage.define(powerShell)
  },
  toml: async () => {
    const [{ StreamLanguage }, { toml }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/toml')
    ])
    return StreamLanguage.define(toml)
  },
  ini: async () => {
    const [{ StreamLanguage }, { properties }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/properties')
    ])
    return StreamLanguage.define(properties)
  },
  dockerfile: async () => {
    const [{ StreamLanguage }, { dockerFile }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/dockerfile')
    ])
    return StreamLanguage.define(dockerFile)
  }
}

/** 已加载语言缓存（同一语言只加载一次） */
const cache = new Map<string, Promise<Extension | null>>()

/** 取某路径对应语言扩展（异步；未知语言返回 null = 纯文本） */
export function loadLanguageExtension(filePath: string): Promise<Extension | null> {
  const id = getLanguageId(filePath)
  const loader = LOADERS[id]
  if (!loader) return Promise.resolve(null)
  let pending = cache.get(id)
  if (!pending) {
    pending = loader().catch(() => null)
    cache.set(id, pending)
  }
  return pending
}
