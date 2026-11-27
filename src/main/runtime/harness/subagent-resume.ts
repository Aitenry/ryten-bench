import logger from 'electron-log'
import { settingsStore } from '../../context'
import type { HarnessSettings } from '../../types/settings'
import { getDefaultProvider, getProviderById } from '../../database/mapper/provider'
import { getTopicById } from '../../database/mapper/harness/harness'
import { getProviderService } from '../../provider/service'
import type { SubAgentMainModelDescriptor } from '../../services/harness/types'
import { buildSubAgentTools as buildSubAgentToolsFromRegistry } from '../../tools/harness/builders'
import { memoryScopeRoot, parseMemoryScope } from '../../services/harness/memory-scope'
import { guardTools } from './permission-guard'
import { buildTeamTools, teamStore } from './team'
import { teamModeStore } from './team-mode'
import { buildSubAgentSessionPrompt } from './subagent'
import { resolveSubAgentModelSpec } from './subagent-model'
import { MAX_TOOL_CALLS, MIN_TOOL_CALLS } from './agent'
import { SpillStore } from './spill'
import type { SubagentSessionRuntime } from './subagent-sessions'

/**
 * 冷恢复：按持久化的子代理配置快照重建一次会话运行所需的 runtime。
 *
 * 恢复语义对齐 DSH 的「按当前部署的 preset 重建 continuable session」，但刻意去掉
 * Cordis/插件组合那层：这里只需要
 * - 主模型（spawn 时持久化的 provider/model；缺失或不可用时回退默认供应商）与
 *   `provider:model` 覆盖解析；
 * - 工具（子代理声明集合 + 团队任务板）并统一过权限闸门；
 * - 系统提示词（基础 prompt + 专属记忆 + 技能 + 团队段，与首次启动同源）；
 * - 运行时上限（模型设置的工具轮数）。
 *
 * 记忆作用域按**话题当前的** `memory_scope` 解析：插件/对话/工作区会话各自落到自己的记忆目录，
 * 与主对话/前台子代理保持同一口径（配置快照里不重复存路径，避免设置搬家后指向旧目录）。
 */
export async function buildResumedSubagentRuntime(
  topicId: number,
  descriptor?: SubAgentMainModelDescriptor
): Promise<SubagentSessionRuntime | undefined> {
  try {
    const settings = settingsStore.get('harness') as HarnessSettings | undefined
    await teamModeStore.ensure(topicId)
    const workspaceId = settings?.activeWorkspaceId ?? 0
    const defaultProvider = await getDefaultProvider()
    if (!defaultProvider) {
      logger.warn('[SubagentResume] No default provider; cannot resume session')
      return undefined
    }

    const providerService = getProviderService()
    // 优先用 spawn 时持久化的 provider（DSH 的 descriptor 语义）；缺失/不可用回退默认
    let provider = defaultProvider
    let usedPersistedDescriptor = false
    if (descriptor?.providerId) {
      try {
        const persisted = await getProviderById(descriptor.providerId)
        if (persisted) {
          provider = persisted
          usedPersistedDescriptor = true
        }
      } catch (err) {
        logger.warn('[SubagentResume] Failed to read persisted provider, using default:', err)
      }
    }
    let mainModel
    try {
      mainModel = await providerService.createModel(
        provider.id,
        usedPersistedDescriptor ? descriptor?.model : undefined
      )
    } catch (err) {
      if (provider.id !== defaultProvider.id) {
        logger.warn(
          '[SubagentResume] Failed to create persisted model, falling back to default provider:',
          err
        )
        provider = defaultProvider
        usedPersistedDescriptor = false
        mainModel = await providerService.createModel(defaultProvider.id)
      } else {
        throw err
      }
    }
    // 实际生效的模型名：持久化 descriptor 的 model 优先（模型名可能是历史值）
    const effectiveModel =
      (usedPersistedDescriptor ? descriptor?.model?.trim() : '') || provider.model
    logger.info(
      `[SubagentResume] Using model provider=${provider.id} (${provider.provider}/${effectiveModel})${usedPersistedDescriptor ? ' from persisted descriptor' : ' (default fallback)'}`
    )
    let configuredMaxToolCalls: number | undefined
    try {
      configuredMaxToolCalls = (await providerService.getConfig(provider.id)).max_tool_rounds
    } catch (err) {
      logger.warn('[SubagentResume] Failed to read model max tool rounds, using default:', err)
    }
    const maxToolCalls = Math.max(
      MIN_TOOL_CALLS,
      Math.floor(configuredMaxToolCalls ?? MAX_TOOL_CALLS)
    )

    const topic = (await getTopicById(topicId))[0]
    const memoryPath = memoryScopeRoot(
      settings?.memoryPath || undefined,
      parseMemoryScope(topic?.memory_scope, workspaceId)
    )
    const skillsPath = settings?.skillsPath || undefined
    const workspaceRoot = settings?.workspacePath || undefined

    return {
      mainModel,
      resolveModel: (spec) => resolveSubAgentModelSpec(spec),
      buildTools: (subAgent) =>
        guardTools(
          [
            ...buildSubAgentToolsFromRegistry(subAgent),
            ...(teamModeStore.isEnabled(topicId) ? buildTeamTools(teamStore, topicId) : [])
          ],
          { topicId, workspaceRoot }
        ),
      recursionLimit: maxToolCalls * 2 + 20,
      maxToolCalls,
      spillRef: { current: new SpillStore(workspaceRoot, memoryPath, topicId) },
      extendSystemPrompt: (subAgent) =>
        buildSubAgentSessionPrompt(
          subAgent,
          { memoryPath, skillsPath },
          teamModeStore.isEnabled(topicId)
        )
    }
  } catch (err) {
    logger.warn('[SubagentResume] Failed to build runtime for restored session:', err)
    return undefined
  }
}
