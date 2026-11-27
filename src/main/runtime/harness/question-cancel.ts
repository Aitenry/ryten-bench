/**
 * 「用户取消回答」的协议形状（纯函数，无 electron / i18n 依赖，便于单测）。
 *
 * 与 `ask.ts` 里 `AskAnswer` 对齐：取消不是中止本轮——服务把这条答案结算后，工具调用
 * 正常返回，模型拿到 `cancelled: true`，据此继续执行（不再等待用户）。
 *
 * 为什么不用空 `answers` 数组：模型无法区分「用户取消」和「题目列表为空」；显式标记
 * `cancelled` 才能让提示词和模型都明确走「继续执行」分支。
 */

export interface CancelledAskAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
  cancelled: true
}

/** 为每条挂起问题构造一条「未选、未自填」的答案，并带上取消标记 */
export function buildCancelledAnswer(
  questions: readonly { id: string }[]
): CancelledAskAnswer {
  return {
    answers: questions.map((question) => ({ id: question.id, selected: [] })),
    cancelled: true
  }
}
