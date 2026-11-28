import logger from 'electron-log'
import type { BaseChatModel } from '../../ai/chat-model'

/**
 * Parses a `provider:model` spec into its two halves.
 *
 * Splits on the first colon only (the model name itself may contain colons, e.g. ollama's
 * "qwen2.5:7b"); a malformed spec yields null.
 */
function parseModelSpec(spec: string): { providerType: string; modelName: string } | null {
  const sep = spec.indexOf(':')
  if (sep <= 0) return null
  const providerType = spec.slice(0, sep).trim().toLowerCase()
  const modelName = spec
    .slice(sep + 1)
    .trim()
    .toLowerCase()
  if (!providerType || !modelName) return null
  return { providerType, modelName }
}

/**
 * Resolves a `provider:model` spec to the matching **enabled provider row id**.
 *
 * Shared by subagent model overrides and scheduled-task models: both store the same
 * `provider:model` string and must resolve it the same way, otherwise the same config could pick
 * different providers in the two features. Returns undefined when the spec is malformed or no
 * enabled provider matches (callers decide the fallback).
 */
export async function resolveModelSpecProviderId(
  spec: string | undefined
): Promise<number | undefined> {
  if (!spec) return undefined
  const parsed = parseModelSpec(spec)
  if (!parsed) return undefined
  try {
    const { getEnabledProviders } = await import('../../database/mapper/provider')
    const providers = await getEnabledProviders()
    const match = providers.find(
      (provider) =>
        provider.provider.trim().toLowerCase() === parsed.providerType &&
        provider.model.trim().toLowerCase() === parsed.modelName
    )
    return match?.id
  } catch (err) {
    logger.warn(`[SubagentModel] Failed to resolve "${spec}":`, err)
    return undefined
  }
}

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
  const providerId = await resolveModelSpecProviderId(spec)
  if (providerId === undefined) return undefined
  try {
    const { getProviderService } = await import('../../provider/service')
    return await getProviderService().createModel(providerId)
  } catch (err) {
    logger.warn(`[SubagentModel] Failed to create model for "${spec}", falling back:`, err)
    return undefined
  }
}
