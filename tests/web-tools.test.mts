/**
 * 联网工具核心（`tools/harness/web-parse.ts` + `web-fetch.ts`）的离线回归。
 *
 * 跑法：`node --no-warnings tests/web-tools.test.mts`
 *
 * 用本地 HTTP 服务代替真实网络，覆盖：
 * - SSRF 守卫：私有/本地地址默认拒绝，`allowPrivateHosts` 仅测试放开；
 * - 抓取：HTML→Markdown 正文（去导航/脚本）、JSON 美化、重定向后的最终地址；
 * - 失败分支：非法协议、404、超大响应、不可读内容类型；
 * - 解析：DuckDuckGo 跳转链接还原、结果列表解析（标题/URL/摘要、去重）。
 */
import assert from 'node:assert/strict'
import * as http from 'node:http'
import {
  extractReadableHtml,
  fetchReadable,
  guessContentType,
  isPrivateHostname,
  isPrivateIp,
  isPrivateIpv4,
  isReadableContentType,
  normalizeSearchHref,
  parseDuckDuckGoResults,
  renderBody,
  truncateText
} from '../src/main/tools/harness/web-core.ts'

// ── 1. SSRF 判定 ───────────────────────────────────────────────────────
assert.equal(isPrivateIpv4('127.0.0.1'), true)
assert.equal(isPrivateIpv4('10.1.2.3'), true)
assert.equal(isPrivateIpv4('172.16.0.1'), true)
assert.equal(isPrivateIpv4('172.32.0.1'), false)
assert.equal(isPrivateIpv4('192.168.1.1'), true)
assert.equal(isPrivateIpv4('169.254.169.254'), true)
assert.equal(isPrivateIpv4('8.8.8.8'), false)
assert.equal(isPrivateIpv4('not-an-ip'), false)
assert.equal(isPrivateIp('::1'), true)
assert.equal(isPrivateIp('fd00::1'), true)
assert.equal(isPrivateIp('::ffff:192.168.1.1'), true)
assert.equal(isPrivateIp('2001:4860:4860::8888'), false)
// 十六进制 IPv4 映射 / 展开的 loopback / 链路本地 / 基准测试段（2026-11 审计补充）
assert.equal(isPrivateIp('::ffff:7f00:1'), true)
assert.equal(isPrivateIp('0:0:0:0:0:0:0:1'), true)
assert.equal(isPrivateIp('::ffff:a9fe:a9fe'), true)
assert.equal(isPrivateIp('198.18.0.1'), true)
assert.equal(isPrivateIp('2606:4700:4700::1111'), false)
assert.equal(isPrivateHostname('localhost'), true)
assert.equal(isPrivateHostname('api.localhost'), true)
assert.equal(isPrivateHostname('router.local'), true)
assert.equal(isPrivateHostname('example.com'), false)

// ── 2. HTML 抽取 ───────────────────────────────────────────────────────
const ARTICLE = `<!doctype html><html><head>
  <title>Fallback title</title>
  <meta property="og:title" content="Readable title">
  <script>window.secret = 'SCRIPT'</script>
</head><body>
  <nav>NAVIGATION</nav>
  <article>
    <h1>Main heading</h1>
    <p>First paragraph with   spaces.</p>
    <ul><li>alpha</li><li>beta<ul><li>nested</li></ul></li></ul>
    <pre><code>const x = 1
const y = 2</code></pre>
    <blockquote>quoted line</blockquote>
  </article>
  <footer>FOOTER</footer>
</body></html>`

const extracted = extractReadableHtml(ARTICLE)
assert.equal(extracted.title, 'Readable title')
assert.ok(extracted.text.includes('# Main heading'))
assert.ok(extracted.text.includes('First paragraph with spaces.'))
assert.ok(extracted.text.includes('- alpha'))
assert.ok(extracted.text.includes('- beta'))
assert.ok(extracted.text.includes('```'))
assert.ok(extracted.text.includes('const y = 2'))
assert.ok(extracted.text.includes('> quoted line'))
assert.ok(!extracted.text.includes('NAVIGATION'))
assert.ok(!extracted.text.includes('FOOTER'))
assert.ok(!extracted.text.includes('SCRIPT'))
// 嵌套 li 只取外层，正文不重复
assert.equal(extracted.text.split('nested').length - 1, 1)

// ── 3. 类型判断 / 截断 / 渲染 ─────────────────────────────────────────
assert.equal(guessContentType(null, '<!doctype html><html>'), 'text/html')
assert.equal(guessContentType(null, '{"a":1}'), 'application/json')
assert.equal(guessContentType('text/html; charset=utf-8', ''), 'text/html')
assert.equal(guessContentType(null, 'hello'), 'text/plain')

const clipped = truncateText('abcdef', 3)
assert.deepEqual(clipped, { text: 'abc', truncated: true, total: 6 })
assert.equal(isReadableContentType('text/plain'), true)
assert.equal(isReadableContentType('application/json'), true)
assert.equal(isReadableContentType('image/png'), false)
assert.equal(renderBody('application/json', '{"a":1}'), '{\n  "a": 1\n}')

// ── 4. 搜索解析 ───────────────────────────────────────────────────────
assert.equal(
  normalizeSearchHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc&rut=x'),
  'https://example.com/doc'
)
assert.equal(normalizeSearchHref('https://direct.example/x'), 'https://direct.example/x')

const DDG_HTML = `<html><body>
  <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">First &amp; result</a>
    <a class="result__snippet">snippet one</a></div>
  <div class="result"><a class="result__a" href="https://example.com/b">Second result</a>
    <a class="result__snippet">snippet two</a></div>
  <div class="result"><a class="result__a" href="https://example.com/b">Duplicate</a></div>
</body></html>`
const hits = parseDuckDuckGoResults(DDG_HTML)
assert.equal(hits.length, 2)
assert.deepEqual(hits[0], {
  title: 'First & result',
  url: 'https://example.com/a',
  snippet: 'snippet one'
})
assert.equal(hits[1].url, 'https://example.com/b')

// ── 5. 抓取：本地 HTTP 服务 ────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/article') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(ARTICLE)
    return
  }
  if (req.url === '/data.json') {
    res.setHeader('content-type', 'application/json')
    res.end('{"ok":true,"n":2}')
    return
  }
  if (req.url === '/text') {
    res.setHeader('content-type', 'text/plain')
    res.end('plain body')
    return
  }
  if (req.url === '/redirect') {
    res.statusCode = 302
    res.setHeader('location', '/article')
    res.end()
    return
  }
  if (req.url === '/big') {
    res.setHeader('content-type', 'text/plain')
    res.end('x'.repeat(3 * 1024 * 1024))
    return
  }
  if (req.url === '/image') {
    res.setHeader('content-type', 'image/png')
    res.end('not really a png')
    return
  }
  res.statusCode = 404
  res.statusMessage = 'Not Found'
  res.end('missing')
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`

try {
  const allowed = { allowPrivateHosts: true }

  const html = await fetchReadable(`${base}/article`, allowed)
  assert.equal(html.ok, true)
  if (html.ok) {
    assert.equal(html.title, 'Readable title')
    assert.equal(html.contentType, 'text/html')
    assert.ok(html.content.includes('# Main heading'))
    assert.ok(!html.content.includes('NAVIGATION'))
    assert.equal(html.truncated, false)
  }

  const json = await fetchReadable(`${base}/data.json`, allowed)
  assert.equal(json.ok, true)
  if (json.ok) assert.ok(json.content.includes('"ok": true'))

  const redirect = await fetchReadable(`${base}/redirect`, allowed)
  assert.equal(redirect.ok, true)
  if (redirect.ok) assert.ok(redirect.url.endsWith('/article'))

  const notFound = await fetchReadable(`${base}/404`, allowed)
  assert.equal(notFound.ok, false)
  if (!notFound.ok) assert.equal(notFound.failure.code, 'http-status')

  const big = await fetchReadable(`${base}/big`, allowed)
  assert.equal(big.ok, false)
  if (!big.ok) assert.equal(big.failure.code, 'too-large')

  const image = await fetchReadable(`${base}/image`, allowed)
  assert.equal(image.ok, false)
  if (!image.ok) assert.equal(image.failure.code, 'unsupported-type')

  // 默认（未放行）时本地地址必须被 SSRF 守卫拒绝——不发起请求
  const blocked = await fetchReadable(`${base}/article`)
  assert.equal(blocked.ok, false)
  if (!blocked.ok) assert.equal(blocked.failure.code, 'blocked-private')

  // DNS 解析到私有地址同样拒绝（注入 lookup，不依赖真实 DNS）
  const viaDns = await fetchReadable('http://public-looking.example/article', {
    fetchImpl: (async () => {
      throw new Error('fetch must not run when DNS resolves to a private address')
    }) as unknown as typeof globalThis.fetch,
    lookup: async () => ['192.168.1.10']
  })
  assert.equal(viaDns.ok, false)
  if (!viaDns.ok) assert.equal(viaDns.failure.code, 'blocked-private')

  const ftp = await fetchReadable('ftp://example.com/file')
  assert.equal(ftp.ok, false)
  if (!ftp.ok) assert.equal(ftp.failure.code, 'invalid-url')

  // ── 6. 重定向 SSRF 回归（2026-11 审计 S01） ─────────────────────────
  // 初始 host 公网、302 到内网：旧实现 redirect:'follow' 会直接跟随并读出内网响应
  const redirectCalls: string[] = []
  const redirectToInternal = await fetchReadable('http://public.example/start', {
    fetchImpl: (async (input: string | URL | Request) => {
      const requested = String(input)
      redirectCalls.push(requested)
      if (requested === 'http://public.example/start') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://internal.example/secret' }
        })
      }
      return new Response('SECRET', {
        status: 200,
        headers: { 'content-type': 'text/plain' }
      })
    }) as unknown as typeof globalThis.fetch,
    lookup: async (host) => (host === 'internal.example' ? ['127.0.0.1'] : ['93.184.216.34'])
  })
  assert.equal(redirectToInternal.ok, false)
  if (!redirectToInternal.ok) assert.equal(redirectToInternal.failure.code, 'blocked-private')
  assert.ok(
    !redirectCalls.some((call) => call.includes('internal.example')),
    'must not fetch a redirect target that resolves to a private address'
  )

  // 重定向到非 http(s) 协议（file:）必须拒绝
  const redirectToFile = await fetchReadable('http://public.example/start', {
    fetchImpl: (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'file:///etc/passwd' }
      })) as unknown as typeof globalThis.fetch,
    lookup: async () => ['93.184.216.34']
  })
  assert.equal(redirectToFile.ok, false)
  if (!redirectToFile.ok) assert.equal(redirectToFile.failure.code, 'invalid-url')

  // 重定向自环：跳数必须有上限，不能无限跟随
  let redirectHops = 0
  const redirectLoop = await fetchReadable('http://public.example/start', {
    fetchImpl: (async () => {
      redirectHops += 1
      return new Response(null, { status: 302, headers: { location: '/again' } })
    }) as unknown as typeof globalThis.fetch,
    lookup: async () => ['93.184.216.34']
  })
  assert.equal(redirectLoop.ok, false)
  if (!redirectLoop.ok) assert.equal(redirectLoop.failure.code, 'request-failed')
  assert.ok(redirectHops <= 7, `redirect hops must be bounded, got ${redirectHops}`)
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

console.log('web-tools: all assertions passed')
