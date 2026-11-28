/**
 * **Host protection** for plugin stylesheets (pure functions shared by all three sides; no DOM / node imports).
 *
 * Why it is needed: a plugin bundle's `plugin.css` is injected into the host's `<head>`
 * **as-is** (see `renderer/src/plugin-host/plugin-css.ts`), so its selectors apply to the whole
 * document, not just the plugin's own UI. A single `body { display: none }` or
 * `* { box-sizing: content-box }` can break the entire app — the most direct, and also the least
 * malicious, path by which a plugin can affect how the system runs.
 *
 * What gets blocked (only rules that "cannot spill over into the host shell" pass):
 * - `html` / `body` / `#root`: the document root and mount point; a plugin has no reason to change them;
 * - `*`: global reset, which not even Tailwind produces for a plugin;
 * - `.custom-frame` / `.frame-*` / `.custom-scrollbar` / `.ant-app`: the host shell's own class names;
 * - `:root`: **custom properties only** are allowed through (Tailwind's theme layer is
 *   `:root { --color-… }`); rules that smuggle in real declarations such as `display` or
 *   `font-size` are dropped entirely.
 *
 * Why not "scope all rules to the plugin root node": plugin antd modals/dropdowns are portaled
 * into `document.body`, and after scoping those floating layers would lose all styling (real
 * plugins do use Modal). So only rules that clearly touch the host are cut here and the rest are
 * kept as-is; together with the verify check `safety.scan`, this runtime gate forms two layers
 * of protection.
 *
 * In the return value, `dropped` holds the original selector text for humans — a warn log is
 * emitted at runtime and the verify report names them too (so the model can remove these rules,
 * rather than waiting for users to notice a broken UI).
 *
 * Idempotent: running it again on already-sanitised CSS gives the same result; when nothing
 * matches, the output is byte-identical to the input.
 */

export interface PluginCssAudit {
  /** Sanitised CSS */
  css: string
  /** Dropped rules (original selector text, deduplicated) */
  dropped: string[]
  /** Removed @import statements */
  imports: string[]
}

/** Whether the selector targets the document root (html / body) */
const HTML_BODY = /(^|[\s,>+~(])(?:html|body)(?=$|[\s,>+~.:#[\]])/i
/** Whether the selector targets the React mount point */
const ROOT_ID = /(^|[\s,>+~(])#root(?=$|[\s,>+~.:#[])/
/** Whether the selector targets the host shell's own class names */
const HOST_FRAME =
  /(^|[\s,>+~(])\.(?:custom-frame|custom-scrollbar|frame-[a-z0-9-]+|ant-app)(?=$|[\s,>+~.:#[])/
/** Whether the selector overrides global component styles of the host framework (antd) */
const HOST_ANTD = /(^|[\s,>+~(])\.ant-[a-z0-9-]+/
/** Bare universal selector */
const UNIVERSAL = /(^|[\s,>+~(])\*(?=$|[\s,>+~.:#[])/
/** :root selector */
const ROOT_PSEUDO = /(^|[\s,>+~(]):root(?=$|[\s,>+~.:#[])/
/** One custom-property declaration (`--foo: …`) */
const CUSTOM_PROPERTY = /^\s*--[A-Za-z0-9_-]+\s*:/

/** At-rules whose body may contain ordinary rules (need recursive sanitising) */
const GROUPING_AT_RULES = new Set([
  'media',
  'supports',
  'layer',
  'container',
  'scope',
  'document',
  'starting-style'
])

/** Skip a string literal (returns the position after the closing quote) */
function skipString(css: string, start: number): number {
  const quote = css[start]
  let i = start + 1
  while (i < css.length) {
    if (css[i] === '\\') {
      i += 2
      continue
    }
    if (css[i] === quote) return i + 1
    i += 1
  }
  return css.length
}

/** Find the matching `}` (skipping comments/strings/nested blocks) and return the position after it */
function matchBrace(css: string, open: number): number {
  let depth = 0
  let i = open
  while (i < css.length) {
    const ch = css[i]
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2)
      i = close === -1 ? css.length : close + 2
      continue
    }
    if (ch === '"' || ch === "'") {
      i = skipString(css, i)
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
    i += 1
  }
  return css.length
}

/** Whether the block body contains only custom properties (Tailwind theme layer) */
function onlyCustomProperties(body: string): boolean {
  let seen = false
  for (const declaration of body.split(';')) {
    const text = declaration.trim()
    if (text === '') continue
    if (!CUSTOM_PROPERTY.test(text)) return false
    seen = true
  }
  return seen
}

/** Whether this rule would spill over into the host shell */
function hitsHost(selector: string, body: string): boolean {
  if (HTML_BODY.test(selector)) return true
  if (ROOT_ID.test(selector)) return true
  if (HOST_FRAME.test(selector)) return true
  if (HOST_ANTD.test(selector)) return true
  // `*` is allowed in one form: "variables only". Tailwind's properties layer is
  // `*,:before,:after,::backdrop { --tw-translate-x: 0; … }` (present in real plugin bundles).
  // Universal rules that smuggle in real declarations such as display are a global reset: drop them.
  if (UNIVERSAL.test(selector) && !onlyCustomProperties(body)) return true
  // :root may only hold variables (Tailwind theme); real declarations make it global styling
  if (ROOT_PSEUDO.test(selector) && !onlyCustomProperties(body)) return true
  return false
}

/**
 * Sanitise a CSS fragment (recursing into the bodies of grouping at-rules such as @media / @layer).
 */
function sanitizeFragment(css: string): PluginCssAudit {
  let out = ''
  let cursor = 0
  let segmentStart = 0
  let i = 0
  const dropped: string[] = []
  const imports: string[] = []

  /** Drop [start, end) (including preceding whitespace) by skipping it in the output stream */
  const drop = (start: number, end: number): void => {
    let from = start
    while (from > cursor && /\s/.test(css[from - 1])) from -= 1
    out += css.slice(cursor, from)
    cursor = Math.max(cursor, end)
  }

  while (i < css.length) {
    const ch = css[i]
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2)
      i = close === -1 ? css.length : close + 2
      continue
    }
    if (ch === '"' || ch === "'") {
      i = skipString(css, i)
      continue
    }
    if (ch === '{') {
      const prelude = css.slice(segmentStart, i).trim()
      const end = matchBrace(css, i)
      if (prelude.startsWith('@')) {
        const name = (/^@([a-zA-Z-]+)/.exec(prelude)?.[1] ?? '').toLowerCase()
        if (GROUPING_AT_RULES.has(name)) {
          const body = css.slice(i + 1, Math.max(i + 1, end - 1))
          const inner = sanitizeFragment(body)
          dropped.push(...inner.dropped)
          imports.push(...inner.imports)
          if (inner.css !== body) {
            out += css.slice(cursor, i + 1) + inner.css + '}'
            cursor = end
          }
        }
      } else {
        const body = css.slice(i + 1, Math.max(i + 1, end - 1))
        if (hitsHost(prelude, body)) {
          drop(segmentStart, end)
          dropped.push(prelude.replace(/\s+/g, ' '))
        }
      }
      i = end
      segmentStart = end
      continue
    }
    if (ch === ';') {
      const statement = css.slice(segmentStart, i + 1).trim()
      if (statement.startsWith('@import')) {
        drop(segmentStart, i + 1)
        imports.push(statement)
      }
      i += 1
      segmentStart = i
      continue
    }
    i += 1
  }

  out += css.slice(cursor)
  return { css: out, dropped, imports }
}

/** Sanitise a plugin stylesheet (idempotent for the same CSS) */
export function sanitizePluginCss(css: string): PluginCssAudit {
  if (typeof css !== 'string' || css.trim() === '') {
    return { css: typeof css === 'string' ? css : '', dropped: [], imports: [] }
  }
  const result = sanitizeFragment(css)
  return {
    // Dropping rules may leave blank lines: collapse them so the package has no big gaps
    css: result.css.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n'),
    dropped: [...new Set(result.dropped)],
    imports: [...new Set(result.imports)]
  }
}
