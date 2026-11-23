import { ipcMain } from 'electron'
import logger from 'electron-log'
import { settingsStore } from '../context'
import { awaitInitialized } from '../database/instance'
import { HarnessSettings, SystemSettings } from '../types/settings'
import { syncTrayState } from '../tray'
import { emitAppEvent } from '../plugins/app-events'
import { APP_EVENT_WORKSPACE_CHANGED, type AppWorkspaceChangedPayload } from '../plugins/app-hooks'
import { configurePluginsRoot } from '../workshop/paths'
import { isSamePath, migrateChangedStoragePaths, storagePathOf } from '../storage'
import { remapWorkspacePathsUnderRoot } from '../storage/workspace-refs'

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
      const nextUpdates: Partial<SystemSettings> = { ...updates }

      // 存储路径（记忆 / 插件 / 技能）变更：先把旧目录的数据迁到新目录，成功了才落设置。
      // 失败时抛错、设置保持原值——绝不出现「设置指向新目录，数据还在旧目录」。
      let previousHarness: HarnessSettings | undefined
      let nextHarness: HarnessSettings | undefined
      if (
        nextUpdates.harness &&
        typeof nextUpdates.harness === 'object' &&
        !Array.isArray(nextUpdates.harness)
      ) {
        const rawPreviousHarness = settingsStore.get('harness')
        previousHarness =
          rawPreviousHarness &&
          typeof rawPreviousHarness === 'object' &&
          !Array.isArray(rawPreviousHarness)
            ? (rawPreviousHarness as HarnessSettings)
            : {}
        nextHarness = { ...previousHarness, ...nextUpdates.harness }
        await migrateChangedStoragePaths(previousHarness, nextHarness)
        nextUpdates.harness = nextHarness
      }

      for (const [key, value] of Object.entries(nextUpdates)) {
        if (value === undefined) continue
        if (!ALLOWED_KEYS.includes(key as keyof SystemSettings)) {
          logger.warn(`[Settings] Rejected unknown setting key: ${key}`)
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

      // 插件存放路径变了：运行时注入的根目录要立即跟着换（不重启）。
      // 设置页本身不走这条通道（用 workshop-set-root），但探针/外部调用可能直接写设置。
      if (previousHarness && nextHarness) {
        const beforePlugins = storagePathOf(previousHarness, 'plugins')
        const afterPlugins = storagePathOf(nextHarness, 'plugins')
        if (!isSamePath(beforePlugins, afterPlugins)) {
          // 插件源码目录整体换了：旧插件工作区行 / 活动工作区也跟着换到新根下，
          // 否则旧会话会一直指着已经不存在的目录。
          await remapWorkspacePathsUnderRoot(beforePlugins, afterPlugins)
          configurePluginsRoot(afterPlugins)
          logger.info(
            `[Settings] Plugins storage root applied at runtime: ${afterPlugins || '(cleared)'}`
          )
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
