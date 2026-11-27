import * as fs from 'fs'
import { join } from 'path'
import logger from 'electron-log'
import { mainMessages } from '../../i18n'
import { settingsStore } from '../../context'
import type { HarnessSettings } from '../../types/settings'
import { listAvailableTools } from '../../tools/harness/builders'
import { canonicalToolName, isMcpServerGroup } from '../../../shared/harness/mcp'
import { validateSubAgentDraft, type SubAgentDraft } from '../../../shared/harness/subagent'
import type { SubAgentConfig } from './types'
import {
  createAgent,
  deleteAgent,
  getAgentById,
  getAgentByName,
  getEnabledSubAgentConfigs,
  updateAgent,
  type AgentConfigInput
} from '../../database/mapper/harness/agent'
import { getAllWorkspaces } from '../../database/mapper/harness/harness'

/**
 * 工具名归一：旧名迁移（canonicalToolName）+ 去重 + 去空白。
 * 设置页写入、IPC 读展示、gent_create 共用，避免出现两份"看起来一样"的归一逻辑。
 */
export function normalizeSubAgentTools(tools: string[] | null | undefined): string[] | null {
  if (!tools) return null
  const out: string[] = []
  for (const raw of tools) {
    const canonical = canonicalToolName(String(raw).trim())
    if (canonical && !out.includes(canonical)) out.push(canonical)
  }
  return out
}

/**
 * 子代理（智能体）配置服务 —— IPC（设置页）与运行时工具（`agent_create`）共用。
 *
 * 之前这套写入逻辑全在 `ipc/harness/agent.ts` 里：工作区校验、工具名归一、缓存失效、
 * 删除时清理记忆目录。现在主智能体也能「委派构建子代理」，如果工具再抄一遍就出现两份
 * 规则；因此把**写入语义**收敛到这里，IPC 与工具只做参数解析与错误展示。
 *
 * 职责边界：
 * - 校验（纯格式规则来自 `shared/harness/subagent.ts`，工具注册表在这里校验）；
 * - 落库 + 缓存失效（写后必须 `clearSubAgentCache()`，运行时下一次 `task` 才能看到新配置）；
 * - 删除配置时连带清理该子代理的专属记忆目录（与旧 IPC 行为一致）。
 *
 * 读路径（列表/详情）仍由 IPC 直接查 mapper —— 服务层不提供无意义的透传。
 */

/** 编辑补丁：`null` 表示显式清空可选字段（undefined = 不修改），与设置页表单语义一致 */
export interface SubAgentDraftPatch {
  name?: string
  displayName?: string | null
  description?: string
  systemPrompt?: string
  tools?: string[] | null
  model?: string | null
  skills?: string[] | null
}

/** 草稿 + 归属工作区：设置页与 `agent_create` 工具的共同入参 */
export interface SubAgentDefinitionInput extends SubAgentDraft {
  workspaceId: number
}

/** 已落库的子代理配置（工具回给模型/设置页刷新用） */
export interface SubAgentDefinitionResult {
  id: number
  config: SubAgentConfig
}

/** 工具选择校验：只接受当前注册表里真实存在的可选工具（设置页同源清单） */
function assertKnownTools(tools: string[] | null): void {
  if (!tools || tools.length === 0) return
  const available = new Set(listAvailableTools().map((tool) => tool.name))
  // MCP 服务器分组项（mcp@<server>）由 MCP 页决定具体工具，这里只校验语法；具体可用性在运行时展开
  const unknown = tools.filter((name) => !available.has(name) && !isMcpServerGroup(name))
  if (unknown.length > 0) {
    throw new Error(
      `unknown tool(s): ${unknown.join(', ')}. Use tools that exist in the tool registry, or omit tools to inherit the main agent toolset.`
    )
  }
}

/** 工作区必须存在：`agent_config.workspace_id` 有外键约束，先给出可读错误而不是 FK 违例 */
async function assertWorkspaceExists(workspaceId: number): Promise<void> {
  const workspaces = await getAllWorkspaces()
  if (!workspaceId || !workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw new Error(mainMessages().error.workspaceNotConfigured)
  }
}

/** 草稿 → 数据库写入参数（工具名归一、空串转 null 的规则只在服务里维护） */
function toAgentConfigInput(
  workspaceId: number,
  draft: SubAgentDraft,
  tools: string[] | null
): AgentConfigInput {
  return {
    workspace_id: workspaceId,
    name: draft.name.trim(),
    rename: draft.displayName?.trim() || null,
    prompt: draft.systemPrompt.trim(),
    description: draft.description.trim(),
    tools,
    model: draft.model?.trim() || null,
    skills: draft.skills ?? null,
    enable: true
  }
}

/** 草稿 → 运行时形态（创建/更新成功后返回，避免再查一次库） */
function toSubAgentConfig(draft: SubAgentDraft, tools: string[] | null): SubAgentConfig {
  const rename = draft.displayName?.trim()
  return {
    name: draft.name.trim(),
    ...(rename && rename !== draft.name.trim() ? { rename } : {}),
    description: draft.description.trim(),
    systemPrompt: draft.systemPrompt.trim(),
    tools: tools ?? [],
    ...(draft.model?.trim() ? { model: draft.model.trim() } : {}),
    ...(draft.skills && draft.skills.length > 0 ? { skills: draft.skills } : {})
  }
}

/** 删除配置时连带删除子代理专属记忆目录（`<memoryPath>/workspace-<id>/sub-agents/<name>`） */
function removeSubAgentMemory(workspaceId: number, name: string): void {
  const memoryPath = (settingsStore.get('harness') as HarnessSettings | undefined)?.memoryPath
  if (!memoryPath) return
  try {
    const agentDir = join(memoryPath, `workspace-${workspaceId}`, 'sub-agents', name)
    if (fs.existsSync(agentDir)) {
      fs.rmSync(agentDir, { recursive: true, force: true })
      logger.info(`Auto-removed memory directories for sub-agent: ${name}`)
    }
  } catch (err) {
    logger.warn('Failed to auto-remove sub-agent memory directories:', err)
  }
}

/** 创建子代理配置（设置页「新建」与 `agent_create` 工具共用） */
export async function createSubAgentDefinition(
  input: SubAgentDefinitionInput
): Promise<SubAgentDefinitionResult> {
  const errors = validateSubAgentDraft(input)
  if (errors.length > 0) {
    throw new Error(`invalid subagent definition: ${errors.join('; ')}`)
  }
  await assertWorkspaceExists(input.workspaceId)

  const existing = await getAgentByName(input.workspaceId, input.name.trim())
  if (existing) {
    throw new Error(
      `subagent "${input.name.trim()}" already exists in this workspace. Pick another name.`
    )
  }

  const tools = normalizeSubAgentTools(input.tools)
  assertKnownTools(tools)

  const id = await createAgent(toAgentConfigInput(input.workspaceId, input, tools))
  // 运行时按工作区缓存已启用配置：写后必须失效，下一次 task/agent_create 才能读到
  clearSubAgentCache()
  logger.info(`[SubAgentConfig] Created subagent "${input.name}" (workspace=${input.workspaceId})`)
  return { id, config: toSubAgentConfig(input, tools) }
}

/** 更新子代理配置（设置页编辑用；工具不暴露更新，避免模型改乱用户配置） */
export async function updateSubAgentDefinition(
  workspaceId: number,
  id: number,
  patch: SubAgentDraftPatch,
  expectedRevision?: number
): Promise<boolean> {
  const current = await getAgentById(workspaceId, id)
  if (!current) throw new Error(`subagent config ${id} does not exist in this workspace`)

  // 乐观并发：设置页带着打开时的 revision 保存；期间被别的窗口/进程改过就拒绝
  if (expectedRevision !== undefined && current.revision !== expectedRevision) {
    throw new Error(
      `subagent "${current.name}" was modified by someone else (current revision ${current.revision}, expected ${expectedRevision}); reload and try again`
    )
  }

  const merged: SubAgentDraft = {
    name: patch.name ?? current.name,
    displayName:
      patch.displayName === undefined
        ? (current.rename ?? undefined)
        : (patch.displayName ?? undefined),
    description: patch.description ?? current.description ?? '',
    systemPrompt: patch.systemPrompt ?? current.prompt ?? '',
    tools:
      patch.tools === undefined
        ? current.tools
          ? (JSON.parse(current.tools) as string[])
          : undefined
        : (patch.tools ?? undefined),
    model: patch.model === undefined ? (current.model ?? undefined) : (patch.model ?? undefined),
    skills:
      patch.skills === undefined
        ? current.skills
          ? (JSON.parse(current.skills) as string[])
          : undefined
        : (patch.skills ?? undefined)
  }
  const errors = validateSubAgentDraft(merged)
  if (errors.length > 0) throw new Error(`invalid subagent definition: ${errors.join('; ')}`)

  // 改名要重新校验唯一（排除自己）
  if (merged.name.trim() !== current.name) {
    const existing = await getAgentByName(workspaceId, merged.name.trim())
    if (existing && existing.id !== id) {
      throw new Error(`subagent "${merged.name.trim()}" already exists in this workspace`)
    }
  }

  const tools = normalizeSubAgentTools(merged.tools)
  assertKnownTools(tools)

  // 写库时再带一次 expectedRevision：读-改-写之间若有并发更新，CAS 会失败而不是覆盖
  const result = await updateAgent(
    workspaceId,
    id,
    toAgentConfigInput(workspaceId, merged, tools),
    expectedRevision ?? current.revision
  )
  if (!result) {
    throw new Error(`subagent "${current.name}" was modified concurrently; reload and try again`)
  }
  clearSubAgentCache()
  return result
}

/** 删除子代理配置（设置页删除用；连带清理专属记忆目录） */
export async function deleteSubAgentDefinition(workspaceId: number, id: number): Promise<boolean> {
  const agent = await getAgentById(workspaceId, id)
  const deleted = await deleteAgent(workspaceId, id)
  if (deleted) {
    clearSubAgentCache()
    if (agent) removeSubAgentMemory(workspaceId, agent.name)
  }
  return deleted
}

/** 按工作区缓存的「已启用子代理定义」：task 调用期读取，写配置后由本模块失效 */
const enabledDefinitionsCache = new Map<number, SubAgentConfig[]>()

/** 失效缓存（创建/更新/删除配置后调用；预加载与运行时共用同一份） */
export function clearSubAgentCache(): void {
  enabledDefinitionsCache.clear()
}

/**
 * 读取当前工作区已启用的子代理定义（带进程内缓存）。
 *
 * `task` 工具在**每次调用时**重新读这份清单：主智能体刚用 `agent_create` 建好的
 * 子代理，同一轮内就能被 `task` 派发（缓存在创建时已失效）。预加载也复用同一入口，
 * 避免「读路径两份缓存」。
 */
export async function listEnabledSubAgents(workspaceId: number): Promise<SubAgentConfig[]> {
  const cached = enabledDefinitionsCache.get(workspaceId)
  if (cached) return cached
  const defs = await getEnabledSubAgentConfigs(workspaceId)
  enabledDefinitionsCache.set(workspaceId, defs)
  return defs
}
