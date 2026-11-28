/**
 * Web tool core: URL/SSRF guard, fetching, content rendering, HTML text extraction and search
 * result parsing.
 *
 * This file is deliberately a **single module with no electron / no i18n dependencies**: Node's
 * TS type stripping requires file extensions on relative imports, while project sources uniformly
 * use extensionless imports (bundler resolution), so the offline-testable pure logic has to live
 * in one file (tests import this file directly). Failures are returned as structured codes and
 * localized by tools/harness/web.ts.
 */
import * as cheerio from 'cheerio'
import * as dns from 'node:dns/promises'

// ============================================================================
// Detection and parsing (pure functions)
// ============================================================================

/** Parse a dotted IPv4 into 4 integers in 0-255; returns null when invalid */
function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((part) => (part === '' ? Number.NaN : Number(part)))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return nums as [number, number, number, number]
}

/** Whether an IPv4 literal belongs to a private/reserved range */
export function isPrivateIpv4(ip: string): boolean {
  const parsed = parseIpv4(ip)
  if (!parsed) return false
  const [a, b, c] = parsed
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  // Carrier-grade NAT (100.64.0.0/10)
  if (a === 100 && b >= 64 && b <= 127) return true
  // IETF protocol assignments / documentation examples / benchmarking / multicast / reserved
  // blocks (these never host real public services)
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  if (a >= 224) return true
  return false
}

/**
 * Parse IPv6 into 8 16-bit groups (supports `::` compression, an embedded IPv4 tail and `%zone`).
 * Invalid input returns null, which the caller treats as "not private" (same as the old behavior).
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

/** Reassemble two 16-bit groups into a dotted IPv4 (only used for private-range checks) */
function ipv4FromGroups(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

/** Whether an IP literal (v4/v6) is private/reserved */
export function isPrivateIp(ip: string): boolean {
  const value = ip.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!value.includes(':')) return isPrivateIpv4(value)
  const groups = parseIpv6(value)
  if (!groups) return false
  // `::` (unspecified address) and `::1` (loopback)
  if (groups.every((group) => group === 0)) return true
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true
  // fc00::/7 (unique local addresses, including fd00::/8) and fe80::/10 (link-local)
  if ((groups[0] & 0xfe00) === 0xfc00) return true
  if ((groups[0] & 0xffc0) === 0xfe80) return true
  // fec0::/10 (deprecated site-local addresses)
  if ((groups[0] & 0xffc0) === 0xfec0) return true
  // IPv4-mapped `::ffff:a.b.c.d` / `::ffff:7f00:1` and IPv4-compatible `::a.b.c.d`
  const v4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
  const v4Compat =
    groups.slice(0, 6).every((group) => group === 0) && (groups[6] !== 0 || groups[7] > 1)
  if (v4Mapped || v4Compat) return isPrivateIpv4(ipv4FromGroups(groups[6], groups[7]))
  // IPv4 addresses embedded in 64:ff9b::/96 (NAT64) and 2002::/16 (6to4) are also checked
  // against the private ranges
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return isPrivateIpv4(ipv4FromGroups(groups[6], groups[7]))
  }
  if (groups[0] === 0x2002) return isPrivateIpv4(ipv4FromGroups(groups[1], groups[2]))
  return false
}

/** Private/reserved hostname (literal check: localhost, .local/.internal and private IP literals) */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    return true
  }
  return isPrivateIp(host)
}

/** Truncate to the limit; returns whether it was truncated and the original length */
export function truncateText(
  text: string,
  max: number
): { text: string; truncated: boolean; total: number } {
  if (text.length <= max) return { text, truncated: false, total: text.length }
  return { text: text.slice(0, max), truncated: true, total: text.length }
}

/** Determine the response type (falls back to the first bytes of the body when the header is missing) */
export function guessContentType(header: string | null, body: string): string {
  const declared = (header ?? '').split(';')[0].trim().toLowerCase()
  if (declared) return declared
  const head = body.trimStart().slice(0, 32).toLowerCase()
  if (head.startsWith('<!doctype') || head.startsWith('<html')) return 'text/html'
  if (head.startsWith('{') || head.startsWith('[')) return 'application/json'
  return 'text/plain'
}

/**
 * HTML -> model-facing Markdown text (drops scripts/navigation/footers, keeps headings,
 * paragraphs, lists and code blocks).
 *
 * Not reaching for Readability + jsdom: the project has no @types/jsdom, while cheerio ships its
 * own types and keeps memory more predictable; extraction follows the common body structure
 * (article/main/body), which is sufficient and testable offline.
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
    // For nested structures only keep the outermost node: a p inside pre or an li inside li
    // would duplicate the text
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

  // Fall back to the page's plain text when there is no block-level content (extreme page layout)
  const text = lines.length > 0 ? lines.join('\n') : $('body').text().replace(/\s+/g, ' ').trim()
  return { title, text }
}

/** One search result */
export interface SearchHit {
  title: string
  url: string
  snippet: string
}

/** Restore a DuckDuckGo redirect link to its real URL */
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

/** Parse a DuckDuckGo HTML results page */
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
// Fetching (structured failures, no localized text)
// ============================================================================

/** Maximum duration of one fetch (including all manually followed redirects) */
export const FETCH_TIMEOUT_MS = 20_000
/** Maximum manual redirect hops (each hop re-runs the private-network check so a 302 to an internal host cannot slip through) */
const MAX_REDIRECTS = 5
/** Status codes treated as redirects */
const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])
/** Response body limit (bytes): anything larger is rejected so big files are never read into memory */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
/** Content limit returned to the model (characters) */
export const MAX_CONTENT_CHARS = 24_000
/** Public UA: many sites reject an empty UA or an obviously scripted one */
export const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 RytenBenchWebTool/1.0'

/** Structured fetch failure reasons (localization is the caller's job) */
export type WebFetchFailure =
  | { code: 'invalid-url'; url: string }
  | { code: 'blocked-private'; host: string }
  | { code: 'request-failed'; url: string; message: string }
  | { code: 'http-status'; url: string; status: number; statusText: string }
  | { code: 'too-large'; url: string; limit: number }
  | { code: 'unsupported-type'; url: string; type: string }

export interface WebFetchOptions {
  /** Replace the global fetch (offline tests) */
  fetchImpl?: typeof globalThis.fetch
  /** For tests: allow local/internal addresses (denied by default to prevent SSRF) */
  allowPrivateHosts?: boolean
  /** For tests: replace DNS resolution */
  lookup?: (host: string) => Promise<string[]>
}

export type WebFetchResult =
  | {
      ok: true
      /** Final URL (after following redirects) */
      url: string
      /** HTML <title>/og:title; empty for other types */
      title: string
      contentType: string
      /** Rendered model-readable body (already truncated) */
      content: string
      /** Raw response body before rendering (used for search-result parsing) */
      raw: string
      truncated: boolean
      total: number
    }
  | { ok: false; failure: WebFetchFailure }

/** Whether this is a content type the model can read */
export function isReadableContentType(contentType: string): boolean {
  if (contentType.startsWith('text/')) return true
  if (contentType === 'application/json' || contentType.endsWith('+json')) return true
  if (contentType === 'application/xml' || contentType === 'application/xhtml+xml') return true
  return false
}

/** Render the response body: HTML -> Markdown-style text; JSON -> indented; others as-is */
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

/** Private-address guard: checks both the literal and the DNS resolution results (denied by default, tests can relax it) */
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
    // Leave resolution failures for fetch to report; a DNS failure is not mistaken for a private
    // address
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
 * Fetch one URL and return model-readable text.
 *
 * @param rawUrl absolute URL (http/https)
 * @param options test injection points (fetch / DNS / private-address allowlist)
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
    // Follow redirects manually: fetch's redirect:'follow' validates the host only once before
    // starting, so a public page could 302 to http://127.0.0.1/ or cloud metadata and bypass the
    // SSRF guard. Here every hop re-runs the "literal + DNS resolution" check, and the hop count
    // and protocol are limited.
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
      // The redirect body is no longer needed: cancel it explicitly to avoid holding the connection
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
