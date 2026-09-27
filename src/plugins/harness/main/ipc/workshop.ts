import { BrowserWindow, shell } from 'electron'
import logger from 'electron-log'
import { settingsStore } from '../../../../main/context'
import { safeSend } from '../../../../main/safe-send'
import type { MainIpcHandlers } from '../../../../main/plugins/context'
import type { MainAgentConfig } from '../../shared/mcp'
import type { WorkshopRendererProbe } from '../../shared/workshop'
import { resolveProbeResult } from '../workshop/probe'
import { workshopToolInfos } from '../tools/workshop'
import {
  build,
  createDraftFromTemplate,
  dirOf,
  draftDetail,
  disable,
  exportZip,
  lastReport,
  listDraftSummaries,
  publish,
  readFile,
  removeDraft,
  removeFile,
  unpublish,
  verify,
  workshopState,
  writeFile
} from '../workshop/service'

/**
 * 插件工坊的 IPC（harness 插件的第 6 个域）。
 *
 * 通道名一律 `plugin:harness:workshop-*`：停用「AI 助手」时工坊的设置页与全部动作一起消失
 * （与既有的 5 个域同一套生命周期语义）。
 *
 * 两条设计约束：
 * - **动作不抛错**：面板要能把「构建失败 / 验收未过 / 装不上」的原话显示给用户，
 *   因此统一返回 `{ ok, error?, data? }`（`workshop-probe-result` 例外：它是渲染层回话，返回 boolean）；
 * - **任何变更后广播 `workshop-changed`**：AI 在对话里改草稿/构建/发布时，正开着设置页的
 *   用户要能立刻看到状态变化，而不是手动刷新。
 */

/** 主进程 → 渲染层的事件通道（必须逐个 `ctx.registerEvent` 声明才进 preload 白名单） */
export const WORKSHOP_EVENT_CHANNELS = [
  /** 草稿/产物/安装态发生变化（面板据此重拉清单） */
  'plugin:harness:workshop-changed',
  /** 渲染层实时探针请求（见 workshop/probe.ts） */
  'plugin:harness:workshop-probe'
] as const

/** 广播「工坊状态变了」（渲染层可能要重新 fetch 插件模块/样式） */
export function broadcastWorkshopChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win.webContents, 'plugin:harness:workshop-changed', { at: Date.now() })
  }
}

/** 统一的结果包装（失败不抛错，面板显示 error 原文） */
async function act<T>(
  run: () => Promise<T> | T
): Promise<{ ok: boolean; error?: string; data?: T }> {
  try {
    return { ok: true, data: await run() }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('[Workshop] 动作失败:', message)
    return { ok: false, error: message }
  }
}

export function workshopIpcHandlers(): MainIpcHandlers {
  const handlers: MainIpcHandlers = {}
  /** 收通道：本插件的命名空间前缀只在这里出现 */
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`plugin:harness:${channel}`] = handler
  }

  /** 工坊状态（面板标题：可用性 + 根目录 + 草稿数） */
  handle('workshop-state', () => workshopState())

  /** 全部草稿（含构建/安装/最近验收摘要） */
  handle('workshop-list', () => listDraftSummaries())

  /** 单个草稿详情（文件树 + 清单 + 目录） */
  handle('workshop-detail', (id: string) => draftDetail(id))

  /** 草稿文件内容（面板只读预览） */
  handle('workshop-read-file', (id: string, relPath: string) => readFile(id, relPath))

  /** 最近一次验收报告 */
  handle('workshop-report', (id: string) => lastReport(id))

  handle(
    'workshop-build',
    async (id: string, dev?: boolean) =>
      await act(async () => {
        const info = await build(id, { dev: Boolean(dev) })
        broadcastWorkshopChanged()
        return info
      })
  )

  handle(
    'workshop-verify',
    async (id: string, probe?: boolean) =>
      await act(async () => {
        const report = await verify(id, { probeRenderer: probe })
        broadcastWorkshopChanged()
        return report
      })
  )

  handle(
    'workshop-publish',
    async (id: string) =>
      await act(async () => {
        const result = await publish(id)
        broadcastWorkshopChanged()
        return result
      })
  )

  handle(
    'workshop-disable',
    async (id: string) =>
      await act(async () => {
        disable(id)
        broadcastWorkshopChanged()
        return true
      })
  )

  handle(
    'workshop-unpublish',
    async (id: string) =>
      await act(async () => {
        unpublish(id)
        broadcastWorkshopChanged()
        return true
      })
  )

  handle(
    'workshop-create',
    async (input: { id: string; title?: string; template?: string; description?: string }) =>
      await act(async () => {
        const result = createDraftFromTemplate({
          id: input?.id,
          title: input?.title,
          template: (input?.template as never) ?? 'page',
          description: input?.description
        })
        broadcastWorkshopChanged()
        return { id: result.meta.id, files: result.files, dir: result.dir }
      })
  )

  handle(
    'workshop-write-file',
    async (id: string, relPath: string, content: string) =>
      await act(async () => {
        const file = writeFile(id, relPath, content)
        broadcastWorkshopChanged()
        return file
      })
  )

  handle(
    'workshop-remove-file',
    async (id: string, relPath: string) =>
      await act(async () => {
        removeFile(id, relPath)
        broadcastWorkshopChanged()
        return true
      })
  )

  handle(
    'workshop-remove',
    async (id: string) =>
      await act(async () => {
        removeDraft(id)
        broadcastWorkshopChanged()
        return true
      })
  )

  handle('workshop-export', async (id: string) => await act(async () => await exportZip(id)))

  /** 在系统文件管理器里打开草稿目录（面板「打开目录」） */
  handle(
    'workshop-open-dir',
    async (id: string) =>
      await act(async () => {
        const dir = dirOf(id)
        const error = await shell.openPath(dir)
        if (error) throw new Error(error)
        return dir
      })
  )

  /**
   * 一键把工坊的 4 个工具放进「主智能体 → 工具」。
   *
   * 为什么要它：工具集是按用户在智能体页勾选的清单组装的（`effectiveMainAgentTools`），
   * 新工具不会自己出现——不点这一下，用户会发现「助手根本不会用插件工坊」。
   */
  handle(
    'workshop-enable-tools',
    async () =>
      await act(async () => {
        const current = (settingsStore.get('mainAgent') as MainAgentConfig | undefined) ?? {}
        const names = workshopToolInfos.map((tool) => tool.name)
        const tools = [...new Set([...(current.tools ?? []), ...names])]
        settingsStore.set('mainAgent', { ...current, tools })
        broadcastWorkshopChanged()
        return tools
      })
  )

  /** 渲染层探针的回话（见 workshop/probe.ts；返回 false = 已超时的迟到结果） */
  handle('workshop-probe-result', (payload: unknown) => {
    const accepted = resolveProbeResult(payload as WorkshopRendererProbe & { probeId?: string })
    if (!accepted) {
      logger.warn('[Workshop] 探针结果被丢弃（对应请求已超时）')
    }
    return accepted
  })

  return handlers
}
