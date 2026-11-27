#!/usr/bin/env node
/**
 * UI 预览截图（不是测试）：起一份 out/ 生产构建 + 临时 profile，按用户确认的路径截几张图：
 *   1) 初始助手页：右侧**没有**资源管理器面板
 *   2) 点击对话侧栏「开始」→ 右侧出现开始工具面板
 *   3) 开始面板选「新建终端」→ 右侧切换到终端
 *   4) 开始面板选「浏览器」→ 右侧切换到浏览器
 *
 * 产物：.tmp/ui-preview/*.png
 */
const { spawn, execSync } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, '.tmp', 'ui-preview')
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
fs.mkdirSync(OUT, { recursive: true })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-ui-preview-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function createCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
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
    await sleep(400)
  }
  throw new Error('renderer page not found')
}

;(async () => {
  const port = 9600
  const appEnv = { ...process.env }
  delete appEnv.ELECTRON_RUN_AS_NODE
  const log = fs.createWriteStream(path.join(OUT, 'app.log'))
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
    cwd: ROOT,
    env: appEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false
  })
  child.stdout.pipe(log)
  child.stderr.pipe(log)

  let cdp = null
  try {
    const page = await waitForPage(port)
    cdp = createCdp(page.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.call('Runtime.enable')
    await cdp.call('Page.enable')

    const evaluate = async (expression) => {
      const r = await cdp.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      })
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'page error')
      }
      return r.result?.value
    }
    const waitFor = async (expression, timeoutMs = 20000) => {
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        try {
          if (await evaluate(expression)) return true
        } catch {
          /* retry */
        }
        await sleep(250)
      }
      return false
    }
    const shot = async (name) => {
      const result = await cdp.call('Page.captureScreenshot', { format: 'png' })
      if (result?.data) fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'))
      console.log('SHOT', name)
    }
    const invoke = async (channel, ...args) =>
      evaluate(
        `window.api.system.invoke(${JSON.stringify(channel)}${args.length ? ', ' + args.map((a) => JSON.stringify(a)).join(', ') : ''})`
      )

    await sleep(2500)
    // 准备：工作区 + conversation topic + 一个默认 provider（不联网，只影响欢迎页/输入框）
    const setup = await invoke('harness:chat-ensure-workspace')
    const workspaceId = setup?.data?.workspaceId ?? null
    const providerId = await evaluate(
      `window.api.providers.create(${JSON.stringify({
        name: 'UI Preview Provider',
        provider: 'custom',
        base_url: 'http://127.0.0.1:9',
        api_key: 'preview-key',
        model: 'preview-model',
        thinking_mode: 'off',
        is_default: true,
        extra_config: { api_format: 'openai', streaming: true }
      })})`
    )
    console.log('workspace', workspaceId, 'provider', providerId)
    const topicId = await invoke('harness:harness-topic-create', workspaceId, '开始面板 UI 预览')
    await evaluate(
      `window.api.systemSettings.update({ harness: { activeMode: 'chat', chatContent: { workspaceId: ${workspaceId}, topicId: ${topicId} } } })`
    )
    await cdp.call('Page.reload', { ignoreCache: false })
    await waitFor(`!!document.querySelector('.harness-input-editor .ProseMirror')`, 30000)
    // 等启动遮罩/入场动画结束，避免截到 splash
    await sleep(6000)

    // 1) 初始：右侧不应有资源管理器/任何面板
    const initial = JSON.parse(
      await evaluate(`JSON.stringify({
        rightPanels: document.querySelectorAll('[data-workspace-panel]').length,
        startEntry: !!document.querySelector('[data-harness-start-toggle]')
      })`)
    )
    console.log('INITIAL', JSON.stringify(initial))
    await shot('01-initial-no-panel')

    // 2) 点开始：右侧开始面板
    await evaluate(`document.querySelector('[data-harness-start-toggle]')?.click()`)
    await waitFor(`!!document.querySelector('[data-start-page]')`, 12000)
    await sleep(500)
    await shot('02-start-panel')

    // 3) 新建终端：右侧终端
    await evaluate(`document.querySelector('[data-start-card="terminal"]')?.click()`)
    await waitFor(`!!document.querySelector('[data-terminal-session-id]')`, 30000)
    await sleep(800)
    await shot('03-terminal-panel')

    // 4) 顶部「1」按钮：收起所有右侧面板（面板内不再有「2」关闭按钮）
    await evaluate(`document.querySelector('[data-harness-start-toggle]')?.click()`)
    await waitFor(`!document.querySelector('[data-terminal-panel]')`, 12000)
    await sleep(500)
    await shot('03b-panel-closed-by-top-button')

    // 重新打开终端，继续验证「关最后一个页签 → 侧栏自动收起」
    await evaluate(`document.querySelector('[data-harness-start-toggle]')?.click()`)
    await waitFor(`!!document.querySelector('[data-start-page]')`, 12000)
    await evaluate(`document.querySelector('[data-start-card="terminal"]')?.click()`)
    await waitFor(`!!document.querySelector('[data-terminal-session-id]')`, 20000)
    await sleep(800)

    // 4) 关掉最后一个终端页签 → 终端侧栏自动收起（不保留空终端区）
    await evaluate(`document.querySelector('[data-terminal-close-tab="1"]')?.click()`)
    await waitFor(`!document.querySelector('[data-terminal-panel]')`, 12000)
    await sleep(600)
    const terminalClosed = await evaluate(`!document.querySelector('[data-terminal-panel]')`)
    console.log('TERMINAL_CLOSED', terminalClosed)
    await shot('05-terminal-empty-closed')

    // 4) 浏览器：右侧浏览器
    await evaluate(`document.querySelector('[data-harness-start-toggle]')?.click()`)
    await waitFor(`!!document.querySelector('[data-start-page]')`, 12000)
    await sleep(400)
    await evaluate(`document.querySelector('[data-start-card="browser"]')?.click()`)
    await waitFor(`!!document.querySelector('[data-browser-panel] [data-browser-blank="1"]')`, 15000)
    await sleep(500)
    await shot('04-browser-blank')

    // 两个标签时的标签栏（检查紧凑/对齐）
    await evaluate(`document.querySelector('[data-browser-new-tab]')?.click()`)
    await sleep(500)
    await shot('04a-browser-two-tabs')
    await evaluate(`(() => {
      const closes = document.querySelectorAll('[data-browser-close-tab]')
      closes[closes.length - 1]?.click()
      return true
    })()`)
    await sleep(400)

    // 标签搜索面板（打开中 + 最近关闭）
    await evaluate(`document.querySelector('[data-browser-tab-search]')?.click()`)
    await waitFor(`!!document.querySelector('[data-browser-tab-search-panel]')`, 8000)
    await sleep(500)
    await shot('04b-browser-tab-search')
    await evaluate(`document.querySelector('[data-browser-tab-search]')?.click()`)

    // 用户输入网址后才加载真实网页
    await evaluate(`(() => {
      const input = document.querySelector('[data-browser-address]')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'https://example.com')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
      return true
    })()`)
    await sleep(200)
    await evaluate(`(() => {
      const input = document.querySelector('[data-browser-address]')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    await waitFor(`!!document.querySelector('[data-browser-webview]')`, 15000)
    await sleep(2500)
    await shot('04-browser-loaded')
  } catch (err) {
    console.log('FAIL', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  } finally {
    try {
      cdp?.close()
    } catch {
      /* ignore */
    }
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    } catch {
      /* exited */
    }
    log.end()
  }
})()
