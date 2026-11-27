#!/usr/bin/env node
/**
 * 0.2.6 全链路 E2E 审计（本地工装，不入库）：
 *
 * 启动 electron-vite 产出的生产构建（`out/`）+ 临时 userData + CDP，
 * 按用户可感知的「链路」逐段验证：启动 → 外壳/路由 → 会话与流式对话（本地 mock
 * provider）→ 输入框工具/技能/MCP 选择 → 技能页（搜索/预览/编辑/删除）→ 智能体表单
 * → 记忆/MCP/联网搜索设置 → 定时任务页 + 跨模式 IPC → 插件仓库/资料库 → 弹窗滚动几何。
 *
 * 不碰真实用户数据：所有 IPC/DB/技能写入都发生在临时 profile；
 * 聊天用本进程内的 OpenAI 兼容 mock server，不依赖外网与 API Key。
 *
 * 用法：node scripts/e2e-026-audit.cjs
 * 产物：.tmp/e2e-026/{report.json,screenshots,app.log,app.err.log}
 */
const { spawn, execSync } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, '.tmp', 'e2e-026')
const SHOTS = path.join(OUT, 'screenshots')
const REPORT = path.join(OUT, 'report.json')
const BASE_PORT = Number(process.env.AUDIT_CDP_PORT || 9444)
const ELECTRON = (() => {
  try {
    return require('electron')
  } catch {
    return path.join(
      ROOT,
      'node_modules',
      '.pnpm',
      'electron@44.1.1',
      'node_modules',
      'electron',
      'dist',
      'electron.exe'
    )
  }
})()

fs.mkdirSync(SHOTS, { recursive: true })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-026-audit-'))
const skillsRoot = path.join(profile, 'data', 'skills')
fs.mkdirSync(path.join(skillsRoot, 'audit-alpha'), { recursive: true })
fs.mkdirSync(path.join(skillsRoot, 'audit-beta'), { recursive: true })
fs.writeFileSync(
  path.join(skillsRoot, 'audit-alpha', 'SKILL.md'),
  '---\nname: Audit Alpha\ndescription: 链路审计技能 A\n---\n\n# Audit Alpha\n\n这是审计用技能 A 的正文。\n'
)
fs.writeFileSync(
  path.join(skillsRoot, 'audit-beta', 'SKILL.md'),
  '---\nname: Audit Beta\ndescription: 链路审计技能 B\n---\n\n# Audit Beta\n\n这是审计用技能 B 的正文。\n'
)
// BOM 编码的 SKILL.md：列表要能按 frontmatter 解析出名字（而不是退化成目录名），
// 预览不能把 frontmatter 当正文，编辑保存后会规范化为无 BOM 的 UTF-8。
fs.mkdirSync(path.join(skillsRoot, 'audit-bom'))
fs.writeFileSync(
  path.join(skillsRoot, 'audit-bom', 'SKILL.md'),
  '\uFEFF---\nname: Audit Bom\ndescription: 带 BOM 的审计技能\n---\n\n# Audit Bom\n\nBOM 正文。\n'
)
// 同名目录（SKILL.md 是文件夹）不能被当成技能
fs.mkdirSync(path.join(skillsRoot, 'audit-broken', 'SKILL.md'), { recursive: true })

const results = []
const pageErrors = []
let failed = 0

function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail ?? null })
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 本地 OpenAI 兼容 mock provider（验证「输入 → 主进程 agent → 模型流 → 渲染」全链） ──
const MOCK_REPLY = 'MOCK-REPLY-0.2.6-链路自检通过'
const MOCK_TOOL_CALL_ID = 'call_propose_audit'
const MOCK_ASK_CALL_ID = 'call_ask_audit'
const MOCK_ASK_TOOL_ARGS = JSON.stringify({
  questions: [
    {
      id: 'verify',
      header: '验证',
      question: '用哪种方式验证这轮改动？',
      options: [
        { label: '先跑类型检查', description: '快，覆盖类型问题' },
        { label: '跑完整 E2E', description: '慢，覆盖全部链路' }
      ]
    },
    { id: 'note', header: '补充', question: '还需要补充什么说明？' }
  ]
})
const MOCK_TOOL_ARGS = JSON.stringify({
  question: '要继续吗？',
  actions: [
    { label: '继续', reply: 'ACTION-CONTINUE' },
    { label: '取消' }
  ]
})
function startMockProvider() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        let payload = {}
        try {
          payload = JSON.parse(body || '{}')
        } catch {
          /* ignore */
        }
        const messages = Array.isArray(payload.messages) ? payload.messages : []
        const contentOf = (m) =>
          typeof m?.content === 'string'
            ? m.content
            : Array.isArray(m?.content)
              ? m.content.map((part) => part?.text ?? '').join(' ')
              : ''
        const userText = messages
          .filter((m) => m.role === 'user')
          .map(contentOf)
          .join('\n')
        // 只看「最后一条用户消息」及其后的工具结果：同一会话里可以重复触发脚本
        let lastUserIndex = -1
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (messages[i].role === 'user') {
            lastUserIndex = i
            break
          }
        }
        const lastUserContent = lastUserIndex >= 0 ? contentOf(messages[lastUserIndex]) : ''
        const messagesAfterLastUser = messages.slice(lastUserIndex + 1)
        const toolMessages = messagesAfterLastUser.filter((m) => m.role === 'tool')
        const lastToolContent = toolMessages.length ? contentOf(toolMessages[toolMessages.length - 1]) : ''
        const wantsAsk = /ASK-TEST/.test(lastUserContent)
        const wantsPropose = /PROPOSE-TEST/.test(lastUserContent)
        // 第一轮：模拟模型调用 propose_action / ask_user_question（验证工具循环与输入区 UI）
        const scriptedToolCall = toolMessages.length === 0
          ? wantsAsk
            ? { id: MOCK_ASK_CALL_ID, name: 'ask_user_question', args: MOCK_ASK_TOOL_ARGS }
            : wantsPropose
              ? { id: MOCK_TOOL_CALL_ID, name: 'propose_action', args: MOCK_TOOL_ARGS }
              : null
          : null
        const scriptedReply = (() => {
          if (/ACTION-CONTINUE/.test(lastUserContent)) return 'ACTION-CLICKED-OK-0.2.6'
          if (wantsAsk && toolMessages.length > 0) {
            if (/cancelled/.test(lastToolContent)) return 'ASK-CANCEL-OK-0.2.6'
            let detail = ''
            try {
              const parsed = JSON.parse(lastToolContent)
              detail = (parsed.answers || [])
                .map((answer) => [...(answer.selected || []), answer.custom ?? ''].filter(Boolean).join('|'))
                .join(';')
            } catch {
              /* 非 JSON：保持空 detail */
            }
            return `ASK-ANSWER-OK-0.2.6 ${detail}`
          }
          if (toolMessages.length > 0) return 'PROPOSE-TOOL-DONE-0.2.6'
          return MOCK_REPLY
        })()
        const modelName = payload.model || 'audit-model'
        const wantsStream = payload.stream === true
        const makeChunk = (delta, finish = null) =>
          JSON.stringify({
            id: 'chatcmpl-audit',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [{ index: 0, delta, finish_reason: finish }]
          })
        const writeUsageChunk = () =>
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-audit',
              object: 'chat.completion.chunk',
              model: modelName,
              choices: [],
              usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
            })}\n\n`
          )
        if (wantsStream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive'
          })
          res.write(`data: ${makeChunk({ role: 'assistant', content: '' })}\n\n`)
          if (scriptedToolCall) {
            res.write(
              `data: ${makeChunk({
                tool_calls: [
                  {
                    index: 0,
                    id: scriptedToolCall.id,
                    type: 'function',
                    function: { name: scriptedToolCall.name, arguments: '' }
                  }
                ]
              })}\n\n`
            )
            res.write(
              `data: ${makeChunk({
                tool_calls: [{ index: 0, function: { arguments: scriptedToolCall.args } }]
              })}\n\n`
            )
            res.write(`data: ${makeChunk({}, 'tool_calls')}\n\n`)
            writeUsageChunk()
          } else {
            res.write(`data: ${makeChunk({ content: scriptedReply })}\n\n`)
            res.write(`data: ${makeChunk({}, 'stop')}\n\n`)
            writeUsageChunk()
          }
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        const message = scriptedToolCall
          ? {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: scriptedToolCall.id,
                  type: 'function',
                  function: { name: scriptedToolCall.name, arguments: scriptedToolCall.args }
                }
              ]
            }
          : { role: 'assistant', content: scriptedReply }
        res.end(
          JSON.stringify({
            id: 'chatcmpl-audit',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [
              {
                index: 0,
                message,
                finish_reason: scriptedToolCall ? 'tool_calls' : 'stop'
              }
            ],
            usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
          })
        )
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

// ── 极简 CDP 客户端 ──
function createCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const handlers = []
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
      return
    }
    for (const handler of handlers) handler(msg)
  })
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const callId = ++id
      pending.set(callId, { resolve, reject })
      ws.send(JSON.stringify({ id: callId, method, params }))
    })
  return {
    ready: new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    }),
    call,
    on: (handler) => handlers.push(handler),
    close: () => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }
}

async function fetchJson(url) {
  const res = await fetch(url)
  return res.json()
}

async function waitForPage(port, timeoutMs = 60000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`)
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
      if (page) return page
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('renderer page not found')
}

async function main() {
  const mock = await startMockProvider()
  console.log('mock provider on', `http://127.0.0.1:${mock.port}`)

  // 端口占用时顺延
  let port = BASE_PORT
  for (let i = 0; i < 10; i += 1) {
    try {
      await fetchJson(`http://127.0.0.1:${port}/json/list`)
      port += 1
    } catch {
      break
    }
  }

  const appEnv = { ...process.env }
  delete appEnv.ELECTRON_RUN_AS_NODE
  const outLog = fs.createWriteStream(path.join(OUT, 'app.log'))
  const errLog = fs.createWriteStream(path.join(OUT, 'app.err.log'))
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
    cwd: ROOT,
    env: appEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false
  })
  child.stdout.pipe(outLog)
  child.stderr.pipe(errLog)
  let exited = false
  child.on('exit', (code) => {
    exited = true
    console.log('APP_EXIT', code)
  })

  let cdp = null
  try {
    const page = await waitForPage(port)
    cdp = createCdp(page.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.call('Runtime.enable')
    await cdp.call('Page.enable')
    await cdp.call('Log.enable')
    cdp.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const desc =
          msg.params?.exceptionDetails?.exception?.description ||
          msg.params?.exceptionDetails?.text ||
          'unknown exception'
        pageErrors.push(`exception: ${desc}`)
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const text = (msg.params.args || [])
          .map((a) => a.value ?? a.description ?? '')
          .join(' ')
          .slice(0, 400)
        pageErrors.push(`console.error: ${text}`)
      }
      if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        pageErrors.push(`log: ${msg.params.entry.text.slice(0, 400)}`)
      }
    })

    const evaluate = async (expression) => {
      const r = await cdp.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      })
      if (r.exceptionDetails) {
        throw new Error(
          'page exception: ' +
            (r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'unknown')
        )
      }
      return r.result?.value
    }
    const waitFor = async (expression, timeoutMs = 10000) => {
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        try {
          const value = await evaluate(expression)
          if (value) return value
        } catch {
          /* retry */
        }
        await sleep(250)
      }
      return null
    }
    const screenshot = async (name) => {
      try {
        const shot = await cdp.call('Page.captureScreenshot', { format: 'png' })
        if (shot?.data) {
          fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(shot.data, 'base64'))
        }
      } catch (err) {
        console.log('screenshot failed', name, String(err))
      }
    }
    const invoke = async (channel, ...args) =>
      evaluate(
        `window.api.system.invoke(${JSON.stringify(channel)}${args.length ? ', ' + args.map((a) => JSON.stringify(a)).join(', ') : ''})`
      )
    const goRoute = async (hash, settleMs = 900) => {
      await evaluate(`location.hash = ${JSON.stringify(hash)}`)
      await sleep(settleMs)
    }
    const bodyText = () => evaluate(`(document.body.innerText || '').replace(/\\s+/g, ' ')`)
    const clickButtonByText = async (text, exact = false) => {
      const clicked = await evaluate(`(() => {
        const norm = (t) => (t || '').replace(/\\s+/g, '').trim()
        const target = ${JSON.stringify(text)}
        const buttons = [...document.querySelectorAll('button')]
        const hit = buttons.find((b) => {
          const t = norm(b.innerText)
          return ${exact ? 't === norm(target)' : 't.includes(norm(target))'}
        })
        if (!hit) return false
        hit.click()
        return true
      })()`)
      await sleep(600)
      return clicked
    }
    const setInput = async (selector, value) => {
      const ok = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return false
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(el, ${JSON.stringify(value)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`)
      await sleep(250)
      return ok
    }
    const pressEnter = async () => {
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      })
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      })
    }
    /** 终端专用 Enter：xterm 处理 keydown，带上 text 更接近真实按键 */
    const terminalPressEnter = async () => {
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: '\r',
        unmodifiedText: '\r'
      })
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      })
    }
    /**
     * 终端面板「直接在页面上打字」：逐字符派发 keydown/keyup。
     * 面板没有输入框，React 的 onKeyDown 才是唯一入口，所以不能依赖 Input.insertText。
     */
    const typeOnSurface = async (text) => {
      const vkOf = (ch) => {
        if (ch === ' ') return 32
        if (ch === '-') return 189
        if (ch === '_') return 189
        if (ch === '.') return 190
        if (/[0-9]/.test(ch)) return 48 + Number(ch)
        if (/[a-zA-Z]/.test(ch)) return ch.toUpperCase().charCodeAt(0)
        return 0
      }
      for (const ch of text) {
        const vk = vkOf(ch)
        await cdp.call('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: ch,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk
        })
        await cdp.call('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: ch,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk
        })
        await sleep(20)
      }
    }

    // ── 0) 启动（首启没有工作区，外壳可能先停在装配态；这里只验证进程/桥/首帧） ──
    await waitFor(
      `document.querySelector('#root') && typeof window.api?.system?.invoke === 'function'`,
      60000
    )
    await sleep(1500)
    const boot = await evaluate(`JSON.stringify({
      title: document.title,
      url: location.href,
      api: typeof window.api,
      invoke: typeof window.api?.system?.invoke,
      rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
      nodes: document.querySelectorAll('*').length,
      bodySample: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160)
    })`)
    const bootInfo = JSON.parse(boot)
    record(
      '启动：渲染层挂载 + preload 桥可用',
      bootInfo.invoke === 'function' && bootInfo.rootChildren > 0,
      `nodes=${bootInfo.nodes} rootChildren=${bootInfo.rootChildren}`
    )
    record('启动：页面标题', /RytenBench/i.test(bootInfo.title), `title=${bootInfo.title}`)
    await screenshot('01-boot')

    // ── 1) 准备工作区 + mock provider + 会话 ──
    const setup = await invoke('harness:chat-ensure-workspace')
    const workspaceId = setup?.data?.workspaceId ?? null
    record('工作区：chat-ensure-workspace', setup?.ok === true && workspaceId > 0, JSON.stringify(setup).slice(0, 160))
    const providerId = await evaluate(
      `window.api.providers.create(${JSON.stringify({
        name: 'Audit Mock Provider',
        provider: 'custom',
        base_url: `http://127.0.0.1:${mock.port}`,
        api_key: 'audit-key',
        model: 'audit-model',
        thinking_mode: 'off',
        is_default: true,
        extra_config: { api_format: 'openai', streaming: true }
      })})`
    )
    record('模型 Provider：创建自定义 mock 路由', Number.isFinite(providerId) && providerId > 0, `id=${providerId}`)
    const defaultProvider = await evaluate(`window.api.providers.getDefault()`)
    record(
      '模型 Provider：默认路由已生效',
      defaultProvider?.id === providerId,
      `default=${defaultProvider?.name ?? null}`
    )

    const topicId = await invoke('harness:harness-topic-create', workspaceId, '0.2.6 链路审计会话')
    record('会话：新建 topic', Number.isFinite(topicId) && topicId > 0, `topicId=${topicId}`)
    await evaluate(`window.api.systemSettings.update({ harness: { activeMode: 'chat', chatContent: { workspaceId: ${workspaceId}, topicId: ${topicId} } } })`)
    await cdp.call('Page.reload', { ignoreCache: false })
    await waitFor(`!!document.querySelector('.shell-nav')`, 30000)
    await waitFor(`!!document.querySelector('.harness-input-editor .ProseMirror')`, 30000)
    await sleep(1200)

    // ── 2) 外壳路由 ──
    const routes = await evaluate(
      `JSON.stringify([...document.querySelectorAll('.shell-nav a')].map((a) => a.getAttribute('href')).filter(Boolean))`
    )
    const routeList = JSON.parse(routes)
    record(
      '外壳：系统路由入口齐全（资料库/插件仓库/定时任务/更多）',
      ['#/notes', '#/plugins', '#/schedules'].every((h) => routeList.some((r) => r.endsWith(h))) &&
        (await evaluate(
          `[...document.querySelectorAll('.shell-nav button.shell-nav-item')].some((b) => (b.innerText || '').includes('更多'))`
        )) === true,
      routeList.join(',')
    )
    await screenshot('02-shell')
    for (const [hash, expectText, label] of [
      ['#/notes', '资料库', '资料库'],
      ['#/plugins', '插件', '插件仓库'],
      ['#/schedules', '定时任务', '定时任务'],
      ['#/harness', '对话', '对话']
    ]) {
      await goRoute(hash, 1100)
      const text = await bodyText()
      record(`路由：${label} 页面可进入`, text.includes(expectText), `hash=${await evaluate('location.hash')}`)
    }

    // ── 3) 设置弹窗 → 联网搜索页（搜索设置属于「常规」分组，只在设置弹窗里） ──
    const openSettings = async () => {
      const clicked = await evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('title') || '').startsWith('设置'))
        if (!b) return false
        b.click()
        return true
      })()`)
      await sleep(1000)
      return clicked
    }
    const settingsClicked = await openSettings()
    let settingsOpen = await evaluate(`!!document.querySelector('.ant-modal')`)
    record('设置弹窗：可打开', settingsClicked && settingsOpen, `clicked=${settingsClicked}`)
    const searchTabClicked = await evaluate(`(() => {
      const norm = (t) => (t || '').replace(/\\s+/g, '')
      const b = [...document.querySelectorAll('.ant-modal button')].find((x) => norm(x.innerText) === '联网搜索')
      if (!b) return false
      b.click()
      return true
    })()`)
    await sleep(1000)
    const searchPage = await bodyText()
    record(
      '联网搜索设置页：三组服务商可见',
      searchTabClicked && /内置|DeepSeek|Tavily/.test(searchPage),
      `tab=${searchTabClicked} ${searchPage.slice(0, 90)}`
    )
    await screenshot('02-search-settings')
    const searchSettings0 = await invoke('harness:harness-search-settings-get')
    record(
      '联网搜索：设置可读',
      !!searchSettings0 && typeof searchSettings0 === 'object',
      JSON.stringify(searchSettings0).slice(0, 200)
    )
    await invoke('harness:harness-search-provider-save-key', { provider: 'tavily', apiKey: 'tvly-audit-1234567890abcdef' })
    const searchSettings1 = await invoke('harness:harness-search-settings-get')
    const masked = JSON.stringify(searchSettings1)
    record(
      '联网搜索：密钥保存后只回掩码（前6+后6）',
      masked.includes('tvly-a') && masked.includes('abcdef') && !masked.includes('tvly-audit-1234567890abcdef'),
      masked.match(/tvly[^"]*/)?.[0] ?? 'no-mask'
    )
    await invoke('harness:harness-search-provider-clear-key', { provider: 'tavily' })
    await invoke('harness:harness-search-default-set', { provider: 'builtin' })
    const searchSettings2 = await invoke('harness:harness-search-settings-get')
    record(
      '联网搜索：默认服务商可切换',
      JSON.stringify(searchSettings2).includes('builtin'),
      JSON.stringify(searchSettings2).slice(0, 160)
    )
    await evaluate(`document.querySelector('.ant-modal .ant-modal-close')?.click()`)
    await sleep(600)

    // ── 4) 输入框三选择器 + 会话级选择持久化 ──
    await goRoute('#/harness', 1200)
    const composerButtons = await evaluate(
      `JSON.stringify([...document.querySelectorAll('button')].map((b) => (b.innerText || '').replace(/\\s+/g,' ').trim()).filter(Boolean))`
    )
    const buttonTexts = JSON.parse(composerButtons)
    record(
      '输入框：工具/技能/MCP 三个选择器都在',
      buttonTexts.some((t) => t.startsWith('工具')) &&
        buttonTexts.some((t) => t.startsWith('技能')) &&
        buttonTexts.some((t) => t.startsWith('MCP')),
      buttonTexts.filter((t) => /^(工具|技能|MCP)/.test(t)).join(' | ')
    )
    // 打开工具选择器：定时任务 / MCP 合并为单条
    const toolsOpened = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim().startsWith('工具'))
      if (!b) return false
      b.click()
      return true
    })()`)
    await sleep(800)
    const toolsPickerText = await bodyText()
    record(
      '输入框：工具清单把定时任务/MCP 合并为单项',
      toolsOpened && /定时任务/.test(toolsPickerText) && toolsPickerText.length > 80,
      `opened=${toolsOpened}`
    )
    await screenshot('03-tools-picker')
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await sleep(400)
    // 打开技能选择器
    const skillsOpened = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim().startsWith('技能'))
      if (!b) return false
      b.click()
      return true
    })()`)
    await sleep(900)
    const skillsPickerText = await bodyText()
    record(
      '输入框：技能选择器列出目录里的技能',
      skillsOpened && skillsPickerText.includes('Audit Alpha'),
      `opened=${skillsOpened}`
    )
    await screenshot('04-skills-picker')
    // 选中一个技能 → 会话级选择写入 DB
    await evaluate(`(() => {
      const el = [...document.querySelectorAll('*')].find((x) => x.children.length === 0 && (x.textContent || '').trim() === 'Audit Alpha')
      if (!el) return false
      let node = el
      while (node && node !== document.body) {
        if (node.getAttribute && node.getAttribute('role') === 'option') { node.click(); return true }
        node = node.parentElement
      }
      el.click()
      return true
    })()`)
    await sleep(1000)
    const selection = await invoke('harness:harness-topic-agent-selection-get', { topicId })
    record(
      '输入框：技能选择按会话持久化',
      JSON.stringify(selection ?? {}).includes('audit-alpha'),
      JSON.stringify(selection).slice(0, 200)
    )
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await sleep(400)

    // ── 4b) 会话状态链路：计划模式 / 目标 / 团队模式（IPC → 事件广播 → 输入区 UI） ──
    const planOn = await invoke('harness:harness-plan-set', { topicId, active: true })
    await sleep(900)
    const planUi = await bodyText()
    record(
      '计划模式：开启后输入区出现计划徽标',
      planOn?.active === true && /计划/.test(planUi),
      JSON.stringify(planOn).slice(0, 120)
    )
    await invoke('harness:harness-plan-set', { topicId, active: false })
    await sleep(500)
    const goalCreate = await invoke('harness:harness-goal-create', {
      topicId,
      objective: '0.2.6 链路审计目标：验证目标条渲染'
    })
    await sleep(900)
    const goalText = await evaluate(`document.querySelector('.inline-goal')?.innerText ?? ''`)
    record(
      '目标：创建后 goal bar 渲染目标文本',
      goalCreate?.ok === true && String(goalText).includes('0.2.6 链路审计目标'),
      JSON.stringify(goalCreate).slice(0, 140)
    )
    await screenshot('05-goal-bar')
    await invoke('harness:harness-goal-clear', topicId)
    await sleep(500)
    const teamOn = await invoke('harness:harness-team-mode-set', { topicId, enabled: true })
    await sleep(700)
    const teamState = await invoke('harness:harness-team-mode-get', topicId)
    record(
      '团队模式：开启/读取状态一致',
      teamState?.enabled === true && teamOn?.enabled !== false,
      JSON.stringify({ set: teamOn, get: teamState }).slice(0, 160)
    )
    await invoke('harness:harness-team-mode-set', { topicId, enabled: false })
    await sleep(500)

    // ── 4c) 目标轮次上限：斜杠命令进目标输入态 → 数字框 → 创建后落库 ──
    await invoke('harness:harness-goal-clear', topicId)
    await sleep(600)
    await evaluate(`(() => { const el = document.querySelector('.harness-input-editor .ProseMirror'); el.focus(); return true })()`)
    await cdp.call('Input.insertText', { text: '/' })
    const slashMenuReady = await waitFor(`!!document.querySelector('[data-harness-slash-menu]')`, 5000)
    await pressEnter()
    await sleep(900)
    const goalComposeOpened = await evaluate(
      `!!document.querySelector('.is-goal-compose') && !!document.querySelector('.ant-input-number-input')`
    )
    const roundsFilled = await evaluate(`(() => {
      const input = document.querySelector('.ant-input-number-input')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '5')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      input.blur()
      return true
    })()`)
    await evaluate(`(() => { const el = document.querySelector('.harness-input-editor .ProseMirror'); el.focus(); return true })()`)
    await cdp.call('Input.insertText', { text: '轮次上限审计目标 GOAL-ROUNDS-026' })
    await sleep(400)
    await pressEnter()
    await sleep(1800)
    const goalAfter = await invoke('harness:harness-goal-get', topicId)
    record(
      '目标：轮次上限可在输入态设置并落库（5 轮）',
      !!slashMenuReady && goalComposeOpened && roundsFilled && goalAfter?.maxGoalRounds === 5,
      JSON.stringify({
        slashMenu: !!slashMenuReady,
        opened: goalComposeOpened,
        filled: roundsFilled,
        rounds: goalAfter?.maxGoalRounds
      }).slice(0, 200)
    )
    await invoke('harness:harness-goal-clear', topicId)
    await sleep(600)

    // ── 5) MCP：真实 stdio server → 连接 → 工具清单 → 移除 ──
    const mcpServerScript = path.join(__dirname, 'mcp-audit-server.cjs')
    const mcpSave = await invoke('harness:mcp-server-save', {
      name: 'audit-echo',
      description: '0.2.6 链路审计 MCP',
      enabled: true,
      transport: 'stdio',
      command: process.execPath,
      args: [mcpServerScript],
      env: {},
      cwd: ROOT
    })
    record('MCP：保存 stdio server 配置', mcpSave === true || !!mcpSave, JSON.stringify(mcpSave).slice(0, 200))
    await invoke('harness:mcp-server-reconnect')
    let mcpView = null
    for (let i = 0; i < 30; i += 1) {
      await sleep(500)
      const views = await invoke('harness:mcp-servers-list')
      mcpView = (views || []).find((v) => v?.config?.name === 'audit-echo') ?? null
      if (mcpView && (mcpView.status === 'ok' || mcpView.status === 'error')) break
    }
    record(
      'MCP：真实连接成功并发现工具',
      mcpView?.status === 'ok' && (mcpView?.tools || []).some((t) => t.rawName === 'echo'),
      `status=${mcpView?.status} tools=${(mcpView?.tools || []).map((t) => t.rawName).join(',')}`
    )
    await goRoute('#/more/mcp', 1400)
    const mcpPageText = await bodyText()
    record('MCP 设置页：已连接 server 展示', mcpPageText.includes('audit-echo'), mcpPageText.slice(0, 100))
    await screenshot('05-mcp-settings')

    // MCP 资源浏览器：服务器卡片「资源」→ 列资源 → 点开预览文本
    const resourcesOpened = await evaluate(`(() => {
      const card = [...document.querySelectorAll('[data-mcp-row-action="resources"]')][0]
      if (!card) return false
      card.click()
      return true
    })()`)
    await sleep(1400)
    const resourceListed = await evaluate(
      `JSON.stringify({
        modal: !!document.querySelector('[data-mcp-resources-list]'),
        hasResource: !!document.querySelector('[data-mcp-resource-uri="audit://note"]'),
        text: (document.querySelector('[data-mcp-resources-list]')?.innerText || '').replace(/\\s+/g,' ').slice(0, 160)
      })`
    )
    const resourceListedInfo = JSON.parse(resourceListed)
    record(
      'MCP 资源：弹窗列出服务器暴露的 resources',
      resourcesOpened && resourceListedInfo.modal && resourceListedInfo.hasResource,
      JSON.stringify(resourceListedInfo).slice(0, 200)
    )
    if (resourceListedInfo.hasResource) {
      await evaluate(`document.querySelector('[data-mcp-resource-uri="audit://note"]')?.click()`)
      const previewText = await waitFor(
        `(document.querySelector('[data-mcp-resource-preview]')?.innerText || '').includes('audit-resource-body-026')`,
        8000
      )
      record('MCP 资源：点资源可读取并预览内容', !!previewText)
      await screenshot('05b-mcp-resource-preview')
    } else {
      record('MCP 资源：点资源可读取并预览内容', false, 'no resource row')
    }
    await evaluate(`document.querySelector('.ant-modal .ant-modal-close')?.click()`)
    await sleep(500)

    // ── 6) 技能页：搜索 / 预览 / 编辑保存 / 删除 ──
    await goRoute('#/more/skills', 1500)
    const skillsPage = await evaluate(`JSON.stringify({
      cards: document.querySelectorAll('[data-skill-id]').length,
      hasSearch: !!document.querySelector('input[placeholder="搜索技能"]'),
      fill: (() => { const el = document.querySelector('.more-fill-view'); return el ? { client: el.clientHeight, scroll: el.scrollHeight } : null })(),
      pageScroll: { client: document.documentElement.clientHeight, scroll: document.documentElement.scrollHeight }
    })`)
    const skillsInfo = JSON.parse(skillsPage)
    record(
      '技能页：发现技能且搜索框在最右',
      skillsInfo.cards === 3 && skillsInfo.hasSearch,
      `cards=${skillsInfo.cards} search=${skillsInfo.hasSearch}`
    )
    const skillTitles = await evaluate(
      `JSON.stringify([...document.querySelectorAll('[data-skill-id]')].map((c) => ({ id: c.getAttribute('data-skill-id'), text: (c.innerText || '').replace(/\\s+/g, ' ') })))`
    )
    const titles = JSON.parse(skillTitles)
    record(
      '技能页：BOM 文件按 frontmatter 解析名字 + 同名目录不被当成技能',
      titles.some((t) => t.id === 'audit-bom' && t.text.includes('Audit Bom')) &&
        !titles.some((t) => t.id === 'audit-broken'),
      JSON.stringify(titles.map((t) => t.id))
    )
    record(
      '技能页：卡片区吃满剩余高度（页面不出整页滚动条）',
      skillsInfo.pageScroll.scroll <= skillsInfo.pageScroll.client + 8,
      JSON.stringify(skillsInfo.pageScroll)
    )
    await screenshot('06-skills')
    await setInput('input[placeholder="搜索技能"]', 'alpha')
    await sleep(600)
    const filtered = await evaluate(`JSON.stringify([...document.querySelectorAll('[data-skill-id]')].map((el) => el.getAttribute('data-skill-id')))`)
    record('技能页：搜索过滤生效', JSON.parse(filtered).length === 1 && filtered.includes('audit-alpha'), filtered)
    await setInput('input[placeholder="搜索技能"]', '')
    await sleep(500)
    // 点卡片 → 共享 Markdown 预览
    await evaluate(`(() => { const c = document.querySelector('[data-skill-id]'); if (!c) return false; c.click(); return true })()`)
    await sleep(900)
    const preview = await evaluate(`JSON.stringify({
      modal: !!document.querySelector('.ant-modal .ant-modal-body'),
      text: (document.querySelector('.ant-modal')?.innerText || '').replace(/\\s+/g,' ').slice(0, 200),
      width: Math.round(document.querySelector('.ant-modal')?.getBoundingClientRect().width ?? 0)
    })`)
    const previewInfo = JSON.parse(preview)
    record(
      '技能页：点卡片打开整窗 Markdown 预览',
      previewInfo.text.includes('Audit Alpha') && previewInfo.width > 600,
      `w=${previewInfo.width}`
    )
    await screenshot('07-skill-preview')
    await evaluate(`document.querySelector('.ant-modal .ant-modal-close')?.click()`)
    await sleep(500)
    // 卡片上的编辑按钮
    const editOpened = await evaluate(`(() => {
      const card = [...document.querySelectorAll('[data-skill-id]')].find((c) => c.getAttribute('data-skill-id') === 'audit-alpha')
      const btn = card?.querySelector('button[aria-label="编辑"]')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    await sleep(1100)
    const editState = await evaluate(`JSON.stringify({
      open: !!document.querySelector('.ant-modal textarea'),
      rawStart: ([...document.querySelectorAll('.ant-modal textarea')].at(-1)?.value || '').slice(0, 24),
      rawLen: ([...document.querySelectorAll('.ant-modal textarea')].at(-1)?.value || '').length
    })`)
    const editInfo = JSON.parse(editState)
    record('技能页：编辑弹窗载入 SKILL.md 原文（含 frontmatter）', editOpened && editInfo.open && editInfo.rawStart.startsWith('---'), editState)
    await screenshot('08-skill-edit')
    const saved = await evaluate(`(async () => {
      const ta = [...document.querySelectorAll('.ant-modal textarea')].at(-1)
      if (!ta) return 'no-textarea'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ta.value + '\\n\\n<!-- audit-marker-026 -->')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 200))
      const save = [...document.querySelectorAll('.ant-modal button')].find((b) => (b.innerText || '').replace(/\\s+/g, '') === '保存')
      if (!save) return 'no-save-button'
      save.click()
      await new Promise((r) => setTimeout(r, 1500))
      return JSON.stringify({ clicked: true, modals: document.querySelectorAll('.ant-modal').length })
    })()`)
    const alphaFile = path.join(skillsRoot, 'audit-alpha', 'SKILL.md')
    const alphaContent = fs.existsSync(alphaFile) ? fs.readFileSync(alphaFile, 'utf8') : ''
    record('技能页：编辑保存写回磁盘', alphaContent.includes('audit-marker-026'), saved)

    // BOM 技能：预览不含 frontmatter，编辑原文以 --- 开头（BOM 已被剥掉），保存后文件不再带 BOM
    await evaluate(`(() => { const c = [...document.querySelectorAll('[data-skill-id]')].find((x) => x.getAttribute('data-skill-id') === 'audit-bom'); if (!c) return false; c.click(); return true })()`)
    await sleep(900)
    const bomPreview = await evaluate(
      `JSON.stringify({ text: (document.querySelector('.ant-modal')?.innerText || '').replace(/\\s+/g,' ').slice(0, 300) })`
    )
    const bomPreviewInfo = JSON.parse(bomPreview)
    record(
      '技能页：BOM 技能预览不把 frontmatter 当正文',
      bomPreviewInfo.text.includes('BOM 正文') && !bomPreviewInfo.text.includes('description:'),
      bomPreviewInfo.text.slice(0, 120)
    )
    await evaluate(`document.querySelector('.ant-modal .ant-modal-close')?.click()`)
    await sleep(500)
    const bomEditOpened = await evaluate(`(() => {
      const card = [...document.querySelectorAll('[data-skill-id]')].find((c) => c.getAttribute('data-skill-id') === 'audit-bom')
      const btn = card?.querySelector('button[aria-label="编辑"]')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    await sleep(1100)
    const bomRaw = await evaluate(
      `JSON.stringify({ start: ([...document.querySelectorAll('.ant-modal textarea')].at(-1)?.value || '').slice(0, 8) })`
    )
    record(
      '技能页：BOM 技能编辑原文以 frontmatter 开头（隐形 BOM 已剥离）',
      bomEditOpened && JSON.parse(bomRaw).start.startsWith('---'),
      bomRaw
    )
    await evaluate(`(async () => {
      const ta = [...document.querySelectorAll('.ant-modal textarea')].at(-1)
      if (!ta) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ta.value + '\\n\\n<!-- bom-marker-026 -->')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 200))
      const save = [...document.querySelectorAll('.ant-modal button')].find((b) => (b.innerText || '').replace(/\\s+/g, '') === '保存')
      if (save) save.click()
      await new Promise((r) => setTimeout(r, 1500))
      return true
    })()`)
    const bomFile = path.join(skillsRoot, 'audit-bom', 'SKILL.md')
    const bomContent = fs.existsSync(bomFile) ? fs.readFileSync(bomFile, 'utf8') : ''
    record(
      '技能页：BOM 技能保存后规范化（无 BOM、内容保留）',
      bomContent.includes('bom-marker-026') && !bomContent.startsWith('\uFEFF'),
      `bom=${bomContent.startsWith('\uFEFF')} marker=${bomContent.includes('bom-marker-026')}`
    )
    // 关掉可能还在动画/残留的弹窗，再继续后续动作（堆叠弹窗会遮住后面的点击目标）
    const closeAllModals = async () => {
      for (let i = 0; i < 4; i += 1) {
        await evaluate(`(() => {
          document.querySelectorAll('.ant-modal-close').forEach((b) => b.click())
          return true
        })()`)
        await sleep(400)
        const visible = await evaluate(`[...document.querySelectorAll('.ant-modal')].filter((m) => {
          const wrap = m.closest('.ant-modal-wrap')
          return wrap && getComputedStyle(wrap).display !== 'none' && getComputedStyle(m).display !== 'none'
        }).length`)
        if (visible === 0) return true
        await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
        await sleep(300)
      }
      return false
    }
    await closeAllModals()

    // 删除 beta
    const deleteClicked = await evaluate(`(() => {
      const card = [...document.querySelectorAll('[data-skill-id]')].find((c) => c.getAttribute('data-skill-id') === 'audit-beta')
      const btn = card?.querySelector('button[aria-label="删除"]')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    await sleep(700)
    const confirmClicked = await evaluate(`(() => {
      const confirm = [...document.querySelectorAll('.ant-modal-confirm')]
        .filter((c) => { const wrap = c.closest('.ant-modal-wrap'); return wrap && getComputedStyle(wrap).display !== 'none' })
        .at(-1)
      if (!confirm) return false
      const ok = [...confirm.querySelectorAll('button')].find((b) => ['确定','确认','OK'].includes((b.innerText || '').replace(/\\s+/g,'')))
      if (!ok) return false
      ok.click()
      return true
    })()`)
    await sleep(1500)
    const betaGone = !fs.existsSync(path.join(skillsRoot, 'audit-beta'))
    const cardsAfter = await evaluate(`document.querySelectorAll('[data-skill-id]').length`)
    record(
      '技能页：删除（二次确认）移除目录并刷新列表',
      deleteClicked && confirmClicked && betaGone && cardsAfter === 2,
      `confirm=${confirmClicked} betaGone=${betaGone} cards=${cardsAfter}`
    )
    await screenshot('09-skills-after')

    // 删除已选中的技能 → 回到对话页，技能徽标不能残留「幽灵选中」计数。
    // 用 IPC 删除（删除 UI 已在 beta 上验证过），避免与仍开着的编辑弹窗抢点击目标。
    const alphaDelete = await invoke('harness:harness-delete-skill', 'audit-alpha')
    await closeAllModals()
    await goRoute('#/notes', 900)
    await goRoute('#/more/skills', 1300)
    const alphaGone = !fs.existsSync(path.join(skillsRoot, 'audit-alpha'))
    await goRoute('#/harness', 1600)
    await waitFor(`!!document.querySelector('.harness-input-editor .ProseMirror')`, 20000)
    await sleep(1200)
    const ghost = await evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === '选择技能')
      return JSON.stringify({ found: !!btn, text: btn ? (btn.innerText || '').replace(/\\s+/g, ' ') : null })
    })()`)
    const ghostInfo = JSON.parse(ghost)
    record(
      '技能页：删除已选技能后输入框徽标不再计入幽灵选中',
      alphaDelete === true && alphaGone && ghostInfo.found && /技能\s*0/.test(ghostInfo.text || ''),
      JSON.stringify({ deleted: alphaDelete, alphaGone, ...ghostInfo })
    )

    // ── 7) 智能体表单：版式 + 校验不误报 + 新建链路 ──
    await closeAllModals()
    await goRoute('#/more/agents', 1500)
    await clickButtonByText('新建')
    await sleep(1000)
    const agentModal = await evaluate(`JSON.stringify({
      open: !!document.querySelector('.ant-modal'),
      scrollGutter: (() => { const b = document.querySelector('.ant-modal .app-modal-scroll'); return b ? getComputedStyle(b).paddingRight : null })(),
      labels: [...document.querySelectorAll('.ant-modal .ant-form-item-label > label')].slice(0, 6).map((l) => {
        const s = getComputedStyle(l)
        const inner = l.querySelector('span')
        const star = l.querySelector('span span')
        const required = (l.innerText || '').includes('*')
        return { text: (l.innerText || '').trim().slice(0, 12), labelFontSize: s.fontSize,
          innerFontSize: inner ? getComputedStyle(inner).fontSize : null,
          required,
          starAfterText: star ? (l.innerHTML.indexOf('*') > l.innerHTML.indexOf((l.innerText || '').trim().slice(0, 1))) : null,
          starColor: star ? getComputedStyle(star).color : null }
      }),
      itemGap: (() => { const it = document.querySelector('.ant-modal .ant-form-item'); return it ? getComputedStyle(it).marginBottom : null })()
    })`)
    const agentInfo = JSON.parse(agentModal)
    record('智能体表单：弹窗打开且表单滚动区右侧留 6px 滑块槽', agentInfo.open && agentInfo.scrollGutter === '6px', `gutter=${agentInfo.scrollGutter}`)
    record(
      '智能体表单：标签 12px 且必填星号在文字后',
      agentInfo.labels.some((l) => l.innerFontSize === '12px') &&
        agentInfo.labels.filter((l) => l.required).every((l) => l.starAfterText === true),
      JSON.stringify(agentInfo.labels.slice(0, 4))
    )
    record('智能体表单：字段间距 14px', agentInfo.itemGap === '14px', `gap=${agentInfo.itemGap}`)
    await screenshot('10-agent-modal')
    // 留空点保存：字段红字提示出现，且不应出现 "[object Object]" toast
    const saveClicked = await evaluate(`(() => { const norm = (t) => (t || '').replace(/\\s+/g, ''); const b = [...document.querySelectorAll('.ant-modal button')].find((x) => ['保存','确定','OK'].includes(norm(x.innerText))); if (b) b.click(); return !!b })()`)
    await sleep(1200)
    const validation = await evaluate(`JSON.stringify({
      requiredHints: /请输入英文标识名|请输入功能描述|请输入系统提示词/.test(document.body.innerText || ''),
      objectToast: (document.body.innerText || '').includes('[object Object]'),
      toasts: [...document.querySelectorAll('.ant-message-notice')].map((n) => (n.innerText || '').replace(/\\s+/g,' '))
    })`)
    const validationInfo = JSON.parse(validation)
    record(
      '智能体表单：校验失败有字段提示、无 [object Object] 误报',
      saveClicked && validationInfo.requiredHints && !validationInfo.objectToast,
      `save=${saveClicked} hints=${validationInfo.requiredHints} toasts=${JSON.stringify(validationInfo.toasts)}`
    )
    await screenshot('11-agent-validation')
    await evaluate(`document.querySelector('.ant-modal .ant-modal-close')?.click()`)
    await sleep(600)

    // 运行与安全卡：沙箱状态 + 新会话默认权限档位
    const runtimeText = await bodyText()
    record(
      '更多-智能体：运行与安全卡展示沙箱与默认权限',
      runtimeText.includes('运行与安全') &&
        runtimeText.includes('默认权限模式') &&
        runtimeText.includes('沙箱'),
      runtimeText.slice(runtimeText.indexOf('运行与安全'), runtimeText.indexOf('运行与安全') + 120)
    )
    const sandboxStatus = await invoke('harness:harness-sandbox-status')
    record(
      '沙箱：状态 IPC 可读（后端/强制级别/可用性）',
      !!sandboxStatus && typeof sandboxStatus === 'object',
      JSON.stringify(sandboxStatus).slice(0, 160)
    )
    const permBefore = await invoke('harness:harness-permission-get')
    const permSet = await invoke('harness:harness-permission-set', {
      mode: 'read-only',
      scope: 'default'
    })
    const permAfter = await invoke('harness:harness-permission-get')
    record(
      '权限：新会话默认档位可写回',
      permAfter?.defaultMode === 'read-only' || permSet?.defaultMode === 'read-only',
      JSON.stringify({ set: permSet, get: permAfter }).slice(0, 160)
    )
    await invoke('harness:harness-permission-set', {
      mode: permBefore?.defaultMode ?? 'workspace-write',
      scope: 'default'
    })
    await screenshot('11b-runtime-security')

    // ── 8) 记忆页：机制说明卡片已移除 ──
    await goRoute('#/more/memory', 1400)
    const memoryText = await bodyText()
    record(
      '记忆页：可进入且机制说明卡片已移除',
      memoryText.includes('记忆') && !memoryText.includes('记忆机制说明'),
      memoryText.slice(0, 80)
    )
    await screenshot('12-memory')

    // ── 9) 定时任务页 + 跨模式任务链路 ──
    await goRoute('#/schedules', 1400)
    const schedulesOpened = await clickButtonByText('新建任务')
    await sleep(900)
    const scheduleModal = await evaluate(`JSON.stringify({
      open: !!document.querySelector('.ant-modal'),
      text: (document.querySelector('.ant-modal')?.innerText || '').replace(/\\s+/g,' '),
      bodyClass: document.querySelector('.ant-modal .ant-modal-body')?.className ?? null,
      bodyPadRight: (() => { const b = document.querySelector('.ant-modal .ant-modal-body'); return b ? getComputedStyle(b).paddingRight : null })(),
      maxHeight: (() => { const b = document.querySelector('.ant-modal .ant-modal-body'); return b ? getComputedStyle(b).maxHeight : null })()
    })`)
    const scheduleInfo = JSON.parse(scheduleModal)
    record('定时任务页：新建弹窗可打开', schedulesOpened && scheduleInfo.open)
    record(
      '定时任务弹窗：名称在模式之前 + 目标模式/新会话/任务级选择齐全',
      scheduleInfo.text.indexOf('名称') >= 0 &&
        scheduleInfo.text.indexOf('模式') > scheduleInfo.text.indexOf('名称') &&
        scheduleInfo.text.includes('对话') &&
        scheduleInfo.text.includes('新的会话') &&
        scheduleInfo.text.includes('工具') &&
        scheduleInfo.text.includes('技能') &&
        scheduleInfo.text.includes('MCP'),
      scheduleInfo.text.slice(0, 120)
    )
    record(
      '定时任务弹窗：固定高度 + 右侧 6px 滑块槽',
      scheduleInfo.bodyPadRight === '6px' && /px/.test(scheduleInfo.maxHeight ?? ''),
      `padRight=${scheduleInfo.bodyPadRight} maxHeight=${scheduleInfo.maxHeight}`
    )
    // 必填校验
    await evaluate(`(() => { const b = [...document.querySelectorAll('.ant-modal button')].find((x) => (x.innerText||'').includes('创建任务')); if (b) b.click(); return !!b })()`)
    await sleep(800)
    record('定时任务弹窗：名称必填校验', (await bodyText()).includes('请填写任务名称'))
    await screenshot('13-schedule-editor')
    await evaluate(`document.querySelector('.ant-modal .ant-modal-close')?.click()`)
    await sleep(600)
    // 跨模式任务：IPC 创建（对话根 + 新会话）→ 列表可见 → 执行记录 → 编辑 → 删除
    const chatRoot = await invoke('harness:chat-workspaces')
    const rootId = chatRoot?.data?.rootWorkspaceId ?? workspaceId
    const createdTask = await invoke('harness:harness-schedule-create', {
      title: '审计-跨模式任务',
      prompt: 'ping 0.2.6 链路审计',
      when: { kind: 'daily', time: '09:00' },
      topicId: null,
      targetMode: 'chat',
      targetWorkspaceId: rootId,
      targetMemoryScope: 'chat',
      agentConfig: { tools: ['web_fetch'], skills: ['audit-alpha'], mcpServers: [] }
    })
    record(
      '定时任务：跨模式创建成功（新会话目标 + 任务级选择）',
      createdTask?.ok === true && createdTask?.task?.targetMode === 'chat',
      JSON.stringify(createdTask).slice(0, 240)
    )
    const taskId = createdTask?.task?.id ?? null
    await goRoute('#/notes', 900)
    await goRoute('#/schedules', 1600)
    record('定时任务页：新任务出现在卡片列表', (await bodyText()).includes('审计-跨模式任务'))
    await screenshot('14-schedules-list')
    if (taskId) {
      const runs = await invoke('harness:harness-schedule-runs', { id: taskId, limit: 20, offset: 0 })
      record('定时任务：执行记录可读', !!runs && Array.isArray(runs.runs) && runs.runs.length === 0, JSON.stringify(runs).slice(0, 160))
      const updated = await invoke('harness:harness-schedule-update-full', { id: taskId, title: '审计-跨模式任务-已改', enabled: false })
      record('定时任务：完整编辑（改名 + 暂停）', updated?.ok === true && updated?.task?.title?.includes('已改'), JSON.stringify(updated).slice(0, 200))
      const deleted = await invoke('harness:harness-schedule-update', { id: taskId, action: 'delete' })
      record('定时任务：删除', deleted?.ok === true, JSON.stringify(deleted).slice(0, 120))
    } else {
      record('定时任务：执行记录可读', false, 'no taskId')
      record('定时任务：完整编辑（改名 + 暂停）', false, 'no taskId')
      record('定时任务：删除', false, 'no taskId')
    }

    // ── 10) 其它页面：插件仓库 / 资料库 / 更多页 ──
    for (const [hash, label] of [
      ['#/plugins', '插件仓库'],
      ['#/notes', '资料库'],
      ['#/more/agents', '更多-智能体'],
      ['#/more/skills', '更多-技能'],
      ['#/more/memory', '更多-记忆'],
      ['#/more/mcp', '更多-MCP']
    ]) {
      await goRoute(hash, 1200)
      const text = await bodyText()
      const contentNodes = await evaluate(`document.querySelector('#root')?.querySelectorAll('*').length ?? 0`)
      record(`${label} 页面渲染正常`, text.trim().length > 10 && contentNodes > 50, `nodes=${contentNodes}`)
    }

    // ── 11) 真实流式对话（mock provider）：输入 → 发送 → 流式渲染 ──
    await goRoute('#/harness', 1600)
    const readyComposer = await waitFor(
      `!!document.querySelector('.harness-input-editor .ProseMirror')`,
      20000
    )
    if (readyComposer) {
      await evaluate(`(() => { const el = document.querySelector('.harness-input-editor .ProseMirror'); el.focus(); return true })()`)
      await sleep(400)
      await cdp.call('Input.insertText', { text: '链路审计消息 CHAT-AUDIT-026' })
      await sleep(500)
      await pressEnter()
      const appeared = await waitFor(
        `(document.querySelector('.harness-message-list')?.innerText || '').includes('CHAT-AUDIT-026')`,
        10000
      )
      record('对话：用户消息进入消息区', !!appeared)
      const replyAppeared = await waitFor(
        `(document.querySelector('.harness-message-list')?.innerText || '').includes(${JSON.stringify(MOCK_REPLY)})`,
        30000
      )
      record('对话：mock 模型流式回复渲染完成', !!replyAppeared, replyAppeared ? '' : 'timeout 30s')
      await sleep(1000)
      await screenshot('16-chat-roundtrip')
      const turnState = await invoke('harness:harness-turn-state', topicId)
      record('对话：本轮已收尾（turn-state 非 running）', !turnState?.running, JSON.stringify(turnState).slice(0, 160))

      // ── 11b) propose_action → 输入区预填条（消息流零留痕）──
      await evaluate(`(() => { const el = document.querySelector('.harness-input-editor .ProseMirror'); el.focus(); return true })()`)
      await sleep(300)
      await cdp.call('Input.insertText', { text: '请给我可选操作 PROPOSE-TEST' })
      await sleep(400)
      await pressEnter()
      const proposalPrefillReady = await waitFor(
        `!!document.querySelector('[data-proposal-prefill]')`,
        20000
      )
      const proposalPrefillState = JSON.parse(
        await evaluate(`JSON.stringify({
          value: document.querySelector('[data-proposal-input]')?.value ?? '',
          inMessageList: !!document.querySelector('.harness-message-list [data-proposal-prefill]'),
          messageButtons: [...document.querySelectorAll('.harness-message-list button')]
            .filter((b) => ['继续', '取消'].includes((b.innerText || '').trim())).length,
          messageHasQuestion: (document.querySelector('.harness-message-list')?.innerText || '').includes('要继续吗')
        })`)
      )
      record(
        '下一步确认：输入区出现预填条并默认回填 AI 推荐内容',
        !!proposalPrefillReady && proposalPrefillState.value === 'ACTION-CONTINUE',
        JSON.stringify(proposalPrefillState)
      )
      record(
        '下一步确认：消息流零留痕（无问题、无按钮、无卡片）',
        !proposalPrefillState.inMessageList &&
          proposalPrefillState.messageButtons === 0 &&
          !proposalPrefillState.messageHasQuestion,
        JSON.stringify(proposalPrefillState)
      )
      await screenshot('17-propose-prefill')

      // ✕ 关闭：不发消息、普通输入框恢复
      await evaluate(`document.querySelector('[data-proposal-dismiss]')?.click()`)
      await sleep(800)
      const proposalDismissed = JSON.parse(
        await evaluate(`JSON.stringify({
          bar: !document.querySelector('[data-proposal-prefill]'),
          composer: !!document.querySelector('.harness-input-editor'),
          sent: (document.querySelector('.harness-message-list')?.innerText || '').includes('ACTION-CONTINUE')
        })`)
      )
      record(
        '下一步确认：✕ 关闭不发消息且输入框恢复',
        proposalDismissed.bar && proposalDismissed.composer && !proposalDismissed.sent,
        JSON.stringify(proposalDismissed)
      )

      // 再触发一次：› 发送预填内容 → 作为下一条用户消息继续对话
      await evaluate(`(() => { const el = document.querySelector('.harness-input-editor .ProseMirror'); el.focus(); return true })()`)
      await cdp.call('Input.insertText', { text: '请给我可选操作 PROPOSE-TEST' })
      await sleep(400)
      await pressEnter()
      const proposalSecondReady = await waitFor(
        `!!document.querySelector('[data-proposal-prefill] [data-proposal-send]')`,
        20000
      )
      if (proposalSecondReady) {
        await evaluate(`(() => {
          const el = document.querySelector('[data-proposal-input]')
          if (!el) return false
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          setter.call(el, 'ACTION-CONTINUE-EDITED')
          el.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()`)
        await sleep(250)
        await evaluate(`document.querySelector('[data-proposal-send]')?.click()`)
      }
      const proposeContinueOk = await waitFor(
        `(document.querySelector('.harness-message-list')?.innerText || '').includes('ACTION-CLICKED-OK')`,
        25000
      )
      const editedPrefillSent = await waitFor(
        `(document.querySelector('.harness-message-list')?.innerText || '').includes('ACTION-CONTINUE-EDITED')`,
        5000
      )
      record(
        '下一步确认：预填内容可编辑，› 发送的是编辑后的文本',
        !!proposalSecondReady && !!proposeContinueOk && !!editedPrefillSent,
        JSON.stringify({ ready: !!proposalSecondReady, continued: !!proposeContinueOk, edited: !!editedPrefillSent })
      )
      await sleep(700)
      await screenshot('18-propose-followup')

      // ── 11c) ask_user_question → 输入区内联面板：提交继续 / 取消不终止 ──
      await evaluate(`(() => { const el = document.querySelector('.harness-input-editor .ProseMirror'); el.focus(); return true })()`)
      await sleep(300)
      await cdp.call('Input.insertText', { text: '请向我提问 ASK-TEST' })
      await sleep(400)
      await pressEnter()
      const askPanelReady = await waitFor(`!!document.querySelector('[data-ask-panel]')`, 20000)
      const askPanelShape = JSON.parse(
        await evaluate(`JSON.stringify({
          modal: !!document.querySelector('.ant-modal-content'),
          options: document.querySelectorAll('[data-ask-option]').length,
          align: getComputedStyle(document.querySelector('.ask-inline-opt') || document.body).alignItems,
          header: (document.querySelector('.ask-inline-head')?.innerText || '').replace(/\\s+/g, ' ')
        })`)
      )
      record(
        '提问：ask_user_question 以输入区内联面板出现（不再弹独立窗口）',
        !!askPanelReady && !askPanelShape.modal && askPanelShape.options >= 3,
        JSON.stringify(askPanelShape)
      )
      record(
        '提问：选项按钮与右侧内容垂直居中',
        askPanelShape.align === 'center',
        JSON.stringify({ align: askPanelShape.align })
      )
      await screenshot('19-ask-inline')

      const askStepState = JSON.parse(
        await evaluate(`JSON.stringify({
          progress: (document.querySelector('.ask-inline-progress')?.innerText || '').replace(/\\s+/g, ' '),
          hasNext: !!document.querySelector('[data-ask-next]'),
          hasSubmit: !!document.querySelector('[data-ask-submit]')
        })`)
      )
      record(
        '提问：多题时进入分步模式（下一题/提交按步骤出现）',
        askStepState.progress.includes('1 / 2') && askStepState.hasNext && !askStepState.hasSubmit,
        JSON.stringify(askStepState)
      )
      if (askPanelReady) {
        await evaluate(`document.querySelector('[data-ask-option="先跑类型检查"]')?.click()`)
        await sleep(250)
        await evaluate(`document.querySelector('[data-ask-next="1"]')?.click()`)
        await sleep(400)
        await evaluate(`(() => {
          const el = document.querySelector('[data-ask-custom="1"]')
          if (!el) return false
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          setter.call(el, '多题补充：通过')
          el.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()`)
        await sleep(250)
        await evaluate(`document.querySelector('[data-ask-submit="1"]')?.click()`)
      }
      const askAnsweredOk = await waitFor(
        `(document.querySelector('.harness-message-list')?.innerText || '').includes('ASK-ANSWER-OK')`,
        25000
      )
      const askPanelGone = await evaluate(`!document.querySelector('[data-ask-panel]')`)
      const askAnswerDetail = await evaluate(
        `(document.querySelector('.harness-message-list')?.innerText || '')`
      )
      record(
        '提问：提交回答后面板收起且本轮继续（不新开消息）',
        !!askAnsweredOk && askPanelGone,
        JSON.stringify({ answered: !!askAnsweredOk, panelGone: askPanelGone })
      )
      record(
        '提问：多题答案（选项 + 自由文本）完整回传给模型',
        /先跑类型检查/.test(askAnswerDetail) && /多题补充：通过/.test(askAnswerDetail),
        String(askAnswerDetail).replace(/\\s+/g, ' ').slice(0, 160)
      )

      // 第二次提问：点「取消」→ 面板消失、输入恢复、模型继续执行不终止
      await evaluate(`(() => { const el = document.querySelector('.harness-input-editor .ProseMirror'); el.focus(); return true })()`)
      await sleep(300)
      await cdp.call('Input.insertText', { text: '请向我提问 ASK-TEST' })
      await sleep(400)
      await pressEnter()
      const askCancelReady = await waitFor(`!!document.querySelector('[data-ask-panel] [data-ask-cancel="1"]')`, 20000)
      if (askCancelReady) {
        await evaluate(`document.querySelector('[data-ask-cancel="1"]')?.click()`)
      }
      await sleep(600)
      const cancelShape = JSON.parse(
        await evaluate(`JSON.stringify({
          panel: !!document.querySelector('[data-ask-panel]'),
          composer: !!document.querySelector('.harness-input-editor'),
          tip: (document.querySelector('.harness-message-list')?.innerText || '').includes('已取消回答')
        })`)
      )
      const askCancelOk = await waitFor(
        `(document.querySelector('.harness-message-list')?.innerText || '').includes('ASK-CANCEL-OK')`,
        25000
      )
      record(
        '提问：取消后面板消失、输入恢复、模型继续执行且不终止本轮',
        !!askCancelReady && !cancelShape.panel && cancelShape.composer && !cancelShape.tip && !!askCancelOk,
        JSON.stringify({ ...cancelShape, continued: !!askCancelOk })
      )
      await screenshot('20-ask-cancelled')

    } else {
      await screenshot('16-chat-missing')
      const chatDiag = await evaluate(
        `JSON.stringify({ hash: location.hash, body: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 240), contenteditable: document.querySelectorAll('[contenteditable="true"]').length })`
      )
      record('对话：用户消息进入消息区', false, chatDiag)
      record('对话：mock 模型流式回复渲染完成', false, 'composer not found')
      record('对话：本轮已收尾（turn-state 非 running）', false, 'composer not found')
    }

    // ── 11b2) 持久终端：xterm.js + node-pty 真终端 + 打开默认新建（用户侧不受档位限制）──
    await invoke('harness:harness-permission-set', {
      topicId,
      mode: 'workspace-write',
      scope: 'topic'
    })
    await evaluate(`document.querySelector('[data-harness-start-toggle]')?.click()`)
    await sleep(700)
    const terminalToggle = await evaluate(`(() => {
      const btn = document.querySelector('[data-start-card="terminal"]')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    await sleep(1200)
    const terminalPanelShape = JSON.parse(
      await evaluate(`JSON.stringify({
        width: Math.round(document.querySelector('[data-terminal-panel]')?.getBoundingClientRect().width ?? 0),
        xterm: !!document.querySelector('[data-terminal-panel] .xterm'),
        legacySurface: !!document.querySelector('[data-terminal-surface]'),
        visibleInputs: [...document.querySelectorAll('[data-terminal-panel] input, [data-terminal-panel] textarea')]
          .filter((el) => {
            const rect = el.getBoundingClientRect()
            const style = getComputedStyle(el)
            return rect.width > 40 && rect.height > 16 && style.opacity !== '0' && style.visibility !== 'hidden'
          }).length
      })`)
    )
    record(
      '持久终端：使用开源 xterm.js 渲染（无自绘 surface、无可见输入框）',
      terminalPanelShape.width >= 360 &&
        terminalPanelShape.xterm &&
        !terminalPanelShape.legacySurface &&
        terminalPanelShape.visibleInputs === 0,
      JSON.stringify(terminalPanelShape)
    )
    // 打开面板且没有会话：默认自动新建（不点「新建」）
    const terminalSessionReady = await waitFor(
      `!!document.querySelector('[data-terminal-session-id]') && !!document.querySelector('[data-terminal-panel] .xterm')`,
      30_000
    )
    record(
      '持久终端：打开面板后默认自动新建终端会话',
      !!terminalToggle && !!terminalSessionReady,
      JSON.stringify({ toggle: !!terminalToggle, autoSession: !!terminalSessionReady })
    )
    const ptySessions = await invoke('harness:pty-terminal-list', { topicId })
    const ptySession = (ptySessions && ptySessions.sessions && ptySessions.sessions[0]) || null
    record(
      '持久终端：主进程是真实 PTY 会话（node-pty）',
      ptySession?.alive === true && typeof ptySession?.pid === 'number' && ptySession.pid > 0,
      JSON.stringify(ptySession).slice(0, 180)
    )
    // 真终端细节①：shell 自己打印 prompt（不是前端伪造）
    const shellPrompt = await waitFor(
      `/[>#$]/.test(document.querySelector('[data-terminal-text]')?.textContent || '')`,
      15_000
    )
    const promptTail = await evaluate(
      `(document.querySelector('[data-terminal-text]')?.textContent || '').slice(-160)`
    )
    record(
      '持久终端：shell 自己输出真实 prompt',
      !!shellPrompt,
      JSON.stringify({ tail: promptTail })
    )
    const terminalFocused = await evaluate(`(() => {
      const input = document.querySelector('[data-terminal-panel] .xterm-helper-textarea')
      if (!input) return false
      input.focus()
      return true
    })()`)
    await sleep(300)
    await cdp.call('Input.insertText', { text: 'echo PTYOUT-MARK-026' })
    // 真终端细节②：PTY echo——按键内容由 shell 回显（前端不做本地 echo）
    const typedEcho = await waitFor(
      `(document.querySelector('[data-terminal-text]')?.textContent || '').includes('echo PTYOUT-MARK-026')`,
      10_000
    )
    record('持久终端：键入内容由 PTY 回显（真终端回声）', !!terminalFocused && !!typedEcho)
    await sleep(200)
    await terminalPressEnter()
    // 输出行以行首的标记出现（回显行是 "echo PTYOUT-MARK-026"，不能算执行成功）
    // ANSI 序列会夹在行首与输出之间，按「标记出现两次」判定：回显行 1 次 + 执行输出 1 次
    const terminalOutput = await waitFor(
      `(((document.querySelector('[data-terminal-text]')?.textContent || '').split('PTYOUT-MARK-026').length - 1) >= 2)`,
      20_000
    )
    const terminalTail = await evaluate(
      `(document.querySelector('[data-terminal-text]')?.textContent || '').slice(-220)`
    )
    record(
      '持久终端：workspace-write 档下用户可直接使用终端',
      (await invoke('harness:harness-permission-get', topicId))?.mode === 'workspace-write' &&
        !!terminalSessionReady &&
        !!terminalOutput,
      JSON.stringify({
        mode: (await invoke('harness:harness-permission-get', topicId))?.mode,
        session: !!terminalSessionReady,
        output: !!terminalOutput
      })
    )
    record(
      '持久终端：在 xterm 中回车执行命令并看到输出',
      !!terminalFocused && !!terminalOutput,
      JSON.stringify({ focused: !!terminalFocused, output: !!terminalOutput, tail: terminalTail })
    )
    await screenshot('21-terminal-panel')

    // 真终端细节③：收起面板不杀进程；从开始页重开恢复同一会话并回放缓冲
    await evaluate(`document.querySelector('[data-harness-start-toggle]')?.click()`)
    await sleep(600)
    const panelClosed = await evaluate(`!document.querySelector('[data-terminal-panel]')`)
    await evaluate(`document.querySelector('[data-harness-start-toggle]')?.click()`)
    await sleep(700)
    await evaluate(`document.querySelector('[data-start-card="terminal"]')?.click()`)
    await sleep(900)
    const restoredSession = await waitFor(
      `!!document.querySelector('[data-terminal-session-id]') && !!document.querySelector('[data-terminal-panel] .xterm')`,
      15_000
    )
    const restoredBuffer = await waitFor(
      `(document.querySelector('[data-terminal-text]')?.textContent || '').includes('PTYOUT-MARK-026')`,
      15_000
    )
    const sessionsAfterReopen = await invoke('harness:pty-terminal-list', { topicId })
    const sessionCount = (sessionsAfterReopen && sessionsAfterReopen.sessions
      ? sessionsAfterReopen.sessions.length
      : -1)
    record(
      '持久终端：收起面板不终止进程，重开恢复会话并回放输出',
      !!panelClosed && !!restoredSession && !!restoredBuffer && sessionCount === 1,
      JSON.stringify({ closed: !!panelClosed, restored: !!restoredSession, replay: !!restoredBuffer, count: sessionCount })
    )

    await evaluate(`document.querySelector('[data-terminal-close-tab="1"]')?.click()`)
    const terminalClosed = await waitFor(
      `!document.querySelector('[data-terminal-session-id]')`,
      10_000
    )
    const sessionsAfterClose = await invoke('harness:pty-terminal-list', { topicId })
    const countAfterClose = sessionsAfterClose && sessionsAfterClose.sessions ? sessionsAfterClose.sessions.length : -1
    record(
      '持久终端：关闭页签会结束 PTY 会话',
      !!terminalClosed && countAfterClose === 0,
      JSON.stringify({ closed: !!terminalClosed, count: countAfterClose })
    )
    // 关闭最后一个终端后侧栏已自动收起（权限档保持 workspace-write，不影响后续断言）

    // ── 11b3) 开始页 + 侧栏角标 + 应用内浏览器（顶部栏终端按钮已移除）──
    await evaluate(`document.querySelector('[data-harness-start-toggle]')?.click()`)
    await sleep(900)
    const startShape = JSON.parse(
      await evaluate(`JSON.stringify({
        page: !!document.querySelector('[data-start-page]'),
        cards: document.querySelectorAll('[data-start-card]').length,
        headerStart: !!document.querySelector('[data-harness-start-toggle]'),
        shellStartAbsent: !document.querySelector('[data-shell-start]'),
        noPanelCloseButtons:
          !document.querySelector('[data-terminal-hide]') && !document.querySelector('[data-browser-close]'),
        moreToolsCard: !!document.querySelector('[data-start-card="more"]'),
        terminalButtonInTopBar: !!document.querySelector('[data-harness-terminal-toggle]')
      })`)
    )
    record(
      '开始面板：顶部按钮入口、三个工具卡片、无内部关闭按钮、无「更多工具」',
      startShape.page &&
        startShape.cards === 3 &&
        startShape.headerStart &&
        startShape.shellStartAbsent &&
        startShape.noPanelCloseButtons &&
        !startShape.moreToolsCard &&
        !startShape.terminalButtonInTopBar,
      JSON.stringify(startShape)
    )
    await screenshot('22-start-page')

    // 从开始页选「新建终端」→ 跳回助手并自动建会话；开始页与侧栏角标显示运行数
    await evaluate(`document.querySelector('[data-start-card="terminal"]')?.click()`)
    const terminalFromStart = await waitFor(
      `!!document.querySelector('[data-terminal-panel]') && !!document.querySelector('[data-terminal-session-id]')`,
      30_000
    )
    record('开始面板：选择「新建终端」后右侧打开终端面板并建会话', !!terminalFromStart)
    // 顶部按钮：先收起终端，再打开开始面板
    await evaluate(`document.querySelector('[data-harness-start-toggle]')?.click()`)
    await sleep(500)
    await evaluate(`document.querySelector('[data-harness-start-toggle]')?.click()`)
    await sleep(1600)
    const startBadge = await waitFor(
      `(document.querySelector('[data-start-terminal-badge]')?.innerText || '').includes('1')`,
      12_000
    )
    const noSidebarEntry = await evaluate(
      `!document.querySelector('[data-harness-start-badge]')`
    )
    record(
      '开始面板：终端运行数角标显示在卡片上（侧栏入口已移除）',
      !!startBadge && noSidebarEntry,
      JSON.stringify({ start: !!startBadge, noSidebarEntry })
    )

    // 统一面板宽度：终端 → 工作区切换时右列宽度一致
    await evaluate(`document.querySelector('[data-start-card="terminal"]')?.click()`)
    await sleep(800)
    const terminalWidth = await evaluate(
      `Math.round(document.querySelector('[data-terminal-panel]')?.getBoundingClientRect().width ?? 0)`
    )
    await evaluate(`document.querySelector('[data-harness-start-toggle]')?.click()`)
    await sleep(500)
    await evaluate(`document.querySelector('[data-harness-start-toggle]')?.click()`)
    await sleep(700)
    await evaluate(`document.querySelector('[data-start-card="workspace"]')?.click()`)
    await waitFor(`!!document.querySelector('[data-workspace-panel]')`, 8_000)
    const workspaceWidth = await evaluate(
      `Math.round(document.querySelector('[data-workspace-panel]')?.getBoundingClientRect().width ?? 0)`
    )
    record(
      '右列面板宽度统一（终端与工作区切换不跳宽）',
      terminalWidth >= 360 && Math.abs(terminalWidth - workspaceWidth) <= 2,
      JSON.stringify({ terminalWidth, workspaceWidth })
    )

    // 浏览器：开始面板选择 → 空白页 → 地址栏 Enter 后加载
    await evaluate(`document.querySelector('[data-harness-start-toggle]')?.click()`)
    await sleep(500)
    await evaluate(`document.querySelector('[data-harness-start-toggle]')?.click()`)
    await sleep(700)
    await evaluate(`document.querySelector('[data-start-card="browser"]')?.click()`)
    const browserReady = await waitFor(`!!document.querySelector('[data-browser-panel]')`, 20_000)
    const browserBlankState = JSON.parse(
      await evaluate(`JSON.stringify({
        panel: !!document.querySelector('[data-browser-panel]'),
        blank: !!document.querySelector('[data-browser-blank="1"]'),
        webviewBeforeInput: !!document.querySelector('[data-browser-webview]'),
        hasOpenButton: !!document.querySelector('[data-browser-go]')
      })`)
    )
    record(
      '浏览器：开始面板选择后打开（空白起始，不预设网站、无「打开」按钮）',
      !!browserReady &&
        browserBlankState.blank &&
        !browserBlankState.webviewBeforeInput &&
        !browserBlankState.hasOpenButton,
      JSON.stringify(browserBlankState)
    )
    if (browserReady) {
      await evaluate(`(() => {
        const input = document.querySelector('[data-browser-address]')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, 'https://example.com')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.focus()
        return true
      })()`)
      await evaluate(`(() => {
        const input = document.querySelector('[data-browser-address]')
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        return true
      })()`)
      const browserTitle = await waitFor(
        `(document.querySelector('[data-browser-panel]')?.innerText || '').includes('Example Domain')`,
        20_000
      )
      const browserDebug = JSON.parse(
        await evaluate(`JSON.stringify({
          address: document.querySelector('[data-browser-address]')?.value ?? null,
          hasGo: !!document.querySelector('[data-browser-go]'),
          webviewSrc: document.querySelector('[data-browser-webview]')?.src ?? null,
          webviewUrl: (() => { try { return document.querySelector('[data-browser-webview]')?.getURL?.() ?? null } catch (err) { return 'ERR:' + String(err) } })(),
          hasLoadURL: typeof document.querySelector('[data-browser-webview]')?.loadURL,
          panelText: (document.querySelector('[data-browser-panel]')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 160)
        })`)
      )
      record(
        '浏览器：地址栏 Enter 加载网页并在标签/标题显示（无「打开」按钮）',
        !!browserTitle && !browserDebug.hasGo,
        JSON.stringify(browserDebug)
      )
      await screenshot('23-browser-panel')
      await evaluate(`document.querySelector('[data-harness-start-toggle]')?.click()`)
      await sleep(500)
    }

    // 清理：结束开始页创建的终端会话，回到助手页继续后续检索断言
    const cleanupSessions = await invoke('harness:pty-terminal-list', { topicId })
    for (const session of cleanupSessions?.sessions ?? []) {
      await invoke('harness:pty-terminal-close', { sessionId: session.sessionId })
    }
    await goRoute('#/harness', 1400)

    // ── 11c) 会话检索：标题 + 正文混合结果 → 点正文命中定位 ──
    const searchTopicId = await invoke(
      'harness:harness-topic-create',
      workspaceId,
      '检索目标会话 SEARCH-026'
    )
    const searchDialogueId = await invoke('harness:harness-dialogue-add', {
      topic_id: searchTopicId,
      role: 'user',
      content: '正文关键词 SEARCH-026 用于侧栏检索定位'
    })
    await invoke('harness:harness-dialogue-add', {
      topic_id: searchTopicId,
      role: 'assistant',
      content: '已收到 SEARCH-026，这条是助手回复。'
    })
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await sleep(400)
    const searchOpened = await evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('搜索'))
      if (!btn) return false
      btn.click()
      return true
    })()`)
    await sleep(700)
    const searchInputReady = await setInput('input[placeholder="搜索会话"]', 'SEARCH-026')
    await sleep(1600)
    const panelState = JSON.parse(
      await evaluate(`JSON.stringify({
        panel: !!document.querySelector('[data-harness-search-results]'),
        dialogueHit: !!document.querySelector('[data-search-dialogue-id="${searchDialogueId}"]'),
        topicHit: !!document.querySelector('[data-search-topic-id="${searchTopicId}"]'),
        groupTitles: (document.querySelector('[data-harness-search-results]')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 160)
      })`)
    )
    record(
      '会话检索：侧栏搜索返回标题 + 正文混合结果',
      searchOpened && searchInputReady && panelState.panel && panelState.dialogueHit && panelState.topicHit,
      JSON.stringify(panelState).slice(0, 220)
    )
    if (panelState.dialogueHit) {
      await evaluate(
        `document.querySelector('[data-search-dialogue-id="${searchDialogueId}"]')?.click()`
      )
      const highlightSeen = await waitFor(`!!document.querySelector('.harness-jump-highlight')`, 6000)
      await sleep(400)
      const afterJump = JSON.parse(
        await evaluate(`JSON.stringify({
          selected: document.querySelector('[data-topic-id="${searchTopicId}"]')?.getAttribute('data-topic-selected'),
          keyword: (document.querySelector('.harness-message-list')?.innerText || '').includes('SEARCH-026')
        })`)
      )
      record(
        '会话检索：点正文命中打开会话并滚动高亮目标消息',
        !!highlightSeen && afterJump.selected === '1' && afterJump.keyword,
        JSON.stringify({ highlightSeen: !!highlightSeen, ...afterJump })
      )
      await screenshot('19-session-search')
    } else {
      record('会话检索：点正文命中打开会话并滚动高亮目标消息', false, 'no dialogue hit row')
    }
    await invoke('harness:harness-topic-delete', searchTopicId)

    // ── 11d) 深分页命中：目标在第 2 页之外，点命中后要自动翻页再定位 ──
    const deepSeed = JSON.parse(
      await evaluate(`(async () => {
        const topicId = await window.api.system.invoke('harness:harness-topic-create', ${workspaceId}, '深分页检索 SEARCH-OLD-026')
        let firstId = 0
        for (let i = 0; i < 30; i += 1) {
          const content = i === 0 ? '更早的消息 SEARCH-OLD-026 在深分页里' : '填充消息 ' + i
          const id = await window.api.system.invoke('harness:harness-dialogue-add', {
            topic_id: topicId,
            role: i % 2 === 0 ? 'user' : 'assistant',
            content
          })
          if (i === 0) firstId = id
        }
        return JSON.stringify({ topicId, firstId })
      })()`)
    )
    await sleep(600)
    const deepSearchOpened = await evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('搜索'))
      if (!btn) return false
      btn.click()
      return true
    })()`)
    await sleep(600)
    await setInput('input[placeholder="搜索会话"]', 'SEARCH-OLD-026')
    await sleep(1800)
    const deepHitExists = await evaluate(
      `!!document.querySelector('[data-search-dialogue-id="${deepSeed.firstId}"]')`
    )
    if (deepHitExists) {
      await evaluate(
        `document.querySelector('[data-search-dialogue-id="${deepSeed.firstId}"]')?.click()`
      )
      const deepHighlight = await waitFor(`!!document.querySelector('.harness-jump-highlight')`, 8000)
      const deepState = JSON.parse(
        await evaluate(`JSON.stringify({
          selected: document.querySelector('[data-topic-id="${deepSeed.topicId}"]')?.getAttribute('data-topic-selected'),
          target: (document.querySelector('.harness-message-list')?.innerText || '').includes('SEARCH-OLD-026'),
          olderPageLoaded: (document.querySelector('.harness-message-list')?.innerText || '').includes('填充消息 9')
        })`)
      )
      record(
        '会话检索：首屏之外的正文命中会自动翻页并定位高亮',
        deepSearchOpened && !!deepHighlight && deepState.selected === '1' && deepState.target && deepState.olderPageLoaded,
        JSON.stringify({ hit: deepHitExists, highlight: !!deepHighlight, ...deepState })
      )
      await screenshot('20-session-search-deep')
    } else {
      record('会话检索：首屏之外的正文命中会自动翻页并定位高亮', false, 'deep hit not found')
    }
    await invoke('harness:harness-topic-delete', deepSeed.topicId)

    // ── 12) 汇总渲染层错误 ──
    const jsErrors = (await evaluate(`JSON.stringify(window.__auditErrors || [])`)) || '[]'
    const benign = /(ERR_NAME_NOT_RESOLVED|net::ERR|ResizeObserver loop|Error fetching IP data|favicon|DevTools|Download the React DevTools)/i
    const realErrors = pageErrors.filter((e) => !benign.test(e))
    record(
      '运行时：无未捕获异常/控制台错误',
      realErrors.length === 0,
      realErrors.slice(0, 3).join(' || ').slice(0, 500)
    )

    const passed = results.length - failed
    const report = {
      at: new Date().toISOString(),
      branch: await new Promise((resolve) => {
        try {
          resolve(
            execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim() +
              '@' +
              execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
          )
        } catch {
          resolve('unknown')
        }
      }),
      summary: `${passed}/${results.length} passed`,
      failed,
      results,
      pageErrors: realErrors.slice(0, 50),
      rawPageErrors: pageErrors.slice(0, 100),
      jsErrors: JSON.parse(jsErrors)
    }
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2))
    console.log(`\nSUMMARY: ${passed}/${results.length} passed, failed=${failed}`)
    console.log(`REPORT: ${REPORT}`)
  } finally {
    try {
      cdp?.close()
    } catch {
      /* ignore */
    }
    mock.server.close()
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    } catch {
      /* already exited */
    }
    await sleep(800)
    try {
      fs.rmSync(profile, { recursive: true, force: true })
    } catch {
      console.log('profile cleanup failed (locked):', profile)
    }
  }
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('AUDIT ERROR:', err)
  try {
    execSync(`taskkill /PID ${process.pid} /T /F`, { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
  process.exit(2)
})
