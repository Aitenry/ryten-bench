/**
 * 联网搜索设置服务（主进程）：读取视图、保存/清除密钥、切换默认服务与行为。
 *
 * 安全约定：
 * - 密钥用与模型供应商相同的**机器派生密钥 + AES-256-GCM** 加密后存数据库；
 * - 对渲染层只暴露「是否已配置 + 掩码（前 6 + 后 6 / 短 Key 只露末 4）」；
 * - 解密只发生在真正发起搜索前（`getProviderApiKey`）。
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

/** 全部可选服务（顺序即 UI 顺序；重新导出给调用方使用） */
export { SEARCH_PROVIDER_IDS, asSearchProviderId, maskApiKey }
/** 单条服务的对外状态 */
export interface SearchProviderState {
  provider: SearchProviderId
  /** 是否需要密钥（内置搜索为 false） */
  requiresKey: boolean
  /** 是否已配置可用（内置搜索恒为 true） */
  configured: boolean
  /** 掩码 Key（前 6 + 后 6）；未配置时为空 */
  maskedKey?: string
  /** 「设置 → 模型」里已有同厂商 Key，可提示复用 */
  canReuseModelKey?: boolean
}

/** 设置页读取的完整视图 */
export interface SearchSettingsView {
  defaultProvider: SearchProviderId
  autoFallback: boolean
  includeContent: boolean
  providers: SearchProviderState[]
}

/** 稳定错误码（页面负责翻译） */
export type SearchSettingsError =
  | 'invalid-provider'
  | 'invalid-key'
  | 'not-configured'
  | 'save-failed'

/** 读取设置视图（含各服务掩码与复用提示） */
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
      // 仅供提示：模型供应商里已有同厂商 Key（不解密、不返回 Key）
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

/** 设置默认搜索服务（必须已配置；内置搜索恒可用） */
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

/** 更新行为开关 */
export async function setSearchBehaviors(
  patch: { autoFallback?: boolean; includeContent?: boolean }
): Promise<void> {
  await updateSearchSettingsRow({
    ...(typeof patch.autoFallback === 'boolean' ? { autoFallback: patch.autoFallback } : {}),
    ...(typeof patch.includeContent === 'boolean' ? { includeContent: patch.includeContent } : {})
  })
}

/** 保存某服务的密钥（加密后落库；返回掩码） */
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

/** 清除某服务的密钥；若它正是默认服务则退回内置搜索 */
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

/** 取某服务的明文 Key（仅主进程内部发起搜索时使用）；未配置/解密失败返回 undefined */
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
