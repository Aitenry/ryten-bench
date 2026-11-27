/**
 * 「合并云端数据」三方决策的回归测试（`src/main/lattice/merge-base.ts`）。
 *
 * 跑法：`pnpm test:merge`（Node 22 自带 TS 类型擦除，不需要构建）
 *
 * 这里钉死的是用户 2026-11-25 报的那类事故：
 * - 本机删掉/改过的行，被云端旧快照「合并」回来；
 * - 两边都改过时自动并集，把脏数据推回云端；
 * - `exportedAt` 每次都变，导致「看起来永远有改动」。
 */
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import {
  decideMergeAction,
  normalizeSnapshot,
  snapshotsEqual
} from '../src/main/lattice/merge-base.ts'

let checks = 0

function check(name: string, fn: () => void): void {
  fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

const base = {
  format: 'personal-ledger.snapshot',
  version: 1,
  exportedAt: '2026-11-25T06:00:00.000Z',
  accounts: [
    { id: 1, name: '现金', type: 'cash', currency: 'CNY' },
    { id: 2, name: '工资卡', type: 'bank', currency: 'CNY' }
  ],
  transactions: [
    { id: 10, amount: 25, date: '2026-11-24', note: '午饭' },
    { id: 11, amount: 8, date: '2026-11-24', note: '咖啡' }
  ]
}

check('exportedAt 不同不算数据变化', () => {
  const next = { ...base, exportedAt: '2026-11-25T07:30:00.000Z' }
  assert.equal(snapshotsEqual(base, next), true)
})

check('行顺序不同不算数据变化（SQL 没 ORDER BY 也不会假冲突）', () => {
  const next = { ...base, transactions: [...base.transactions].reverse() }
  assert.equal(snapshotsEqual(base, next), true)
})

check('删掉一行必须算变化（否则删除会被云端回填）', () => {
  const next = { ...base, transactions: base.transactions.slice(0, 1) }
  assert.equal(snapshotsEqual(base, next), false)
})

check('改一行必须算变化', () => {
  const next = {
    ...base,
    transactions: [{ ...base.transactions[0], amount: 30 }, base.transactions[1]]
  }
  assert.equal(snapshotsEqual(base, next), false)
})

check('gzip+base64 信封解开后与明文等价（大账本也能比对）', () => {
  const payload = { ...base }
  const packed = {
    format: 'personal-ledger.snapshot.packed',
    version: 1,
    encoding: 'gzip+base64',
    packed: gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64')
  }
  assert.equal(snapshotsEqual(packed, base), true)
  const changed = { ...payload, transactions: payload.transactions.slice(0, 1) }
  const changedPacked = {
    ...packed,
    packed: gzipSync(Buffer.from(JSON.stringify(changed), 'utf8')).toString('base64')
  }
  assert.equal(snapshotsEqual(changedPacked, base), false)
})

check('坏信封不会抛错，按「可能变了」处理', () => {
  const broken = {
    format: 'personal-ledger.snapshot.packed',
    encoding: 'gzip+base64',
    packed: 'not-base64!!'
  }
  assert.equal(snapshotsEqual(broken, base), false)
  assert.doesNotThrow(() => normalizeSnapshot(broken))
})

check('两边都没动 → sync', () => {
  assert.equal(
    decideMergeAction({ hasBase: true, baseRev: 7, serverRev: 7, dirty: false, localDrift: false }),
    'sync'
  )
})

check('只有本机动 → push（删除/修改往上推，不会被回填）', () => {
  assert.equal(
    decideMergeAction({ hasBase: true, baseRev: 7, serverRev: 7, dirty: true, localDrift: true }),
    'push'
  )
  // 即使 dirty 标记丢了，检测到快照漂移也要走 push
  assert.equal(
    decideMergeAction({ hasBase: true, baseRev: 7, serverRev: 7, dirty: false, localDrift: true }),
    'push'
  )
})

check('只有云端动 → pull（本机没有未同步改动才允许）', () => {
  assert.equal(
    decideMergeAction({ hasBase: true, baseRev: 7, serverRev: 8, dirty: false, localDrift: false }),
    'pull'
  )
})

check('两边都动 → conflict，绝不自动并集', () => {
  assert.equal(
    decideMergeAction({ hasBase: true, baseRev: 7, serverRev: 8, dirty: true, localDrift: true }),
    'conflict'
  )
  assert.equal(
    decideMergeAction({ hasBase: true, baseRev: 7, serverRev: 8, dirty: false, localDrift: true }),
    'conflict'
  )
})

check('没有基线 / 服务端 rev 回退 → no-base，不猜', () => {
  assert.equal(
    decideMergeAction({
      hasBase: false,
      baseRev: 0,
      serverRev: 3,
      dirty: false,
      localDrift: false
    }),
    'no-base'
  )
  assert.equal(
    decideMergeAction({ hasBase: true, baseRev: 9, serverRev: 3, dirty: false, localDrift: false }),
    'no-base'
  )
})

console.log(`\n${checks} checks passed`)
