import { boolean, integer, pgTable, text, timestamp, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * 联网搜索的全局配置（**单行表**，id 恒为 1）。
 *
 * - `default_provider`：全局默认搜索服务（builtin / deepseek / tavily），未配置时用内置搜索；
 * - `auto_fallback`：所选服务失败/超时时是否回退到内置搜索；
 * - `include_content`：是否请求正文摘要（DeepSeek need_content / Tavily raw content）。
 *
 * 密钥单独放在 `search_providers`（加密），本表不存任何敏感信息。
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
 * 各搜索服务的密钥（**加密存储**，一台机器一份）。
 *
 * `api_key_encrypted` 用与模型供应商相同的机器派生密钥（AES-256-GCM）加密；
 * `key_mask` 只是展示用的掩码（前 6 + 后 6），读取接口不会返回明文/密文。
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
