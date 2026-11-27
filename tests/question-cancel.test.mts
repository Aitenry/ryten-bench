/**
 * 「用户取消回答」协议形状的回归测试。
 *
 * 跑法：`node --no-warnings tests/question-cancel.test.mts`
 *
 * 关键语义：取消不是中止本轮——答案带 cancelled:true，工具正常返回让模型继续；
 * 每条问题都有一条空选择占位，顺序与入参一致。
 */
import assert from 'node:assert/strict'
import { buildCancelledAnswer } from '../src/main/runtime/harness/question-cancel.ts'

// ── 1. 单题 ────────────────────────────────────────────────────────────────
assert.deepEqual(buildCancelledAnswer([{ id: 'q1' }]), {
  answers: [{ id: 'q1', selected: [] }],
  cancelled: true
})

// ── 2. 多题：顺序保持，全部空选 ────────────────────────────────────────────
assert.deepEqual(buildCancelledAnswer([{ id: 'a' }, { id: 'b' }]), {
  answers: [
    { id: 'a', selected: [] },
    { id: 'b', selected: [] }
  ],
  cancelled: true
})

// ── 3. 空问题列表也能构造（工具层会正常返回）────────────────────────────────
assert.deepEqual(buildCancelledAnswer([]), { answers: [], cancelled: true })

// ── 4. 每次调用返回新对象（不会被下游修改污染）──────────────────────────────
{
  const first = buildCancelledAnswer([{ id: 'q1' }])
  const second = buildCancelledAnswer([{ id: 'q1' }])
  assert.notEqual(first, second)
  assert.notEqual(first.answers, second.answers)
}

console.log('question-cancel: all assertions passed')
