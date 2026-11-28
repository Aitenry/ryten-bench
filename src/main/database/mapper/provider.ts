import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { PgInsertValue, PgUpdateSetSource } from 'drizzle-orm/pg-core'
import logger from 'electron-log'
import { encryptApiKey, decryptApiKey } from '../../crypto/provider-key'
import { withOrm } from '../orm'
import { llm_providers } from '../schema'
import { DEFAULT_MAX_TOOL_ROUNDS, type ThinkingMode } from '../../../shared/model-params'

// --- Type definitions ---

/** Raw database row (fields inferred from schema) */
export type LlmProviderRow = typeof llm_providers.$inferSelect

/**
 * Pin sort value: the database takes "current max + 1", so the frontend no longer fills in a sort number.
 * List order is always sort_order descending → pinned (>0) first, unpinned (0) after.
 */
const NEXT_PIN_ORDER = sql`(select coalesce(max(sort_order), 0) + 1 from ${llm_providers})`

/** Provider config (api_key is decrypted only on runtime paths; it is always null in list views, so keys never reach the renderer) */
export interface LlmProviderConfig {
  id: number
  name: string
  provider: string
  base_url: string | null
  api_key: string | null
  model: string
  /** Sampling temperature: null = unset, use the provider's best default */
  temperature: number | null
  max_tokens: number | null
  top_p: number | null
  top_k: number | null
  thinking_mode: ThinkingMode
  /** Reasoning effort: null = unset (no tier parameter is sent, model default applies); values come from the model profile's tier table */
  reasoning_effort: string | null
  max_tool_rounds: number
  extra_config: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  is_default: boolean
  is_enabled: boolean
  /** Pin sort value (>0 means pinned, taken from max+1 in SQL); used for list ordering only, never typed in the form */
  sort_order: number
  /** Whether pinned (projection of sort_order > 0, read directly by the UI toggle) */
  is_pinned: boolean
}

/** Input for create/update (excluding auto-generated fields) */
export interface LlmProviderInput {
  name: string
  provider: string
  base_url?: string | null
  api_key?: string | null // plaintext input, encrypted inside the mapper
  model: string
  /** Sampling params: empty (undefined/null) = not sent, use the provider's best default */
  temperature?: number | null
  max_tokens?: number | null
  top_p?: number | null
  top_k?: number | null
  thinking_mode?: ThinkingMode
  /** Reasoning effort: empty (undefined/null) = unset, no tier parameter is sent */
  reasoning_effort?: string | null
  max_tool_rounds?: number
  extra_config?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
  is_default?: boolean
  is_enabled?: boolean
  /** Whether pinned: true → sort_order is max+1 from SQL, false → reset to 0 */
  pinned?: boolean
}

// --- Internal helpers ---

/**
 * Build the config from a row. When includeKey=false, api_key is always null (list/read-only
 * scenarios where the decrypted key must never leave the main process); runtime read paths
 * (getProviderById, getEnabledProviders, getDefaultProvider) must pass true for fetch calls.
 *
 * Columns are nullable; missing values fall back to the table defaults (top_p, top_k, temperature unset = not sent /
 * thinking_mode auto / max_tool_rounds 500 / is_default false / is_enabled true / sort_order 0).
 */
function rowToConfig(row: LlmProviderRow, includeKey = true): LlmProviderConfig {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    base_url: row.base_url,
    api_key: includeKey && row.api_key_encrypted ? decryptApiKey(row.api_key_encrypted) : null,
    model: row.model,
    temperature: row.temperature,
    max_tokens: row.max_tokens,
    top_p: row.top_p,
    top_k: row.top_k,
    thinking_mode: (row.thinking_mode as ThinkingMode | null) ?? 'auto',
    reasoning_effort: row.reasoning_effort ?? null,
    max_tool_rounds: row.max_tool_rounds ?? DEFAULT_MAX_TOOL_ROUNDS,
    extra_config: row.extra_config ? JSON.parse(row.extra_config) : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    is_default: row.is_default ?? false,
    is_enabled: row.is_enabled ?? true,
    sort_order: row.sort_order ?? 0,
    is_pinned: (row.sort_order ?? 0) > 0
  }
}

// --- CRUD ---

/**
 * Get the list view of all providers (read-only scenarios such as the settings tree).
 * Does not decrypt api_key — keys never reach the renderer;
 * paths that need the full config (including the key) should use getProviderById / getEnabledProviders / getDefaultProvider.
 */
async function getAllProviderList(): Promise<LlmProviderConfig[]> {
  return withOrm('getAllProviderList', async (db) => {
    const rows = await db
      .select()
      .from(llm_providers)
      // Pinned (>0) first; unpinned (0) follow in creation order
      .orderBy(desc(llm_providers.sort_order), asc(llm_providers.id))
    logger.info(`Query for all providers returned ${rows.length} rows.`)
    return rows.map((row) => rowToConfig(row, false))
  })
}

/**
 * Get a provider by ID
 */
async function getProviderById(id: number): Promise<LlmProviderConfig | null> {
  return withOrm('getProviderById', async (db) => {
    const rows = await db.select().from(llm_providers).where(eq(llm_providers.id, id)).limit(1)
    if (rows.length === 0) return null
    return rowToConfig(rows[0])
  })
}

/**
 * Get the default provider (enabled)
 */
async function getDefaultProvider(): Promise<LlmProviderConfig | null> {
  return withOrm('getDefaultProvider', async (db) => {
    const rows = await db
      .select()
      .from(llm_providers)
      .where(and(eq(llm_providers.is_default, true), eq(llm_providers.is_enabled, true)))
      .limit(1)
    if (rows.length === 0) {
      // Fallback: take the first enabled one
      const fallback = await db
        .select()
        .from(llm_providers)
        .where(eq(llm_providers.is_enabled, true))
        .orderBy(desc(llm_providers.sort_order), asc(llm_providers.id))
        .limit(1)
      if (fallback.length === 0) return null
      return rowToConfig(fallback[0])
    }
    return rowToConfig(rows[0])
  })
}

/**
 * Get all enabled providers
 */
async function getEnabledProviders(): Promise<LlmProviderConfig[]> {
  return withOrm('getEnabledProviders', async (db) => {
    const rows = await db
      .select()
      .from(llm_providers)
      .where(eq(llm_providers.is_enabled, true))
      .orderBy(desc(llm_providers.sort_order), asc(llm_providers.id))
    return rows.map((row) => rowToConfig(row))
  })
}

/** Normalize the input into columns ready to be written (encrypt api_key, serialize JSON columns; the pinned sort value uses an SQL subquery) */
function toProviderColumns(input: LlmProviderInput): PgInsertValue<typeof llm_providers> {
  return {
    name: input.name,
    provider: input.provider,
    base_url: input.base_url || null,
    api_key_encrypted: input.api_key ? encryptApiKey(input.api_key) : null,
    model: input.model,
    temperature: input.temperature ?? null,
    max_tokens: input.max_tokens || null,
    top_p: input.top_p ?? null,
    top_k: input.top_k ?? null,
    thinking_mode: input.thinking_mode ?? 'auto',
    reasoning_effort: input.reasoning_effort?.trim() || null,
    max_tool_rounds: input.max_tool_rounds ?? DEFAULT_MAX_TOOL_ROUNDS,
    extra_config: input.extra_config ? JSON.stringify(input.extra_config) : null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    is_default: input.is_default ?? false,
    is_enabled: input.is_enabled ?? true,
    // The pinned sort value comes from the database as max+1; callers do not pass a number
    sort_order: input.pinned ? NEXT_PIN_ORDER : 0
  }
}

/**
 * Create a provider
 */
async function createProvider(input: LlmProviderInput): Promise<number> {
  return withOrm('createProvider', async (db) => {
    // If this one is set as default, clear any other default first
    if (input.is_default) {
      await db
        .update(llm_providers)
        .set({ is_default: false })
        .where(eq(llm_providers.is_default, true))
    }

    const rows = await db
      .insert(llm_providers)
      .values(toProviderColumns(input))
      .returning({ id: llm_providers.id })

    const newId = rows[0].id
    logger.info(`Created provider "${input.name}" with ID: ${newId}`)
    return newId
  })
}

/**
 * Create providers in bulk (the model list pulled by "one-click add").
 * Compared with calling createProvider one by one:
 * - all inserts complete in a single transaction (PGlite per-transaction overhead);
 * - invalid inputs and existing (provider, model) combinations are skipped automatically to prevent duplicates;
 * - the caller clears the cache and broadcasts a change only once, avoiding stormy full refreshes of the renderer.
 */
async function createProviders(
  inputs: LlmProviderInput[]
): Promise<{ created: number; skipped: number }> {
  return withOrm('createProviders', async (db) => {
    const list = Array.isArray(inputs) ? inputs : []
    const valid = list.filter(
      (i) =>
        i &&
        typeof i.name === 'string' &&
        i.name.trim() !== '' &&
        typeof i.model === 'string' &&
        i.model.trim() !== '' &&
        typeof i.provider === 'string' &&
        i.provider.trim() !== ''
    )
    const skippedByValidation = list.length - valid.length

    let created = 0
    await db.transaction(async (tx) => {
      // Bulk add does not set a default model; if any input requests one, clear the current default first
      if (valid.some((i) => i.is_default)) {
        await tx
          .update(llm_providers)
          .set({ is_default: false })
          .where(eq(llm_providers.is_default, true))
      }

      for (const input of valid) {
        // Skip (provider, model) combinations that duplicate existing providers
        const dup = await tx
          .select({ id: llm_providers.id })
          .from(llm_providers)
          .where(
            and(eq(llm_providers.provider, input.provider), eq(llm_providers.model, input.model))
          )
          .limit(1)
        if (dup.length > 0) continue

        await tx.insert(llm_providers).values(toProviderColumns(input))
        created++
      }
    })

    const skipped = skippedByValidation + (valid.length - created)
    logger.info(
      `Batch created ${created} provider(s), skipped ${skipped} (${list.length} input(s)).`
    )
    return { created, skipped }
  })
}

/**
 * Update a provider
 */
async function updateProvider(id: number, updates: Partial<LlmProviderInput>): Promise<boolean> {
  return withOrm('updateProvider', async (db) => {
    const patch: PgUpdateSetSource<typeof llm_providers> = {}

    if (updates.name !== undefined) patch.name = updates.name
    if (updates.provider !== undefined) patch.provider = updates.provider
    if (updates.base_url !== undefined) patch.base_url = updates.base_url
    // An empty string is treated as deleting the key
    if (updates.api_key !== undefined) {
      patch.api_key_encrypted = updates.api_key ? encryptApiKey(updates.api_key) : null
    }
    if (updates.model !== undefined) patch.model = updates.model
    if (updates.temperature !== undefined) patch.temperature = updates.temperature
    if (updates.max_tokens !== undefined) patch.max_tokens = updates.max_tokens
    if (updates.top_p !== undefined) patch.top_p = updates.top_p
    if (updates.top_k !== undefined) patch.top_k = updates.top_k
    if (updates.thinking_mode !== undefined) patch.thinking_mode = updates.thinking_mode
    if (updates.reasoning_effort !== undefined) {
      // Empty string/null is treated as "unset": clear the tier and fall back to the model default
      patch.reasoning_effort = updates.reasoning_effort?.trim() || null
    }
    if (updates.max_tool_rounds !== undefined) patch.max_tool_rounds = updates.max_tool_rounds
    if (updates.extra_config !== undefined) {
      patch.extra_config = updates.extra_config ? JSON.stringify(updates.extra_config) : null
    }
    if (updates.metadata !== undefined) {
      // null or an empty object clears the metadata
      patch.metadata =
        updates.metadata && Object.keys(updates.metadata).length > 0
          ? JSON.stringify(updates.metadata)
          : null
    }
    if (updates.is_default !== undefined) {
      if (updates.is_default) {
        await db
          .update(llm_providers)
          .set({ is_default: false })
          .where(eq(llm_providers.is_default, true))
      }
      patch.is_default = updates.is_default
    }
    if (updates.is_enabled !== undefined) patch.is_enabled = updates.is_enabled
    // Pin toggle: on → SQL takes the current max sort value + 1 (place first); off → reset to 0 (back to unpinned)
    if (updates.pinned !== undefined) patch.sort_order = updates.pinned ? NEXT_PIN_ORDER : 0

    if (Object.keys(patch).length === 0) {
      logger.warn('No fields to update for provider:', id)
      return false
    }

    patch.updated_at = sql`now()`
    const updated = await db
      .update(llm_providers)
      .set(patch)
      .where(eq(llm_providers.id, id))
      .returning({ id: llm_providers.id })

    logger.info(`Updated provider ID=${id}, ${updated.length} row(s) affected.`)
    return updated.length > 0
  })
}

/**
 * Delete a provider
 */
async function deleteProvider(id: number): Promise<boolean> {
  return withOrm('deleteProvider', async (db) => {
    const deleted = await db
      .delete(llm_providers)
      .where(eq(llm_providers.id, id))
      .returning({ id: llm_providers.id })
    logger.info(`Deleted provider ID=${id}, ${deleted.length} row(s) affected.`)
    return deleted.length > 0
  })
}

/**
 * Delete providers in bulk (by ID set).
 * Symmetric to bulk create: all deletes complete in a single transaction, and the caller only clears the cache once and broadcasts one change,
 * avoiding repeated full renderer refreshes (and freezes) triggered by calling deleteProvider one by one.
 */
async function deleteProviders(ids: number[]): Promise<number> {
  return withOrm('deleteProviders', async (db) => {
    const unique = [
      ...new Set((Array.isArray(ids) ? ids : []).filter((id) => Number.isInteger(id) && id > 0))
    ]
    if (unique.length === 0) return 0

    await db.transaction(async (tx) => {
      for (const id of unique) {
        await tx.delete(llm_providers).where(eq(llm_providers.id, id))
      }
    })
    logger.info(`Batch deleted ${unique.length} provider(s).`)
    return unique.length
  })
}

/**
 * Set the default provider
 */
async function setDefaultProvider(id: number): Promise<boolean> {
  return withOrm('setDefaultProvider', async (db) => {
    await db
      .update(llm_providers)
      .set({ is_default: false })
      .where(eq(llm_providers.is_default, true))
    const updated = await db
      .update(llm_providers)
      .set({ is_default: true, updated_at: sql`now()` })
      .where(eq(llm_providers.id, id))
      .returning({ id: llm_providers.id })
    logger.info(`Set provider ID=${id} as default, ${updated.length} row(s) affected.`)
    return updated.length > 0
  })
}

export {
  getAllProviderList,
  getProviderById,
  getDefaultProvider,
  getEnabledProviders,
  createProvider,
  createProviders,
  updateProvider,
  deleteProvider,
  deleteProviders,
  setDefaultProvider
}
