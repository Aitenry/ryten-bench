/**
 * Wire shape of "the user cancelled the answer" (pure functions, no electron / i18n dependency,
 * easy to unit test).
 *
 * Mirrors `AskAnswer` in `ask.ts`: cancelling is not aborting the turn — once the service settles
 * this answer, the tool call returns normally, the model sees `cancelled: true`, and it continues
 * from there (without waiting for the user).
 *
 * Why not an empty `answers` array: the model cannot tell "the user cancelled" apart from "the
 * question list was empty"; an explicit `cancelled` marker lets the prompt and the model both take
 * the "continue" branch unambiguously.
 */

export interface CancelledAskAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
  cancelled: true
}

/** Build an "unselected, no custom input" answer for each pending question, marked as cancelled */
export function buildCancelledAnswer(
  questions: readonly { id: string }[]
): CancelledAskAnswer {
  return {
    answers: questions.map((question) => ({ id: question.id, selected: [] })),
    cancelled: true
  }
}
