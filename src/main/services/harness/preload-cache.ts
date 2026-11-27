import logger from 'electron-log'
import { settingsStore } from '../../context'
import { HarnessSettings } from '../../types/settings'
import { setCachedDefaultProvider, setCachedEnabledProviders } from '../../provider/cache'
import { getEnabledProviders, getDefaultProvider } from '../../database/mapper/provider'
import { getAllTopicsPaginated } from '../../database/mapper/harness/harness'
import { listEnabledSubAgents } from './subagents'

/**
 * 预加载缓存：加载页阶段预取 Harness 界面所需数据（子代理定义 + 话题首页）。
 *
 * 归属说明（本轮迁移）：模型 Provider 的三项缓存（enabled / default）属 core 的
 * provider-* 通道，已挪到 `src/main/provider/cache.ts`；子代理定义缓存在本轮收进
 * `services/harness/subagents.ts`（写配置与读配置只有一个入口），这里只在预取时
 * 调一次服务并顺手把 provider 缓存写进 core。
 */

/**
 * 话题数据不再全量缓存，前端使用分页查询。
 * 保留这个空实现是为了让话题 CRUD 后的调用点保持统一（以后若恢复缓存只需改这里）。
 */
// eslint-disable-next-line @typescript-eslint/no-empty-function -- 刻意的 no-op 占位
export function clearTopicCache(): void {}

export async function preloadHarnessData(): Promise<void> {
  try {
    const harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined
    const workspaceId = harnessSettings?.activeWorkspaceId ?? 0
    const [enabled, defaultProvider, topicsResult, subAgents] = await Promise.all([
      getEnabledProviders(),
      getDefaultProvider(),
      getAllTopicsPaginated(workspaceId, 0, 20),
      listEnabledSubAgents(workspaceId)
    ])
    setCachedEnabledProviders(enabled)
    setCachedDefaultProvider(defaultProvider)
    logger.info('[Preload] Harness data preloaded:', {
      providers: enabled.length,
      topics: topicsResult.items.length,
      topicsTotal: topicsResult.total,
      subAgents: subAgents.length
    })
  } catch (err) {
    logger.error('[Preload] Failed to preload harness data:', err)
  }
}
