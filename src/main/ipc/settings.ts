import { ipcMain } from 'electron'
import logger from 'electron-log'
import { settingsStore } from '../context'
import { awaitInitialized } from '../database/instance'
import { SystemSettings } from '../types/settings'
import { syncTrayState } from '../tray'
import { emitAppEvent } from '../plugins/app-events'
import { APP_EVENT_WORKSPACE_CHANGED, type AppWorkspaceChangedPayload } from '../plugins/app-hooks'

/** 当前活动工作区（设置已落盘后读取；未配置时为 null/空串） */
function workspaceChangedPayload(): AppWorkspaceChangedPayload {
  const harness = settingsStore.get('harness') as
    { activeWorkspaceId?: number; workspacePath?: string } | undefined
  return {
    workspaceId: harness?.activeWorkspaceId ?? null,
    workspacePath: harness?.workspacePath ?? ''
  }
}

/** 系统设置 + 锁屏 IPC */
export function registerSettingsIpc(): void {
  ipcMain.handle('lock-screen-code', async () => {
    try {
      await awaitInitialized()
      // 返回完整 lock 对象 { code, view }（修复：此前 `as string` 类型谎言,
      // 运行时返回对象而类型声明与 preload d.ts 互相矛盾）
      return settingsStore.get('lock')
    } catch (error) {
      console.error('Error in lock-screen-code:', error)
      throw error
    }
  })

  ipcMain.handle('lock-screen-view', async (_event, open: boolean) => {
    try {
      const lock = settingsStore.get('lock') as { code: string; view: boolean } | undefined
      if (lock) {
        lock.view = open
        settingsStore.set('lock', lock)
      }
    } catch (error) {
      console.error('Error in lock-screen-view:', error)
      throw error
    }
  })

  ipcMain.handle('system-settings-get-all', async () => {
    try {
      await awaitInitialized()
      const all = settingsStore.store
      // 不暴露 provider-keystore 内部数据给前端
      return {
        ip: all.ip,
        lock: all.lock,
        graph: all.graph,
        harness: all.harness,
        defaultModelId: all.defaultModelId,
        defaultEmbeddingModelId: all.defaultEmbeddingModelId,
        musicDirectory: all.musicDirectory,
        theme: all.theme,
        language: all.language,
        tray: all.tray,
        weatherRefreshInterval: all.weatherRefreshInterval,
        weatherLastFetched: all.weatherLastFetched,
        weatherData: all.weatherData
      } as SystemSettings
    } catch (error) {
      logger.error('Error in system-settings-get-all:', error)
      throw error
    }
  })

  ipcMain.handle('system-settings-update', async (_event, updates: Partial<SystemSettings>) => {
    try {
      // 键白名单（修复：此前任意顶层键/类型直接落盘——拼错键被永久持久化，
      // 或把 lock/harness/graph 整键写成非对象,下游读取无兜底）
      const ALLOWED_KEYS: Array<keyof SystemSettings> = [
        'ip',
        'lock',
        'graph',
        'harness',
        'defaultModelId',
        'defaultEmbeddingModelId',
        'musicDirectory',
        'theme',
        'language',
        'tray',
        'weatherRefreshInterval',
        'weatherLastFetched',
        'weatherData'
      ]
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) continue
        if (!ALLOWED_KEYS.includes(key as keyof SystemSettings)) {
          logger.warn(`[Settings] 拒绝未知设置键: ${key}`)
          continue
        }
        // 对于对象类型的设置（如 harness），与现有值合并而非替换
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const existing = settingsStore.get(key as keyof SystemSettings) as
            Record<string, unknown> | undefined
          settingsStore.set(key as keyof SystemSettings, { ...(existing ?? {}), ...value } as never)
        } else {
          settingsStore.set(key as keyof SystemSettings, value)
        }
      }
      // 托盘设置变化时即时同步（关闭行为 / 菜单勾选态）；语言变化时同步托盘提示文案
      if ('tray' in updates || 'language' in updates) {
        syncTrayState()
      }
      // 工作区切换（新建 / 选择 / 重建）后通知订阅方（事件总线）：工作区文件监听的
      // 换根动作属于 AI 助手（`src/main/system/harness.ts`），core 只负责在设置落盘后发事件；
      // 第三方插件也可以订阅同一个事件（见 src/main/plugins/app-hooks.ts）
      if ('harness' in updates) {
        emitAppEvent(APP_EVENT_WORKSPACE_CHANGED, workspaceChangedPayload())
      }
      logger.info('System settings updated:', Object.keys(updates).join(', '))
      return true
    } catch (error) {
      logger.error('Error in system-settings-update:', error)
      throw error
    }
  })
}
