/**
 * 定时任务时间规则回归（`runtime/harness/schedule-core.ts`，纯逻辑）。
 *
 * 跑法：`node --no-warnings tests/schedule-core.test.mts`
 */
import assert from 'node:assert/strict'
import {
  MAX_EVERY_MINUTES,
  MIN_EVERY_MINUTES,
  computeNextRun,
  describeScheduleWhen,
  nextRunAfterRun,
  parseDailyTime,
  selectDueTaskIds,
  validateScheduleWhen
} from '../src/main/runtime/harness/schedule-core.ts'

const now = new Date(2026, 10, 27, 10, 0, 0)

// ── once ─────────────────────────────────────────────────────────────
const future = new Date(now.getTime() + 60 * 60_000).toISOString()
const onceOk = validateScheduleWhen({ kind: 'once', at: future }, now)
assert.equal(onceOk.ok, true)
if (onceOk.ok) assert.equal(onceOk.nextRunAt, new Date(future).toISOString())

assert.deepEqual(validateScheduleWhen({ kind: 'once', at: 'not-a-date' }, now), {
  ok: false,
  reason: 'invalid-at'
})
// 已过去 / 太近（<30s）都拒绝
assert.deepEqual(
  validateScheduleWhen({ kind: 'once', at: new Date(now.getTime() - 1000).toISOString() }, now),
  { ok: false, reason: 'at-in-past' }
)
assert.deepEqual(
  validateScheduleWhen({ kind: 'once', at: new Date(now.getTime() + 5_000).toISOString() }, now),
  { ok: false, reason: 'at-in-past' }
)

// ── every ────────────────────────────────────────────────────────────
const every = validateScheduleWhen({ kind: 'every', minutes: 15 }, now)
assert.equal(every.ok, true)
if (every.ok) {
  assert.equal(new Date(every.nextRunAt).getTime(), now.getTime() + 15 * 60_000)
}
assert.deepEqual(
  validateScheduleWhen({ kind: 'every', minutes: MIN_EVERY_MINUTES - 1 }, now),
  { ok: false, reason: 'invalid-minutes' }
)
assert.deepEqual(
  validateScheduleWhen({ kind: 'every', minutes: MAX_EVERY_MINUTES + 1 }, now),
  { ok: false, reason: 'invalid-minutes' }
)
assert.deepEqual(validateScheduleWhen({ kind: 'every', minutes: 5.5 }, now), {
  ok: false,
  reason: 'invalid-minutes'
})

// ── daily ────────────────────────────────────────────────────────────
assert.deepEqual(parseDailyTime('09:30'), { hours: 9, minutes: 30 })
assert.equal(parseDailyTime('9:30'), null)
assert.equal(parseDailyTime('24:00'), null)
assert.equal(parseDailyTime('12:60'), null)

const dailyLater = validateScheduleWhen({ kind: 'daily', time: '18:00' }, now)
assert.equal(dailyLater.ok, true)
if (dailyLater.ok) {
  const next = new Date(dailyLater.nextRunAt)
  assert.equal(next.getHours(), 18)
  assert.equal(next.getMinutes(), 0)
  assert.equal(next.getDate(), 27)
}

// 当天已过点 → 明天同一时刻
const dailyRoll = computeNextRun({ kind: 'daily', time: '09:30' }, now)
assert.ok(dailyRoll)
if (dailyRoll) {
  assert.equal(dailyRoll.getDate(), 28)
  assert.equal(dailyRoll.getHours(), 9)
  assert.equal(dailyRoll.getMinutes(), 30)
}

// ── 其它 ─────────────────────────────────────────────────────────────
assert.deepEqual(validateScheduleWhen(null, now), { ok: false, reason: 'missing' })
assert.deepEqual(validateScheduleWhen({ kind: 'weekly' } as never, now), {
  ok: false,
  reason: 'unknown-kind'
})
assert.equal(describeScheduleWhen({ kind: 'once', at: 'x' }), 'once at x')
assert.equal(describeScheduleWhen({ kind: 'every', minutes: 10 }), 'every 10 min')
assert.equal(describeScheduleWhen({ kind: 'daily', time: '08:00' }), 'daily at 08:00')


// ── 调度选择（runner 的纯逻辑部分） ─────────────────────────────────
const t = (offsetMs: number): string => new Date(now.getTime() + offsetMs).toISOString()
const dueTasks = [
  { id: 'late', enabled: true, nextRunAt: t(-60_000) },
  { id: 'latest', enabled: true, nextRunAt: t(-120_000) },
  { id: 'future', enabled: true, nextRunAt: t(60_000) },
  { id: 'paused', enabled: false, nextRunAt: t(-60_000) },
  { id: 'none', enabled: true, nextRunAt: null },
  { id: 'broken', enabled: true, nextRunAt: 'not-a-date' }
]
// 到期按时间升序；停用 / 无排期 / 非法时间都不选
assert.deepEqual(selectDueTaskIds(dueTasks, now), ['latest', 'late'])
// 正在执行的跳过
assert.deepEqual(selectDueTaskIds(dueTasks, now, { running: new Set(['late']) }), ['latest'])
// limit 截断
const manyDue = ['a', 'b', 'c', 'd'].map((id, index) => ({
  id,
  enabled: true,
  nextRunAt: t(-(index + 1) * 1000)
}))
assert.deepEqual(selectDueTaskIds(manyDue, now, { limit: 3 }), ['d', 'c', 'b'])

// ── 执行后的下一次触发 ──────────────────────────────────────────────
assert.equal(nextRunAfterRun({ kind: 'once', at: t(60_000) }, now), null)
assert.equal(nextRunAfterRun({ kind: 'every', minutes: 10 }, now), t(10 * 60_000))
const dailyNext = nextRunAfterRun({ kind: 'daily', time: '09:30' }, now)
assert.ok(dailyNext)
if (dailyNext) {
  const date = new Date(dailyNext)
  assert.equal(date.getDate(), 28)
  assert.equal(date.getHours(), 9)
  assert.equal(date.getMinutes(), 30)
}

console.log('schedule-core: all assertions passed')
