/**
 * 后台任务输出缓冲回归（性能审计 P18）。
 *
 * `jobs-buffer.ts` 是零依赖纯逻辑；这里直接断言：
 * - 超过帧数 / 字符上限时丢弃最旧帧；
 * - 裁剪后消费游标同步回退，不会出现负游标或「越读越少」；
 * - 未超限时不丢弃。
 *
 * 跑法：`node --no-warnings tests/jobs.test.mts`
 */
import assert from 'node:assert/strict'
import {
  appendFrameWithinCap,
  type FramedOutputState
} from '../src/main/runtime/harness/jobs-buffer.ts'

const limits = { maxChars: 100, maxFrames: 5 }

// ── 1. 未超限：全部保留 ───────────────────────────────────────────────
const state: FramedOutputState = { outputFrames: [], cursor: 0, bufferedChars: 0 }
assert.equal(appendFrameWithinCap(state, 'aaa', limits), 0)
assert.equal(appendFrameWithinCap(state, 'bbb', limits), 0)
assert.deepEqual(state.outputFrames, ['aaa', 'bbb'])
assert.equal(state.bufferedChars, 6)

// ── 2. 帧数超限：丢最旧，游标回退 ─────────────────────────────────────
state.cursor = 2 // 两条都读过了
for (const frame of ['c', 'd', 'e']) appendFrameWithinCap(state, frame, limits)
assert.deepEqual(state.outputFrames, ['aaa', 'bbb', 'c', 'd', 'e'])
state.cursor = state.outputFrames.length
const dropped = appendFrameWithinCap(state, 'f', limits)
assert.equal(dropped, 1)
assert.deepEqual(state.outputFrames, ['bbb', 'c', 'd', 'e', 'f'])
assert.equal(state.cursor, 4, 'cursor must shift back when the oldest frame is dropped')
assert.equal(state.bufferedChars, 7)

// ── 3. 字符数超限：大帧也会丢 ─────────────────────────────────────────
const charState: FramedOutputState = { outputFrames: [], cursor: 0, bufferedChars: 0 }
appendFrameWithinCap(charState, 'x'.repeat(80), limits)
appendFrameWithinCap(charState, 'y'.repeat(80), limits)
assert.equal(charState.outputFrames.length, 1, 'old frame dropped once char cap exceeded')
assert.equal(charState.bufferedChars, 80)

// ── 4. 游标不会变成负数 ───────────────────────────────────────────────
const edge: FramedOutputState = { outputFrames: [], cursor: 0, bufferedChars: 0 }
for (let i = 0; i < 10; i++) appendFrameWithinCap(edge, `f${i}`, limits)
assert.ok(edge.cursor >= 0)
assert.ok(edge.outputFrames.length <= limits.maxFrames)

console.log('jobs: all assertions passed')
