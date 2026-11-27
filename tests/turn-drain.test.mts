/**
 * 排队消息接续循环（services/harness/turn-drain.ts）的回归测试。
 *
 * 跑法：`node --no-warnings tests/turn-drain.test.mts`
 *
 * 这是「任务结束后排队消息没发出去」的直接回归：旧实现只接**一条**就不再触发，
 * 这里锁死「队列里几条就接几条」以及四种终止条件（有回合在跑 / 目标在跑 / 用户中止 / 起轮抛错）。
 */
import assert from 'node:assert/strict'
import { drainPendingTurns, type DrainTurnDeps } from '../src/main/services/harness/turn-drain.ts'
import type { QueuedMessage } from '../src/main/services/harness/queue-store.ts'

const item = (id: string): QueuedMessage => ({
  id,
  topicId: 1,
  senderId: 1,
  text: `消息 ${id}`,
  createdAt: 0
})

/** 假依赖：队列 + 回合状态 + 可编排的起轮行为 */
function makeDeps(options: {
  queue: QueuedMessage[]
  turnActive?: boolean
  goalRunning?: boolean
  /** 每轮的结果；缺省 = 正常结束 */
  outcomes?: (item: QueuedMessage, index: number) => { cancelled: boolean } | null
  /** 每轮抛错 */
  throwOn?: (item: QueuedMessage, index: number) => boolean
}): { deps: DrainTurnDeps; started: QueuedMessage[] } {
  const queue = [...options.queue]
  const started: QueuedMessage[] = []
  const deps: DrainTurnDeps = {
    isTurnActive: () => options.turnActive ?? false,
    isGoalRunning: () => options.goalRunning ?? false,
    hasPending: () => queue.length > 0,
    shift: () => queue.shift() ?? null,
    runTurn: async (next) => {
      const index = started.length
      started.push(next)
      if (options.throwOn?.(next, index)) throw new Error('boom')
      // 注意：outcomes 返回 null 表示「这一轮没跑起来」，不能用 ?? 兜成成功
      const outcome = options.outcomes ? options.outcomes(next, index) : { cancelled: false }
      // 真实现里回合在这时已经收尾；这里同样把 active 放开，下一轮检查才通得过
      options.turnActive = false
      return outcome
    }
  }
  return { deps, started }
}

// ── 1. 队列里几条就接几条（旧实现只接一条，这条断言就是本次修复的核心）──────────
{
  const { deps, started } = makeDeps({ queue: [item('a'), item('b'), item('c')] })
  const drained = await drainPendingTurns(deps)
  assert.equal(drained, 3)
  assert.deepEqual(started.map((it) => it.id), ['a', 'b', 'c'], '必须按 FIFO 全部接续')
  assert.equal(deps.hasPending(), false)
}

// ── 2. 队列空：什么都不做 ──────────────────────────────────────────────────────
{
  const { deps, started } = makeDeps({ queue: [] })
  assert.equal(await drainPendingTurns(deps), 0)
  assert.equal(started.length, 0)
}

// ── 3. 已有回合在跑：不抢跑（等它自己结束后再走接续）────────────────────────────
{
  const { deps, started } = makeDeps({ queue: [item('a')], turnActive: true })
  assert.equal(await drainPendingTurns(deps), 0)
  assert.equal(started.length, 0)
  assert.equal(deps.hasPending(), true, '抢跑被挡下时队列内容要保留')
}

// ── 4. 目标自动续跑在跑：同样不抢跑 ─────────────────────────────────────────────
{
  const { deps, started } = makeDeps({ queue: [item('a')], goalRunning: true })
  assert.equal(await drainPendingTurns(deps), 0)
  assert.equal(started.length, 0)
  assert.equal(deps.hasPending(), true)
}

// ── 5. 用户中止中间那一轮：后面的留在队列里，不再自动接着跑 ─────────────────────
{
  const { deps, started } = makeDeps({
    queue: [item('a'), item('b'), item('c')],
    outcomes: (_it, index) => ({ cancelled: index === 1 })
  })
  assert.equal(await drainPendingTurns(deps), 1, '中止的那一轮不计入已接续')
  assert.deepEqual(started.map((it) => it.id), ['a', 'b'])
  assert.equal(deps.hasPending(), true, '被中止之后的排队消息必须保留')
  assert.equal(deps.shift()?.id, 'c')
}

// ── 6. 起轮抛错：记一次错就停（不无限重试，剩余条目留在队列里）────────────────
{
  const seen: unknown[] = []
  const { deps, started } = makeDeps({
    queue: [item('a'), item('b')],
    throwOn: (_it, index) => index === 0
  })
  deps.onError = (error) => seen.push(error)
  assert.equal(await drainPendingTurns(deps), 0)
  assert.equal(started.length, 1)
  assert.equal(seen.length, 1)
  assert.equal(String(seen[0]), 'Error: boom')
  assert.equal(deps.hasPending(), true)
}

// ── 7. 防御性上限：runTurn 一直成功也不会无限循环（结果受 maxTurns 约束）────────
{
  const queue: QueuedMessage[] = []
  for (let i = 0; i < 8; i++) queue.push(item(`q${i}`))
  const { deps } = makeDeps({ queue })
  const drained = await drainPendingTurns({ ...deps, maxTurns: 3 })
  assert.equal(drained, 3)
  assert.equal(deps.hasPending(), true)
}

// ── 8. runTurn 返回 null（例如渲染帧失效）：当作中止处理 ───────────────────────
{
  const { deps, started } = makeDeps({
    queue: [item('a'), item('b')],
    outcomes: () => null
  })
  assert.equal(await drainPendingTurns(deps), 0)
  assert.equal(started.length, 1)
  assert.equal(deps.hasPending(), true)
}

console.log('turn-drain: all assertions passed')
