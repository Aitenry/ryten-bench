/**
 * 插件化改造 UI 冒烟验证（CDP 驱动真实应用）：
 * 启动 electron --remote-debugging-port=9222 后运行本脚本，
 * 依次验证：菜单装载 → harness/music 点击路由切换 → 高亮 → 无重挂载（路由保持）
 * → 设置弹窗打开/插件面板/关闭 → 连续切换稳定。
 */
const http = require('node:http')
const PORT = 9222

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

async function findPage() {
  for (let i = 0; i < 90; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
      if (page) return page
    } catch {
      // 端口尚未就绪，重试
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('renderer page not found')
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
  }
  async open() {
    await new Promise((res, rej) => {
      this.ws.onopen = res
      this.ws.onerror = rej
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    }
  }
  call(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  close() {
    try {
      this.ws.close()
    } catch {
      // 忽略
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const page = await findPage()
  console.log('target:', page.url)
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.open()
  await cdp.call('Runtime.enable')
  const results = []
  const step = (name, ok, detail) => {
    results.push({ name, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`)
  }
  const evalJs = async (expr) => {
    const r = await cdp.call('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) {
      throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails))
    }
    return r.result.value
  }

  /** 用真实 CDP 鼠标事件点击选择器命中的元素中心（忠实模拟用户点击） */
  const realClick = async (selectorExpr) => {
    const rect = await evalJs(`(() => {
      const el = ${selectorExpr}
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    if (!rect) return false
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    return true
  }

  // 1) 等待内置插件装载完成（侧栏 4 项）
  let menuCount = 0
  for (let i = 0; i < 40; i++) {
    menuCount = await evalJs(`document.querySelectorAll('.frame-menu-item').length`)
    if (menuCount >= 4) break
    await sleep(500)
  }
  step('内置插件装载（侧栏 >= 4 菜单项）', menuCount >= 4, `count=${menuCount}`)

  // 2) harness 菜单（第 4 项，title=助手）
  await realClick(`document.querySelectorAll('.frame-menu-item')[3]`)
  await sleep(1200)
  const hash1 = await evalJs('location.hash')
  const active1 = await evalJs(
    `document.querySelector('.frame-menu-item.frame-menu-item-active')?.getAttribute('title')`
  )
  step('点击 harness 菜单 → 路由切换', hash1 === '#/harness', `hash=${hash1}`)
  step('harness 菜单高亮', active1 === '助手', `active=${active1}`)

  // 3) music 菜单（第 3 项）
  await realClick(`document.querySelectorAll('.frame-menu-item')[2]`)
  await sleep(1200)
  const hash2 = await evalJs('location.hash')
  step('点击 music 菜单 → 路由切换', hash2 === '#/music', `hash=${hash2}`)

  // 4) 等待 2.5s（跨过宿主异步装载窗口）验证状态未被重挂载清空
  await sleep(2500)
  const hashAfterWait = await evalJs('location.hash')
  step('2.5s 后路由保持（无重挂载重置）', hashAfterWait === '#/music', `hash=${hashAfterWait}`)

  // 5) 切到 music 页（避开 harness 侧栏的「助手设置」聚焦入口），
  //    精确点击 RightBar 的「设置」按钮（title === '设置'）
  await sleep(300)
  const settingsBtn = await realClick(
    `[...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '') === '设置') || [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '') === 'Settings')`
  )
  await sleep(900)
  const fullTabs = await evalJs(
    `[...document.querySelectorAll('.ant-modal button')].map(b => (b.textContent||'').trim()).filter(t => t && t.length < 6)`
  )
  const modalOpen = await evalJs(
    `!!document.querySelector('.ant-modal-root .ant-modal, .ant-modal-wrap .ant-modal')`
  )
  const hasPluginsTab = Array.isArray(fullTabs) && fullTabs.includes('插件')
  step(
    '设置按钮点击 → 完整弹窗打开（含插件页签）',
    settingsBtn !== false && modalOpen === true && hasPluginsTab,
    `tabs=${JSON.stringify(fullTabs)}`
  )

  // 6) 弹窗内切到「插件」页签 → 面板展示
  if (modalOpen) {
    const clicked = await realClick(
      `[...document.querySelectorAll('.ant-modal button')].find((b) => (b.textContent || '').trim() === '插件')`
    )
    await sleep(1000)
    const hasPanel = await evalJs(`document.body.textContent.includes('已安装插件')`)
    step('插件管理面板展示', clicked === true && hasPanel === true, `click=${clicked}`)

    // 7) 关闭弹窗（真实鼠标点击关闭按钮中心）
    const closed = await realClick(`document.querySelector('.ant-modal-close')`)
    await sleep(800)
    const modalGone = await evalJs(
      `!document.querySelector('.ant-modal-root .ant-modal, .ant-modal-wrap .ant-modal')`
    )
    step('设置弹窗关闭', closed === true && modalGone === true, `click=${closed}`)
  }

  // 8) 连续切换 music → harness，最终稳定
  await realClick(`document.querySelectorAll('.frame-menu-item')[2]`)
  await sleep(600)
  await realClick(`document.querySelectorAll('.frame-menu-item')[3]`)
  await sleep(1200)
  const hash3 = await evalJs('location.hash')
  step('连续切换菜单稳定（最终 #/harness）', hash3 === '#/harness', `hash=${hash3}`)

  const failed = results.filter((r) => !r.ok).length
  console.log(`SUMMARY: ${results.length - failed}/${results.length} passed`)
  cdp.close()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('SMOKE ERROR:', e)
  process.exit(2)
})