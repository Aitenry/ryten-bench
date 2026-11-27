import { ipcMain } from 'electron'
import logger from 'electron-log'
import { settingsStore } from '../context'
import { awaitInitialized } from '../database/instance'
import { HarnessSettings, SystemSettings } from '../types/settings'
import { getPublicLockSettings } from '../lock/service'
import { syncTrayState } from '../tray'
import { emitAppEvent } from '../plugins/app-events'
import { APP_EVENT_WORKSPACE_CHANGED, type AppWorkspaceChangedPayload } from '../plugins/app-hooks'
import { configurePluginsRoot } from '../workshop/paths'
import { isSamePath, migrateChangedStoragePaths, storagePathOf } from '../storage'
import { remapWorkspacePathsUnderRoot } from '../storage/workspace-refs'
import { getAllWorkspaces } from '../database/mapper/harness/harness'
import { isUserSelectedRoot, workspacePathKey } from '../workspace/selected-roots'

/** 当前活动工作区（设置已落盘后读取；未配置时为 null/空串） */
function workspaceChangedPayload(): AppWorkspaceChangedPayload {
  const harness = settingsStore.get('harness') as
    { activeWorkspaceId?: number; workspacePath?: string } | undefined
  return {
    workspaceId: harness?.activeWorkspaceId ?? null,
    workspacePath: harness?.workspacePath ?? ''
  }
}

/**
 * 工作区根 / 活动工作区 ID 的信任校验（安全审计 S03）。
 *
 * 渲染层可以调用 `system-settings-update` 改 `harness.workspacePath`，而所有文件类 IPC
 * 都拿这个值当 `assertInsideWorkspace` 的根——一旦被改成 `C:\` 就能读写任意文件。
 * 因此这里把它收敛为：目录必须是「用户经系统对话框亲手选过」或已登记的工作区行；
 * `activeWorkspaceId` 必须对应真实工作区行。清空（切走/删除工作区）始终允许。
 */
async function validateWorkspacePatch(
  next: HarnessSettings,
  previous: HarnessSettings | undefined,
  patch: Partial<HarnessSettings>
): Promise<void> {
  let cachedRows: Promise<Awaited<ReturnType<typeof getAllWorkspaces>>> | null = null
  const rows = (): Promise<Awaited<ReturnType<typeof getAllWorkspaces>>> => {
    cachedRows ??= getAllWorkspaces()
    return cachedRows
  }

  if ('workspacePath' in patch) {
    const nextPath = typeof next.workspacePath === 'string' ? next.workspacePath.trim() : ''
    if (nextPath) {
      let known = isUserSelectedRoot(nextPath)
      if (!known) {
        try {
          known = (await rows()).some(
            (row) => workspacePathKey(row.path) === workspacePathKey(nextPath)
          )
        } catch (err) {
          // 数据库不可用时按拒绝处理（fail closed），避免校验被绕过
          logger.warn('[Settings] Workspace path validation failed (database unavailable):', err)
        }
      }
      if (!known) {
        logger.warn('[Settings] Rejected harness.workspacePath that was not picked by the user')
        next.workspacePath = previous?.workspacePath ?? ''
      }
    }
  }

  if ('activeWorkspaceId' in patch) {
    const nextId = next.activeWorkspaceId
    if (typeof nextId === 'number' && Number.isFinite(nextId)) {
      let exists = false
      try {
        exists = (await rows()).some((row) => row.id === nextId)
      } catch (err) {
        logger.warn('[Settings] activeWorkspaceId validation failed (database unavailable):', err)
      }
      if (!exists) {
        logger.warn('[Settings] Rejected harness.activeWorkspaceId that does not exist')
        next.activeWorkspaceId = previous?.activeWorkspaceId
      }
    }
  }
}

/** 系统设置 IPC（锁屏走专用通道，见 ipc/lock.ts：摘要不能经通用设置通道下发/改写） */
export function registerSettingsIpc(): void {
  ipcMain.handle('system-settings-get-all', async () => {
    try {
      await awaitInitialized()
      const all = settingsStore.store
      // 不暴露 provider-keystore 内部数据给前端；
      // 锁屏只给「开关 + 自动锁屏时长」——解锁码摘要留在主进程（见 ipc/lock.ts）
      return {
        ip: all.ip,
        lock: getPublicLockSettings(),
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

      // 锁屏**不走通用设置通道**：走这里等于允许渲染层随意改 `lock.code`（原实现就是如此，
      // 改密码时连原密码都不必知道）。开关/自动锁屏/改码各有专用通道（见 ipc/lock.ts）。
      if ('lock' in nextUpdates) {
        logger.warn('[Settings] Rejected lock settings through generic update channel')
        delete nextUpdates.lock
      }

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
        await validateWorkspacePatch(nextHarness, previousHarness, nextUpdates.harness)
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
