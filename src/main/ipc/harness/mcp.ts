import { BrowserWindow, dialog } from 'electron'
import * as fs from 'fs'
import logger from 'electron-log'
import { safeSend } from '../../safe-send'
import { settingsStore } from '../../context'
import { mainMessages } from '../../i18n'
import type { IpcHandlerMap } from '../register'
import type { MainAgentConfig, McpServerInput } from '../../../shared/harness/mcp'
import { mcpServerViews, refreshCatalog, testMcpServer } from '../../runtime/harness/mcp'
import {
  listMcpResourceTemplates,
  listMcpResources,
  readMcpResource
} from '../../runtime/harness/mcp'
import {
  importMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  upsertMcpServer
} from '../../runtime/harness/mcp-store'

/**
 * IPC for MCP server management (Settings → MCP page).
 *
 * Ownership: MCP is an "external source of tools for the AI", and its settings page sits under
 * the assistant group, so it belongs to the harness plugin along with agent config; channels are
 * always `harness:mcp-*`, and disabling the "AI assistant" removes this channel group as well.
 *
 * Catalog changes (connect/disconnect/new tools) are broadcast via
 * `harness:harness-mcp-updated`: both the tool dropdown on the agent settings page and the MCP
 * page rely on it to refresh — **without this broadcast, a just-saved server's tools won't show
 * up until the settings page is reopened next time**.
 */

/** Catalog update event channel (main → renderer; declared into the preload whitelist by main/index.ts) */
export const MCP_EVENT_CHANNELS = {
  catalogUpdated: 'harness:harness-mcp-updated'
} as const

/** Broadcast catalog changes (send only, never subscribe; safeSend silently skips destroyed windows) */
function broadcastCatalog(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) safeSend(win.webContents, MCP_EVENT_CHANNELS.catalogUpdated, {})
  }
}

/** Reconnect and broadcast (run after save/remove/toggle/manual reconnect) */
async function reconnectAndBroadcast(): Promise<void> {
  await refreshCatalog()
  broadcastCatalog()
}

export function mcpIpcHandlers(): IpcHandlerMap {
  const handlers: IpcHandlerMap = {}
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`harness:${channel}`] = handler
  }

  // Current server list + runtime status (connected or not, which tools exist).
  // **Read-only snapshot, no reconnect** (2026-09-26 user requirement: loading the list must not
  // test connections, otherwise it stalls with many servers). To refresh the status, click
  // "Reconnect"; save/toggle/remove still reconnect actively and broadcast.
  handle('mcp-servers-list', async () => {
    try {
      return mcpServerViews()
    } catch (error) {
      logger.error('Error in mcp-servers-list:', error)
      throw error
    }
  })

  // Add/update a server → reconnect immediately so the UI sees the real status right away
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

  // Manually reconnect all servers (one click recovers after external processes are killed or the network comes back)
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
   * Test a **not-yet-saved** server: returns the tool list on success, the raw error on failure.
   * Deliberately does not throw — the form needs to show the failure reason under the field
   * (a thrown error would be folded into one generic failure by the IPC layer).
   */
  handle('mcp-server-test', async (input: McpServerInput) => {
    try {
      return await testMcpServer(input)
    } catch (error) {
      logger.error('Error in mcp-server-test:', error)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Import mcp.json-shaped config (reports each entry; partial success is usable)
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
   * Import: the main process opens a file dialog to read mcp.json.
   *
   * It lives in the main process because the renderer has no fs, and users' configs are usually
   * already on disk (Cursor's `~/.cursor/mcp.json`, Claude Desktop's
   * `claude_desktop_config.json`), so picking a file is far more realistic than having the user
   * copy-paste a big chunk of JSON. Returns null when the selection is canceled.
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
   * Check/uncheck all tools contributed by one server (writes mainAgent.mcpTools).
   *
   * Only this one key changes: `mcpTools` is stored separately from the main agent page's
   * `tools` (see the notes in shared/mcp.ts), so disabling a server here does **not** touch
   * other tools the user picked on the agent page — and saving on both sides at once won't
   * overwrite each other (each writes its own key), which is exactly why the two entry points
   * keep separate copies of the data.
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

  // ── Resource browsing (read-only): the "Resources" entry on the server row of the MCP page ──
  // The model side has long had the list_mcp_resources / read_mcp_resource tools, but users had
  // no browsing entry. Here the same runtime read capability is wrapped into three read-only
  // channels; failures return `{ok:false,error}` instead of throwing (a disconnected server or
  // unsupported resources are expected states, and the page shows the reason in place).
  handle(
    'mcp-resources-list',
    async (payload: { server?: unknown; cursor?: unknown }) => {
      const server = typeof payload?.server === 'string' ? payload.server.trim() : ''
      if (!server) return { ok: false, error: 'invalid-server', resources: [] as unknown[] }
      try {
        const result = await listMcpResources(
          server,
          typeof payload?.cursor === 'string' && payload.cursor ? payload.cursor : undefined
        )
        return { ok: true as const, ...result }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('Error in mcp-resources-list:', message)
        return { ok: false, error: message, resources: [] as unknown[] }
      }
    }
  )

  handle(
    'mcp-resources-templates',
    async (payload: { server?: unknown; cursor?: unknown }) => {
      const server = typeof payload?.server === 'string' ? payload.server.trim() : ''
      if (!server) return { ok: false, error: 'invalid-server', templates: [] as unknown[] }
      try {
        const result = await listMcpResourceTemplates(
          server,
          typeof payload?.cursor === 'string' && payload.cursor ? payload.cursor : undefined
        )
        return { ok: true as const, ...result }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('Error in mcp-resources-templates:', message)
        return { ok: false, error: message, templates: [] as unknown[] }
      }
    }
  )

  handle(
    'mcp-resources-read',
    async (payload: { server?: unknown; uri?: unknown }) => {
      const server = typeof payload?.server === 'string' ? payload.server.trim() : ''
      const uri = typeof payload?.uri === 'string' ? payload.uri.trim() : ''
      if (!server || !uri) return { ok: false, error: 'invalid-request', contents: [] as unknown[] }
      try {
        const result = await readMcpResource(server, uri)
        return { ok: true as const, ...result }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('Error in mcp-resources-read:', message)
        return { ok: false, error: message, contents: [] as unknown[] }
      }
    }
  )

  return handlers
}
