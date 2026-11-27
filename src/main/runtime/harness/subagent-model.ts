import logger from 'electron-log'
import type { BaseChatModel } from '../../ai/chat-model'

/**
 * 解析子代理配置里的 `provider:model` 覆盖模型；失败返回 undefined（调用方回退主模型）。
 *
 * 从 Runtime 抽出来的原因：主运行时（前台 task / 工作流）和冷恢复（`subagent-resume.ts`）
 * 必须用同一条解析规则，否则同一个配置在「首次启动」和「重启恢复」后可能落到不同模型。
 * 失败只告警不抛错：子代理是增强能力，模型缺失时降级到主模型而不是让会话不可用。
 */
export async function resolveSubAgentModelSpec(
  spec: string | undefined
): Promise<BaseChatModel | undefined> {
  if (!spec) return undefined
  // 仅按第一个冒号分割（模型名可能本身含冒号，如 ollama 的 "qwen2.5:7b"）
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
