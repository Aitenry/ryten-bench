/**
 * `settings.json` 备份 / 自愈（`src/main/settings-file.ts`）的回归测试。
 *
 * 跑法：`pnpm test:settings`（Node 22 自带 TS 类型擦除，不需要构建）
 *
 * 这层规则一旦退化，删掉 `%APPDATA%/ryten-bench/settings.json` 就会让应用按默认值重建：
 * 锁屏被关掉、主题/工作区路径丢失。测试把「缺失恢复、坏文件留档、坏备份不采纳」
 * 三条边界钉死。
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  readSettingsObject,
  restoreSettingsFile,
  settingsFilePaths,
  writeSettingsBackup
} from '../src/main/settings-file.ts'

let checks = 0

function check(name: string, fn: () => void): void {
  fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rb-settings-'))
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value), 'utf8')
}

const SAMPLE = {
  lock: { view: true, code: 'scrypt$16384$8$1$salt$hash', autoLockMinutes: 5 },
  harness: { workspacePath: 'D:/work' },
  theme: 'dark'
}

check('settings.json 存在且合法：原样使用，不动备份', () => {
  const dir = tempDir()
  const { settings } = settingsFilePaths(dir)
  writeJson(settings, SAMPLE)
  writeJson(settingsFilePaths(dir).backup, { theme: 'light' })

  const result = restoreSettingsFile(dir)
  assert.equal(result.settingsExisted, true)
  assert.equal(result.restoredFromBackup, false)
  assert.equal(result.quarantined, null)
  assert.deepEqual(readSettingsObject(settings), SAMPLE)

  fs.rmSync(dir, { recursive: true, force: true })
})

check('settings.json 缺失：从 settings.backup.json 恢复', () => {
  const dir = tempDir()
  const { settings, backup } = settingsFilePaths(dir)
  writeJson(backup, SAMPLE)

  const result = restoreSettingsFile(dir)
  assert.equal(result.settingsExisted, false)
  assert.equal(result.restoredFromBackup, true)
  assert.deepEqual(readSettingsObject(settings), SAMPLE)

  fs.rmSync(dir, { recursive: true, force: true })
})

check('settings.json 是坏 JSON：改名留档后从备份恢复', () => {
  const dir = tempDir()
  const { settings, backup } = settingsFilePaths(dir)
  fs.writeFileSync(settings, '{ this is not json', 'utf8')
  writeJson(backup, SAMPLE)

  const result = restoreSettingsFile(dir, Date.UTC(2026, 10, 24, 12, 0, 0))
  assert.equal(result.restoredFromBackup, true)
  assert.ok(result.quarantined && fs.existsSync(result.quarantined), String(result.quarantined))
  assert.match(path.basename(result.quarantined ?? ''), /^settings\.invalid-.*\.json$/)
  assert.deepEqual(readSettingsObject(settings), SAMPLE)

  fs.rmSync(dir, { recursive: true, force: true })
})

check('没有备份：缺失时保持缺失，让应用按默认值启动', () => {
  const dir = tempDir()
  const result = restoreSettingsFile(dir)
  assert.equal(result.restoredFromBackup, false)
  assert.equal(result.backupInvalid, false)
  assert.equal(fs.existsSync(settingsFilePaths(dir).settings), false)

  fs.rmSync(dir, { recursive: true, force: true })
})

check('坏 JSON 且没有备份：只留档，不凭空造设置', () => {
  const dir = tempDir()
  const { settings } = settingsFilePaths(dir)
  fs.writeFileSync(settings, 'not-json', 'utf8')

  const result = restoreSettingsFile(dir)
  assert.equal(result.restoredFromBackup, false)
  assert.ok(result.quarantined && fs.existsSync(result.quarantined))
  assert.equal(fs.existsSync(settings), false)

  fs.rmSync(dir, { recursive: true, force: true })
})

check('备份本身是坏 JSON：标记 backupInvalid，不覆盖设置', () => {
  const dir = tempDir()
  const { settings, backup } = settingsFilePaths(dir)
  writeJson(backup, ['not', 'an', 'object'])
  fs.writeFileSync(settings, 'broken', 'utf8')

  const result = restoreSettingsFile(dir)
  assert.equal(result.restoredFromBackup, false)
  assert.equal(result.backupInvalid, true)
  assert.equal(fs.existsSync(settings), false)

  fs.rmSync(dir, { recursive: true, force: true })
})

check('writeSettingsBackup：把有效设置复制成备份（原子替换）', () => {
  const dir = tempDir()
  const { settings, backup } = settingsFilePaths(dir)
  writeJson(settings, SAMPLE)

  assert.equal(writeSettingsBackup(dir), true)
  assert.deepEqual(readSettingsObject(backup), SAMPLE)
  assert.equal(fs.existsSync(`${backup}.tmp`), false)

  // 再写一次新的有效内容：备份应被替换，而不是追加/损坏
  const next = { ...SAMPLE, theme: 'light' }
  writeJson(settings, next)
  assert.equal(writeSettingsBackup(dir), true)
  assert.deepEqual(readSettingsObject(backup), next)

  fs.rmSync(dir, { recursive: true, force: true })
})

check('writeSettingsBackup：设置文件缺失或损坏时拒绝写备份', () => {
  const dir = tempDir()
  const { settings, backup } = settingsFilePaths(dir)

  assert.equal(writeSettingsBackup(dir), false)
  assert.equal(fs.existsSync(backup), false)

  fs.writeFileSync(settings, '{half', 'utf8')
  assert.equal(writeSettingsBackup(dir), false)
  assert.equal(fs.existsSync(backup), false)

  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`\n全部通过（${checks} 项）`)
