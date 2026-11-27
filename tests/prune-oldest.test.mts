/**
 * 目录清理回归（性能审计 P19）：按 mtime 删最旧文件、保留最新 N 个、跳过不匹配文件。
 *
 * 跑法：`node --no-warnings tests/prune-oldest.test.mts`
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pruneOldestFiles } from '../src/main/runtime/harness/prune-oldest.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-prune-'))
try {
  // 6 个匹配文件，mtime 依次递增；另有 1 个不匹配文件
  for (let i = 0; i < 6; i++) {
    const file = path.join(dir, `spill-${i}.txt`)
    fs.writeFileSync(file, `content-${i}`)
    const time = new Date(Date.now() - (6 - i) * 60_000)
    fs.utimesSync(file, time, time)
  }
  fs.writeFileSync(path.join(dir, 'keep-me.json'), '{}')
  fs.writeFileSync(path.join(dir, 'other.txt'), 'x')

  const removed = await pruneOldestFiles(dir, {
    keep: 3,
    match: (name) => name.startsWith('spill-')
  })
  assert.equal(removed.length, 3, 'must remove the 3 oldest matching files')
  const left = fs.readdirSync(dir).sort()
  assert.deepEqual(
    left,
    ['keep-me.json', 'other.txt', 'spill-3.txt', 'spill-4.txt', 'spill-5.txt'],
    'newest matching files and non-matching files must survive'
  )

  // 再次清理：数量已在上限内，不应删除
  const again = await pruneOldestFiles(dir, {
    keep: 3,
    match: (name) => name.startsWith('spill-')
  })
  assert.equal(again.length, 0)

  // 目录不存在：返回空数组而不是抛错
  const missing = await pruneOldestFiles(path.join(dir, 'does-not-exist'), {
    keep: 1,
    match: () => true
  })
  assert.equal(missing.length, 0)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('prune-oldest: all assertions passed')
