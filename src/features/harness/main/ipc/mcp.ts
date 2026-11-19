import { BrowserWindow, dialog } from 'electron'
import * as fs from 'fs'
import logger from 'electron-log'
import { safeSend } from '../../../../main/safe-send'
import { settingsStore } from '../../../../main/context'
import { mainMessages } from '../../../../main/i18n'
import type { MainIpcHandlers } from '../../../../main/plugins/context'
import type { MainAgentConfig, McpServerInput } from '../../shared/mcp'
import { mcpServerViews, refreshCatalog, testMcpServer } from '../runtime/mcp'
import {
  importMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  upsertMcpServer
} from '../runtime/mcp-store'

/**
 * MCP 服务器管理的 IPC（设置 → MCP 页）。
 *
 * 归属：MCP 是「AI 工具的外部来源」，配置页挂在助手分组下，因此与智能体配置同属 harness 插件；
 * 通道一律 `plugin:harness:mcp-*`，停用「AI 助手」后这组通道一并消失。
 *
 * 目录变化（连上/断开/新增工具）通过 `plugin:harness:harness-mcp-updated` 广播：
 * 智能体设置页的工具下拉与 MCP 页都靠它刷新——**没有这个广播，刚保存的服务器工具要等
 * 下一次重新打开设置页才会出现**。
 */

/** 目录更新事件通道（主进程 → 渲染层；由 main/index.ts 声明进 preload 白名单） */
export const MCP_EVENT_CHANNELS = {
  catalogUpdated: 'plugin:harness:harness-mcp-updated'
} as const

/** 广播目录变化（只发不订阅；窗口销毁时 safeSend 静默跳过） */
function broadcastCatalog(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) safeSend(win.webContents, MCP_EVENT_CHANNELS.catalogUpdated, {})
  }
}

/** 重连并广播（保存/删除/切启用态/手动重连之后都要走一遍） */
async function reconnectAndBroadcast(): Promise<void> {
  await refreshCatalog()
  broadcastCatalog()
}

export function mcpIpcHandlers(): MainIpcHandlers {
  const handlers: MainIpcHandlers = {}
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`plugin:harness:${channel}`] = handler
  }

  // 当前服务器清单 + 运行期状态（连没连上、有哪些工具）。
  // **只读快照、不重连**（2026-09-26 用户要求：加载列表不要测试连接，否则服务器一多就卡）。
  // 状态要更新就点「重新连接」；保存/切换启用态/删除仍然会主动重连并广播。
  handle('mcp-servers-list', async () => {
    try {
      return mcpServerViews()
    } catch (error) {
      logger.error('Error in mcp-servers-list:', error)
      throw error
    }
  })

  // 新增/更新一台服务器 → 立刻重连，让界面马上看到真实状态
  handle('mcp-server-save', async (input: McpServerInput) => {
    try {
      const saved = upsertMcpServer(input)
      await reconnectAndBroadcast()
      return saved
    } catch (error) {
      logger.error('Error in mcp-server-save:', error)
      throw error
    }
  })

  handle('mcp-server-remove', async (id: string) => {
    try {
      removeMcpServer(id)
      await reconnectAndBroadcast()
      return true
    } catch (error) {
      logger.error('Error in mcp-server-remove:', error)
      throw error
    }
  })

  handle('mcp-server-toggle', async (id: string, enabled: boolean) => {
    try {
      setMcpServerEnabled(id, enabled)
      await reconnectAndBroadcast()
      return true
    } catch (error) {
      logger.error('Error in mcp-server-toggle:', error)
      throw error
    }
  })

  // 手动重连全部服务器（外部进程被系统杀掉、网络恢复后用户点一下就恢复）
  handle('mcp-server-reconnect', async () => {
    try {
      await reconnectAndBroadcast()
      return true
    } catch (error) {
      logger.error('Error in mcp-server-reconnect:', error)
      throw error
    }
  })

  /**
   * 试连一台**尚未保存**的服务器：连上返回工具清单，连不上返回原始错误。
   * 刻意不抛错——表单要把失败原因显示在字段下方（抛错会被 IPC 折成一句通用失败）。
   */
  handle('mcp-server-test', async (input: McpServerInput) => {
    try {
      return await testMcpServer(input)
    } catch (error) {
      logger.error('Error in mcp-server-test:', error)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // 导入 mcp.json 形态的配置（逐条回报结果，部分成功也可用）
  handle('mcp-servers-import', async (raw: unknown) => {
    try {
      const result = importMcpServers(raw)
      if (result.imported.length > 0) await reconnectAndBroadcast()
      return result
    } catch (error) {
      logger.error('Error in mcp-servers-import:', error)
      throw error
    }
  })

  /**
   * 导入：主进程弹文件框读 mcp.json。
   *
   * 放主进程的原因：渲染层没有 fs，且用户手上的配置多半就在磁盘上（Cursor 的
   * `~/.cursor/mcp.json`、Claude Desktop 的 `claude_desktop_config.json`），
   * 选文件比让用户复制粘贴一大段 JSON 现实得多。取消选择返回 null。
   */
  handle('mcp-servers-import-file', async () => {
    try {
      const picked = await dialog.showOpenDialog({
        properties: ['openFile'],
        title: mainMessages().dialog.selectMcpConfig,
        filters: [
          { name: 'JSON', extensions: ['json'] },
          { name: mainMessages().dialog.filterAllFiles, extensions: ['*'] }
        ]
      })
      if (picked.canceled || picked.filePaths.length === 0) return null
      const text = fs.readFileSync(picked.filePaths[0], 'utf-8')
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (err) {
        throw new Error(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`)
      }
      const result = importMcpServers(parsed)
      if (result.imported.length > 0) await reconnectAndBroadcast()
      return result
    } catch (error) {
      logger.error('Error in mcp-servers-import-file:', error)
      throw error
    }
  })

  /**
   * 勾选/取消一台服务器带来的全部工具（写入 mainAgent.mcpTools）。
   *
   * 只改这一个键：`mcpTools` 与主智能体页的 `tools` 分开存（见 shared/mcp.ts 的说明），
   * 因此在这里停用一台服务器**不会**动用户在智能体页挑的其他工具——两边同时保存也不会
   * 互相覆盖（各写各的键），这正是把两个入口的数据拆成两份的原因。
   */
  handle('mcp-tools-set', (toolNames: string[]) => {
    try {
      const current = (settingsStore.get('mainAgent') as MainAgentConfig | undefined) ?? {}
      const next: MainAgentConfig = {
        ...current,
        mcpTools: Array.isArray(toolNames) ? toolNames.filter((n) => typeof n === 'string') : []
      }
      settingsStore.set('mainAgent', next)
      return true
    } catch (error) {
      logger.error('Error in mcp-tools-set:', error)
      throw error
    }
  })

  return handlers
}
