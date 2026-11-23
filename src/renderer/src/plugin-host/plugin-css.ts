import { pluginUrl } from '@shared/plugin/protocol'
import { sanitizePluginCss } from '@shared/plugin/css-safety'

/**
 * **插件自带的样式表**（`plugin://<id>/plugin.css`）的注入与摘除。
 *
 * 为什么需要它（2026-09-26 用户实测：外部插件装进来后界面「内容都变形了」）：
 * 宿主自己的 Tailwind 是在**构建期**扫描宿主源码生成 CSS 的，运行期才装进
 * `userData/plugins/<id>/` 的插件源码不在宿主的扫描范围里——实测 task-planner /
 * music-player 用到的 124 个类名里有 49 个（39% / 18%）在宿主产物 CSS 里没有任何规则，
 * `w-[280px]` / `grid-cols-2` / `bottom-full` / `hover:scale-105` 这类布局关键类全缺，
 * 于是布局塌掉。
 *
 * 所以约定：**插件包自带一份编译好的 `plugin.css`**（插件仓库的构建脚本用 Tailwind
 * 扫自己的源码生成），宿主在装载插件时把它注入 `<head>`，停用/卸载时摘掉。
 * 插件因此不依赖宿主的扫描范围，第三方插件也能自洽。
 *
 * 细节：
 * - 用 `fetch` + 内联 `<style>`（CSP 里 `style-src 'self' 'unsafe-inline'` 允许），
 *   而不是 `<link rel="stylesheet" href="plugin://...">`（那要求 `style-src plugin:`）；
 * - 包里没有 `plugin.css` 时**静默跳过**（旧包、或纯 JS 样式的插件），只留一条 debug 日志。
 *   前提是协议处理器把「文件不存在」如实回 **404**（2026-09-26 修复：它曾让 net.fetch
 *   抛 `ERR_FILE_NOT_FOUND`，于是这里的 `res.ok` 判断永远走不到，主进程还每次打一条
 *   带堆栈的假 warn——可选资源缺失时每次启用都刷日志）；
 * - 同一个 id 重复注入时先移除旧的（幂等），停用后 `document` 里不留痕迹。
 * - **注入前过一遍宿主保护**（`@shared/plugin/css-safety`）：`html` / `body` / `#root` /
 *   `*` / 宿主外壳的类名一律丢弃，`:root` 只允许放变量。一条 `body { display:none }`
 *   就能让整个应用白屏——样式是插件能影响宿主最省事的一条路径，必须在入口拦住。
 *   被丢掉的规则会打一条 warn（带选择器原文），验收报告也会点名。
 */

const STYLE_ATTR = 'data-plugin-css'

/** 取该插件已注入的样式节点 */
function existingStyle(id: string): HTMLStyleElement | null {
  return document.head.querySelector<HTMLStyleElement>(`style[${STYLE_ATTR}="${id}"]`)
}

/**
 * 注入插件样式（没有 plugin.css 就什么都不做）。
 *
 * 失败不抛：样式缺失只该表现为「界面不好看」，不该让插件装载失败（也就不会白屏）。
 */
export async function installPluginCss(id: string): Promise<boolean> {
  removePluginCss(id)
  try {
    const res = await fetch(pluginUrl(id, 'plugin.css'))
    if (!res.ok) {
      console.debug(`[plugin:${id}] No plugin.css (HTTP ${res.status}), skipping style injection`)
      return false
    }
    const css = await res.text()
    if (css.trim() === '') return false
    let audit: ReturnType<typeof sanitizePluginCss>
    try {
      audit = sanitizePluginCss(css)
    } catch (err) {
      // 清洗器自身异常时**宁可不注入**也不要把未清洗的全局 CSS 放进宿主文档
      console.warn(`[plugin:${id}] plugin.css sanitization failed, skipping style injection:`, err)
      return false
    }
    if (audit.dropped.length > 0 || audit.imports.length > 0) {
      const dropped = audit.dropped.slice(0, 6).join(' | ')
      console.warn(
        `[plugin:${id}] Dropped ${audit.dropped.length} global rules in plugin.css that would affect the host` +
          (audit.imports.length > 0 ? `, plus ${audit.imports.length} @import rules removed` : '') +
          (dropped ? `: ${dropped}${audit.dropped.length > 6 ? ' ...' : ''}` : '')
      )
    }
    if (audit.css.trim() === '') {
      console.warn(`[plugin:${id}] plugin.css is empty after sanitization (all global rules), no styles injected`)
      return false
    }
    const style = document.createElement('style')
    style.setAttribute(STYLE_ATTR, id)
    style.textContent = audit.css
    document.head.appendChild(style)
    console.info(
      `[plugin:${id}] Injected plugin styles plugin.css (${(audit.css.length / 1024).toFixed(1)}KB)`
    )
    return true
  } catch (err) {
    console.warn(`[plugin:${id}] Failed to inject plugin.css (ignored, does not affect plugin functionality):`, err)
    return false
  }
}

/** 摘除插件样式（停用/卸载；幂等） */
export function removePluginCss(id: string): void {
  existingStyle(id)?.remove()
}
