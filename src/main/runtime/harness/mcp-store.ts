/**
 * Persistence of MCP server configuration (the electron-store `mcpServers` key).
 *
 * Why stored separately from harness settings: `HarnessSettings` holds global items such as
 * directories/workspace, while MCP is an editable **list** (containing commands, environment
 * variables, request headers and other credentials), so the two have different structures; like
 * `mainAgent`, it is a separate top-level key rather than part of the `harness` object.
 *
 * This file is the only place in the project that reads/writes `mcpServers`: the manager
 * (runtime/mcp.ts) gets a read method injected via `configureMcp(readMcpServers)`, so the manager
 * itself does not need to import electron and can run regression offline.
 */
import { randomUUID } from 'node:crypto'
import { settingsStore } from '../../context'
import {
  mcpNamespace,
  normalizeMcpServer,
  restoreServerSecrets,
  type McpServerConfig,
  type McpServerInput
} from '../../../shared/harness/mcp'

const STORE_KEY = 'mcpServers'

/** Read the raw configuration (the shape is not guaranteed valid: historical data / hand-edited stores must be tolerated) */
export function readMcpServers(): McpServerInput[] {
  const raw = settingsStore.get(STORE_KEY)
  return Array.isArray(raw) ? (raw as McpServerInput[]) : []
}

/** Normalized server list (for the manager to connect; order is the user's ordering) */
export function listMcpServerConfigs(): McpServerConfig[] {
  const out: McpServerConfig[] = []
  for (const item of readMcpServers()) {
    try {
      out.push(normalizeMcpServer(item))
    } catch {
      // listMcpServers in runtime/mcp.ts already warns once, so skip silently here
    }
  }
  return out
}

function writeMcpServers(servers: McpServerInput[]): void {
  settingsStore.set(STORE_KEY, servers)
}

/**
 * Namespace uniqueness check: tool names only contain the sanitized server name
 * (`mcp__<ns>__<tool>`), so "My Server" and "my-server" collide on the same namespace — block it at
 * save time with a readable message instead of waiting for the hard-to-notice behavior of "the
 * latter one is ignored" in the tool list.
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

/** Add or update a server (input with an existing id → update in place; otherwise create and generate an id) */
export function upsertMcpServer(input: McpServerInput): McpServerConfig {
  const raw = readMcpServers()
  const wantsUpdate = Boolean(input.id && raw.some((s) => s.id === input.id))
  // Mask restoration must happen before normalization: recover the real credentials first, then
  // validate/persist according to the field rules
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

/** Delete a server (its connection and tools disappear on the next refresh) */
export function removeMcpServer(id: string): void {
  writeMcpServers(readMcpServers().filter((s) => s.id !== id))
}

/** Toggle only the enabled state (the row switch; leave other fields untouched to avoid corrupting a half-filled config) */
export function setMcpServerEnabled(id: string, enabled: boolean): McpServerConfig {
  const raw = readMcpServers()
  const index = raw.findIndex((s) => s.id === id)
  if (index < 0) throw new Error(`MCP server not found: ${id}`)
  // **No mask restoration** here: toggling the switch does not touch env/headers, so the original
  // values stay on disk as-is
  const next = normalizeMcpServer({ ...raw[index], id, enabled })
  raw[index] = next
  writeMcpServers(raw)
  return next
}

/**
 * Import an mcp.json-shaped configuration (the common shape used by MCP clients).
 *
 * Two envelopes are supported: `{ "mcpServers": { "name": {...} } }` and a bare
 * `{ "name": {...} }`; entries accept either `type` or `transport`, defaulting to stdio.
 * Results are returned per entry — **partial success must remain usable**, so failures are reported
 * entry by entry instead of failing the whole import.
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
