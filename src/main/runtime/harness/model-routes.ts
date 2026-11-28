/**
 * `list_subagent_models` tool: lists **enabled** model routes (`provider:model`) with a
 * capability summary.
 *
 * Why it is needed: the `model` field of `agent_create` / subagent configuration only accepts
 * enabled `provider:model` routes; models cannot see the provider configuration, so without
 * this read-only list they can only guess (a wrong guess silently falls back to the main model).
 *
 * Read-only, no side effects; data comes from the provider mapper (enabled provider rows) and
 * model profiles (capability labels).
 */
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { mainFormat } from '../../i18n'
import { getModelRoutesTexts } from '../../i18n/tool-results-models'
import { getEnabledProviders } from '../../database/mapper/provider'
import { findModelProfile } from '../../provider/model-tags'
import { formatModelRoutes, type ModelRouteEntry } from './model-routes-core'

/** Builds the model route list tool */
export function buildModelRoutesTool(): StructuredToolInterface {
  return tool(
    async () => {
      const texts = getModelRoutesTexts()
      try {
        const providers = await getEnabledProviders()
        const entries: ModelRouteEntry[] = providers.map((provider) => {
          const profile = findModelProfile(provider.model)
          const capabilities = profile?.capabilities
          return {
            spec: `${provider.provider}:${provider.model}`,
            name: provider.name,
            providerType: provider.provider,
            model: provider.model,
            isDefault: provider.is_default,
            capabilities: capabilities
              ? {
                  image: capabilities.supports_image_input === true,
                  tools: capabilities.supports_function_calling === true,
                  reasoning:
                    capabilities.supports_thinking === true ||
                    (capabilities.reasoning_effort_levels?.length ?? 0) > 0
                }
              : undefined
          }
        })
        return formatModelRoutes(mainFormat, texts, entries)
      } catch (error) {
        return mainFormat(texts.failed, {
          message: error instanceof Error ? error.message : String(error)
        })
      }
    },
    {
      name: 'list_subagent_models',
      isConcurrencySafe: () => true,
      timeoutMs: 15_000,
      description:
        'List the enabled model routes of this app as "provider:model" specs with a capability summary (image input, tool calling, reasoning) and which one is the default. Use it before setting the `model` field of agent_create or a subagent configuration; omitted models inherit the main model.',
      schema: z.object({})
    }
  )
}
