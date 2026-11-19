/**
 * MCP 服务器配置的持久化（electron-store 的 `mcpServers` 键）。
 *
 * 为什么与 harness 设置分开存：`HarnessSettings` 是「目录/工作区」这类全局项，
 * 而 MCP 是一份可增删的**列表**（含命令、环境变量、请求头等凭据），两者结构不同；
 * 与 `mainAgent` 同款——单独一个顶层键，不进 `harness` 对象。
 *
 * 这个文件是全项目唯一读写 `mcpServers` 的地方：管理器（runtime/mcp.ts）通过
 * `configureMcp(readMcpServers)` 注入读取方法，因此管理器自身不必 import electron，
 * 可以离线跑回归。
 */
import { randomUUID } from 'node:crypto'
import { settingsStore } from '../../../../main/context'
import {
  mcpNamespace,
  normalizeMcpServer,
  restoreServerSecrets,
  type McpServerConfig,
  type McpServerInput
} from '../../shared/mcp'

const STORE_KEY = 'mcpServers'

/** 读取原始配置（形状不保证合法：历史数据/手改过的 store 都要容错） */
export function readMcpServers(): McpServerInput[] {
  const raw = settingsStore.get(STORE_KEY)
  return Array.isArray(raw) ? (raw as McpServerInput[]) : []
}

/** 规范化后的服务器列表（供管理器连接，顺序即用户排序） */
export function listMcpServerConfigs(): McpServerConfig[] {
  const out: McpServerConfig[] = []
  for (const item of readMcpServers()) {
    try {
      out.push(normalizeMcpServer(item))
    } catch {
      // runtime/mcp.ts 的 listMcpServers 已经会告警一次，这里静默跳过
    }
  }
  return out
}

function writeMcpServers(servers: McpServerInput[]): void {
  settingsStore.set(STORE_KEY, servers)
}

/**
 * 命名空间唯一性校验：工具名里只有净化后的服务器名（`mcp__<ns>__<tool>`），
 * 因此 "My Server" 与 "my-server" 会撞到同一个命名空间 —— 保存时直接挡住并给出可读提示，
 * 而不是等到工具清单里出现「后一个被忽略」这种难以察觉的行为。
 */
function assertNamespaceAvailable(name: string, excludeId?: string): void {
  const ns = mcpNamespace(name)
  const conflict = listMcpServerConfigs().find(
    (s) => s.id !== excludeId && mcpNamespace(s.name) === ns
  )
  if (conflict) {
    throw new Error(`服务器名 "${name}" 与 "${conflict.name}" 的工具命名空间相同（${ns}）`)
  }
}

/** 新增或更新一台服务器（input 带 id 且已存在 → 就地更新；否则新建并生成 id） */
export function upsertMcpServer(input: McpServerInput): McpServerConfig {
  const raw = readMcpServers()
  const wantsUpdate = Boolean(input.id && raw.some((s) => s.id === input.id))
  // 掩码还原要在规范化之前做：先拿回真实凭据，再按字段规则校验/落盘
  const previous = wantsUpdate ? raw.find((s) => s.id === input.id) : undefined
  const config = normalizeMcpServer(restoreServerSecrets(input, previous))
  const id = wantsUpdate ? config.id : randomUUID()
  const next: McpServerConfig = { ...config, id }
  assertNamespaceAvailable(next.name, id)

  const index = wantsUpdate ? raw.findIndex((s) => s.id === id) : -1
  const list = [...raw]
  if (index >= 0) list[index] = next
  else list.push(next)
  writeMcpServers(list)
  return next
}

/** 删除一台服务器（其连接与工具随下一次刷新消失） */
export function removeMcpServer(id: string): void {
  writeMcpServers(readMcpServers().filter((s) => s.id !== id))
}

/** 只切启用态（列表行的开关；不动其余字段，避免把半填的配置写坏） */
export function setMcpServerEnabled(id: string, enabled: boolean): McpServerConfig {
  const raw = readMcpServers()
  const index = raw.findIndex((s) => s.id === id)
  if (index < 0) throw new Error(`MCP server not found: ${id}`)
  // 这里**不做掩码还原**：切开关不碰 env/headers，原值原样留在磁盘上
  const next = normalizeMcpServer({ ...raw[index], id, enabled })
  raw[index] = next
  writeMcpServers(raw)
  return next
}

/**
 * 导入 mcp.json 形态的配置（Cursor / Claude Desktop / VS Code 都用这个形状）。
 *
 * 支持两种外壳：`{ "mcpServers": { "name": {...} } }` 与直接
 * `{ "name": {...} }`；条目内 `type`/`transport` 都认，缺省按 stdio。
 * 返回逐条结果——**部分成功也要能用**，失败原因逐条回报而不是整体失败。
 */
export function importMcpServers(raw: unknown): {
  imported: string[]
  failed: { name: string; reason: string }[]
} {
  const imported: string[] = []
  const failed: { name: string; reason: string }[] = []
  const shell = (raw ?? {}) as Record<string, unknown>
  const table = (
    shell.mcpServers && typeof shell.mcpServers === 'object' ? shell.mcpServers : shell
  ) as Record<string, unknown>

  for (const [name, value] of Object.entries(table)) {
    if (!value || typeof value !== 'object') {
      failed.push({ name, reason: '配置项不是对象' })
      continue
    }
    try {
      const entry = value as McpServerInput
      upsertMcpServer({ ...entry, name: (entry.name as string) || name })
      imported.push(name)
    } catch (err) {
      failed.push({ name, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { imported, failed }
}
