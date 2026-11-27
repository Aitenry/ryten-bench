/**
 * Mermaid 预览页构建的离线回归（安全审计 S07）。
 *
 * 覆盖：
 * - SVG 里的 <script> / 内联事件 / javascript: 链接被清洗；
 * - 每次构建生成随机 nonce，模板自带脚本全部带 nonce；
 * - CSP meta 注入 <head>，且只放行该 nonce。
 *
 * 跑法：`node --no-warnings tests/mermaid-preview.test.mts`
 */
import assert from 'node:assert/strict'
import {
  buildMermaidPreviewHtml,
  sanitizeSvgForPreview
} from '../src/main/windows/mermaid-preview-html.ts'

const TEMPLATE = `<!DOCTYPE html><html><head><meta charset="utf-8" /></head><body>
<div id="viewport"><!-- __MERMAID_SVG__ --></div>
<!-- __MERMAID_I18N__ -->
<script>var I18N = window.__MERMAID_I18N__ || {}</script>
<script>document.title = 'x'</script>
</body></html>`

// ── 1. SVG 清洗 ───────────────────────────────────────────────────────
const dirty = `<svg onclick="alert(1)"><script>alert('x')</script><a xlink:href="javascript:alert(1)">x</a><foreignObject><div>h</div></foreignObject><rect width="10"/></svg>`
const clean = sanitizeSvgForPreview(dirty)
assert.ok(!clean.includes('<script'))
assert.ok(!clean.includes('onclick'))
assert.ok(!clean.includes('javascript:'))
assert.ok(!clean.includes('foreignObject'))
assert.ok(clean.includes('<rect width="10"/>'), 'benign SVG content must be preserved')

// ── 2. nonce + CSP ────────────────────────────────────────────────────
const html = buildMermaidPreviewHtml(TEMPLATE, dirty, { title: 'Preview' })

const nonceMatch = /script-src 'nonce-([^']+)'/.exec(html)
assert.ok(nonceMatch, 'CSP with nonce must be present')
const nonce = nonceMatch[1]
assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy"`))
assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<body'), 'CSP must be in <head>')

// 模板自带的两个 <script> 都带 nonce；注入的 i18n 脚本也带
const scriptTags = html.match(/<script[^>]*>/g) ?? []
assert.equal(scriptTags.filter((tag) => tag.includes(`nonce="${nonce}"`)).length, scriptTags.length)
assert.ok(scriptTags.length >= 3, 'template scripts + injected i18n script must all carry the nonce')

// i18n 注入
assert.ok(html.includes('window.__MERMAID_I18N__={"title":"Preview"}'))
assert.ok(!html.includes('<!-- __MERMAID_SVG__ -->'))
assert.ok(!html.includes('<!-- __MERMAID_I18N__ -->'))

// ── 3. nonce 每次不同（防止猜测/复用） ────────────────────────────────
const html2 = buildMermaidPreviewHtml(TEMPLATE, '<svg></svg>', {})
const nonce2 = /script-src 'nonce-([^']+)'/.exec(html2)[1]
assert.notEqual(nonce, nonce2)

console.log('mermaid-preview: all assertions passed')
