import logger from 'electron-log'
import type { BaseChatModel } from '../../ai/chat-model'

/**
 * Resolves the `provider:model` override model from a subagent config; returns undefined on
 * failure (the caller falls back to the main model).
 *
 * Extracted from Runtime because the main runtime (foreground task / workflow) and cold
 * resume (`subagent-resume.ts`) must use the same resolution rule; otherwise the same
 * config could resolve to different models on first start and after a restart. Failures
 * only warn and never throw: subagents are an enhancement, so a missing model degrades to
 * the main model instead of making the session unusable.
 */
export async function resolveSubAgentModelSpec(
  spec: string | undefined
): Promise<BaseChatModel | undefined> {
  if (!spec) return undefined
  // Split on the first colon only (the model name itself may contain colons, e.g. ollama's "qwen2.5:7b")
  const sep = spec.indexOf(':')
  if (sep <= 0) return undefined
  const type = spec.slice(0, sep).trim().toLowerCase()
  const modelName = spec
    .slice(sep + 1)
    .trim()
    .toLowerCase()
  if (!type || !modelName) return undefined
  try {
    const { getEnabledProviders } = await import('../../database/mapper/provider')
    const { getProviderService } = await import('../../provider/service')
    const providers = await getEnabledProviders()
    const match = providers.find(
      (provider) =>
        provider.provider.toLowerCase() === type && provider.model.toLowerCase() === modelName
    )
    if (!match) return undefined
    return await getProviderService().createModel(match.id)
  } catch (err) {
    logger.warn(`[SubagentModel] Failed to resolve "${spec}", falling back to the main model:`, err)
    return undefined
  }
}
