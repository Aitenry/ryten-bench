import { useSyncExternalStore } from 'react'
import type {
  LockCodeChangeResult,
  LockScreenSnapshot,
  LockUnlockResult
} from '@renderer/types/settings'

/**
 * Renderer-side snapshot of the lock screen (the main process is the single source of truth;
 * this is just a subscribable mirror of it).
 *
 * Difference from the previous version: it used to keep `locked` in AppContent's `useState` and
 * read the unlock code digest into the renderer, so refreshing the page unlocked it and UI code
 * could read the digest. Now this holds only a `LockScreenSnapshot`
 * (enabled / whether a code exists / whether it is the default code / auto-lock timeout /
 * whether locked), with no digest at all; `locked` changes are pushed by the main process via
 * `lock-screen-changed`, and `getState()` restores them after a refresh.
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

/**
 * Collapse an unknown value coming over IPC into a snapshot; return null on a bad shape
 * (prefer keeping the previous state over injecting undefined into the UI)
 */
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

/** Read the lock screen snapshot in a component (re-renders only when it changes) */
export function useLockScreenState(): LockScreenSnapshot {
  return useSyncExternalStore(subscribeLockScreenState, getLockScreenState)
}

function ipc(): NonNullable<Window['api']['lock']> {
  return window.api.lock
}

/**
 * Attach the main-process push channel and do an initial fetch.
 *
 * Reference counting: both AppContent and the settings page subscribe, but **only one IPC
 * listener** is installed; React StrictMode's mount -> unmount -> mount also leaves no duplicate
 * listener and loses no events (on remount getState fills in changes from the gap).
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
      // Main process unavailable (should not happen): keep the initial snapshot, so the lock
      // screen entry point simply stays inactive
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

/**
 * Subscribe to lock screen state (returns an unsubscribe function; the IPC listener is detached
 * only when the last subscriber leaves)
 */
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

/**
 * Lock manually (Esc or a UI entry); the main process decides whether it actually locks (no
 * lock when disabled or when no code is set)
 */
export async function requestLock(): Promise<void> {
  const next = normalize(await ipc().lock())
  if (next) publish(next)
}

/** Unlock: verification runs in the main process; the renderer only gets the result */
export async function requestUnlock(code: string): Promise<LockUnlockResult> {
  const result = await ipc().unlock(code)
  // On success pull the snapshot again: even if a broadcast is dropped (renderer frame just
  // rebuilt, etc.), the UI will not stay stuck on the lock screen
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

/** Settings page toggle / auto-lock timeout */
export async function configureLock(patch: {
  enabled?: boolean
  autoLockMinutes?: number
}): Promise<LockScreenSnapshot> {
  const next = await ipc().configure(patch)
  const normalized = normalize(next)
  if (normalized) publish(normalized)
  return normalized ?? getLockScreenState()
}

/** Change the code: the old code is verified by the main process */
export async function changeLockCode(
  oldCode: string,
  newCode: string
): Promise<LockCodeChangeResult> {
  return ipc().changeCode(oldCode, newCode)
}
