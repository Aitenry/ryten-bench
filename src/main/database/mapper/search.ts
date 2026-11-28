/**
 * Web search settings mapper (global single-row settings + per-service encrypted keys).
 *
 * Read APIs only return the mask and whether a key is configured; decryption happens in the main
 * process only, right before a search call (see `search/settings.ts`).
 */
import { and, eq, isNotNull } from 'drizzle-orm'
import { withOrm } from '../orm'
import { llm_providers, search_providers, search_settings } from '../schema'

/** Global search settings (defaults = built-in search + fallback on + no content fetch) */
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

/** Read the global search settings (returns defaults when no row exists, without writing) */
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

/** Update the global search settings (single-row upsert) */
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

/** Config row of each search service (includes ciphertext; main-process internal use only) */
export interface SearchProviderRow {
  provider: string
  apiKeyEncrypted: string | null
  keyMask: string | null
}

/** List all search-service config rows */
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

/** Read the config row of a single service */
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

/** Write/update the key of a service (ciphertext + mask) */
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

/** Delete the key of a service */
export async function clearSearchProviderRow(provider: string): Promise<void> {
  await withOrm('clearSearchProviderRow', async (db) => {
    await db.delete(search_providers).where(eq(search_providers.provider, provider))
  })
}

/**
 * "Whether a key for the same vendor is already configured under model providers" — used for the key-reuse hint in search results.
 *
 * Only checks the `provider` type and "whether an encrypted key exists"; it neither decrypts nor returns the key.
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
