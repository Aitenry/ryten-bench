/**
 * 打包产物 E2E 冒烟：启动 dist-e2e 的 RytenBench.exe（临时 userData + CDP），
 * 等渲染页起来后读 DOM 状态并截图，然后杀掉进程树。
 *
 * 用法：node .tmp/e2e-smoke.cjs <exePath>
 *
 * 关注点：
 * - 打包态能否正常启动（不因 asar 缺文件/迁移失败直接退出）；
 * - 预加载桥（window.api.system.invoke）是否存在；
 * - 渲染层是否挂载出真实界面（节点数、正文片段）；
 * - 截图留档供人工/视觉复核。
 */
const { spawn, execSync } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const exe = process.argv[2]
if (!exe) {
  console.error('usage: node e2e-smoke.cjs <exePath>')
  process.exit(2)
}

const PORT = 9223
const userData = path.join(os.tmpdir(), `rb-e2e-userdata-${Date.now()}`)
const logPath = path.join(process.cwd(), '.tmp', 'e2e-app.log')
const log = fs.createWriteStream(logPath)

// 外层 harness 会设 ELECTRON_RUN_AS_NODE=1；带着它启动打包产物会退化成 Node 进程
// （Chromium 开关一律报 bad option，退出码 9），这里必须剥掉。
const appEnv = { ...process.env }
delete appEnv.ELECTRON_RUN_AS_NODE

const child = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
  detached: false,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false,
  env: appEnv
})
child.stdout.pipe(log)
child.stderr.pipe(log)
let exited = false
child.on('exit', (code) => {
  exited = true
  console.log('APP_EXIT', code)
})

const getJson = (url) =>
  new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (err) {
            reject(err)
          }
        })
      })
      .on('error', reject)
  })

async function findPage() {
  for (let i = 0; i < 120; i++) {
    if (exited) throw new Error('app exited before the renderer page appeared')
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      const page = list.find((target) => target.type === 'page' && /index\.html/.test(target.url))
      if (page) return page
    } catch {
      // 调试端口尚未就绪
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('renderer page not found')
}

async function probe(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const callId = ++id
      pending.set(callId, resolve)
      ws.send(JSON.stringify({ id: callId, method, params }))
    })

  await send('Runtime.enable')
  await send('Page.enable')
  // 给首屏（DB 初始化 + 路由挂载）留出时间
  await new Promise((resolve) => setTimeout(resolve, 4000))

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    return result.result?.result?.value
  }

  const dom = await evaluate(`JSON.stringify({
    title: document.title,
    url: location.href,
    api: typeof window.api,
    systemInvoke: typeof window.api?.system?.invoke,
    rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
    nodes: document.querySelectorAll('*').length,
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400)
  })`)

  // ── 新增能力检查：定时任务跨模式目标 + 会话级选择（走真实 IPC + DB） ──
  const scheduleFlow = await evaluate(`(async () => {
    try {
      const inv = window.api.system.invoke
      await inv('harness:chat-ensure-workspace')
      const chat = await inv('harness:chat-workspaces')
      const rootId = chat?.data?.rootWorkspaceId ?? null
      const created = await inv('harness:harness-schedule-create', {
        title: 'E2E cross-mode task',
        prompt: 'ping',
        when: { kind: 'daily', time: '09:00' },
        topicId: null,
        targetMode: 'chat',
        targetWorkspaceId: rootId,
        targetMemoryScope: 'chat',
        agentConfig: { tools: ['web_fetch'], skills: ['demo-skill'], mcpTools: ['mcp@demo'] }
      })
      const list = await inv('harness:harness-schedule-list')
      const createdId = created?.task?.id
      const saved = (list || []).find((task) => task.id === createdId) || null
      let deleted = null
      if (saved) {
        deleted = await inv('harness:harness-schedule-update', { id: saved.id, action: 'delete' })
      }
      return JSON.stringify({
        created: created?.ok === true,
        createdError: created?.ok === true ? null : created?.error,
        saved: saved
          ? {
              topicId: saved.topicId,
              targetMode: saved.targetMode,
              targetWorkspaceId: saved.targetWorkspaceId,
              targetMemoryScope: saved.targetMemoryScope,
              agentConfig: saved.agentConfig
            }
          : null,
        deleted: deleted?.ok === true
      })
    } catch (error) {
      return JSON.stringify({ failed: String(error) })
    }
  })()`)
  console.log('SCHEDULE_FLOW', scheduleFlow)

  // ── 工具清单：定时任务/MCP 合并成一个选择项 ──
  const mergedTools = await evaluate(`(async () => {
    try {
      const tools = await window.api.system.invoke('harness:harness-get-tools')
      const names = (tools || []).map((tool) => tool.name)
      return JSON.stringify({
        hasScheduleGroup: names.includes('schedule-tasks'),
        hasMcpGroup: names.includes('mcp'),
        hasIndividualScheduleTools: names.some((name) => name.startsWith('schedule_')),
        hasIndividualMcpResourceTools: names.some((name) => name.startsWith('list_mcp_') || name === 'read_mcp_resource')
      })
    } catch (error) {
      return JSON.stringify({ failed: String(error) })
    }
  })()`)
  console.log('MERGED_TOOLS', mergedTools)

  // ── 页面检查：定时任务页（模式/新会话控件）与 composer 的 MCP 选择器 ──
  // 先确保对话工作区存在并刷新：全新临时 profile 首启会停在「配置工作区」空态，
  // 不进入 harness 对话页就没有 composer，MCP 选择器检查会假失败。
  const ensureWorkspace = await evaluate(`(async () => {
    try {
      const ensured = await window.api.system.invoke('harness:chat-ensure-workspace')
      const workspaceId = ensured?.data?.workspaceId
      const topicId = await window.api.system.invoke('harness:harness-topic-create', workspaceId, '打包冒烟会话')
      // 没有模型供应商时 composer 会换成「去配置模型」引导，MCP 选择器检查就无从谈起；
      // 这里塞一个不指向真实服务的占位路由，只为让 composer 正常渲染（不会发起请求）。
      const providerId = await window.api.providers.create({
        name: 'E2E Mock Provider',
        provider: 'custom',
        base_url: 'http://127.0.0.1:9',
        api_key: 'e2e-key',
        model: 'e2e-model',
        thinking_mode: 'off',
        is_default: true,
        extra_config: { api_format: 'openai' }
      })
      await window.api.systemSettings.update({
        harness: { activeMode: 'chat', chatContent: { workspaceId, topicId } }
      })
      return JSON.stringify({ ok: ensured?.ok === true, workspaceId, topicId, providerId })
    } catch (error) {
      return JSON.stringify({ failed: String(error) })
    }
  })()`)
  console.log('ENSURE_WORKSPACE', ensureWorkspace)
  await evaluate(`location.reload()`)
  await new Promise((resolve) => setTimeout(resolve, 7000))

  const pageChecks = await evaluate(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const buttonTexts = () => [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim())
    location.hash = '#/schedules'
    await wait(1200)
    const schedulesText = (document.body.innerText || '').replace(/\\s+/g, ' ')
    const hasSchedulePage = schedulesText.includes('定时任务')
    const opened = await (async () => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('新建任务'))
      if (!btn) return false
      btn.click()
      await wait(900)
      return true
    })()
    const modalText = opened
      ? ((document.querySelector('.ant-modal')?.innerText || '').replace(/\\s+/g, ' '))
      : ''
    // 必填校验：名称留空点「创建任务」应出现「请填写任务名称」
    let titleRequiredHint = false
    const createButton = [...document.querySelectorAll('.ant-modal button')].find((b) =>
      (b.innerText || '').includes('创建任务')
    )
    if (createButton) {
      createButton.click()
      await wait(600)
      titleRequiredHint = (document.body.innerText || '').includes('请填写任务名称')
    }
    const hasMode = modalText.includes('对话') && modalText.includes('工作') && modalText.includes('插件')
    const hasNewSession = modalText.includes('新的会话')
    const titleIndex = modalText.indexOf('名称')
    const modeIndex = modalText.indexOf('模式')
    const titleFirst = titleIndex >= 0 && modeIndex > titleIndex
    const hasAgentConfig = modalText.includes('工具') && modalText.includes('技能') && modalText.includes('MCP')
    const compactRows = modalText.includes('执行时间') && modalText.includes('下次触发')
    location.hash = '#/harness'
    await wait(1200)
    const composerText = (document.body.innerText || '').replace(/\\s+/g, ' ')
    return JSON.stringify({
      hasSchedulePage,
      openedNewTaskModal: opened,
      hasModeSelector: hasMode,
      hasNewSessionOption: hasNewSession,
      hasTaskAgentConfig: hasAgentConfig,
      titleFieldFirst: titleFirst,
      titleRequiredHint,
      compactRows,
      composerHasMcpButton: buttonTexts().some((text) => text.startsWith('MCP')),
      composerTextSample: composerText.slice(0, 220)
    })
  })()`)
  console.log('PAGE_CHECKS', pageChecks)

  // 定时任务页 + 新建弹窗截图（人工核对版式用）
  const shotState = await evaluate(`(async () => {
    location.hash = '#/schedules'
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const clickNewTask = () => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        (b.innerText || '').includes('新建任务')
      )
      if (btn) btn.click()
      return Boolean(btn)
    }
    let clicked = clickNewTask()
    await new Promise((resolve) => setTimeout(resolve, 900))
    let modalOpen = Boolean(document.querySelector('.ant-modal'))
    if (!modalOpen) {
      clicked = clickNewTask() || clicked
      await new Promise((resolve) => setTimeout(resolve, 1200))
      modalOpen = Boolean(document.querySelector('.ant-modal'))
    }
    const modal = document.querySelector('.ant-modal')
    const wrap = document.querySelector('.ant-modal-wrap')
    const rect = modal?.getBoundingClientRect()
    const styles = modal ? window.getComputedStyle(modal) : null
    return JSON.stringify({
      clicked,
      modalOpen,
      modalText: modal ? (modal.innerText || '').replace(/\s+/g, ' ').slice(0, 60) : null,
      rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
      display: styles?.display ?? null,
      visibility: styles?.visibility ?? null,
      opacity: styles?.opacity ?? null,
      wrapDisplay: wrap ? window.getComputedStyle(wrap).display : null
    })
  })()`)
  console.log('SHOT_STATE', shotState)
  await send('Page.bringToFront')
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const shotSchedules = await send('Page.captureScreenshot', { format: 'png' })
  if (shotSchedules.result?.data) {
    fs.writeFileSync(
      path.join(process.cwd(), '.tmp', 'e2e-schedules-modal.png'),
      Buffer.from(shotSchedules.result.data, 'base64')
    )
    console.log('SCREENSHOT_SCHEDULES', path.join('.tmp', 'e2e-schedules-modal.png'))
  }

  // 打包态真终端：开始页 → 新建终端，验证 node-pty 原生模块在 asar.unpacked 里可用
  const ptyCheck = await evaluate(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    location.hash = '#/harness'
    await wait(1600)
    document.querySelector('[data-harness-start-toggle]')?.click()
    await wait(700)
    const startPage = !!document.querySelector('[data-start-page]')
    const card = document.querySelector('[data-start-card="terminal"]')
    if (!card) return JSON.stringify({ ok: false, reason: 'start page terminal card missing', startPage })
    card.click()
    const started = Date.now()
    while (Date.now() - started < 35000) {
      const hasSession = !!document.querySelector('[data-terminal-session-id]')
      const text = document.querySelector('[data-terminal-text]')?.textContent || ''
      if (hasSession && text.length > 0) break
      await wait(500)
    }
    const text = document.querySelector('[data-terminal-text]')?.textContent || ''
    const sessions = document.querySelectorAll('[data-terminal-session-id]').length
    const hasXterm = !!document.querySelector('[data-terminal-panel] .xterm')
    document.querySelector('[data-harness-start-toggle]')?.click()
    return JSON.stringify({
      ok: startPage && sessions > 0 && hasXterm && text.length > 0,
      startPage,
      sessions,
      hasXterm,
      textLength: text.length,
      tail: text.slice(-120)
    })
  })()`)
  console.log('PTY_CHECK', ptyCheck)
  if (!JSON.parse(ptyCheck).ok) process.exitCode = 1

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) {
    fs.writeFileSync(path.join(process.cwd(), '.tmp', 'e2e-startup.png'), Buffer.from(shot.result.data, 'base64'))
    console.log('SCREENSHOT', path.join('.tmp', 'e2e-startup.png'))
  }

  // 控制台错误与运行时报错（首屏阶段）
  const errors = await evaluate(`JSON.stringify(window.__dshSmokeErrors || [])`)

  ws.close()
  return { dom, errors }
}

;(async () => {
  try {
    const page = await findPage()
    console.log('PAGE', JSON.stringify({ title: page.title, url: page.url }))
    const { dom, errors } = await probe(page.webSocketDebuggerUrl)
    console.log('DOM', dom)
    console.log('ERRORS', errors)
    if (!dom) process.exitCode = 1
  } catch (err) {
    console.log('FAIL', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  } finally {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    } catch {
      // 已退出
    }
    log.end()
  }
})()
