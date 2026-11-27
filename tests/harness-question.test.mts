/**
 * ask_user_question 内联面板答题纯逻辑的回归测试。
 *
 * 跑法：`node --no-warnings tests/harness-question.test.mts`
 *
 * 覆盖：单选题 / 多选题 / 自由文本 / 「其他」自填的答案折叠，以及可提交判定。
 */
import assert from 'node:assert/strict'
import {
  QUESTION_OTHER_VALUE,
  buildQuestionAnswer,
  buildQuestionAnswers,
  canSubmitAllQuestions,
  canSubmitQuestion,
  questionHasChoices
} from '../src/renderer/src/utils/harness/question.ts'

const single = {
  id: 'q1',
  question: '用哪种方式验证？',
  options: [{ label: '先跑类型检查' }, { label: '跑完整 E2E', description: '慢但全' }]
}
const multi = {
  id: 'q2',
  question: '还需要哪些检查？',
  multi_select: true,
  options: [{ label: 'lint' }, { label: 'typecheck' }]
}
const freeText = { id: 'q3', question: '补充说明？' }

// ── 1. 是否有选项 ──────────────────────────────────────────────────────────
assert.equal(questionHasChoices(single), true)
assert.equal(questionHasChoices({ id: 'x', question: 'empty options', options: [] }), false)
assert.equal(questionHasChoices(freeText), false)

// ── 2. 单选 + 其他 ──────────────────────────────────────────────────────────
assert.equal(canSubmitQuestion(single), false, '未选择不能提交')
assert.equal(canSubmitQuestion(single, { selected: [single.options[0].label] }), true)
assert.equal(
  canSubmitQuestion(single, { selected: [QUESTION_OTHER_VALUE], custom: '  ' }),
  false,
  '选中「其他」但没填内容不能提交'
)
assert.equal(
  canSubmitQuestion(single, { selected: [QUESTION_OTHER_VALUE], custom: '先只跑类型检查' }),
  true
)
assert.deepEqual(buildQuestionAnswer(single, { selected: [QUESTION_OTHER_VALUE], custom: '自定' }), {
  id: 'q1',
  selected: [],
  custom: '自定'
})
assert.deepEqual(buildQuestionAnswer(single, { selected: ['先跑类型检查'], custom: '忽略' }), {
  id: 'q1',
  selected: ['先跑类型检查']
})

// ── 3. 多选：可多值，其他自填同时保留已选项 ─────────────────────────────────
assert.equal(canSubmitQuestion(multi, { selected: ['lint', 'typecheck'] }), true)
assert.deepEqual(
  buildQuestionAnswer(multi, { selected: ['lint', QUESTION_OTHER_VALUE], custom: ' 还要 e2e ' }),
  { id: 'q2', selected: ['lint'], custom: '还要 e2e' }
)

// ── 4. 自由文本：只有 custom，且必须非空 ────────────────────────────────────
assert.equal(canSubmitQuestion(freeText), false)
assert.equal(canSubmitQuestion(freeText, { selected: [], custom: '  ' }), false)
assert.equal(canSubmitQuestion(freeText, { selected: [], custom: '先别动样式' }), true)
assert.deepEqual(buildQuestionAnswer(freeText, { selected: [], custom: ' 先别动样式 ' }), {
  id: 'q3',
  selected: [],
  custom: '先别动样式'
})

// ── 5. 整批答案顺序与 questions 一致；全部可提交判定 ─────────────────────────
{
  const drafts = {
    q1: { selected: ['先跑类型检查'] },
    q2: { selected: ['lint'] },
    q3: { selected: [], custom: '补充' }
  }
  assert.equal(canSubmitAllQuestions([single, multi, freeText], drafts), true)
  assert.deepEqual(buildQuestionAnswers([single, multi, freeText], drafts), [
    { id: 'q1', selected: ['先跑类型检查'] },
    { id: 'q2', selected: ['lint'] },
    { id: 'q3', selected: [], custom: '补充' }
  ])
  assert.equal(
    canSubmitAllQuestions([single, freeText], { q1: { selected: ['先跑类型检查'] } }),
    false,
    '缺一题答案时不能整批提交'
  )
}

console.log('harness-question: all assertions passed')
