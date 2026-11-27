/**
 * 开始页 → 右上工具面板的启动协议。
 *
 * 开始页和 Harness 是两条路由：点卡片时先把「要打开哪个面板」写进 sessionStorage，
 * 再跳 `/harness`；Harness 挂载后消费一次并打开对应面板。
 * 用 sessionStorage 而不是全局变量：路由切换会重新渲染，但状态不该丢，也不该残留到下次进入。
 */

export type HarnessPanelKind = 'workspace' | 'terminal' | 'browser'

const STORAGE_KEY = 'rytenbench:harness-open-panel'

export function requestHarnessPanel(kind: HarnessPanelKind): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, kind)
  } catch {
    // 隐私模式/存储不可用：忽略，用户可再点一次
  }
}

export function consumeHarnessPanelRequest(): HarnessPanelKind | null {
  try {
    const value = window.sessionStorage.getItem(STORAGE_KEY)
    window.sessionStorage.removeItem(STORAGE_KEY)
    return value === 'workspace' || value === 'terminal' || value === 'browser' ? value : null
  } catch {
    return null
  }
}
