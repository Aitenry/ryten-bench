/**
 * 压缩压力判定（真实 token 优先、字符兜底）与「从 usage_metadata 反推上下文规模」的回归测试。
 *
 * 跑法：`node --no-warnings tests/compaction-pressure.test.mts`
 *
 * 覆盖：
 * - token 口径在窗口 79% 触发（79% 整点算触发，差一点不触发）；
 * - token 数据缺失（模型不回传 / 窗口未知）时退回字符口径 70%；
 * - 上下文 token 的两种供应商口径：OpenAI 系缓存是 prompt 的子集（不能重复加），
 *   Anthropic 系缓存单列（必须补上）；
 * - 最近一次调用取「最后一行明细数组的最后一条」，坏行往前退；
 * - 压缩转录分块：按字符上限切连续块，单条超限也不拆。
 */
import assert from 'node:assert/strict'
import { contextTokensOf, lastCallContextTokens } from '../src/main/runtime/harness/usage.ts'
import {
  decideContextPressure,
  chunkByChars,
  TOKEN_PRESSURE_RATIO
} from '../src/main/runtime/harness/context-pressure.ts'

const WINDOW = 256_000

// ── 1. token 口径：79% 触发 ─────────────────────────────────────────────
const at79 = decideContextPressure({
  totalChars: 300_000,
  maxChars: WINDOW,
  charThreshold: 0.7,
  measuredContextTokens: WINDOW * TOKEN_PRESSURE_RATIO,
  contextWindowTokens: WINDOW
})
assert.equal(at79.tokenBased, true)
assert.equal(at79.triggered, true)
assert.equal(at79.threshold, TOKEN_PRESSURE_RATIO)
assert.ok(Math.abs(at79.ratio - 0.79) < 1e-9)

const below79 = decideContextPressure({
  totalChars: 300_000,
  maxChars: WINDOW,
  charThreshold: 0.7,
  measuredContextTokens: 200_000, // 78.1%
  contextWindowTokens: WINDOW
})
assert.equal(below79.tokenBased, true)
assert.equal(below79.triggered, false)

// token 口径下即使字符已超 70% 也不压：字符多不等于窗口满（英文 4 字符 ≈ 1 token）
const charsOverButTokensFine = decideContextPressure({
  totalChars: WINDOW * 0.9,
  maxChars: WINDOW,
  charThreshold: 0.7,
  measuredContextTokens: 100_000,
  contextWindowTokens: WINDOW
})
assert.equal(charsOverButTokensFine.tokenBased, true)
assert.equal(charsOverButTokensFine.triggered, false)

// ── 2. 兜底：拿不到 token 时用字符 70% ─────────────────────────────────
const charOnly = decideContextPressure({
  totalChars: 180_000,
  maxChars: WINDOW,
  charThreshold: 0.7,
  measuredContextTokens: null,
  contextWindowTokens: WINDOW
})
assert.equal(charOnly.tokenBased, false)
assert.equal(charOnly.tokenRatio, null)
assert.equal(charOnly.triggered, true)

const charUnder = decideContextPressure({
  totalChars: 170_000,
  maxChars: WINDOW,
  charThreshold: 0.7
})
assert.equal(charUnder.tokenBased, false)
assert.equal(charUnder.triggered, false)

// 有 token 没窗口（或反过来）同样退回字符口径
for (const input of [
  { measuredContextTokens: 250_000, contextWindowTokens: null },
  { measuredContextTokens: null, contextWindowTokens: WINDOW },
  { measuredContextTokens: 0, contextWindowTokens: WINDOW }
]) {
  const d = decideContextPressure({
    totalChars: 10_000,
    maxChars: WINDOW,
    charThreshold: 0.7,
    ...input
  })
  assert.equal(d.tokenBased, false)
}

// ── 3. 上下文 token：OpenAI 系缓存不重复加 ─────────────────────────────
assert.equal(
  contextTokensOf({
    prompt_tokens: 1000,
    completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 900 }
  }),
  1200
)

// ── 4. 上下文 token：Anthropic 系缓存单列，必须补上 ────────────────────
assert.equal(
  contextTokensOf({
    input_tokens: 1000,
    output_tokens: 100,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 300
  }),
  6400
)

// 没有明细时至少拿到 prompt + completion
assert.equal(contextTokensOf({ prompt_tokens: 42, completion_tokens: 8 }), 50)
// 全都拿不到 → 0，不当成「有数据」
assert.equal(contextTokensOf({}), 0)

// ── 5. 最近一次调用：最后一行 + 行内最后一条 ───────────────────────────
const rows = [
  {
    usage_metadata: JSON.stringify([
      { usage: { input_tokens: 90_000, output_tokens: 1_000 } },
      { usage: { input_tokens: 100_000, output_tokens: 1_000 } }
    ])
  },
  {
    usage_metadata: JSON.stringify([{ usage: { input_tokens: 5_000, output_tokens: 500 } }])
  }
]
assert.equal(lastCallContextTokens(rows), 5_500)

// 最后一行坏掉：退回上一行，而不是整条放弃
const withBrokenTail = [
  { usage_metadata: JSON.stringify([{ usage: { input_tokens: 5_000, output_tokens: 500 } }]) },
  { usage_metadata: '{not json' },
  { usage_metadata: null }
]
assert.equal(lastCallContextTokens(withBrokenTail), 5_500)

// 全空 → null（调用方退回字符口径）
assert.equal(lastCallContextTokens([]), null)
assert.equal(lastCallContextTokens([{ usage_metadata: null }]), null)

// ── 6. 压缩转录分块 ────────────────────────────────────────────────────
const hundred = (id: number): { id: number; chars: number } => ({ id, chars: 100 })
const chunks = chunkByChars([1, 2, 3, 4, 5].map(hundred), (item) => item.chars, 250)
assert.deepEqual(
  chunks.map((chunk) => chunk.map((item) => item.id)),
  [
    [1, 2],
    [3, 4],
    [5]
  ]
)

// 单条本身就超限：单独成块，绝不拆消息
const oversized = chunkByChars(
  [
    { id: 1, chars: 400 },
    { id: 2, chars: 50 }
  ],
  (item) => item.chars,
  250
)
assert.deepEqual(
  oversized.map((chunk) => chunk.map((item) => item.id)),
  [[1], [2]]
)

console.log('compaction-pressure: all assertions passed')
