import type { HarnessSettings } from '../types/settings'

/**
 * 应用自带的三种「用户数据存储」：记忆 / 插件 / 技能。
 *
 * 它们都是 `HarnessSettings` 里的一个绝对路径；空 = 该能力不启用。
 * 首次启动时按**软件安装目录**预置（`<安装目录>/data/<kind>`），
 * 用户改地址时把旧目录里的数据迁到新目录（见 `./migration.ts`）。
 */
export const STORAGE_KINDS = ['memory', 'plugins', 'skills'] as const

export type StorageKind = (typeof STORAGE_KINDS)[number]

/** 默认数据根下每个 kind 的目录名（与用户口径一致：data/memory、data/plugins、data/skills） */
export const STORAGE_DIR_NAMES: Record<StorageKind, string> = {
  memory: 'memory',
  plugins: 'plugins',
  skills: 'skills'
}

/** 每个 kind 对应的 `HarnessSettings` 字段（唯一真源，别再手写字符串） */
export const STORAGE_SETTING_KEYS = {
  memory: 'memoryPath',
  plugins: 'pluginsPath',
  skills: 'skillsPath'
} as const

/** 只可能是这三个键之一（用于 `harness[key]` 的窄类型索引） */
export type StorageSettingKey = (typeof STORAGE_SETTING_KEYS)[StorageKind]

/** 错误/日志里给人看的名字 */
export const STORAGE_LABELS: Record<StorageKind, string> = {
  memory: '记忆',
  plugins: '插件',
  skills: '技能'
}

/** 读某个 kind 当前配置的路径（空字符串 = 未配置；去掉首尾空格，避免把空白当路径） */
export function storagePathOf(
  harness: HarnessSettings | null | undefined,
  kind: StorageKind
): string {
  const value = harness?.[STORAGE_SETTING_KEYS[kind]]
  return typeof value === 'string' ? value.trim() : ''
}
