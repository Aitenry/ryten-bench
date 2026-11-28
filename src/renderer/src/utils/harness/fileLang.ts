import type { Extension } from '@codemirror/state'

/**
 * File path → CodeMirror language extension.
 *
 * Unlike the Monaco era: languages are **loaded dynamically on demand** (one separate chunk per
 * import). The previous monaco chunk was about 6MB, downloaded in full and evaluated on the main
 * thread; now the first screen only ships the editor core, and TypeScript syntax is fetched when
 * a .ts file is opened, Python syntax when a .py file is opened. Load results are cached per
 * language, so opening the same language a second time costs nothing.
 */

/** Language id (for display in the status bar) */
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

/** Extension → language id */
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
  // Languages with no matching syntax package are all rendered as plain text (no half-baked
  // fake highlighting)
  cs: 'plaintext',
  graphql: 'plaintext',
  gql: 'plaintext',
  prisma: 'plaintext',
  lock: 'plaintext',
  log: 'plaintext',
  txt: 'plaintext'
}

/** File name (no extension) → language id */
const NAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  '.gitignore': 'plaintext',
  '.env': 'ini',
  makefile: 'plaintext'
}

/** Get the language id for a path */
export function getLanguageId(filePath: string): string {
  const name = (filePath.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (NAME_LANG[name]) return NAME_LANG[name]
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  return EXT_LANG[ext] ?? 'plaintext'
}

/** Language name for display in the status bar */
export function getLanguageLabel(filePath: string): string {
  return LANG_LABELS[getLanguageId(filePath)] ?? 'Plain Text'
}

/** Language extension loaders (lazy: only languages actually used end up in a downloaded chunk) */
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

/** Loaded-language cache (each language loads only once) */
const cache = new Map<string, Promise<Extension | null>>()

/** Get the language extension for a path (async; unknown languages return null = plain text) */
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
