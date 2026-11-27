/**
 * 流事件回合守卫（renderer/utils/harness/turn-guard.ts）的回归测试。
 *
 * 跑法：`node --no-warnings tests/turn-guard.test.mts`
 *
 * 覆盖渲染端「按回合丢弃事件」的三条规则：已知回合只收它、未知回合锁首条、
 * 老版本主进程不带回合 id 时退回按话题放行。
 */
import assert from 'node:assert/strict'
import { createTurnGuard } from '../src/renderer/src/utils/harness/turn-guard.ts'

// ── 1. 已知回合：只收这一轮 ───────────────────────────────────────────────────
{
  const guard = createTurnGuard(42)
  assert.equal(guard(42), true)
  assert.equal(guard(41), false, '上一轮的迟到事件必须丢弃')
  assert.equal(guard(43), false, '另一轮的事件必须丢弃')
  assert.equal(guard(42), true)
}

// ── 2. 未知回合（本地发送）：锁在第一条事件上 ─────────────────────────────────
{
  const guard = createTurnGuard()
  assert.equal(guard(7), true, '第一条事件决定本轮身份')
  assert.equal(guard(7), true)
  assert.equal(guard(8), false, '锁定之后别的回合一律丢弃')
  assert.equal(guard(7), true)
}

// ── 3. 老版本主进程不带回合 id：全部放行（退回按话题处理，不能把内容全丢了）──────
{
  const guard = createTurnGuard()
  assert.equal(guard(undefined), true)
  assert.equal(guard(null), true)
  // 放行不代表放弃锁定：后续带 id 的事件仍然被锁住
  assert.equal(guard(5), true)
  assert.equal(guard(6), false)
}

// ── 4. 未知回合 + 首条不带 id：等到第一条带 id 的事件再锁 ─────────────────────
{
  const guard = createTurnGuard()
  assert.equal(guard(undefined), true)
  assert.equal(guard(3), true)
  assert.equal(guard(4), false)
}

// ── 5. 每条流一个守卫：互相不影响 ─────────────────────────────────────────────
{
  const a = createTurnGuard(1)
  const b = createTurnGuard(2)
  assert.equal(a(1), true)
  assert.equal(b(2), true)
  assert.equal(a(2), false)
  assert.equal(b(1), false)
}

console.log('turn-guard: all assertions passed')
