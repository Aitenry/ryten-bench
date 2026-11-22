/**
 * 锁屏（ESC 锁屏）的渲染层共享快照 —— 与 `settings/settings-modal-state.ts` 同款
 * 「模块级可订阅快照」。
 *
 * 为什么必须外置：锁屏配置的真源在主进程（electron-store 的 `lock`），
 *   - 设置页（GeneralSettings）负责**写**：开关 + 解锁码；
 *   - 外壳（AppContent）负责**读**：按 ESC 时判断「开没开、解锁码是什么」。
 * 此前 AppContent 只在挂载时读一次主进程，设置页改完开关只落盘、不通知外壳 ——
 * 于是「在设置里打开『启用锁屏』→ 按 ESC 毫无反应」，非要重启（或外壳子树因插件启停
 * 重挂、AppContent 重挂时再读一次）才生效（2026-09-27 用户报的现象）。
 *
 * 默认 `enabled: false`（而不是 true）：解锁码还没读到时锁屏 = 把人锁在一个进不去的界面里，
 * 宁可这段时间 ESC 没反应。
 */
export interface LockScreenState {
  /** 是否启用锁屏（主进程 `lock.view`） */
  enabled: boolean
  /** 解锁码（主进程 `lock.code`，6 位数字的 MD5）；null = 还没从主进程读到 */
  code: string | null
}

let state: LockScreenState = { enabled: false, code: null }
const listeners = new Set<() => void>()

/** 当前快照（未变更时返回同一个对象引用，可直接喂给 useSyncExternalStore） */
export function getLockScreenState(): LockScreenState {
  return state
}

export function subscribeLockScreenState(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

function publish(patch: Partial<LockScreenState>): void {
  const sameEnabled = patch.enabled === undefined || patch.enabled === state.enabled
  const sameCode = patch.code === undefined || patch.code === state.code
  if (sameEnabled && sameCode) return
  state = { ...state, ...patch }
  for (const onChange of [...listeners]) {
    try {
      onChange()
    } catch (err) {
      console.error('[lock-screen] Error in snapshot subscription callback:', err)
    }
  }
}

/** 写入从主进程读到的锁屏配置（AppContent 挂载时读真源；读失败时按「不启用」兜底） */
export function setLockScreenState(next: Partial<LockScreenState>): void {
  publish(next)
}

/** 设置页切换「启用锁屏」：即时生效，不必重启外壳（随后仍由设置页负责落盘） */
export function setLockScreenEnabled(enabled: boolean): void {
  publish({ enabled })
}
