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
 * Cold resume: rebuild the runtime required to run a session from the persisted subagent
 * config snapshot.
 *
 * Resume semantics rebuild a continuable session from the currently deployed preset, but
 * deliberately omit the plugin-composition layer: only these are needed here
 * - the main model (provider/model persisted at spawn time; falls back to the default
 *   provider when missing or unavailable) and `provider:model` override resolution;
 * - tools (the subagent's declared set + team task board), all passed through the
 *   permission guard;
 * - the system prompt (base prompt + dedicated memory + skills + team section, from the
 *   same source as first start);
 * - runtime limits (tool rounds from the model settings).
 *
 * The memory scope is resolved from the topic's **current** `memory_scope`: plugin /
 * conversation / workspace sessions each land in their own memory directory, consistent
 * with the main conversation and foreground subagents (the config snapshot does not store
 * paths, so moving settings will not leave references to old directories).
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
    // Prefer the provider persisted at spawn time (descriptor semantics); fall back to the default when missing/unavailable
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
    // Effective model name: the persisted descriptor's model takes precedence (it may be a historical value)
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
