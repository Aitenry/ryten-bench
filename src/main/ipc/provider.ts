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

/** 通知所有窗口供应商列表已变更 */
function broadcastProvidersChanged(): void {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) safeSend(w.webContents, 'providers-changed')
  })
}

/**
 * 渲染进程展示用配置：剥离解密后的 api_key。
 * 密钥只在主进程运行时（ProviderService / 拉取调用）解密使用，绝不发送到渲染进程；
 * 前端需要修改密钥时由用户在编辑表单重新输入，空值表示保持原密钥。
 */
function stripApiKey(config: LlmProviderConfig | null): LlmProviderConfig | null {
  if (!config) return null
  return { ...config, api_key: null }
}

function stripApiKeys(list: LlmProviderConfig[]): LlmProviderConfig[] {
  return list.map((c) => ({ ...c, api_key: null }))
}

/**
 * 模型 Provider IPC（core 的 provider-* 通道：列表/增删改/默认/模型档案/拉取模型）。
 *
 * 归属变更（harness 轮）：原先混在本文件里的 8 个智能体通道
 * （agent-get-all / agent-get-paginated / agent-get-by-id / agent-create / agent-update /
 * agent-delete / main-agent-get / main-agent-update）已随 harness 插件搬进
 * `src/main/ipc/harness/agent.ts`（通道名 `harness:agent-*` /
 * `harness:main-agent-*`）——智能体配置挂在 harness 的 workspace 表下，属「AI 助手」。
 * 本文件只留模型 Provider；启动期供应商缓存仍归 core（见 src/main/provider/cache.ts）。
 */
export function registerProviderIpc(): void {
  ipcMain.handle('provider-get-all', async () => {
    try {
      // 列表视图：mapper 层已保证不解密 api_key
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
   * 批量创建供应商（一键添加拉取到的多个模型）。
   * 单事务插入 + 只广播一次变更，避免 29 次逐个创建导致渲染进程反复全量刷新而卡死。
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
   * 批量删除供应商（勾选多个模型后删除）。
   * 单事务删除 + 只广播一次变更，与 provider-create-batch 同理避免刷新风暴。
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

  // 手动添加模型时按模型 ID 查询 models-profile 官方档案（未收录返回 null），
  // 命中后由渲染端自动填充元数据，避免用户重复手填；查询失败返回 null 保持静默
  ipcMain.handle('provider-lookup-profile', async (_event, modelId: string) => {
    try {
      if (!modelId || typeof modelId !== 'string') return null
      return findModelProfile(modelId.trim())
    } catch (error) {
      logger.error('Error in provider-lookup-profile:', error)
      return null
    }
  })

  // 拉取供应商的模型列表（元数据来自 models-profile.json 档案，不做名称/接口能力推导；
  // 档案未收录的模型用兜底档案补齐：最低档上下文窗口/最大输出 + 语言模型 + 可调用工具）
  ipcMain.handle(
    'provider-fetch-models',
    async (_event, providerType: string, baseUrl?: string, apiKey?: string) => {
      try {
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
          // Gemini 原生接口: GET /v1beta/models?key=...
          const base = (baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')
          const url = `${base}/v1beta/models` + (apiKey ? `?key=${encodeURIComponent(apiKey)}` : '')
          // 脱敏（修复：此前把含 API key 的完整 URL 写进日志,密钥落盘）
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
          // OpenAI 兼容协议: GET /v1/models
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
