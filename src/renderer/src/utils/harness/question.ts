/**
 * `ask_user_question` 内联面板的答题纯逻辑（无 React 依赖，便于单元测试）。
 *
 * 与旧弹窗保持同一份协议：选择式问题固定补一项「其他」（伪选项不进 selected，
 * 自填内容走 custom）；多选可多值；自由文本只有 custom。
 */

/** 「其他」伪选项的哨兵值（用控制字符开头，避免与模型给出的真实 label 撞名） */
export const QUESTION_OTHER_VALUE = '\u0000ask-other'

export interface QuestionOptionLike {
  label: string
  description?: string
}

export interface QuestionLike {
  id: string
  question: string
  header?: string
  options?: QuestionOptionLike[]
  multi_select?: boolean
}

export interface QuestionDraft {
  selected: string[]
  custom?: string
}

export interface QuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/** 选择式问题（有 options）才补「其他」；纯文本提问本身就是自由输入 */
export function questionHasChoices(question: QuestionLike): boolean {
  return Boolean(question.options && question.options.length > 0)
}

/** 当前题是否可以提交（选了「其他」必须填内容，否则等于没答） */
export function canSubmitQuestion(question: QuestionLike, draft?: QuestionDraft): boolean {
  const selected = draft?.selected ?? []
  const hasCustom = Boolean(draft?.custom && draft.custom.trim())
  if (questionHasChoices(question)) {
    return selected.includes(QUESTION_OTHER_VALUE) ? hasCustom : selected.length > 0
  }
  return hasCustom
}

/** 把草稿折叠成主进程/模型需要的答案形状（「其他」剥离出 selected，内容进 custom） */
export function buildQuestionAnswer(
  question: QuestionLike,
  draft?: QuestionDraft
): QuestionAnswerItem {
  const selected = draft?.selected ?? []
  const choseOther =
    questionHasChoices(question) && selected.includes(QUESTION_OTHER_VALUE)
  const custom =
    !questionHasChoices(question) || choseOther ? draft?.custom?.trim() || undefined : undefined
  return {
    id: question.id,
    selected: selected.filter((value) => value !== QUESTION_OTHER_VALUE),
    ...(custom ? { custom } : {})
  }
}

/** 整批答案（顺序与 questions 一致） */
export function buildQuestionAnswers(
  questions: readonly QuestionLike[],
  drafts: Record<string, QuestionDraft>
): QuestionAnswerItem[] {
  return questions.map((question) => buildQuestionAnswer(question, drafts[question.id]))
}

/** 是否所有问题都可提交（最后一步总提交按钮的 disabled 条件） */
export function canSubmitAllQuestions(
  questions: readonly QuestionLike[],
  drafts: Record<string, QuestionDraft>
): boolean {
  return questions.every((question) => canSubmitQuestion(question, drafts[question.id]))
}
