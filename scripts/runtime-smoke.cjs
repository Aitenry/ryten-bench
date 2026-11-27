/**
 * 构建产物运行时冒烟（真实 Electron 主进程 + CDP 检查渲染层与 preload 桥）。
 *
 * 为什么需要：typecheck/build/单测都过了，仍可能有「应用起不来 / 渲染层白屏 /
 * preload 桥缺失 / 路由崩」这类只在运行时暴露的问题。本脚本用真实 Electron 启动
 * `out/` 产物（临时 userData，不碰开发数据），通过 CDP：
 *   1. 等主窗口渲染完成；
 *   2. 断言 `window.api.system.invoke` 等桥存在、DOM 已挂载、正文非空；
 *   3. 逐个切换系统路由（#/harness、#/notes、#/more）确认懒加载路由不白屏；
 *   4. 收集渲染进程 console.error / 未捕获异常，并截图留档。
 *
 * 用法：`node scripts/runtime-smoke.cjs`（需先 `npm run build`）
 * 退出码：0 = 全部通过；1 = 有失败项（日志尾部与截图路径会打印出来）。
 */
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const PORT = Number(process.env.SMOKE_PORT || 9225)
const ROOT = path.resolve(__dirname, '..')
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-runtime-smoke-'))
const OUT_DIR = path.join(ROOT, '.tmp')
fs.mkdirSync(OUT_DIR, { recursive: true })
const LOG_PATH = path.join(OUT_DIR, 'runtime-smoke-app.log')
const SHOT_PATH = path.join(OUT_DIR, 'runtime-smoke.png')
const logStream = fs.createWriteStream(LOG_PATH)

function getJson(url) {
  return new Promise((resolve, reject) => {
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
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function findPage(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      const page = list.find((target) => target.type === 'page' && /index\.html/.test(target.url))
      if (page && page.webSocketDebuggerUrl) return page
    } catch {
      // devtools 端口尚未就绪
    }
    await sleep(500)
  }
  throw new Error(`CDP page did not appear within ${timeoutMs}ms`)
}

function createCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
      return
    }
    if (message.method) events.push(message)
  })
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('CDP websocket error')))
  })
  const send = async (method, params = {}) => {
    await opened
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  return { send, events, close: () => ws.close() }
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise
  })
  if (result.exceptionDetails) {
    throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails)}`)
  }
  return result.result.value
}

async function waitFor(cdp, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, expression)) return true
    } catch {
      // 页面还在导航
    }
    await sleep(300)
  }
  return false
}

const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures.push(name)
}

async function main() {
  const electronBinary = require('electron')
  if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) {
    throw new Error('out/main/index.js not found; run `npm run build` first')
  }

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(
    electronBinary,
    [ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`, '--disable-gpu'],
    { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  )
  child.stdout.pipe(logStream)
  child.stderr.pipe(logStream)

  let exitCode = null
  child.on('exit', (code) => {
    exitCode = code
  })

  try {
    const page = await findPage()
    const cdp = createCdp(page.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    const loaded = await waitFor(cdp, `document.readyState === 'complete'`)
    check('renderer document loaded', loaded)

    check(
      'preload bridge (window.api.system.invoke)',
      (await evaluate(cdp, `typeof window.api?.system?.invoke === 'function'`)) === true
    )
    check(
      'preload bridge (window.electron.ipcRenderer)',
      (await evaluate(cdp, `typeof window.electron?.ipcRenderer?.invoke === 'function'`)) === true
    )
    check(
      'preload bridge (window.loading.getInitState)',
      (await evaluate(cdp, `typeof window.loading?.getInitState === 'function'`)) === true
    )

    const domReady = await waitFor(cdp, `document.querySelectorAll('*').length > 100`)
    check('DOM mounted', domReady, `nodes=${await evaluate(cdp, `document.querySelectorAll('*').length`)}`)
    const initialTextLength = await evaluate(cdp, `document.body.innerText.trim().length`)
    check('initial view has text', initialTextLength > 0, `chars=${initialTextLength}`)

    // 系统路由懒加载：逐个切换，断言目标页正文渲染出来（不是白屏）
    const routes = [
      ['#/harness', 'Harness'],
      ['#/notes', 'Notes'],
      ['#/more', 'More']
    ]
    for (const [hash, label] of routes) {
      await evaluate(cdp, `window.location.hash = '${hash}'`)
      const rendered = await waitFor(
        cdp,
        `document.querySelectorAll('*').length > 100 && document.body.innerText.trim().length > 0`
      )
      await sleep(500)
      check(`route ${label} rendered`, rendered)
    }
    await evaluate(cdp, `window.location.hash = '#/harness'`)
    await sleep(800)

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'))
    check('screenshot captured', fs.statSync(SHOT_PATH).size > 1000, SHOT_PATH)

    // 渲染进程的错误（console.error / 未捕获异常）会经主进程转发进 main.log；
    // 这里同时读 CDP 事件做一次直接检查。
    const consoleErrors = cdp.events.filter(
      (event) =>
        event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error'
    ).length
    const exceptions = cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown').length
    check('no uncaught renderer exceptions', exceptions === 0, `count=${exceptions}`)
    check('no renderer console.error', consoleErrors === 0, `count=${consoleErrors}`)

    cdp.close()
    check('app still running', exitCode === null, exitCode === null ? '' : `exited=${exitCode}`)
  } finally {
    // Windows 下 Electron 会带多个子进程，必须杀进程树
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
    logStream.end()
    fs.rmSync(USER_DATA, { recursive: true, force: true })
  }

  const logTail = fs.existsSync(LOG_PATH)
    ? fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').slice(-15).join('\n')
    : ''
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
    if (logTail) console.error(`--- app log tail ---\n${logTail}`)
    process.exitCode = 1
  } else {
    console.log('\nruntime-smoke: all checks passed')
    if (logTail) console.log(`--- app log tail ---\n${logTail}`)
  }
}

main().catch((err) => {
  console.error('runtime-smoke failed to run:', err)
  process.exitCode = 1
})
