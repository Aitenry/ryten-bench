import logger from 'electron-log'
import { settingsStore } from '../../context'
import { HarnessSettings } from '../../types/settings'
import { setCachedDefaultProvider, setCachedEnabledProviders } from '../../provider/cache'
import { getEnabledProviders, getDefaultProvider } from '../../database/mapper/provider'
import { getAllTopicsPaginated } from '../../database/mapper/harness/harness'
import { listEnabledSubAgents } from './subagents'

/**
 * Preload cache: prefetch the data the Harness UI needs during the loading screen (sub-agent
 * definitions + first topic page).
 *
 * Ownership notes (from this migration): the three model-provider caches (enabled / default)
 * belong to core's provider-* channels and moved to `src/main/provider/cache.ts`; the sub-agent
 * definition cache now lives in `services/harness/subagents.ts` (one entry point for writing and
 * reading config), so this module only calls the service once during prefetch and writes the
 * provider caches into core along the way.
 */

/**
 * Topic data is no longer cached in full; the frontend uses paginated queries.
 * This empty implementation is kept so call sites after topic CRUD stay uniform (restoring the
 * cache later only requires changing this file).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op placeholder
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
