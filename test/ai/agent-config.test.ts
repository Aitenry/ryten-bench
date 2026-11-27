/**
 * 会话级「本轮启用选择」纯逻辑回归（工具 / 技能 / MCP 的选择与合并）。
 *
 * 用户口径（2026-11-27）：新增的技能与 MCP 不能默认开启，必须在输入框下面选择；
 * 定时任务上的选择叠加在会话选择之上。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isEmptyAgentSelection,
  mergeAgentSelection,
  normalizeAgentSelection
} from '../../src/shared/harness/agent-config'

test('agent selection: normalise trims, dedupes and drops invalid entries', () => {
  assert.deepEqual(
    normalizeAgentSelection({
      tools: [' web_fetch ', 'web_fetch', '', 42],
      skills: ['alpha', ' alpha ', 'beta'],
      mcpTools: ['mcp__server__search']
    }),
    {
      tools: ['web_fetch'],
      skills: ['alpha', 'beta'],
      mcpTools: ['mcp__server__search']
    }
  )
  // 非数组 / 缺字段 → 该维度 null（= 不覆盖 / 不启用）
  assert.deepEqual(normalizeAgentSelection(undefined), null)
  assert.deepEqual(normalizeAgentSelection({ tools: 'web_fetch' }), {
    tools: null,
    skills: null,
    mcpTools: null
  })
  // 显式空数组保留：表示「用户明确什么都没选」
  assert.deepEqual(normalizeAgentSelection({ skills: [] }), {
    tools: null,
    skills: [],
    mcpTools: null
  })
})

test('agent selection: merge lets task-level choices win per dimension', () => {
  const session = { tools: ['web_fetch'], skills: ['alpha'], mcpTools: null }
  const task = { tools: ['get_time'], skills: null, mcpTools: ['mcp__s__t'] }
  const merged = mergeAgentSelection(session, task)
  // 任务里非 null 的维度覆盖会话；null 的维度继承会话
  assert.deepEqual(merged, { tools: ['get_time'], skills: ['alpha'], mcpTools: ['mcp__s__t'] })

  // 任务什么都没设置 → 完全继承会话
  assert.deepEqual(mergeAgentSelection(session, { tools: null, skills: null, mcpTools: null }), session)

  // 会话为空、任务只选技能 → 工具/MCP 保持 null（不启用）
  assert.deepEqual(
    mergeAgentSelection(null, { tools: null, skills: ['beta'], mcpTools: null }),
    { tools: null, skills: ['beta'], mcpTools: null }
  )

  assert.equal(isEmptyAgentSelection(null), true)
  assert.equal(isEmptyAgentSelection({ tools: null, skills: null, mcpTools: null }), true)
  assert.equal(isEmptyAgentSelection({ tools: [], skills: null, mcpTools: null }), false)
})
