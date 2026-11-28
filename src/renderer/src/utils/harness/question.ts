/**
 * Pure answering logic for the inline `ask_user_question` panel (no React dependency, so it is
 * easy to unit test).
 *
 * It follows the same protocol as the old modal: a choice question always gets an extra "Other"
 * item (the pseudo-option never enters selected; typed content goes to custom); multi-select
 * allows several values; free text only has custom.
 */

/** Sentinel value of the "Other" pseudo-option (starts with a control character so it cannot collide with a real label from the model) */
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

/** Only choice questions (with options) get an extra "Other"; a plain-text question is free input in itself */
export function questionHasChoices(question: QuestionLike): boolean {
  return Boolean(question.options && question.options.length > 0)
}

/** Whether the current question can be submitted (choosing "Other" requires content, otherwise it counts as unanswered) */
export function canSubmitQuestion(question: QuestionLike, draft?: QuestionDraft): boolean {
  const selected = draft?.selected ?? []
  const hasCustom = Boolean(draft?.custom && draft.custom.trim())
  if (questionHasChoices(question)) {
    return selected.includes(QUESTION_OTHER_VALUE) ? hasCustom : selected.length > 0
  }
  return hasCustom
}

/** Collapse the draft into the answer shape the main process / model expects ("Other" is stripped from selected, its content goes to custom) */
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

/** Answers for the whole batch (same order as questions) */
export function buildQuestionAnswers(
  questions: readonly QuestionLike[],
  drafts: Record<string, QuestionDraft>
): QuestionAnswerItem[] {
  return questions.map((question) => buildQuestionAnswer(question, drafts[question.id]))
}

/** Whether every question can be submitted (the disabled condition of the final submit button) */
export function canSubmitAllQuestions(
  questions: readonly QuestionLike[],
  drafts: Record<string, QuestionDraft>
): boolean {
  return questions.every((question) => canSubmitQuestion(question, drafts[question.id]))
}
