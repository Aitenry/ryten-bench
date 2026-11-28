/**
 * Web search settings service (main process): read view, save/clear keys, switch default service and
 * behavior.
 *
 * Security conventions:
 * - Keys are encrypted with the same **machine-derived key + AES-256-GCM** as model providers before
 *   being stored in the database;
 * - The renderer only sees "configured or not + mask (first 6 + last 6 / short keys expose only the last 4)";
 * - Decryption happens only right before an actual search (`getProviderApiKey`).
 */
import { decryptApiKey, encryptApiKey } from '../crypto/provider-key'
import {
  clearSearchProviderRow,
  getSearchProviderRow,
  getSearchSettingsRow,
  hasModelProviderWithKey,
  listSearchProviderRows,
  updateSearchSettingsRow,
  upsertSearchProviderRow
} from '../database/mapper/search'
import type { SearchProviderId } from './types'

import { SEARCH_PROVIDER_IDS, asSearchProviderId, maskApiKey } from './mask'

/** All available services (order matches UI order; re-exported for callers) */
export { SEARCH_PROVIDER_IDS, asSearchProviderId, maskApiKey }
/** External state of one service */
export interface SearchProviderState {
  provider: SearchProviderId
  /** Whether a key is required (false for builtin search) */
  requiresKey: boolean
  /** Whether it is configured and usable (always true for builtin search) */
  configured: boolean
  /** Masked key (first 6 + last 6); empty when not configured */
  maskedKey?: string
  /** A key for the same vendor already exists under "Settings -> Models" and can be reused */
  canReuseModelKey?: boolean
}

/** Full view read by the settings page */
export interface SearchSettingsView {
  defaultProvider: SearchProviderId
  autoFallback: boolean
  includeContent: boolean
  providers: SearchProviderState[]
}

/** Stable error codes (the page is responsible for translation) */
export type SearchSettingsError =
  | 'invalid-provider'
  | 'invalid-key'
  | 'not-configured'
  | 'save-failed'

/** Read the settings view (including masks and reuse hints for each service) */
export async function getSearchSettingsView(): Promise<SearchSettingsView> {
  const settings = await getSearchSettingsRow()
  const rows = await listSearchProviderRows()
  const rowMap = new Map(rows.map((row) => [row.provider, row]))
  const providers: SearchProviderState[] = []
  for (const provider of SEARCH_PROVIDER_IDS) {
    const requiresKey = provider !== 'builtin'
    const row = rowMap.get(provider)
    const configured = requiresKey ? Boolean(row?.apiKeyEncrypted) : true
    const state: SearchProviderState = { provider, requiresKey, configured }
    if (row?.keyMask) state.maskedKey = row.keyMask
    if (requiresKey && !configured) {
      // Hint only: a key for the same vendor already exists among model providers (not decrypted, not returned)
      state.canReuseModelKey = await hasModelProviderWithKey(provider)
    }
    providers.push(state)
  }
  const defaultProvider = asSearchProviderId(settings.defaultProvider) ?? 'builtin'
  return {
    defaultProvider,
    autoFallback: settings.autoFallback,
    includeContent: settings.includeContent,
    providers
  }
}

/** Set the default search service (must already be configured; builtin search is always available) */
export async function setSearchDefaultProvider(
  provider: unknown
): Promise<{ ok: true; provider: SearchProviderId } | { ok: false; error: SearchSettingsError }> {
  const id = asSearchProviderId(provider)
  if (!id) return { ok: false, error: 'invalid-provider' }
  if (id !== 'builtin') {
    const row = await getSearchProviderRow(id)
    if (!row?.apiKeyEncrypted) return { ok: false, error: 'not-configured' }
  }
  await updateSearchSettingsRow({ defaultProvider: id })
  return { ok: true, provider: id }
}

/** Update behavior toggles */
export async function setSearchBehaviors(
  patch: { autoFallback?: boolean; includeContent?: boolean }
): Promise<void> {
  await updateSearchSettingsRow({
    ...(typeof patch.autoFallback === 'boolean' ? { autoFallback: patch.autoFallback } : {}),
    ...(typeof patch.includeContent === 'boolean' ? { includeContent: patch.includeContent } : {})
  })
}

/** Save a service key (encrypted before storing; returns the mask) */
export async function saveSearchProviderKey(
  provider: unknown,
  apiKey: unknown
): Promise<
  { ok: true; maskedKey: string } | { ok: false; error: SearchSettingsError }
> {
  const id = asSearchProviderId(provider)
  if (!id || id === 'builtin') return { ok: false, error: 'invalid-provider' }
  const plaintext = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!plaintext || plaintext.length > 512 || /\s/.test(plaintext)) {
    return { ok: false, error: 'invalid-key' }
  }
  try {
    const encrypted = encryptApiKey(plaintext)
    const maskedKey = maskApiKey(plaintext)
    await upsertSearchProviderRow(id, encrypted, maskedKey)
    return { ok: true, maskedKey }
  } catch {
    return { ok: false, error: 'save-failed' }
  }
}

/** Clear a service key; fall back to builtin search if it was the default service */
export async function clearSearchProviderKey(
  provider: unknown
): Promise<{ ok: boolean; error?: SearchSettingsError }> {
  const id = asSearchProviderId(provider)
  if (!id || id === 'builtin') return { ok: false, error: 'invalid-provider' }
  await clearSearchProviderRow(id)
  const settings = await getSearchSettingsRow()
  if (settings.defaultProvider === id) {
    await updateSearchSettingsRow({ defaultProvider: 'builtin' })
  }
  return { ok: true }
}

/** Get the plaintext key of a service (only used inside the main process when starting a search); returns undefined when not configured or decryption fails */
export async function getProviderApiKey(
  provider: SearchProviderId
): Promise<string | undefined> {
  if (provider === 'builtin') return undefined
  const row = await getSearchProviderRow(provider)
  if (!row?.apiKeyEncrypted) return undefined
  try {
    const key = decryptApiKey(row.apiKeyEncrypted).trim()
    return key || undefined
  } catch {
    return undefined
  }
}
