import { join, resolve, isAbsolute, sep } from 'path'
import type { MainIpcHandlers } from '../../../../main/plugins/context'
import * as fs from 'fs'
import logger from 'electron-log'
import { mainMessages } from '../../../../main/i18n'
import { settingsStore } from '../../../../main/context'
import { activeWorkspace, syncWorkspaceWatcher } from '../workspace/index'
import { markPathWritten, recordFileChange } from '../workspace/file-history'
import {
  keepFileChanges,
  listFileChangeHistory,
  listWorkspacePendingChanges,
  readFileChangeContent,
  revertFileChange
} from '../workspace/file-history'

/**
 * 校验渲染端传入的路径必须位于 AI 工作区目录内（防任意路径读写）。
 * 渲染进程存在被注入/被导航到远程页面的风险（preload 暴露了完整 API），
 * 文件类 IPC 入口必须自守边界：非绝对路径、越界路径一律拒绝。
 * 返回规范化后的绝对路径。
 */
function assertInsideWorkspace(inputPath: string): string {
  const m = mainMessages().error
  if (typeof inputPath !== 'string' || !isAbsolute(inputPath)) {
    throw new Error(m.invalidPathAbsolute)
  }
  const harnessSettings = settingsStore.get('harness') as { workspacePath?: string } | undefined
  const root = harnessSettings?.workspacePath
  if (!root) {
    throw new Error(m.workspaceDirNotConfigured)
  }
  const normalizedRoot = resolve(root)
  const target = resolve(inputPath)
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + sep)) {
    throw new Error(m.pathOutsideWorkspace)
  }
  return target
}

/**
 * 工作区文件浏览 + 文件改动审查 IPC（AI 工作区目录的文件操作，harness 插件的第 4 个域）。
 *
 * 通道名一律 `plugin:harness:<原扁平名>`（原 `src/main/ipc/workspace.ts` 的 9 个扁平通道
 * 逐个改名）。归属依据：这些工作区文件通道只被 harness 的渲染层组件使用
 * （WorkspacePanel / FileExplorer / FileDiffView 的改动复核与文件浏览器，经插件自己的
 * `renderer/api.ts` 的 `harnessApi.workspace.*` 调用），是 AI 改动复核能力；
 * 因此它从 core 组移出，停用「AI 助手」后这些通道一并消失。
 */
export function workspaceIpcHandlers(): MainIpcHandlers {
  const handlers: MainIpcHandlers = {}
  /** 收通道：本插件的命名空间前缀只在这里出现 */
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`plugin:harness:${channel}`] = handler
  }

  handle('workspace-list-dir', async (dirPath: string) => {
    try {
      const safePath = assertInsideWorkspace(dirPath)
      const entries = await fs.promises.readdir(safePath, { withFileTypes: true })
      return entries
        .filter((d) => !d.name.startsWith('.') || d.name === '.gitignore')
        .map((d) => ({
          name: d.name,
          isDirectory: d.isDirectory(),
          path: join(safePath, d.name)
        }))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name)
        })
    } catch (error) {
      logger.error('Error in workspace-list-dir:', error)
      throw error
    }
  })

  handle('workspace-read-file', async (filePath: string) => {
    try {
      const safePath = assertInsideWorkspace(filePath)
      return await fs.promises.readFile(safePath, 'utf-8')
    } catch (error) {
      logger.error('Error in workspace-read-file:', error)
      throw error
    }
  })

  /**
   * 用户在工作区里保存文件（编辑器 Ctrl+S）。
   *
   * 用户自己的保存不产生待审查改动（待审查只针对模型的改动）；
   * 但如果这次保存是「差异审查」的结果，走 workspace-apply-review。
   */
  handle('workspace-save-file', async (filePath: string, content: string) => {
    try {
      const safePath = assertInsideWorkspace(filePath)
      await fs.promises.writeFile(safePath, content, 'utf-8')
      // 自我写入标记：文件监听不要把它当成「外部改动」
      markPathWritten(safePath)
      return true
    } catch (error) {
      logger.error('Error in workspace-save-file:', error)
      throw error
    }
  })

  // --- 文件改动史（可追溯 / 可回溯） ---

  /** 当前工作区所有待审查的改动（资源管理器徽标 + 页签角标用） */
  handle('workspace-changes-pending', async () => {
    try {
      syncWorkspaceWatcher()
      const active = activeWorkspace()
      if (!active) return []
      return await listWorkspacePendingChanges(active.id)
    } catch (error) {
      logger.error('Error in workspace-changes-pending:', error)
      return []
    }
  })

  /** 单个文件的改动历史（倒序，最新在前） */
  handle('workspace-changes-file', async (filePath: string) => {
    try {
      const safePath = assertInsideWorkspace(filePath)
      return await listFileChangeHistory(safePath)
    } catch (error) {
      logger.error('Error in workspace-changes-file:', error)
      return []
    }
  })

  /** 某次改动的前后正文（差异视图的数据源） */
  handle('workspace-change-content', async (id: number) => {
    try {
      return await readFileChangeContent(id)
    } catch (error) {
      logger.error('Error in workspace-change-content:', error)
      return null
    }
  })

  /** 审查：保留（清除待审查标记，磁盘内容不动） */
  handle('workspace-change-keep', async (ids: number[]) => {
    try {
      return await keepFileChanges(Array.isArray(ids) ? ids : [])
    } catch (error) {
      logger.error('Error in workspace-change-keep:', error)
      return 0
    }
  })

  /** 审查：撤销到某次改动之前（把改动前快照写回磁盘） */
  handle('workspace-change-revert', async (id: number) => {
    try {
      return await revertFileChange(id)
    } catch (error) {
      logger.error('Error in workspace-change-revert:', error)
      return { error: (error as Error).message }
    }
  })

  /**
   * 落盘「差异审查结果」：把用户在差异视图里取舍后的内容写回文件，
   * 并把该文件所有待审查改动标记为已保留。
   *
   * 若审查结果与模型写入的最终内容不同（用户逐处取舍过），额外记一条
   * `review` 改动，让「这次到底留下了什么」也有据可查。
   */
  handle('workspace-apply-review', async (filePath: string, content: string) => {
    try {
      const safePath = assertInsideWorkspace(filePath)
      const active = activeWorkspace()
      const pending = active ? await listWorkspacePendingChanges(active.id) : []
      const mine = pending.filter((c) => c.path === safePath)

      const current = await fs.promises.readFile(safePath, 'utf-8').catch(() => null)
      await fs.promises.writeFile(safePath, content, 'utf-8')
      markPathWritten(safePath)

      if (active && mine.length > 0) {
        const latest = mine[mine.length - 1]
        if (current !== null && current !== content) {
          await recordFileChange({
            workspaceId: active.id,
            workspaceRoot: active.path,
            realPath: safePath,
            before: current,
            after: content,
            source: 'review',
            status: 'kept',
            topicId: latest.topicId,
            callId: latest.callId,
            note: 'review'
          })
        }
        await keepFileChanges(mine.map((c) => c.id))
      }
      return { ok: true }
    } catch (error) {
      logger.error('Error in workspace-apply-review:', error)
      return { error: (error as Error).message }
    }
  })

  return handlers
}
