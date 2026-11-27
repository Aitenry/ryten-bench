/**
 * propose_action 输入区预填条纯逻辑的回归测试。
 *
 * 跑法：`node --no-warnings tests/harness-proposal.test.mts`
 *
 * 覆盖：只认最后一条用户消息之后的提议、旧提议过期、推荐内容取 reply/label、
 * 已完成状态、动作过滤与截断。
 */
import assert from 'node:assert/strict'
import {
  findPendingProposal,
  recommendedProposalText
} from '../src/renderer/src/utils/harness/proposal.ts'

const proposeBlock = (
  id: string,
  actions: unknown,
  status = 'completed'
): {
  type: string
  tool: { name: string; status: string; id: string; input: unknown }
} => ({
  type: 'tool',
  tool: {
    name: 'propose_action',
    status,
    id,
    input: { question: '要继续吗？', actions }
  }
})

// ── 1. 推荐内容：优先 reply，没有则 label ────────────────────────────────────
assert.equal(
  recommendedProposalText([{ label: '继续', reply: '按当前计划继续，先跑类型检查' }]),
  '按当前计划继续，先跑类型检查'
)
assert.equal(recommendedProposalText([{ label: ' 取消 ' }]), '取消')
assert.equal(recommendedProposalText([]), '')

// ── 2. 最新助手消息里的提议才算待确认 ────────────────────────────────────────
{
  const pending = findPendingProposal([
    { role: 'user', id: 'u1' },
    {
      role: 'assistant',
      id: 'a1',
      blocks: [proposeBlock('call-1', [{ label: '继续', reply: '继续执行下一步' }, { label: '取消' }])]
    }
  ])
  assert.ok(pending)
  assert.equal(pending?.key, 'call-1:a1:0')
  assert.equal(pending?.question, '要继续吗？')
  assert.equal(pending?.actions.length, 2)
  assert.equal(pending?.recommendedText, '继续执行下一步', '默认回填第一个动作的 reply')
}

// ── 3. 之后又有用户消息 → 提议过期（不再出现）────────────────────────────────
{
  const pending = findPendingProposal([
    { role: 'assistant', id: 'a1', blocks: [proposeBlock('call-1', [{ label: '继续' }])] },
    { role: 'user', id: 'u2' },
    { role: 'assistant', id: 'a2', blocks: [{ type: 'text' }] }
  ])
  assert.equal(pending, null, '最新助手消息没有提议时不能回溯旧提议')
}

// ── 4. 未完成 / 无动作 / 非 propose_action 的工具块都不算 ─────────────────────
{
  assert.equal(
    findPendingProposal([
      { role: 'user', id: 'u1' },
      { role: 'assistant', id: 'a1', blocks: [proposeBlock('c1', [{ label: '继续' }], 'executing')] }
    ]),
    null,
    '未完成的工具调用不算待确认'
  )
  assert.equal(
    findPendingProposal([
      { role: 'user', id: 'u1' },
      { role: 'assistant', id: 'a1', blocks: [proposeBlock('c1', [])] }
    ]),
    null,
    '没有动作的提议不显示'
  )
  assert.equal(
    findPendingProposal([
      { role: 'user', id: 'u1' },
      {
        role: 'assistant',
        id: 'a1',
        blocks: [
          { type: 'tool', tool: { name: 'read_file', status: 'completed', id: 'x', input: {} } }
        ]
      }
    ]),
    null
  )
}

// ── 5. 脏数据：动作缺 label / 非数组被忽略，最多保留 4 个 ─────────────────────
{
  const pending = findPendingProposal([
    { role: 'user', id: 'u1' },
    {
      role: 'assistant',
      id: 'a1',
      blocks: [
        proposeBlock('c1', [
          { label: 'A' },
          { label: '   ' },
          { description: 'no label' },
          null,
          { label: 'B', reply: '  ' },
          { label: 'C' },
          { label: 'D' },
          { label: 'E' },
          { label: 'F' }
        ])
      ]
    }
  ])
  assert.equal(pending?.actions.length, 4, '最多 4 个动作')
  assert.deepEqual(
    pending?.actions.map((action) => action.label),
    ['A', 'B', 'C', 'D']
  )
  assert.equal(pending?.actions[1].reply, undefined, '空白 reply 归为 undefined')
}

// ── 6. 同一助手消息里取最后一个 propose_action 块；key 在无 tool id 时稳定生成 ──
{
  const pending = findPendingProposal([
    { role: 'user', id: 'u1' },
    {
      role: 'assistant',
      id: 'a1',
      blocks: [
        proposeBlock('call-1', [{ label: '旧' }]),
        { type: 'text' },
        {
          type: 'tool',
          tool: { name: 'propose_action', status: 'completed', input: { actions: [{ label: '新' }] } }
        }
      ]
    }
  ])
  assert.equal(pending?.recommendedText, '新')
  assert.equal(pending?.key, 'no-id:a1:2')
}

console.log('harness-proposal: all assertions passed')
