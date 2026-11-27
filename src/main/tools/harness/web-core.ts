/**
 * 联网工具核心：URL/SSRF 守卫、抓取、内容渲染、HTML 正文抽取与搜索结果解析。
 *
 * 本文件刻意做成**无 electron / 无 i18n 依赖的单模块**：Node 的 TS 类型擦除要求相对
 * import 带扩展名，而项目源码统一用无扩展名 import（bundler 解析），所以可离线测试的
 * 纯逻辑必须收在同一个文件里（测试直接 import 本文件）。失败以结构化 code 返回，
 * 由 tools/harness/web.ts 负责本地化。
 */
import * as cheerio from 'cheerio'
import * as dns from 'node:dns/promises'

// ============================================================================
// 判定与解析（纯函数）
// ============================================================================

/** 把点分 IPv4 解析成 4 个 0-255 的整数；非法返回 null */
function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((part) => (part === '' ? Number.NaN : Number(part)))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return nums as [number, number, number, number]
}

/** 判断一个 IPv4 字面量是否属于私有/保留网段 */
export function isPrivateIpv4(ip: string): boolean {
  const parsed = parseIpv4(ip)
  if (!parsed) return false
  const [a, b, c] = parsed
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  // 运营商级 NAT（100.64.0.0/10）
  if (a === 100 && b >= 64 && b <= 127) return true
  // IETF 协议分配 / 文档示例 / 基准测试 / 组播 / 保留段（不会承载真实公网服务）
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  if (a >= 224) return true
  return false
}

/**
 * 解析 IPv6 为 8 个 16 位分组（支持 `::` 压缩、尾部内嵌 IPv4、`%zone`）。
 * 非法输入返回 null，由调用方按"非私有"处理（与旧行为一致）。
 */
function parseIpv6(value: string): number[] | null {
  let text = value.split('%')[0]
  const ipv4Tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (ipv4Tail) {
    const v4 = parseIpv4(ipv4Tail[1])
    if (!v4) return null
    const high = ((v4[0] << 8) | v4[1]).toString(16)
    const low = ((v4[2] << 8) | v4[3]).toString(16)
    text = `${text.slice(0, -ipv4Tail[1].length).replace(/:$/, '')}:${high}:${low}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if (halves.length === 1 && head.length !== 8) return null
  if (head.length + tail.length > 8) return null
  const groups = [...head, ...new Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
  const nums = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN
  )
  return nums.some((n) => Number.isNaN(n)) ? null : nums
}

/** 把两个 16 位分组还原成点分 IPv4（仅供私有网段判定） */
function ipv4FromGroups(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

/** 判断一个 IP 字面量（v4/v6）是否私有/保留 */
export function isPrivateIp(ip: string): boolean {
  const value = ip.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!value.includes(':')) return isPrivateIpv4(value)
  const groups = parseIpv6(value)
  if (!groups) return false
  // `::`（未指定地址）与 `::1`（回环）
  if (groups.every((group) => group === 0)) return true
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true
  // fc00::/7（唯一本地地址，含 fd00::/8）与 fe80::/10（链路本地）
  if ((groups[0] & 0xfe00) === 0xfc00) return true
  if ((groups[0] & 0xffc0) === 0xfe80) return true
  // fec0::/10（已废弃的站点本地地址）
  if ((groups[0] & 0xffc0) === 0xfec0) return true
  // IPv4 映射 `::ffff:a.b.c.d` / `::ffff:7f00:1` 与 IPv4 兼容 `::a.b.c.d`
  const v4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
  const v4Compat =
    groups.slice(0, 6).every((group) => group === 0) && (groups[6] !== 0 || groups[7] > 1)
  if (v4Mapped || v4Compat) return isPrivateIpv4(ipv4FromGroups(groups[6], groups[7]))
  // 64:ff9b::/96（NAT64）与 2002::/16（6to4）内嵌的 IPv4 同样按私有段判定
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return isPrivateIpv4(ipv4FromGroups(groups[6], groups[7]))
  }
  if (groups[0] === 0x2002) return isPrivateIpv4(ipv4FromGroups(groups[1], groups[2]))
  return false
}

/** 私有/保留主机名（字面量判定：localhost、.local/.internal，以及私有 IP 字面量） */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    return true
  }
  return isPrivateIp(host)
}

/** 截断到上限，返回是否截断与原始长度 */
export function truncateText(
  text: string,
  max: number
): { text: string; truncated: boolean; total: number } {
  if (text.length <= max) return { text, truncated: false, total: text.length }
  return { text: text.slice(0, max), truncated: true, total: text.length }
}

/** 判断响应类型（头部缺失时按内容前几个字节兜底） */
export function guessContentType(header: string | null, body: string): string {
  const declared = (header ?? '').split(';')[0].trim().toLowerCase()
  if (declared) return declared
  const head = body.trimStart().slice(0, 32).toLowerCase()
  if (head.startsWith('<!doctype') || head.startsWith('<html')) return 'text/html'
  if (head.startsWith('{') || head.startsWith('[')) return 'application/json'
  return 'text/plain'
}

/**
 * HTML → 面向模型的 Markdown 文本（去脚本/导航/页脚，保留标题、段落、列表、代码块）。
 *
 * 不用 Readability + jsdom：项目没有 @types/jsdom，而 cheerio 已带类型、内存也更可控；
 * 抽取规则按常见正文结构（article/main/body）走，够用且可离线测试。
 */
export function extractReadableHtml(html: string): { title: string; text: string } {
  const $ = cheerio.load(html)
  const title = (
    $('meta[property="og:title"]').attr('content') ||
    $('title').first().text() ||
    $('h1').first().text() ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim()

  $('script, style, noscript, svg, iframe, canvas, form, button, nav, header, footer, aside').remove()

  const article = $('article').first()
  const main = $('main').first()
  const root = article.length > 0 ? article : main.length > 0 ? main : $('body')

  const lines: string[] = []
  const push = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    if (lines[lines.length - 1] === trimmed) return
    lines.push(trimmed)
  }

  root.find('h1, h2, h3, h4, h5, h6, p, li, pre, blockquote').each((_, element) => {
    const node = $(element)
    const tag = (element as { tagName?: string }).tagName?.toLowerCase() ?? ''
    if (!tag) return
    // 嵌套结构只取最外层：pre 里的 p、li 里的 li 会重复正文
    if (tag !== 'pre' && node.parents('pre').length > 0) return
    if (tag === 'li' && node.parents('li').length > 0) return
    if (tag === 'p' && node.parents('li, blockquote').length > 0) return

    if (tag === 'pre') {
      const code = node.text().replace(/\s+$/, '')
      if (code.trim()) {
        push('```')
        for (const line of code.split('\n').slice(0, 200)) push(line)
        push('```')
      }
      return
    }
    const text = node.text().replace(/\s+/g, ' ').trim()
    if (!text) return
    if (tag === 'h1') push(`# ${text}`)
    else if (tag === 'h2') push(`## ${text}`)
    else if (tag === 'h3') push(`### ${text}`)
    else if (/^h[4-6]$/.test(tag)) push(`#### ${text}`)
    else if (tag === 'li') push(`- ${text}`)
    else if (tag === 'blockquote') push(`> ${text}`)
    else push(text)
  })

  // 没有任何块级内容时退回整页纯文本（极端页面结构）
  const text = lines.length > 0 ? lines.join('\n') : $('body').text().replace(/\s+/g, ' ').trim()
  return { title, text }
}

/** 一条搜索结果 */
export interface SearchHit {
  title: string
  url: string
  snippet: string
}

/** 把 DuckDuckGo 的跳转链接还原成真实 URL */
export function normalizeSearchHref(href: string): string {
  let value = href.trim()
  if (value.startsWith('//')) value = `https:${value}`
  try {
    const url = new URL(value, 'https://duckduckgo.com')
    const target = url.searchParams.get('uddg')
    if (target) return decodeURIComponent(target)
    return url.toString()
  } catch {
    return value
  }
}

/** 解析 DuckDuckGo HTML 结果页 */
export function parseDuckDuckGoResults(html: string, limit = 8): SearchHit[] {
  const $ = cheerio.load(html)
  const hits: SearchHit[] = []
  $('.result').each((_, element) => {
    const node = $(element)
    const anchor = node.find('a.result__a').first()
    const title = anchor.text().replace(/\s+/g, ' ').trim()
    const rawHref = anchor.attr('href') ?? ''
    const snippet = node.find('.result__snippet').first().text().replace(/\s+/g, ' ').trim()
    if (!title || !rawHref) return
    const url = normalizeSearchHref(rawHref)
    if (hits.some((hit) => hit.url === url)) return
    hits.push({ title, url, snippet })
  })
  return hits.slice(0, limit)
}

// ============================================================================
// 抓取（结构化失败，无本地化文案）
// ============================================================================

/** 一次抓取的最长时间（包含手动跟随的全部重定向） */
export const FETCH_TIMEOUT_MS = 20_000
/** 手动跟随重定向的最大跳数（每跳都重新做私网校验，防止 302 到内网） */
const MAX_REDIRECTS = 5
/** 视为重定向的状态码 */
const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])
/** 响应体上限（字节）：超过直接拒绝，避免把大文件读进内存 */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
/** 返回给模型的正文上限（字符） */
export const MAX_CONTENT_CHARS = 24_000
/** 公共 UA：不少站点会拒绝空 UA 或明显的脚本 UA */
export const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 RytenBenchWebTool/1.0'

/** 抓取失败的结构化原因（上层负责本地化） */
export type WebFetchFailure =
  | { code: 'invalid-url'; url: string }
  | { code: 'blocked-private'; host: string }
  | { code: 'request-failed'; url: string; message: string }
  | { code: 'http-status'; url: string; status: number; statusText: string }
  | { code: 'too-large'; url: string; limit: number }
  | { code: 'unsupported-type'; url: string; type: string }

export interface WebFetchOptions {
  /** 替换全局 fetch（离线测试） */
  fetchImpl?: typeof globalThis.fetch
  /** 测试用：允许访问本地/内网地址（默认拒绝，防 SSRF） */
  allowPrivateHosts?: boolean
  /** 测试用：替换 DNS 解析 */
  lookup?: (host: string) => Promise<string[]>
}

export type WebFetchResult =
  | {
      ok: true
      /** 最终地址（跟随重定向后） */
      url: string
      /** HTML 的 <title>/og:title；其它类型为空 */
      title: string
      contentType: string
      /** 渲染后的模型可读正文（已截断） */
      content: string
      /** 渲染前的原始响应体（搜索结果解析用） */
      raw: string
      truncated: boolean
      total: number
    }
  | { ok: false; failure: WebFetchFailure }

/** 是否属于「模型能读」的内容类型 */
export function isReadableContentType(contentType: string): boolean {
  if (contentType.startsWith('text/')) return true
  if (contentType === 'application/json' || contentType.endsWith('+json')) return true
  if (contentType === 'application/xml' || contentType === 'application/xhtml+xml') return true
  return false
}

/** 渲染响应体：HTML → Markdown 风格正文；JSON → 缩进；其余原样 */
export function renderBody(contentType: string, body: string): string {
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    return extractReadableHtml(body).text
  }
  if (contentType === 'application/json' || contentType.endsWith('+json')) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      return body
    }
  }
  return body
}

/** 私有地址守卫：字面量 + DNS 解析结果都检查（默认拒绝，测试可放开） */
async function checkPublicAddress(
  host: string,
  options: WebFetchOptions
): Promise<WebFetchFailure | null> {
  if (options.allowPrivateHosts) return null
  if (isPrivateHostname(host)) return { code: 'blocked-private', host }
  let addresses: string[]
  try {
    addresses = options.lookup
      ? await options.lookup(host)
      : (await dns.lookup(host, { all: true })).map((entry) => entry.address)
  } catch {
    // 解析失败交给 fetch 报错；这里不把 DNS 失败误判成私有地址
    return null
  }
  for (const address of addresses) {
    if (isPrivateIp(address)) {
      return { code: 'blocked-private', host: `${host} → ${address}` }
    }
  }
  return null
}

/**
 * 抓取一个 URL 并返回模型可读文本。
 *
 * @param rawUrl 绝对地址（http/https）
 * @param options 测试注入点（fetch / DNS / 私有地址放行）
 */
export async function fetchReadable(
  rawUrl: string,
  options: WebFetchOptions = {}
): Promise<WebFetchResult> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, failure: { code: 'invalid-url', url: rawUrl } }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, failure: { code: 'invalid-url', url: rawUrl } }
  }

  const doFetch = options.fetchImpl ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let response: Response
  let finalUrl = url
  try {
    // 手动跟随重定向：fetch 的 redirect:'follow' 只在发起前校验一次 host，
    // 公网页面 302 到 http://127.0.0.1/ 或云 metadata 时绕过 SSRF 守卫。
    // 这里每一跳都重新做「字面量 + DNS 解析」校验，并限制跳数与协议。
    for (let hop = 0; ; hop += 1) {
      if (hop > MAX_REDIRECTS) {
        return {
          ok: false,
          failure: {
            code: 'request-failed',
            url: rawUrl,
            message: `too many redirects (>${MAX_REDIRECTS})`
          }
        }
      }
      const hopBlocked = await checkPublicAddress(finalUrl.hostname, options)
      if (hopBlocked) return { ok: false, failure: hopBlocked }

      response = await doFetch(finalUrl.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': WEB_USER_AGENT,
          accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5'
        }
      })
      if (!REDIRECT_STATUS_CODES.has(response.status)) break
      const location = response.headers.get('location')
      if (!location) break
      // 重定向响应体不再需要：显式 cancel，避免占用连接
      await response.body?.cancel().catch(() => undefined)
      let next: URL
      try {
        next = new URL(location, finalUrl)
      } catch {
        return { ok: false, failure: { code: 'invalid-url', url: rawUrl } }
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        return { ok: false, failure: { code: 'invalid-url', url: next.toString() } }
      }
      finalUrl = next
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, failure: { code: 'request-failed', url: rawUrl, message } }
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    return {
      ok: false,
      failure: {
        code: 'http-status',
        url: rawUrl,
        status: response.status,
        statusText: response.statusText
      }
    }
  }

  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    return { ok: false, failure: { code: 'too-large', url: rawUrl, limit: MAX_RESPONSE_BYTES } }
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > MAX_RESPONSE_BYTES) {
    return { ok: false, failure: { code: 'too-large', url: rawUrl, limit: MAX_RESPONSE_BYTES } }
  }

  const raw = buffer.toString('utf8')
  const contentType = guessContentType(response.headers.get('content-type'), raw)
  if (!isReadableContentType(contentType)) {
    return { ok: false, failure: { code: 'unsupported-type', url: rawUrl, type: contentType } }
  }

  const title =
    contentType === 'text/html' || contentType === 'application/xhtml+xml'
      ? extractReadableHtml(raw).title
      : ''
  const rendered = renderBody(contentType, raw)
  const clipped = truncateText(rendered, MAX_CONTENT_CHARS)

  return {
    ok: true,
    url: finalUrl.toString(),
    title,
    contentType,
    content: clipped.text,
    raw,
    truncated: clipped.truncated,
    total: clipped.total
  }
}
