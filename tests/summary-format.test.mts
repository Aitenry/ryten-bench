/**
 * 压缩摘要输出清洗（`<analysis>` 草稿 + `<summary>` 正文）的回归测试。
 *
 * 跑法：`node --no-warnings tests/summary-format.test.mts`
 */
import assert from 'node:assert/strict'
import { extractCheckpointText } from '../src/main/runtime/harness/summary-format.ts'

// ── 1. 标准形态：只取 <summary> 正文，analysis 丢弃 ────────────────────
assert.equal(
  extractCheckpointText(
    '<analysis>\n- user asked for X\n- fixed Y\n</analysis>\n\n<summary>\n## Primary Request and Intent\n- X\n</summary>'
  ),
  '## Primary Request and Intent\n- X'
)

// ── 2. 没有 <summary> 包裹：删掉 analysis，保留其余（格式降级）─────────
assert.equal(
  extractCheckpointText('<analysis>scratch</analysis>\n## Current Work\n- doing Z'),
  '## Current Work\n- doing Z'
)

// ── 3. 残留标签清除 ────────────────────────────────────────────────────
assert.equal(extractCheckpointText('<summary>plain</summary>'), 'plain')
assert.equal(extractCheckpointText('<summary></summary>'), '')

// ── 4. 空输出与纯空白 ─────────────────────────────────────────────────
assert.equal(extractCheckpointText(''), '')
assert.equal(extractCheckpointText('   \n\t  '), '')

// ── 5. analysis 里出现 summary 字样不会误伤（非贪婪匹配到第一个闭合）──
assert.equal(
  extractCheckpointText('<analysis>mentions <summary> tag</analysis><summary>real</summary>'),
  'real'
)

console.log('summary-format: all assertions passed')
