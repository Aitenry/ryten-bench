import { BrowserWindow, dialog, shell } from 'electron'
import logger from 'electron-log'
import { safeSend } from '../../../../main/safe-send'
import type { MainIpcHandlers } from '../../../../main/plugins/context'
import type { WorkshopRendererProbe } from '../../shared/workshop'
import { resolveProbeResult } from '../workshop/probe'
import {
  adoptPluginsRoot,
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
  renameDraft,
  unpublish,
  verify,
  workshopState,
  writeFile
} from '../workshop/service'
import { configurePluginsRoot } from '../workshop/paths'
import {
  ensurePluginWorkspace,
  listPluginWorkspaces,
  syncPluginWorkspaceName
} from '../workshop/workspace'
import { workshopHost } from '../workshop/host'

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
 *
 * 工坊的 4 个 AI 工具**不在这里**挂载：它们随工具注册表走，用户在
 * 「设置 → 智能体 → 工具」里勾选（应用里所有工具都是这一条路径，工坊不搞特殊入口）。
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

  /**
   * 工坊状态（面板标题：可用性 + 根目录 + 草稿数）。
   * 另附**插件工作区清单**（插件 id → 工作区行）：侧栏靠它把插件行和它自己的会话对上，
   * 并把插件工作区从「工作」列表里滤掉（见 main/workshop/workspace.ts）。
   */
  handle('workshop-state', async () => ({
    ...workshopState(),
    pluginWorkspaces: await listPluginWorkspaces()
  }))

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

  /** 重命名插件（改展示名：草稿 title + 清单 name；目录名/id 不动） */
  handle(
    'workshop-rename',
    async (id: string, title: string) =>
      await act(async () => {
        const summary = renameDraft(id, title)
        // 插件会话的工作目录（插件工作区）名字跟着插件走
        await syncPluginWorkspaceName(id, summary.title)
        broadcastWorkshopChanged()
        return summary
      })
  )

  /**
   * 取（必要时创建）某份插件的**插件工作区**——插件会话的工作目录就是它的源码目录
   * （`<插件存放路径>/<插件 id>/`，见 main/workshop/workspace.ts）。
   *
   * 侧栏在「插件行 ＋ 新建会话」时调它，然后像切换普通工作区一样切过去：AI 工作目录、
   * 资源管理器、文件边界全都跟着这个工作区走（用户口径 2026-09-28「在插件模式下新建会话，
   * 其工作区还是之前工作模式下选中的工作区，资源管理器也一样」）。
   */
  handle(
    'workshop-ensure-workspace',
    async (id: string) =>
      await act(async () => {
        const workspace = await ensurePluginWorkspace(id)
        // 工作区清单变了（可能刚建出来）：广播给渲染层，侧栏才知道这个插件行现在有会话可展开、
        // 并且要把这个工作区从「工作」列表里滤掉
        broadcastWorkshopChanged()
        return workspace
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
          // 不传就是默认的 'full'（全部内容）：模板选择只在助手侧按需使用
          template: input?.template as never,
          description: input?.description
        })
        broadcastWorkshopChanged()
        return { id: result.meta.id, files: result.files, dir: result.dir }
      })
  )

  /**
   * 弹系统选择框配置**插件存放路径**（所有插件的源码根目录，没有默认值）。
   *
   * 这个原生框没法被自动化点击，工装因此走 `workshop-set-root`（显式路径）。
   */
  handle(
    'workshop-pick-root',
    async () =>
      await act(async () => {
        const picked = await dialog.showOpenDialog({
          title: '选择插件的存放路径（每个插件会在它下面占一个文件夹）',
          properties: ['openDirectory', 'createDirectory']
        })
        if (picked.canceled || picked.filePaths.length === 0) {
          return { canceled: true as const }
        }
        const result = adoptPluginsRoot(picked.filePaths[0])
        broadcastWorkshopChanged()
        return { canceled: false as const, ...result }
      })
  )

  /** 按显式路径配置插件存放路径（面板/工装用；`dir` 为空 = 清除配置） */
  handle(
    'workshop-set-root',
    async (dir: string) =>
      await act(async () => {
        if (!dir) {
          workshopHost().setPluginsRoot('')
          configurePluginsRoot('')
          broadcastWorkshopChanged()
          return { dir: '', moved: [] as string[] }
        }
        const result = adoptPluginsRoot(dir)
        broadcastWorkshopChanged()
        return result
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
