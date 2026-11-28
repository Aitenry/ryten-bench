/**
 * Pure build logic for the Mermaid preview page HTML (no electron / filesystem dependency, testable
 * offline).
 *
 * Security background (audit S07): the preview window loads a `data:text/html` page with the full
 * preload attached (sandbox:false) — any script in the page can reach `window.api`. The previous
 * implementation pasted the renderer-supplied SVG into the HTML verbatim and had no CSP. Here:
 * - the SVG is sanitized (script / foreignObject / inline handlers / javascript: links removed);
 * - a random nonce is generated per build and applied only to the template's own inline scripts,
 *   which CSP `script-src 'nonce-…'` then allows — injected content cannot execute even if it
 *   carries a script.
 */
import { randomBytes } from 'node:crypto'

/** Sanitize the SVG embedded in the preview page (mermaid strict mode should already be safe; this is defence in depth) */
export function sanitizeSvgForPreview(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href|src)\s*=\s*("|')?\s*javascript:/gi, '$1=$2#')
}

/**
 * Inject the SVG and the i18n strings into the preview template, adding a nonce + CSP.
 *
 * @param templateHtml HTML template of the preview window (contains the
 *   `<!-- __MERMAID_SVG__ -->` and `<!-- __MERMAID_I18N__ -->` placeholders)
 * @param svg          SVG text sent by the renderer
 * @param i18n         String object for the preview window (injected as JSON verbatim)
 */
export function buildMermaidPreviewHtml(
  templateHtml: string,
  svg: string,
  i18n: Record<string, unknown>
): string {
  const nonce = randomBytes(16).toString('base64')
  const i18nJson = JSON.stringify(i18n).replace(/</g, '\\u003c')
  // Replace via a function so `$` characters in the svg do not trigger replace special sequences
  let html = templateHtml
    .replace('<!-- __MERMAID_SVG__ -->', () => sanitizeSvgForPreview(svg))
    .replace(
      '<!-- __MERMAID_I18N__ -->',
      () => `<script nonce="${nonce}">window.__MERMAID_I18N__=${i18nJson}</script>`
    )
  // Apply the nonce to the template's own <script> tags (skip ones that already have one)
  html = html.replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`)
  const csp =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
    `script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:">`
  html = html.replace(/<head([^>]*)>/i, (match) => `${match}${csp}`)
  return html
}
