import { BrowserWindow, ipcMain } from 'electron'
import logger from 'electron-log'
import { safeSend } from '../safe-send'
import { mainFormat, mainMessages } from '../i18n'
import { getProviderService } from '../provider/service'
import {
  type FetchedModelInfo,
  findModelProfile,
  geminiModelId,
  resolveFetchedModelMetadata
} from '../provider/model-tags'
import {
  clearProviderCache,
  getCachedEnabledProviders,
  setCachedEnabledProviders,
  getCachedDefaultProvider,
  setCachedDefaultProvider
} from '../provider/cache'
import {
  getAllProviderList,
  getProviderById,
  getDefaultProvider,
  getEnabledProviders,
  createProvider,
  createProviders,
  updateProvider,
  deleteProvider,
  deleteProviders,
  setDefaultProvider,
  LlmProviderConfig,
  LlmProviderInput
} from '../database/mapper/provider'

/** Notify all windows that the provider list changed */
function broadcastProvidersChanged(): void {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) safeSend(w.webContents, 'providers-changed')
  })
}

/**
 * Config for renderer display: the decrypted api_key is stripped.
 * The key is only decrypted for use in the main-process runtime (ProviderService / fetch calls)
 * and is never sent to the renderer; when the frontend needs to change the key the user re-enters
 * it in the edit form, and an empty value means keep the existing key.
 */
function stripApiKey(config: LlmProviderConfig | null): LlmProviderConfig | null {
  if (!config) return null
  return { ...config, api_key: null }
}

function stripApiKeys(list: LlmProviderConfig[]): LlmProviderConfig[] {
  return list.map((c) => ({ ...c, api_key: null }))
}

/**
 * Model provider IPC (core's provider-* channels: list / create-update-delete / default / model
 * profiles / fetch models).
 *
 * Ownership change (harness round): the 8 agent channels previously mixed into this file
 * (agent-get-all / agent-get-paginated / agent-get-by-id / agent-create / agent-update /
 * agent-delete / main-agent-get / main-agent-update) moved with the harness plugin into
 * `src/main/ipc/harness/agent.ts` (channel names `harness:agent-*` /
 * `harness:main-agent-*`) — agent configuration lives under the harness workspace table and
 * belongs to the "AI assistant". This file only keeps model providers; the startup provider cache
 * still belongs to core (see src/main/provider/cache.ts).
 */
export function registerProviderIpc(): void {
  ipcMain.handle('provider-get-all', async () => {
    try {
      // List view: the mapper layer already guarantees api_key is not decrypted
      return await getAllProviderList()
    } catch (error) {
      logger.error('Error in provider-get-all:', error)
      throw error
    }
  })

  ipcMain.handle('provider-get-by-id', async (_event, id: number) => {
    try {
      return stripApiKey(await getProviderById(id))
    } catch (error) {
      logger.error('Error in provider-get-by-id:', error)
      throw error
    }
  })

  ipcMain.handle('provider-get-default', async () => {
    try {
      if (getCachedDefaultProvider()) return stripApiKey(getCachedDefaultProvider())
      const provider = await getDefaultProvider()
      setCachedDefaultProvider(provider)
      return stripApiKey(provider)
    } catch (error) {
      logger.error('Error in provider-get-default:', error)
      throw error
    }
  })

  ipcMain.handle('provider-get-enabled', async () => {
    try {
      const cached = getCachedEnabledProviders()
      if (cached) return stripApiKeys(cached)
      const providers = await getEnabledProviders()
      setCachedEnabledProviders(providers)
      return stripApiKeys(providers)
    } catch (error) {
      logger.error('Error in provider-get-enabled:', error)
      throw error
    }
  })

  ipcMain.handle('provider-create', async (_event, input: LlmProviderInput) => {
    try {
      const id = await createProvider(input)
      clearProviderCache()
      getProviderService().clearCache()
      broadcastProvidersChanged()
      return id
    } catch (error) {
      logger.error('Error in provider-create:', error)
      throw error
    }
  })

  /**
   * Batch-create providers (one-click add of multiple fetched models).
   * Single-transaction insert + a single change broadcast, avoiding 29 individual creates that
   * make the renderer re-fetch everything repeatedly and freeze.
   */
  ipcMain.handle('provider-create-batch', async (_event, inputs: LlmProviderInput[]) => {
    try {
      const result = await createProviders(inputs)
      clearProviderCache()
      getProviderService().clearCache()
      broadcastProvidersChanged()
      return result
    } catch (error) {
      logger.error('Error in provider-create-batch:', error)
      throw error
    }
  })

  ipcMain.handle(
    'provider-update',
    async (_event, id: number, updates: Partial<LlmProviderInput>) => {
      try {
        const result = await updateProvider(id, updates)
        clearProviderCache()
        getProviderService().clearCache()
        broadcastProvidersChanged()
        return result
      } catch (error) {
        logger.error('Error in provider-update:', error)
        throw error
      }
    }
  )

  ipcMain.handle('provider-delete', async (_event, id: number) => {
    try {
      const result = await deleteProvider(id)
      clearProviderCache()
      getProviderService().clearCache()
      broadcastProvidersChanged()
      return result
    } catch (error) {
      logger.error('Error in provider-delete:', error)
      throw error
    }
  })

  /**
   * Batch-delete providers (delete after selecting multiple models).
   * Single-transaction delete + a single change broadcast; same idea as provider-create-batch to
   * avoid a refresh storm.
   */
  ipcMain.handle('provider-delete-batch', async (_event, ids: number[]) => {
    try {
      const count = await deleteProviders(ids)
      clearProviderCache()
      getProviderService().clearCache()
      broadcastProvidersChanged()
      return count
    } catch (error) {
      logger.error('Error in provider-delete-batch:', error)
      throw error
    }
  })

  ipcMain.handle('provider-set-default', async (_event, id: number) => {
    try {
      const result = await setDefaultProvider(id)
      clearProviderCache()
      getProviderService().clearCache()
      broadcastProvidersChanged()
      return result
    } catch (error) {
      logger.error('Error in provider-set-default:', error)
      throw error
    }
  })

  // Look up the official models-profile entry by model id when adding a model manually (null when
  // not listed). On a hit the renderer auto-fills the metadata so the user does not have to retype
  // it; a failed lookup returns null silently
  ipcMain.handle('provider-lookup-profile', async (_event, modelId: string) => {
    try {
      if (!modelId || typeof modelId !== 'string') return null
      return findModelProfile(modelId.trim())
    } catch (error) {
      logger.error('Error in provider-lookup-profile:', error)
      return null
    }
  })

  // Fetch the provider's model list (metadata comes from the models-profile.json profiles; no
  // inference from name/API capabilities; models missing from the profiles are filled in with a
  // fallback profile: lowest context window / max output + language model + tool calling)
  ipcMain.handle(
    'provider-fetch-models',
    async (_event, providerType: string, baseUrl?: string, apiKey?: string) => {
      try {
        // Accept only http(s) base URLs (security audit S13): previously any string was
        // concatenated into fetch, so after renderer injection it could be used to probe non-HTTP
        // protocols or malformed addresses, and the error message would leak internal exceptions.
        if (baseUrl) {
          let parsed: URL
          try {
            parsed = new URL(baseUrl)
          } catch {
            throw new Error('baseUrl is not a valid URL')
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('baseUrl must use http or https')
          }
        }
        const models: FetchedModelInfo[] = []

        if (providerType === 'ollama') {
          const url = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '') + '/api/tags'
          logger.info(`[FetchModels] Ollama: ${url}`)
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 15000)
          const res = await fetch(url, { signal: controller.signal })
          clearTimeout(timeout)
          if (!res.ok) {
            throw new Error(
              mainFormat(mainMessages().error.httpFromProvider, {
                provider: 'Ollama',
                status: res.status
              })
            )
          }
          const data = (await res.json()) as { models?: Record<string, unknown>[] }
          for (const m of data.models || []) {
            const id = typeof m.name === 'string' ? m.name : ''
            if (!id) continue
            models.push({ id, metadata: resolveFetchedModelMetadata(id) })
          }
        } else if (providerType === 'google-genai') {
          // Gemini native API: GET /v1beta/models?key=...
          const base = (baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')
          const url = `${base}/v1beta/models` + (apiKey ? `?key=${encodeURIComponent(apiKey)}` : '')
          // Redact (fix: the full URL containing the API key used to be written to the log, leaking the key to disk)
          logger.info(`[FetchModels] Gemini: ${base}/v1beta/models${apiKey ? '?key=***' : ''}`)
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 15000)
          const res = await fetch(url, { signal: controller.signal })
          clearTimeout(timeout)
          if (!res.ok) {
            throw new Error(
              mainFormat(mainMessages().error.httpFromProvider, {
                provider: 'Gemini',
                status: res.status
              })
            )
          }
          const data = (await res.json()) as { models?: Record<string, unknown>[] }
          for (const m of data.models || []) {
            const id = geminiModelId(m)
            if (!id) continue
            models.push({ id, metadata: resolveFetchedModelMetadata(id) })
          }
        } else {
          // OpenAI-compatible protocol: GET /v1/models
          const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
          const url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
          logger.info(`[FetchModels] OpenAI-compatible: ${url}`)
          const headers: Record<string, string> = { 'Content-Type': 'application/json' }
          if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 15000)
          const res = await fetch(url, { headers, signal: controller.signal })
          clearTimeout(timeout)
          if (!res.ok) {
            throw new Error(
              mainFormat(mainMessages().error.httpFromProvider, {
                provider: 'API',
                status: res.status
              })
            )
          }
          const data = (await res.json()) as { data?: Record<string, unknown>[] }
          for (const m of data.data || []) {
            const id = typeof m.id === 'string' ? m.id : ''
            if (!id) continue
            models.push({ id, metadata: resolveFetchedModelMetadata(id) })
          }
        }

        logger.info(`[FetchModels] Got ${models.length} models for ${providerType}`)
        return models
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        logger.error(`[FetchModels] Failed for ${providerType}:`, errMsg)
        throw new Error(mainFormat(mainMessages().error.fetchModelsFailed, { reason: errMsg }))
      }
    }
  )
}
