import logger from 'electron-log'
import { settingsStore } from '../../../main/context'
import { HarnessSettings } from '../../../main/types/settings'
import { setCachedDefaultProvider, setCachedEnabledProviders } from '../../../main/provider/cache'
import { getEnabledProviders, getDefaultProvider } from '../../../main/database/mapper/provider'
import { getAllTopicsPaginated } from './db/mapper/harness'
import { loadSubAgentDefinitions } from './tools/builders'
import { SubAgentConfig } from './types'

/**
 * 预加载缓存：加载页阶段预取 Harness 界面所需数据（子代理定义 + 话题首页）。
 *
 * 归属说明（本轮迁移）：模型 Provider 的三项缓存（enabled / default）属 core 的
 * provider-* 通道，已挪到 `src/main/provider/cache.ts`；这里只保留 harness 自己的子代理
 * 定义缓存，预取时顺手把 provider 缓存写进 core（插件 → core，方向合法）。
 */
let cachedSubAgentDefs: Map<number, SubAgentConfig[]> | null = null

export function clearAgentCache(): void {
  cachedSubAgentDefs = null
}

export async function getSubAgentDefs(workspaceId: number): Promise<SubAgentConfig[]> {
  if (!cachedSubAgentDefs) cachedSubAgentDefs = new Map()
  if (cachedSubAgentDefs.has(workspaceId)) return cachedSubAgentDefs.get(workspaceId)!
  const defs = await loadSubAgentDefinitions(workspaceId)
  cachedSubAgentDefs.set(workspaceId, defs)
  return defs
}

export function clearTopicCache(): void {
  // 话题数据不再全量缓存，前端使用分页查询
}

export async function preloadHarnessData(): Promise<void> {
  try {
    const harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined
    const workspaceId = harnessSettings?.activeWorkspaceId ?? 0
    const [enabled, defaultProvider, topicsResult, subAgents] = await Promise.all([
      getEnabledProviders(),
      getDefaultProvider(),
      getAllTopicsPaginated(workspaceId, 0, 20),
      loadSubAgentDefinitions(workspaceId)
    ])
    setCachedEnabledProviders(enabled)
    setCachedDefaultProvider(defaultProvider)
    if (!cachedSubAgentDefs) cachedSubAgentDefs = new Map()
    cachedSubAgentDefs.set(workspaceId, subAgents)
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
