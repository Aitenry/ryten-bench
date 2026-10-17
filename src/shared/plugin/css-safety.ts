/**
 * 插件样式表的**宿主保护**（三端共用的纯函数，不 import DOM / node）。
 *
 * 为什么需要它：插件包自带的 `plugin.css` 会被**原样注入宿主的 `<head>`**
 * （见 `renderer/src/plugin-host/plugin-css.ts`），选择器因此作用于整个文档，
 * 不只是插件自己的界面。一条 `body { display: none }` 或者 `* { box-sizing: content-box }`
 * 就能把整个应用搞坏——这是「插件不能影响系统运转」里最直接、也最不需要恶意的一条路径。
 *
 * 拦什么（只放行「不会波及宿主外壳」的规则）：
 * - `html` / `body` / `#root`：文档根与挂载点，插件没有理由改；
 * - `*`：全局重置，插件用 Tailwind 也不会产出它；
 * - `.custom-frame` / `.frame-*` / `.custom-scrollbar` / `.ant-app`：宿主外壳自己的类名；
 * - `:root`：**只放行自定义属性**（Tailwind 的 theme 层就是 `:root { --color-… }`），
 *   夹带 `display`、`font-size` 这类真声明整条丢弃。
 *
 * 为什么不做「把所有规则都 scope 到插件根节点」：插件的 antd 弹窗/下拉是 portal 到
 * `document.body` 的，scope 之后这些浮层会失去全部样式（真实插件都在用 Modal）。
 * 因此这里只砍「明确在动宿主的」规则，其余原样保留；验收项 `safety.scan` 与这条
 * 运行时闸门一起，构成两层保护。
 *
 * 返回值里 `dropped` 是给人看的选择器原文——运行期会打一条 warn 日志，
 * 验收报告也会点名（模型据此删掉这些规则，而不是等用户发现界面坏了）。
 *
 * 幂等：对已经清洗过的 CSS 再跑一遍，结果不变；没有命中任何规则时与输入逐字节相同。
 */

export interface PluginCssAudit {
  /** 清洗后的 CSS */
  css: string
  /** 被丢弃的规则（选择器原文，已去重） */
  dropped: string[]
  /** 被移除的 @import 语句 */
  imports: string[]
}

/** 选择器是否指向文档根（html / body） */
const HTML_BODY = /(^|[\s,>+~(])(?:html|body)(?=$|[\s,>+~.:#[\]])/i
/** 选择器是否指向 React 挂载点 */
const ROOT_ID = /(^|[\s,>+~(])#root(?=$|[\s,>+~.:#[])/
/** 选择器是否指向宿主外壳自己的类名 */
const HOST_FRAME =
  /(^|[\s,>+~(])\.(?:custom-frame|custom-scrollbar|frame-[a-z0-9-]+|ant-app)(?=$|[\s,>+~.:#[])/
/** 选择器是否在改宿主框架（antd）的全局组件样式 */
const HOST_ANTD = /(^|[\s,>+~(])\.ant-[a-z0-9-]+/
/** 裸通配选择器 */
const UNIVERSAL = /(^|[\s,>+~(])\*(?=$|[\s,>+~.:#[])/
/** :root 选择器 */
const ROOT_PSEUDO = /(^|[\s,>+~(]):root(?=$|[\s,>+~.:#[])/
/** 一条自定义属性声明（`--foo: …`） */
const CUSTOM_PROPERTY = /^\s*--[A-Za-z0-9_-]+\s*:/

/** 体内可以继续出现普通规则的 at-rule（需要递归清洗） */
const GROUPING_AT_RULES = new Set([
  'media',
  'supports',
  'layer',
  'container',
  'scope',
  'document',
  'starting-style'
])

/** 跳过字符串字面量（返回结束引号之后的位置） */
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

/** 找配对的 `}`（跳过注释/字符串/嵌套块），返回闭合之后的位置 */
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

/** 块体是否只含自定义属性（Tailwind theme 层） */
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

/** 这条规则会不会波及宿主外壳 */
function hitsHost(selector: string, body: string): boolean {
  if (HTML_BODY.test(selector)) return true
  if (ROOT_ID.test(selector)) return true
  if (HOST_FRAME.test(selector)) return true
  if (HOST_ANTD.test(selector)) return true
  // `*` 允许「只放变量」的一种形态：Tailwind 的 properties 层就是
  // `*,:before,:after,::backdrop { --tw-translate-x: 0; … }`（真实插件包里都有）。
  // 夹带 display 这类真声明的通配规则才是全局重置，丢。
  if (UNIVERSAL.test(selector) && !onlyCustomProperties(body)) return true
  // :root 只允许放变量（Tailwind theme）；夹带真声明就是全局样式
  if (ROOT_PSEUDO.test(selector) && !onlyCustomProperties(body)) return true
  return false
}

/**
 * 清洗一段 CSS（递归处理 @media / @layer 等分组 at-rule 的体内规则）。
 */
function sanitizeFragment(css: string): PluginCssAudit {
  let out = ''
  let cursor = 0
  let segmentStart = 0
  let i = 0
  const dropped: string[] = []
  const imports: string[] = []

  /** 丢弃 [start, end)（连同前面的空白），从输出流里跳过它 */
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

/** 清洗插件样式表（对同一份 CSS 幂等） */
export function sanitizePluginCss(css: string): PluginCssAudit {
  if (typeof css !== 'string' || css.trim() === '') {
    return { css: typeof css === 'string' ? css : '', dropped: [], imports: [] }
  }
  const result = sanitizeFragment(css)
  return {
    // 删规则可能留下空行：收一下，避免产物里出现大段空白
    css: result.css.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n'),
    dropped: [...new Set(result.dropped)],
    imports: [...new Set(result.imports)]
  }
}
