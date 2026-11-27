/**
 * 联网搜索设置 mapper（全局单行 settings + 各服务加密密钥）。
 *
 * 读取接口只返回掩码与是否已配置；解密只发生在主进程调用搜索前（见 `search/settings.ts`）。
 */
import { and, eq, isNotNull } from 'drizzle-orm'
import { withOrm } from '../orm'
import { llm_providers, search_providers, search_settings } from '../schema'

/** 全局搜索设置（默认值 = 内置搜索 + 回退开 + 不取正文） */
export interface SearchSettingsRow {
  defaultProvider: string
  autoFallback: boolean
  includeContent: boolean
}

export const DEFAULT_SEARCH_SETTINGS: SearchSettingsRow = {
  defaultProvider: 'builtin',
  autoFallback: true,
  includeContent: false
}

/** 读取全局搜索设置（行不存在时返回默认值，不落库） */
export async function getSearchSettingsRow(): Promise<SearchSettingsRow> {
  return withOrm('getSearchSettingsRow', async (db) => {
    const rows = await db.select().from(search_settings).limit(1)
    const row = rows[0]
    if (!row) return { ...DEFAULT_SEARCH_SETTINGS }
    return {
      defaultProvider: row.default_provider,
      autoFallback: row.auto_fallback,
      includeContent: row.include_content
    }
  })
}

/** 更新全局搜索设置（单行 upsert） */
export async function updateSearchSettingsRow(
  patch: Partial<SearchSettingsRow>
): Promise<SearchSettingsRow> {
  return withOrm('updateSearchSettingsRow', async (db) => {
    const current = await db.select().from(search_settings).limit(1)
    const next: SearchSettingsRow = {
      defaultProvider: patch.defaultProvider ?? current[0]?.default_provider ?? DEFAULT_SEARCH_SETTINGS.defaultProvider,
      autoFallback: patch.autoFallback ?? current[0]?.auto_fallback ?? DEFAULT_SEARCH_SETTINGS.autoFallback,
      includeContent: patch.includeContent ?? current[0]?.include_content ?? DEFAULT_SEARCH_SETTINGS.includeContent
    }
    await db
      .insert(search_settings)
      .values({
        id: 1,
        default_provider: next.defaultProvider,
        auto_fallback: next.autoFallback,
        include_content: next.includeContent,
        updated_at: new Date().toISOString()
      })
      .onConflictDoUpdate({
        target: search_settings.id,
        set: {
          default_provider: next.defaultProvider,
          auto_fallback: next.autoFallback,
          include_content: next.includeContent,
          updated_at: new Date().toISOString()
        }
      })
    return next
  })
}

/** 各搜索服务的配置行（含密文；仅主进程内部使用） */
export interface SearchProviderRow {
  provider: string
  apiKeyEncrypted: string | null
  keyMask: string | null
}

/** 列出全部搜索服务配置行 */
export async function listSearchProviderRows(): Promise<SearchProviderRow[]> {
  return withOrm('listSearchProviderRows', async (db) => {
    const rows = await db.select().from(search_providers)
    return rows.map((row) => ({
      provider: row.provider,
      apiKeyEncrypted: row.api_key_encrypted,
      keyMask: row.key_mask
    }))
  })
}

/** 读取单个服务的配置行 */
export async function getSearchProviderRow(provider: string): Promise<SearchProviderRow | null> {
  return withOrm('getSearchProviderRow', async (db) => {
    const rows = await db
      .select()
      .from(search_providers)
      .where(eq(search_providers.provider, provider))
    const row = rows[0]
    if (!row) return null
    return {
      provider: row.provider,
      apiKeyEncrypted: row.api_key_encrypted,
      keyMask: row.key_mask
    }
  })
}

/** 写入/更新某服务的密钥（密文 + 掩码） */
export async function upsertSearchProviderRow(
  provider: string,
  apiKeyEncrypted: string,
  keyMask: string
): Promise<void> {
  await withOrm('upsertSearchProviderRow', async (db) => {
    await db
      .insert(search_providers)
      .values({
        provider,
        api_key_encrypted: apiKeyEncrypted,
        key_mask: keyMask,
        updated_at: new Date().toISOString()
      })
      .onConflictDoUpdate({
        target: search_providers.provider,
        set: {
          api_key_encrypted: apiKeyEncrypted,
          key_mask: keyMask,
          updated_at: new Date().toISOString()
        }
      })
  })
}

/** 删除某服务的密钥 */
export async function clearSearchProviderRow(provider: string): Promise<void> {
  await withOrm('clearSearchProviderRow', async (db) => {
    await db.delete(search_providers).where(eq(search_providers.provider, provider))
  })
}

/**
 * 「模型供应商里是否已配置同厂商的 Key」——用于搜索结果 Key 的复用提示。
 *
 * 只查 `provider` 类型与「是否存在已加密 Key」两件事，不解密、不返回 Key。
 */
export async function hasModelProviderWithKey(providerType: string): Promise<boolean> {
  return withOrm('hasModelProviderWithKey', async (db) => {
    const rows = await db
      .select({ id: llm_providers.id })
      .from(llm_providers)
      .where(
        and(
          eq(llm_providers.provider, providerType),
          isNotNull(llm_providers.api_key_encrypted),
          eq(llm_providers.is_enabled, true)
        )
      )
      .limit(1)
    return rows.length > 0
  })
}
