import { boolean, integer, pgTable, text, timestamp, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * Global web search configuration (**single-row table**, id is always 1).
 *
 * - `default_provider`: global default search service (builtin / deepseek / tavily); builtin search is used when unset;
 * - `auto_fallback`: whether to fall back to builtin search when the selected service fails/times out;
 * - `include_content`: whether to request content summaries (DeepSeek need_content / Tavily raw content).
 *
 * Keys are stored separately in `search_providers` (encrypted); this table holds no sensitive information.
 */
export const search_settings = pgTable(
  'search_settings',
  {
    id: integer().primaryKey().notNull(),
    default_provider: text().notNull().default('builtin'),
    auto_fallback: boolean().notNull().default(true),
    include_content: boolean().notNull().default(false),
    updated_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    check('search_settings_singleton_check', sql`${table.id} = 1`),
    check(
      'search_settings_default_provider_check',
      sql`${table.default_provider} in ('builtin', 'deepseek', 'tavily')`
    )
  ]
)

/**
 * Keys for each search service (**encrypted storage**, one per machine).
 *
 * `api_key_encrypted` is encrypted with the same machine-derived key as model providers (AES-256-GCM);
 * `key_mask` is only a display mask (first 6 + last 6); read APIs never return plaintext or ciphertext.
 */
export const search_providers = pgTable(
  'search_providers',
  {
    provider: text().primaryKey().notNull(),
    api_key_encrypted: text(),
    key_mask: text(),
    updated_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    check(
      'search_providers_provider_check',
      sql`${table.provider} in ('builtin', 'deepseek', 'tavily')`
    )
  ]
)
