/**
 * Mermaid 预览页 HTML 的纯构建逻辑（不依赖 electron / 文件系统，可离线测试）。
 *
 * 安全背景（2026-11 审计 S07）：预览窗口加载的是 `data:text/html` 页面，且挂了
 * 完整 preload（sandbox:false）——页面里任何脚本都能拿到 `window.api`。原实现把
 * 渲染层传来的 SVG 原样拼进 HTML，也没有 CSP。这里：
 * - 清洗 SVG（去 script / foreignObject / 内联事件 / javascript: 链接）；
 * - 每次生成随机 nonce，只给模板自带的内联脚本打标，再用 CSP `script-src 'nonce-…'`
 *   放行——注入的内容即使带脚本也执行不了。
 */
import { randomBytes } from 'node:crypto'

/** 清洗要嵌入预览页的 SVG（mermaid strict 模式本应安全，这里是纵深防御） */
export function sanitizeSvgForPreview(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href|src)\s*=\s*("|')?\s*javascript:/gi, '$1=$2#')
}

/**
 * 把 SVG 与 i18n 文案注入预览模板，并加上 nonce + CSP。
 *
 * @param templateHtml 预览窗口的 HTML 模板（含 `<!-- __MERMAID_SVG__ -->` 与
 *   `<!-- __MERMAID_I18N__ -->` 两个占位符）
 * @param svg          渲染层传来的 SVG 文本
 * @param i18n         预览窗口的文案对象（原样 JSON 注入）
 */
export function buildMermaidPreviewHtml(
  templateHtml: string,
  svg: string,
  i18n: Record<string, unknown>
): string {
  const nonce = randomBytes(16).toString('base64')
  const i18nJson = JSON.stringify(i18n).replace(/</g, '\\u003c')
  // 函数形式替换，避免 svg 中的 $ 字符触发 replace 特殊序列
  let html = templateHtml
    .replace('<!-- __MERMAID_SVG__ -->', () => sanitizeSvgForPreview(svg))
    .replace(
      '<!-- __MERMAID_I18N__ -->',
      () => `<script nonce="${nonce}">window.__MERMAID_I18N__=${i18nJson}</script>`
    )
  // 给模板自带的 <script> 打 nonce（已经打过的不重复处理）
  html = html.replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`)
  const csp =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
    `script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:">`
  html = html.replace(/<head([^>]*)>/i, (match) => `${match}${csp}`)
  return html
}
