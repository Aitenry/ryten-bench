/**
 * `list_subagent_models` 工具：列出**已启用**的模型路由（`provider:model`）与能力摘要。
 *
 * 为什么需要：`agent_create` / 子代理配置的 `model` 字段只接受已启用的 `provider:model`；
 * 模型看不到供应商配置，没有这个只读清单就只能瞎猜（猜错会静默回退主模型）。
 *
 * 只读、无副作用；数据来自 provider mapper（启用中的供应商行）与模型档案（能力标签）。
 */
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { mainFormat } from '../../i18n'
import { getModelRoutesTexts } from '../../i18n/tool-results-models'
import { getEnabledProviders } from '../../database/mapper/provider'
import { findModelProfile } from '../../provider/model-tags'
import { formatModelRoutes, type ModelRouteEntry } from './model-routes-core'

/** 构造模型路由清单工具 */
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
