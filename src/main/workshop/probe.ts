import { BrowserWindow } from 'electron'
import logger from 'electron-log'
import { isSenderAlive, safeSend } from '../safe-send'
import type { WorkshopRendererProbe } from '../../shared/harness/workshop'

/**
 * Main-process side of the renderer **live probe** (channel and semantics: `WorkshopRendererProbe`
 * in shared/workshop.ts).
 *
 * Why it deserves its own channel: a main-process smoke test only proves "the main module can be
 * loaded", while the most real failure mode of an external plugin is that the **renderer module
 * blows up on import inside the host environment** — importing a key the host UI table does not
 * have, reading something at top level that does not exist on `window`, named exports of the
 * bridge not matching up. Only running these in the **real renderer process** (real React, real
 * antd, real `__RB_HOST_UI__` table) exposes them.
 *
 * Protocol:
 * 1. The main process emits the event `harness:workshop-probe` = `{ probeId, id, entry }`;
 * 2. The assistant UI (the harness Provider, mounted permanently) receives it: fetch the build
 *    output's `renderer.mjs` -> blob import -> call `install(ctx)` with a **recording context**
 *    -> possibly mount the registered route component once more;
 * 3. The result comes back over the `harness:workshop-probe-result` channel and is redeemed here
 *    by `probeId`.
 *
 * Timeouts and no-window both count as **skip (not failure)**: a plugin must not be judged
 * unusable just because the user has not opened the UI.
 */

/** Default timeout: blob import + install + one mount normally complete within a few hundred ms; leave room for cold start */
const DEFAULT_TIMEOUT_MS = 15_000

const pending = new Map<string, (result: WorkshopRendererProbe) => void>()

/** Whether a probe is pending (for diagnostics) */
export function pendingProbeCount(): number {
  return pending.size
}

/** Broadcast a probe request to all windows and wait for the result (no window / timeout -> skip) */
export function probeRendererPlugin(
  id: string,
  entry = 'renderer.mjs',
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<WorkshopRendererProbe> {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
  if (windows.length === 0) {
    return Promise.resolve({
      status: 'skip',
      detail: '当前没有可用窗口（界面未打开），跳过渲染层探针'
    })
  }

  const probeId = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return new Promise<WorkshopRendererProbe>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(probeId)
      resolve({
        status: 'skip',
        detail: `界面在 ${Math.round(timeoutMs / 1000)}s 内没有响应探针（助手界面可能未挂载）`
      })
    }, timeoutMs)

    pending.set(probeId, (result) => {
      clearTimeout(timer)
      resolve(result)
    })

    // Always go through safeSend: sending to an already-invalid renderer frame does not throw,
    // so only it can tell (see safe-send.ts)
    let delivered = 0
    for (const win of windows) {
      if (!isSenderAlive(win.webContents)) continue
      if (safeSend(win.webContents, 'harness:workshop-probe', { probeId, id, entry })) {
        delivered += 1
      }
    }
    if (delivered === 0) {
      clearTimeout(timer)
      pending.delete(probeId)
      resolve({ status: 'skip', detail: '所有窗口的渲染帧都已失效，跳过渲染层探针' })
    }
  })
}

/**
 * Redeem a probe result (called by the IPC channel).
 *
 * Returning false means **there is no matching pending request** (the UI replied only after the
 * timeout) — log that truthfully rather than treating it as success (otherwise a "probe timeout"
 * would be silently overwritten as a pass).
 */
export function resolveProbeResult(payload: unknown): boolean {
  const data = payload as {
    probeId?: unknown
    status?: unknown
    detail?: unknown
    registrations?: unknown
    durationMs?: unknown
  }
  const probeId = typeof data?.probeId === 'string' ? data.probeId : ''
  const resolve = probeId ? pending.get(probeId) : undefined
  if (!resolve) {
    logger.warn(`[Workshop] Received orphaned probe result (timed out or duplicated): ${probeId || '(missing probeId)'}`)
    return false
  }
  pending.delete(probeId)
  const status = data?.status === 'pass' || data?.status === 'fail' ? data.status : 'skip'
  resolve({
    status,
    detail: typeof data?.detail === 'string' ? data.detail : undefined,
    registrations: Array.isArray(data?.registrations)
      ? data.registrations.filter((item): item is string => typeof item === 'string')
      : undefined,
    durationMs: typeof data?.durationMs === 'number' ? data.durationMs : undefined
  })
  return true
}
