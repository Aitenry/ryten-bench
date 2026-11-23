import logger from 'electron-log'
import { activeHarnessStreams } from '../context'
import type { HarnessSettings } from '../types/settings'
import { isSamePath, migrateStorageDirectory, type StorageMigrationResult } from './migration'
import { storagePathOf, STORAGE_KINDS, STORAGE_LABELS } from './types'

export {
  bootstrapStorageLayout,
  discoverStorageLayoutOptions,
  migrateLegacyHarnessSettingsKey,
  resolveInstallDirectory,
  resolveStorageLayout,
  DATA_DIR_NAME,
  type InstallDirOptions,
  type SettingsStoreLike,
  type StorageLayout,
  type StorageLayoutOptions,
  type StorageLayoutSource
} from './layout'

export {
  isPathInside,
  isSamePath,
  migrateStorageDirectory,
  type StorageMigrationResult,
  type StorageMigrationSkip
} from './migration'

export {
  STORAGE_DIR_NAMES,
  STORAGE_KINDS,
  STORAGE_LABELS,
  STORAGE_SETTING_KEYS,
  storagePathOf,
  type StorageKind,
  type StorageSettingKey
} from './types'

/**
 * 设置里三个存储路径发生变化时，把旧目录的数据迁到新目录。
 *
 * 触发点只有一个口径：`system-settings-update`（内存/技能由设置页直接写；
 * 插件存放路径另有 `workshop-set-root` 通道，那边走同一个搬迁内核）。
 *
 * 顺序有意义：**先搬文件，成功后才允许调用方落设置**。搬失败就抛错、设置保持原值，
 * 用户不会遇到「设置已经指向新目录、数据还在旧目录」的半成品状态。
 */
export async function migrateChangedStoragePaths(
  previous: HarnessSettings,
  next: HarnessSettings
): Promise<StorageMigrationResult[]> {
  const results: StorageMigrationResult[] = []
  for (const kind of STORAGE_KINDS) {
    const from = storagePathOf(previous, kind)
    const to = storagePathOf(next, kind)
    if (!from || !to || isSamePath(from, to)) continue

    if (kind === 'memory') {
      if (activeHarnessStreams.size > 0) {
        throw new Error('有正在进行的对话，暂时不能迁移记忆存储目录：请等本轮结束再试')
      }
      // 记忆目录里有 Mnemon 的 PGlite（进程内持有文件句柄）：先关掉，
      // 否则 Windows 上目录搬不动（EBUSY/EPERM）；下一次访问会按新路径重新打开。
      // 惰性 import：PGlite / LangChain 记忆栈只在真的要迁移记忆目录时才加载，
      // 不让「改个设置」把整套记忆运行时拖进 core 的启动路径。
      const { closeAllMnemon } = await import('../services/harness/mnemon-singleton')
      await closeAllMnemon()
    }

    const result = migrateStorageDirectory(kind, from, to)
    if (result.skipped) {
      logger.info(
        `[Storage] ${STORAGE_LABELS[kind]} path set to ${to} (nothing to migrate: ${result.skipped})`
      )
    } else {
      logger.info(
        `[Storage] Migrated ${STORAGE_LABELS[kind]} storage: ${from} -> ${to} ` +
          `(${result.moved.length} top-level item(s), ${result.conflicts.length} conflict(s))`
      )
    }
    for (const warning of result.warnings) {
      logger.warn(`[Storage] ${warning}`)
    }
    for (const conflict of result.conflicts) {
      logger.warn(
        `[Storage] ${STORAGE_LABELS[kind]} target already had "${conflict}"; ` +
          `kept the target copy and preserved the old one as *.migrated-*`
      )
    }
    results.push(result)
  }
  return results
}
