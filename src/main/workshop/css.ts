import * as fs from 'fs'
import * as path from 'path'

/**
 * Generation of the plugin stylesheet (`plugin.css`) and its coverage check.
 *
 * Why this exists (the 2026-09-26 incident): the host's own Tailwind is generated at **build
 * time** by scanning host sources, so plugin sources installed at runtime are out of that scan
 * range, and nearly 40% of the class names used by plugins had no rule at all in the host CSS —
 * the UI broke outright. The contract is therefore "each plugin ships its own plugin.css", and
 * the workshop automates it in two steps:
 *
 * 1. **Generate** (`auto` mode): scan the draft sources for class names and use Tailwind's
 *    **JS compile API** (the `tailwindcss` package exports `compile`; pure JS, no oxide native
 *    scanner) to emit the theme + utilities layers without preflight — the equivalent of doing
 *    it by hand;
 * 2. **Check**: look up every class name used in `className` positions against the final CSS and
 *    put the missing ones in the acceptance report (`style.coverage`). Typos and dynamically
 *    concatenated names that cannot be scanned get named there as well.
 *
 * The two candidate kinds must stay separate (a hard-learned lesson):
 * - **strict (className positions)**: `className="p-4 flex"`,
 *   `className={cn('mt-2', x && 'hidden')}` — these must really have rules; one missing rule is
 *   one missing style;
 * - **loose (other string literals)**: only used to **feed Tailwind generation** (so indirect
 *   forms like `const cls = 'flex p-2'` can be compiled), **not part of the coverage check** —
 *   otherwise strings like `useState` or `plugin:demo:state-get` would be reported as missing
 *   class names and drown the report.
 */

/** Tailwind entry: only the theme + utilities layers (no preflight, so injecting into the host document does not reset host styles) */
const TAILWIND_ENTRY =
  '@import "tailwindcss/theme" layer(theme);\n@import "tailwindcss/utilities" layer(utilities);\n'

/** Known Tailwind variant prefixes (decides whether candidates like `hover:bg-red-500` are plausible) */
const VARIANT_PREFIXES = new Set([
  'hover',
  'focus',
  'focus-visible',
  'focus-within',
  'active',
  'visited',
  'disabled',
  'checked',
  'first',
  'last',
  'odd',
  'even',
  'group',
  'peer',
  'dark',
  'light',
  'sm',
  'md',
  'lg',
  'xl',
  '2xl',
  'motion-safe',
  'motion-reduce',
  'print',
  'rtl',
  'ltr',
  'before',
  'after',
  'placeholder',
  'selection',
  'file',
  'open'
])

/** Shape constraint for a single candidate */
const TOKEN_RE = /^[A-Za-z0-9!@%_:\-./[\]()#,>+~*=&$]+$/

/**
 * Whether a candidate "looks like a Tailwind class name".
 *
 * This filter only serves generation (loose candidates) and the final fallback filtering:
 * - exclude URLs / paths / regexes / CJK text / long sentences;
 * - anything containing `:` must be a known variant chain (channel names like
 *   `plugin:demo:state-set` must be excluded).
 */
export function looksLikeClassName(token: string): boolean {
  if (token.length < 2 || token.length > 64) return false
  if (!TOKEN_RE.test(token)) return false
  if (/^https?:|^data:|^plugin:|^blob:|^file:/.test(token)) return false
  if (token.includes('//') || token.includes('\\')) return false
  const segments = token.split(':')
  if (segments.length > 1) {
    // The last segment is the utility; every preceding segment must be a known variant
    // (combinations such as hover:focus are allowed)
    const prefixes = segments.slice(0, -1)
    if (!prefixes.every((p) => VARIANT_PREFIXES.has(p) || p === '')) return false
  }
  if (/^[A-Z]/.test(token)) return false // Component / type names
  if (/^[a-z]+[A-Z]/.test(token)) return false // camelCase identifiers
  return true
}

/** Split a class-name text into candidates (whitespace-separated, filtered token by token) */
function splitTokens(text: string, into: Set<string>): void {
  for (const token of text.split(/\s+/)) {
    if (looksLikeClassName(token)) into.add(token)
  }
}

/** Contents of string literals (for generation: indirect forms must be scannable too) */
function literalContents(source: string): string[] {
  const out: string[] = []
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const body = match[2]
    if (body && body.length <= 400) out.push(body)
  }
  return out
}

/**
 * Literals in `className` / `class` positions (used for the coverage check).
 *
 * All three forms are collected: `className="a b"`, `className={'a b'}`,
 * `className={cn('a', x && 'b')}` — for the last one the whole expression is taken by matching
 * braces, then the string literals inside are extracted.
 */
function classNameExpressions(source: string): string[] {
  const out: string[] = []
  const attrRe = /\bclass(?:Name)?\s*=\s*/g
  while (attrRe.exec(source) !== null) {
    const index = attrRe.lastIndex
    const quote = source[index]
    if (quote === '"' || quote === "'") {
      const end = source.indexOf(quote, index + 1)
      if (end > 0) {
        out.push(source.slice(index + 1, end))
        attrRe.lastIndex = end + 1
      }
      continue
    }
    if (quote !== '{') continue
    // Take the whole expression by matching braces (nesting and backticks in template literals
    // are allowed)
    let depth = 0
    let cursor = index
    while (cursor < source.length) {
      const ch = source[cursor]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) break
      }
      cursor += 1
    }
    const expr = source.slice(index + 1, cursor)
    for (const literal of literalContents(expr)) out.push(literal)
    attrRe.lastIndex = cursor + 1
  }
  return out
}

/** Extract both kinds of candidates from one source file */
export function extractCandidates(source: string): { strict: string[]; loose: string[] } {
  const strict = new Set<string>()
  const loose = new Set<string>()
  for (const expr of classNameExpressions(source)) splitTokens(expr, strict)
  for (const literal of literalContents(source)) splitTokens(literal, loose)
  // strict members are also generation inputs, so drop duplicates from loose
  for (const token of strict) loose.delete(token)
  return { strict: [...strict], loose: [...loose] }
}

/** Scan draft sources (ts/tsx/js/jsx/mjs/cjs/html under renderer/** and main/**) and accumulate both candidate kinds */
export function scanDraftCandidates(draftDir: string): { strict: string[]; all: string[] } {
  const strict = new Set<string>()
  const loose = new Set<string>()
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist'].includes(entry.name)) continue
        walk(full, nextRel)
        continue
      }
      if (!/\.(tsx?|jsx?|mjs|cjs|html)$/.test(entry.name)) continue
      try {
        const found = extractCandidates(fs.readFileSync(full, 'utf-8'))
        for (const token of found.strict) strict.add(token)
        for (const token of found.loose) loose.add(token)
      } catch {
        // Skip unreadable files (does not affect the build)
      }
    }
  }
  walk(draftDir, '')
  return { strict: [...strict], all: [...new Set([...strict, ...loose])] }
}

/** Class names must be escaped in CSS (`w-[280px]` → `.w-\[280px\]`, `hover:scale-105` → `.hover\:scale-105`) */
export function cssEscapeClass(className: string): string {
  return className.replace(/[^A-Za-z0-9_-]/g, (ch) => `\\${ch}`)
}

/** Whether the CSS has a rule for this class (escaped selector followed by a non-class-name char, so `.flex` does not match `.flex-1`) */
export function cssHasRule(css: string, className: string): boolean {
  const selector = `.${cssEscapeClass(className)}`
  let index = css.indexOf(selector)
  while (index >= 0) {
    const after = css[index + selector.length]
    if (after === undefined) return true
    if (!/[A-Za-z0-9_-]/.test(after)) return true
    index = css.indexOf(selector, index + 1)
  }
  return false
}

/** Class names among the strict candidates that have no rule (at most `limit` entries, so the report is not stuffed with hundreds of names) */
export function missingClasses(css: string, strict: string[], limit = 24): string[] {
  const missing: string[] = []
  for (const candidate of [...strict].sort((a, b) => a.localeCompare(b, 'en'))) {
    if (cssHasRule(css, candidate)) continue
    missing.push(candidate)
    if (missing.length >= limit) break
  }
  return missing
}

/**
 * Module loader (injected by the service).
 *
 * Why injection instead of a local `import`: the build needs esbuild and styles need
 * tailwindcss; neither should be statically bundled into the plugin package, and **offline
 * tooling must be able to use the copy in the repo**. `resolve` is used for subpath stylesheets
 * inside Tailwind such as `tailwindcss/theme`.
 */
export interface ModuleLoader {
  require: (id: string) => unknown
  resolve: (id: string) => string
}

/** Tailwind compiler handle (lazily loaded: report a readable error when unavailable, letting the caller degrade) */
type TailwindCompiler = { build: (candidates: string[]) => string }

/**
 * Compile the plugin stylesheet with Tailwind's JS API.
 *
 * Key point: **we supply the candidates ourselves** (`build(candidates)`), so Tailwind's file
 * scanning is never triggered — `@tailwindcss/oxide` (a native module) may not be available in
 * the packaged app, and this path does not need it.
 */
export async function compilePluginCss(
  candidates: string[],
  loader: ModuleLoader,
  baseDir: string
): Promise<string> {
  if (candidates.length === 0) return ''
  const tailwind = loader.require('tailwindcss') as {
    compile?: (
      css: string,
      opts: {
        base: string
        loadStylesheet: (
          id: string,
          base: string
        ) => Promise<{ path: string; base: string; content: string }>
        loadModule?: (id: string, base: string) => Promise<{ base: string; module: unknown }>
      }
    ) => Promise<TailwindCompiler>
  }
  if (!tailwind || typeof tailwind.compile !== 'function') {
    throw new Error('tailwindcss 的 JS 编译 API 不可用（compile 缺失）')
  }

  const compiler = await tailwind.compile(TAILWIND_ENTRY, {
    base: baseDir,
    loadStylesheet: async (id) => {
      const resolved = resolveTailwindCss(id, loader)
      return {
        path: resolved,
        base: path.dirname(resolved),
        content: fs.readFileSync(resolved, 'utf-8')
      }
    },
    loadModule: async (id) => ({ base: baseDir, module: loader.require(id) })
  })
  return compiler.build(candidates)
}

/** Resolve Tailwind's internal stylesheet imports (`tailwindcss/theme`, `tailwindcss/utilities`) */
function resolveTailwindCss(id: string, loader: ModuleLoader): string {
  for (const candidate of [id, `${id}/index.css`, `${id}.css`]) {
    try {
      return loader.resolve(candidate)
    } catch {
      // Try the next candidate
    }
  }
  throw new Error(`找不到 Tailwind 内部样式表：${id}`)
}
