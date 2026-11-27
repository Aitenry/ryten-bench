/**
 * 输入框底栏用量状态条的数据汇总（utils/harness/usage.ts）的回归测试。
 *
 * 跑法：`node --no-warnings tests/usage-summary.test.mts`
 *
 * 覆盖：跨轮累加、缓存命中率、上下文取**最近一次调用**（OpenAI 系的缓存是
 * prompt_tokens 的子集，不能重复加；Anthropic 系单列，必须补上）、
 * 老会话没有明细 / 没有 token 时整条不显示（返回 null），以及紧凑计数格式。
 */
import assert from 'node:assert/strict'
import type { HarnessDialogueUsageRow } from '../src/shared/harness/types.ts'
import { buildUsageSummary, formatCompactTokens } from '../src/renderer/src/utils/harness/usage.ts'

/** 只关心用量列的测试行 */
const usageRow = (override: Partial<HarnessDialogueUsageRow>): HarnessDialogueUsageRow => ({
  id: 1,
  workspace_id: 1,
  topic_id: 1,
  dialogue_id: 1,
  provider_id: 1,
  provider: 'deepseek',
  model: 'deepseek-flash',
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  calls: 1,
  usage_metadata: null,
  created_at: '2026-11-25T00:00:00Z',
  ...override
})

// ── 1. 两轮累加：总量、缓存命中率、上下文取第二轮 ──────────────────────────
const openaiStyle = buildUsageSummary([
  usageRow({
    id: 1,
    input_tokens: 1000,
    output_tokens: 200,
    total_tokens: 1200,
    usage_metadata: JSON.stringify([
      {
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          prompt_tokens_details: { cached_tokens: 900 }
        }
      }
    ])
  }),
  usageRow({
    id: 2,
    dialogue_id: 2,
    input_tokens: 2000,
    output_tokens: 100,
    total_tokens: 2100,
    usage_metadata: JSON.stringify([
      {
        usage: {
          prompt_tokens: 2000,
          completion_tokens: 100,
          prompt_tokens_details: { cached_tokens: 1900 }
        }
      }
    ])
  })
])

assert.ok(openaiStyle)
assert.equal(openaiStyle.totalTokens, 3300)
assert.equal(openaiStyle.inputTokens, 3000)
assert.equal(openaiStyle.cacheReadTokens, 2800)
assert.equal(openaiStyle.cacheHitRate, 2800 / 3000)
// 上下文 = 最近一次调用的提示 + 输出；缓存已含在 prompt_tokens 里，不重复加
assert.equal(openaiStyle.contextTokens, 2100)

// ── 2. Anthropic 口径：缓存单列，上下文必须补上 ────────────────────────────
const anthropicStyle = buildUsageSummary([
  usageRow({
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    input_tokens: 500,
    output_tokens: 300,
    total_tokens: 10800,
    usage_metadata: JSON.stringify([
      {
        usage: {
          input_tokens: 500,
          output_tokens: 300,
          cache_read_input_tokens: 9000,
          cache_creation_input_tokens: 1000
        }
      }
    ])
  })
])
assert.ok(anthropicStyle)
assert.equal(anthropicStyle.cacheReadTokens, 9000)
assert.equal(anthropicStyle.cacheWriteTokens, 1000)
assert.equal(anthropicStyle.contextTokens, 10800)

// ── 3. 没有用量行 / 没有 token 的老会话：整条不显示 ────────────────────────
assert.equal(buildUsageSummary([]), null)
assert.equal(buildUsageSummary([usageRow({ usage_metadata: null })]), null)

// ── 4. 紧凑计数（底栏用；精确值留给「本轮用量」面板）────────────────────────
assert.equal(formatCompactTokens(0), '0')
assert.equal(formatCompactTokens(912), '912')
assert.equal(formatCompactTokens(2500), '2.5k')
assert.equal(formatCompactTokens(845_000), '845k')
assert.equal(formatCompactTokens(2_500_000), '2.5M')
assert.equal(formatCompactTokens(12_400_000), '12M')

console.log('usage-summary: all assertions passed')
