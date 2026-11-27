import { useSyncExternalStore } from 'react'
import type {
  LockCodeChangeResult,
  LockScreenSnapshot,
  LockUnlockResult
} from '@renderer/types/settings'
import type { Window } from '../../../resource/types/window'

/**
 * 锁屏的渲染层快照（主进程是唯一真源，这里只是它的一份可订阅镜像）。
 *
 * 与旧版的区别：旧版把 `locked` 放在 AppContent 的 `useState` 里、把解锁码摘要读进渲染层，
 * 于是刷新页面就解锁、摘要还能被界面代码读走。现在这里只有 `LockScreenSnapshot`
 * （开关 / 有无解锁码 / 是否默认码 / 自动锁屏时长 / 是否已锁），没有任何摘要；
 * `locked` 的变化由主进程 `lock-screen-changed` 推送，刷新后 `getState()` 也会恢复。
 */

const FALLBACK_AUTO_LOCK_MINUTES = 5

const INITIAL: LockScreenSnapshot = {
  enabled: false,
  hasCode: false,
  usingDefaultCode: false,
  autoLockMinutes: FALLBACK_AUTO_LOCK_MINUTES,
  locked: false
}

let state: LockScreenSnapshot = INITIAL
const listeners = new Set<() => void>()

/** 把 IPC 过来的未知值收成快照；形状不对返回 null（宁可保持旧状态，也不把 undefined 灌进界面） */
function normalize(raw: unknown): LockScreenSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<LockScreenSnapshot>
  return {
    enabled: value.enabled === true,
    hasCode: value.hasCode === true,
    usingDefaultCode: value.usingDefaultCode === true,
    autoLockMinutes:
      typeof value.autoLockMinutes === 'number' && value.autoLockMinutes >= 0
        ? value.autoLockMinutes
        : FALLBACK_AUTO_LOCK_MINUTES,
    locked: value.locked === true
  }
}

function same(a: LockScreenSnapshot, b: LockScreenSnapshot): boolean {
  return (
    a.enabled === b.enabled &&
    a.hasCode === b.hasCode &&
    a.usingDefaultCode === b.usingDefaultCode &&
    a.autoLockMinutes === b.autoLockMinutes &&
    a.locked === b.locked
  )
}

function publish(next: LockScreenSnapshot): void {
  if (same(state, next)) return
  state = next
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.error('[lock-screen] Error in snapshot subscription callback:', error)
    }
  }
}

export function getLockScreenState(): LockScreenSnapshot {
  return state
}

export function subscribeLockScreenState(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/** 组件里读锁屏快照（变了才重渲染） */
export function useLockScreenState(): LockScreenSnapshot {
  return useSyncExternalStore(subscribeLockScreenState, getLockScreenState)
}

function ipc(): NonNullable<Window['api']['lock']> {
  return window.api.lock
}

/**
 * 挂上主进程推送 + 首次拉取。
 *
 * 引用计数：AppContent 与设置页都会订阅，但**只装一个 IPC 监听**；
 * React StrictMode 的「挂载→卸载→再挂载」也不会留下重复监听或丢事件
 * （重新挂载时 getState 会补上断档期间的变化）。
 */
let bridgeConsumers = 0
let detachBridge: (() => void) | null = null

function attachBridge(): () => void {
  let disposed = false
  const offChanged = ipc().onChanged((raw) => {
    if (disposed) return
    const next = normalize(raw)
    if (next) publish(next)
  })
  void ipc()
    .getState()
    .then((raw) => {
      if (disposed) return
      const next = normalize(raw)
      if (next) publish(next)
    })
    .catch((error) => {
      // 主进程不可用（理论上不会）：保持初始快照，锁屏入口自然不生效
      console.error('[lock-screen] Failed to read lock screen state:', error)
    })
  detachBridge = () => {
    disposed = true
    try {
      offChanged()
    } catch (error) {
      console.error('[lock-screen] Failed to detach lock screen listener:', error)
    }
  }
  return detachBridge
}

/** 订阅锁屏状态（返回取消订阅函数；最后一个订阅者离开时才摘 IPC 监听） */
export function installLockScreenBridge(): () => void {
  if (bridgeConsumers === 0 || !detachBridge) detachBridge = attachBridge()
  bridgeConsumers += 1

  let released = false
  return () => {
    if (released) return
    released = true
    bridgeConsumers = Math.max(0, bridgeConsumers - 1)
    if (bridgeConsumers === 0 && detachBridge) {
      detachBridge()
      detachBridge = null
    }
  }
}

/** 手动锁屏（Esc 或界面入口）；主进程决定是否真的锁（未启用/无密码时不锁） */
export async function requestLock(): Promise<void> {
  const next = normalize(await ipc().lock())
  if (next) publish(next)
}

/** 解锁：校验在主进程，渲染层只拿结果 */
export async function requestUnlock(code: string): Promise<LockUnlockResult> {
  const result = await ipc().unlock(code)
  // 成功时再拉一次快照：即使广播丢包（渲染帧刚重建等），界面也不会停在锁屏上
  if (result.ok) {
    const next = normalize(
      await ipc()
        .getState()
        .catch(() => null)
    )
    if (next) publish(next)
  }
  return result
}

/** 设置页的开关 / 自动锁屏时长 */
export async function configureLock(patch: {
  enabled?: boolean
  autoLockMinutes?: number
}): Promise<LockScreenSnapshot> {
  const next = await ipc().configure(patch)
  const normalized = normalize(next)
  if (normalized) publish(normalized)
  return normalized ?? getLockScreenState()
}

/** 改码：原密码由主进程校验 */
export async function changeLockCode(
  oldCode: string,
  newCode: string
): Promise<LockCodeChangeResult> {
  return ipc().changeCode(oldCode, newCode)
}
