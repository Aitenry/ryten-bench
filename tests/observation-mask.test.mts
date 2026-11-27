/**
 * 观测清理（observation masking）策略的回归测试。
 *
 * 跑法：`node --no-warnings tests/observation-mask.test.mts`
 *
 * 覆盖：最近窗口（工具对数 / 用户回合）不被清理、只清白名单工具、太短的结果不清、
 * 清理量与字符统计正确、数据不足时不清理。
 */
import assert from 'node:assert/strict'
import {
  planObservationMask,
  DEFAULT_OBSERVATION_POLICY,
  MASKABLE_TOOLS,
  type MaskableDialogue
} from '../src/main/runtime/harness/observation-mask.ts'

/** 造一段「用户 → 助手（n 个工具调用）」的对话序列 */
function conversation(turns: number, toolsPerTurn = 2, chars = 2_000): MaskableDialogue[] {
  const dialogues: MaskableDialogue[] = []
  for (let i = 0; i < turns; i++) {
    dialogues.push({ role: 'user', tools: [] })
    dialogues.push({
      role: 'assistant',
      tools: Array.from({ length: toolsPerTurn }, (_, t) => ({
        name: t % 2 === 0 ? 'read_file' : 'grep',
        chars
      }))
    })
  }
  return dialogues
}

// ── 1. 最近窗口原样保留 ────────────────────────────────────────────────
const long = conversation(10) // 20 个工具调用、10 个用户回合
const plan = planObservationMask(long)

assert.ok(plan.maskedCount > 0, '长会话里应该有可清理的旧结果')
// 最后 8 个工具调用（默认 keepToolPairs）绝不能被清
const toolPositions: { dialogue: number; tool: number }[] = []
long.forEach((d, di) => d.tools.forEach((_, ti) => toolPositions.push({ dialogue: di, tool: ti })))
const lastEight = toolPositions.slice(-8)
for (const pos of lastEight) {
  assert.ok(
    !plan.masked.get(pos.dialogue)?.has(pos.tool),
    `最近窗口里的工具调用不能被清理: dialogue=${pos.dialogue} tool=${pos.tool}`
  )
}
// 最近 2 个用户回合内的全部结果也不能被清
const userIndices = long.map((d, i) => (d.role === 'user' ? i : -1)).filter((i) => i >= 0)
const secondLastUser = userIndices[userIndices.length - 2]
assert.ok(secondLastUser >= 0)
for (const [dialogue] of plan.masked) {
  assert.ok(dialogue < secondLastUser, `最近两个用户回合内的对话不能被清理: ${dialogue}`)
}
// 字符统计与条数自洽
assert.equal(plan.maskedChars, plan.maskedCount * 2_000)

// ── 2. 只清白名单工具 ──────────────────────────────────────────────────
const mixed: MaskableDialogue[] = [
  { role: 'user', tools: [] },
  {
    role: 'assistant',
    tools: [
      { name: 'read_file', chars: 9_000 },
      { name: 'write_file', chars: 9_000 },
      { name: 'edit_file', chars: 9_000 },
      { name: 'ask_user', chars: 9_000 }
    ]
  },
  { role: 'user', tools: [] },
  { role: 'assistant', tools: [{ name: 'read_file', chars: 9_000 }] }
]
const mixedPlan = planObservationMask(mixed, { keepToolPairs: 0, keepUserTurns: 0 })
assert.deepEqual([...mixedPlan.masked.keys()], [1])
assert.deepEqual([...mixedPlan.masked.get(1)!], [0], '同一行里只清 read_file')
for (const name of ['write_file', 'edit_file', 'ask_user']) {
  assert.ok(!MASKABLE_TOOLS.has(name), `${name} 不应在清理白名单里`)
}

// ── 3. 太短的结果不清（清了没收益，还多一行噪声）──────────────────────
const tiny: MaskableDialogue[] = [
  { role: 'user', tools: [] },
  { role: 'assistant', tools: [{ name: 'read_file', chars: 100 }] },
  { role: 'user', tools: [] },
  { role: 'assistant', tools: [{ name: 'read_file', chars: 5_000 }] }
]
const tinyPlan = planObservationMask(tiny, { keepToolPairs: 0, keepUserTurns: 0 })
assert.equal(tinyPlan.maskedCount, 0, '小于 minChars 的结果不应被清')

// ── 4. 数据不足时不清理（新会话 / 只有一两轮）──────────────────────────
for (const short of [[], conversation(1), conversation(2)]) {
  const p = planObservationMask(short)
  assert.equal(p.maskedCount, 0, '会话还没攒够最近窗口时不应清理')
}

// ── 5. 默认策略参数符合预期（防止无意间调松）──────────────────────────−1
assert.equal(DEFAULT_OBSERVATION_POLICY.keepToolPairs, 8)
assert.equal(DEFAULT_OBSERVATION_POLICY.keepUserTurns, 2)
assert.equal(DEFAULT_OBSERVATION_POLICY.minChars, 500)

console.log('observation-mask: all assertions passed')
