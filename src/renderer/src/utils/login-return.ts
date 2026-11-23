/**
 * 登录页「从哪来、回哪去」。
 *
 * 背景（用户口径 2026-11-23）：从登录页点「返回工作台」时，出口曾被硬编码成 `/plugins`
 * （插件仓库）——侧栏里记住的那条插件会话明明还在，主区域却换成了插件仓库，于是
 * 「无论我选中哪一个内容，回来都是选中插件仓库」。登录页应该回到进来之前停的那一页：
 * 从对话页进来就回对话页（侧栏按记住的模式 / 会话恢复），从插件仓库进来就回插件仓库。
 * 登录成功与「已登录的人又打开登录页」也走同一个出口，避免同样的跳错。
 *
 * 记录方式：AppShell 在每次**非登录页**路由变化时把当前地址记进模块变量（同一次运行内
 * 一定命中），并复制一份到 sessionStorage（刷新 / 热重载后仍能回来）。登录页自身永远不
 * 入记录，否则「返回」会又停在登录页。
 */

const STORAGE_KEY = 'rytenbench.lattice.loginReturn'

/** 没有任何记录时的落点：应用主页（对话页），也就是登录页按钮说的「工作台」 */
export const DEFAULT_LOGIN_RETURN = '/harness'

/** 同一次运行内的最后一条非登录页地址 */
let lastRoute: string | null = null

/** 只接受站内绝对路径；登录页自身、空路径与协议相对地址都不能当返回目标 */
function isReturnable(route: unknown): route is string {
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//')) return false
  if (route === '/') return false
  return (
    route !== '/login' &&
    !route.startsWith('/login/') &&
    !route.startsWith('/login?') &&
    !route.startsWith('/login#')
  )
}

/** AppShell 每次停到非登录页时调用：记住这一页，供登录页回去 */
export function rememberLoginReturn(route: string): void {
  if (!isReturnable(route)) return
  lastRoute = route
  try {
    window.sessionStorage.setItem(STORAGE_KEY, route)
  } catch {
    // sessionStorage 不可用时只保留内存记录：同一次运行里的返回照常工作
  }
}

/** 登录页出口：回到进来之前那一页；没有记录（深链直接打开登录页）就回工作台 */
export function resolveLoginReturn(): string {
  if (isReturnable(lastRoute)) return lastRoute
  try {
    const saved = window.sessionStorage.getItem(STORAGE_KEY)
    if (isReturnable(saved)) return saved
  } catch {
    // 忽略：退回默认落点
  }
  return DEFAULT_LOGIN_RETURN
}
