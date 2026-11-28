import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  real,
  boolean,
  index,
  uniqueIndex
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { DEFAULT_MAX_TOOL_ROUNDS } from '../../../shared/model-params'

/**
 * LLM provider table (global data).
 * `provider` is the protocol identifier (openai / anthropic / zhipu…); free-form input, not
 * constrained by a whitelist; `api_key_encrypted` stores ciphertext, and plaintext is decrypted
 * only at runtime in the main process.
 *
 * Model-level request parameters (sampling / thinking / tool rounds) are stored per column and
 * consumed directly by ProviderService; the context window and max output belong to the "model
 * profile" dimension and live in metadata (JSON) (context_window / max_output_tokens), so no
 * duplicate columns are created.
 */
export const llm_providers = pgTable(
  'llm_providers',
  {
    id: serial().primaryKey().notNull(),
    name: text().notNull(),
    provider: text().notNull(),
    base_url: text(),
    api_key_encrypted: text(),
    model: text().notNull(),
    temperature: real(),
    max_tokens: integer(),
    /** Top P sampling: empty (null) = use the provider's best default */
    top_p: real(),
    /** Top K sampling: empty (null) = use the provider's best default */
    top_k: integer(),
    /** Thinking mode: auto follows the model default config / on forces enabled / off forces disabled */
    thinking_mode: text().default('auto'),
    /**
     * Reasoning effort: none/minimal/low/medium/high/xhigh/max (protocol values in lowercase).
     * Empty (null) = not set, so no effort parameter is sent; the available levels come from the
     * model profile's capabilities.reasoning_effort_levels, and ProviderService translates them
     * into each vendor's fields by protocol family.
     */
    reasoning_effort: text(),
    /** Upper bound on total tool calls per conversation (tool-call rounds) */
    max_tool_rounds: integer().default(DEFAULT_MAX_TOOL_ROUNDS),
    extra_config: text(),
    metadata: text(),
    is_default: boolean().default(false),
    is_enabled: boolean().default(true),
    sort_order: integer().default(0),
    created_at: timestamp({ mode: 'string' }).defaultNow(),
    updated_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    // Only one default provider globally (PostgreSQL partial unique index)
    uniqueIndex('idx_llm_providers_default')
      .using('btree', table.is_default.asc().nullsLast().op('bool_ops'))
      .where(sql`(is_default = true)`),
    index('idx_llm_providers_enabled').using(
      'btree',
      table.is_enabled.asc().nullsLast().op('bool_ops')
    ),
    index('idx_llm_providers_sort').using(
      'btree',
      table.sort_order.asc().nullsLast().op('int4_ops')
    )
  ]
)
