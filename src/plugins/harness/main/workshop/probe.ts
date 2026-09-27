import { BrowserWindow } from 'electron'
import logger from 'electron-log'
import { isSenderAlive, safeSend } from '../../../../main/safe-send'
import type { WorkshopRendererProbe } from '../../shared/workshop'

/**
 * 渲染层**实时探针**的主进程侧（通道与语义见 shared/workshop.ts 的 `WorkshopRendererProbe`）。
 *
 * 为什么值得单独一条链路：主进程冒烟只能证明「主模块能装载」，
 * 而外部插件最真实的失败模式是**渲染模块在宿主环境里 import 就炸**——
 * 引了宿主 UI 表里没有的键、顶层读了 `window` 上不存在的东西、桥的具名导出对不上。
 * 这些只有让**真实的渲染进程**（真 React、真 antd、真 `__RB_HOST_UI__` 表）跑一遍才会暴露。
 *
 * 协议：
 * 1. 主进程发事件 `plugin:harness:workshop-probe` = `{ probeId, id, entry }`；
 * 2. 助手界面（harness 的 Provider，常驻挂载）里收到后：fetch 产物的 `renderer.mjs`
 *    → blob import → 用一个**记录版上下文**调 `install(ctx)` → 可能再挂载一次注册的路由组件；
 * 3. 结果经 `plugin:harness:workshop-probe-result` 通道回来，这里按 `probeId` 兑付。
 *
 * 超时/没有窗口都算 **skip（不是失败）**：用户没打开界面时不该把插件判成不可用。
 */

/** 默认超时：blob import + install + 一次挂载，正常在几百毫秒内；给足冷启动余量 */
const DEFAULT_TIMEOUT_MS = 15_000

const pending = new Map<string, (result: WorkshopRendererProbe) => void>()

/** 是否有待兑付的探针（诊断用） */
export function pendingProbeCount(): number {
  return pending.size
}

/** 向所有窗口广播探针请求并等待结果（无窗口 / 超时 → skip） */
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

    // 一律走 safeSend：向已失效的渲染帧发送不会抛错，只有它认得出来（见 safe-send.ts）
    let delivered = 0
    for (const win of windows) {
      if (!isSenderAlive(win.webContents)) continue
      if (safeSend(win.webContents, 'plugin:harness:workshop-probe', { probeId, id, entry })) {
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
 * 兑付一次探针结果（由 IPC 通道调用）。
 *
 * 返回 false 表示**没有对应的待兑付请求**（超时后界面才回话）——如实记日志，
 * 而不是当成成功（否则「探针超时」会被悄悄覆盖成通过）。
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
    logger.warn(`[Workshop] 收到无主的探针结果（超时或重复）：${probeId || '(缺 probeId)'}`)
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
