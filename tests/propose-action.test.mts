/**
 * `propose_action` 纯逻辑回归（`runtime/harness/propose-action-core.ts`）。
 *
 * 跑法：`node --no-warnings tests/propose-action.test.mts`
 */
import assert from 'node:assert/strict'
import {
  MAX_ACTION_DESCRIPTION_CHARS,
  MAX_PROPOSED_ACTIONS,
  formatProposedActions,
  normalizeProposedActions,
  type ProposeActionTexts
} from '../src/main/runtime/harness/propose-action-core.ts'

const TEXTS: ProposeActionTexts = {
  shown: 'shown {{count}}',
  item: '- {{label}}{{description}}',
  hint: 'waiting'
}

const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    values[key] === undefined ? match : String(values[key])
  )

// ── 1. 规范化 ───────────────────────────────────────────────────────
assert.equal(normalizeProposedActions(undefined), null)
assert.equal(normalizeProposedActions([]), null)
assert.equal(normalizeProposedActions([{ label: '   ' }]), null)

const normalized = normalizeProposedActions([
  { label: '继续', description: '接着做下一步' },
  { label: '  继续  ' },
  { label: '' },
  { label: '暂停', reply: '先暂停一下' },
  { label: '第三个' },
  { label: '第四个' },
  { label: '第五个' }
])
assert.ok(normalized)
if (normalized) {
  // 条数上限 + label 去重（trim 后相同视为同一个）
  assert.equal(normalized.length, MAX_PROPOSED_ACTIONS)
  assert.deepEqual(
    normalized.map((action) => action.label),
    ['继续', '暂停', '第三个', '第四个']
  )
  assert.equal(normalized[0].description, '接着做下一步')
  assert.equal(normalized[1].reply, '先暂停一下')
}

// 超长字段被截断
const long = normalizeProposedActions([
  { label: 'x'.repeat(100), description: 'd'.repeat(500) }
])
assert.ok(long)
if (long) {
  assert.equal(long[0].label.length, 60)
  assert.equal(long[0].description?.length, MAX_ACTION_DESCRIPTION_CHARS)
}

// ── 2. 给模型的结果文本 ─────────────────────────────────────────────
const rendered = formatProposedActions(fill, TEXTS, [
  { label: '继续', description: '接着做' },
  { label: '暂停' }
])
assert.equal(rendered, 'shown 2\n- 继续— 接着做\n- 暂停\n\nwaiting')

console.log('propose-action: all assertions passed')
