import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * `settings.json` 的启动自检与备份（纯文件操作，不 import electron —— 单测可直接跑）。
 *
 * 背景（2026-11-24）：有人把 `%APPDATA%/ryten-bench/settings.json` 删了，应用下次启动
 * 会按默认值重建：锁屏被关掉、默认密码回到 123456、主题 / 工作区路径 / 托盘设置全部丢失。
 * 数据库（RytenBenchDB）、记忆、技能、插件都还在，丢的只是这份「应用设置」。
 *
 * 这里做两件事：
 * - 每次设置变更后把**当前有效内容**原子地写一份 `settings.backup.json`；
 * - 启动时如果 settings.json 缺失或不是合法 JSON，就尝试用备份恢复；坏文件改名留档，
 *   绝不直接删除（方便事后排查）。
 *
 * 注意：备份与主文件在同一个目录、同一套 Windows 权限下，能挡住误删 / 随手删除，
 * 挡不住「有本机文件权限的人把两份都删掉再直接读数据库」。真正的数据保密要靠
 * 操作系统账户 / BitLocker / 应用层数据库加密，这层只是让锁屏配置不会因为单文件消失
 * 而静默失效（恢复后见 startup 的强制锁屏）。
 */

export interface SettingsFilePaths {
  /** 当前设置文件 */
  settings: string
  /** 最近一份有效设置 */
  backup: string
}

export interface SettingsRecovery {
  /** 启动时 settings.json 存在且是合法 JSON 对象 */
  settingsExisted: boolean
  /** 坏文件被改名后的路径（没有坏文件则为 null） */
  quarantined: string | null
  /** 是否从 settings.backup.json 恢复了设置 */
  restoredFromBackup: boolean
  /** 备份文件存在但自身不是合法 JSON（恢复失败） */
  backupInvalid: boolean
}

/** 两个文件的路径（测试可传任意目录，不依赖 Electron） */
export function settingsFilePaths(userDataDir: string): SettingsFilePaths {
  return {
    settings: path.join(userDataDir, 'settings.json'),
    backup: path.join(userDataDir, 'settings.backup.json')
  }
}

/** 读文件并解析成对象；不存在 / 读失败 / 不是 JSON 对象都返回 null */
export function readSettingsObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function quarantinePath(settings: string, now: number): string {
  const dir = path.dirname(settings)
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  return path.join(dir, `settings.invalid-${stamp}.json`)
}

/**
 * 启动 store 之前调用：确保 settings.json 可用。
 *
 * - 存在且合法：原样使用；
 * - 缺失 / 非法：有合法备份就恢复；非法文件先改名留档（不删）；
 * - 恢复失败：保持缺失，让应用以默认值启动（调用方据此决定是否强制锁屏）。
 */
export function restoreSettingsFile(userDataDir: string, now = Date.now()): SettingsRecovery {
  const { settings, backup } = settingsFilePaths(userDataDir)
  const result: SettingsRecovery = {
    settingsExisted: false,
    quarantined: null,
    restoredFromBackup: false,
    backupInvalid: false
  }

  try {
    fs.mkdirSync(userDataDir, { recursive: true })
  } catch {
    return result
  }

  if (readSettingsObject(settings)) {
    result.settingsExisted = true
    return result
  }

  if (fs.existsSync(settings)) {
    // 坏 JSON：改名留档，避免应用启动时 electron-store 直接抛错，也避免直接删掉证据
    const target = quarantinePath(settings, now)
    try {
      fs.renameSync(settings, target)
      result.quarantined = target
    } catch {
      // 改名失败（被占用等）：下一步的恢复会覆盖它；仍保留原文件，不额外破坏
    }
  }

  if (!fs.existsSync(backup)) return result

  if (!readSettingsObject(backup)) {
    result.backupInvalid = true
    return result
  }

  try {
    // 备份是完整 JSON，直接覆盖（坏文件已改名时这里是新建）
    fs.copyFileSync(backup, settings)
    result.restoredFromBackup = true
  } catch {
    // 磁盘只读 / 被占用：保持缺失，应用用默认值启动
  }
  return result
}

/** 把当前有效的 settings.json 复制成备份；返回是否成功（调用方可决定日志级别） */
export function writeSettingsBackup(userDataDir: string): boolean {
  const { settings, backup } = settingsFilePaths(userDataDir)
  const raw = (() => {
    try {
      return fs.readFileSync(settings, 'utf8')
    } catch {
      return null
    }
  })()
  if (raw === null) return false
  // 先校验再落备份：绝不把半截 JSON / 坏文件复制成「最近一份有效设置」
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  } catch {
    return false
  }

  const temp = `${backup}.tmp`
  try {
    fs.writeFileSync(temp, raw, 'utf8')
    // Windows 上 rename 会替换已有目标；同目录 rename 是原子的，不会留下半截备份
    fs.renameSync(temp, backup)
    return true
  } catch {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // 忽略清理失败
    }
    return false
  }
}
