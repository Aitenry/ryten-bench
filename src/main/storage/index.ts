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
 * When one of the three storage paths in settings changes, migrate the data from the old directory
 * to the new one.
 *
 * There is a single trigger point: `system-settings-update` (memory and skills are written directly
 * from the settings page; the plugin storage path has its own `workshop-set-root` channel, which uses
 * the same migration core).
 *
 * Order matters: **move the files first, and only let the caller persist the settings after success**.
 * A failed move throws and leaves the settings unchanged, so users never end up with settings pointing
 * at the new directory while the data is still in the old one.
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
      // The memory directory contains the memory runtime's PGlite database (file handles held by the
      // process): close it first, otherwise the directory cannot be moved on Windows (EBUSY/EPERM);
      // the next access reopens it at the new path.
      // Lazy import: PGlite / the memory stack is loaded only when the memory directory actually has to
      // be migrated, so a mere settings change does not drag the whole memory runtime into core startup.
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
