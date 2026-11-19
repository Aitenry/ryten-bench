/**
 * 本轮「最终答复」边界的**唯一真源**（协议层）。
 *
 * 为什么单独一个模块：这段逻辑过去长在渲染端（AssistantMessage 里按
 * `segIndex === lastSegIndex && !message.loading` 反向扫块），是**启发式**——
 * 它靠渲染端自己的 loading 状态猜「这一轮结束了没有」，而 loading 的翻转要等
 * `harness-stream-done`。目标自动续跑时驱动器是 `while (await driveOnce())`
 * （见 goal-driver.ts），上一轮的 done 与下一轮的 goalRound 几乎同 tick 落地，
 * 于是「等 loading 翻 false 再摘」在续跑里几乎等于「等整条目标跑完」，
 * 最后一轮的思考与答复就一直留在任务段里。
 *
 * 现在改由主进程在**收到内容的那一刻**给出结论：
 *   - 生产者给每段正文/推理 chunk 打 `answer: true`（该轮尚未出现工具/子代理活动）；
 *   - 一旦出现工具或子代理活动，后续内容一律打 `answer: false`（撤回之前的标记，
 *     说明前面那段只是探索途中的话，不是这一轮交付给用户的答复）；
 *   - 真实边界 `answerFrom` 由本模块从累积块推出，随 done 事件下发，
 *     渲染端只读不猜。
 *
 * 「最终答复」的定义（与渲染端的块序一致，两者都按到达顺序 append）：
 *   从块数组末尾往前，连续的 reasoning / text 块 —— 至少含一个 text 块才算成立。
 * 工具卡打断回溯（被工具隔开的思考与末尾答复不连续），所以边界只会落在
 * 「最后一段非工具内容」的起点上。
 */

/** 参与「答复尾巴」的最少形态（主进程累积块与渲染端合并块的公共子集） */
export interface AnswerBlockLike {
  type: string
}

/**
 * 从块数组尾部数出「最终答复」包含的块数（0 = 本轮没有答复）。
 *
 * 这是**线上口径**：主进程累积块与渲染端合并块的块序一致（两边都按到达顺序
 * append），但块数可能不同（渲染端合并相邻 reasoning、还有只在渲染端存在的
 * 过渡块），所以过线的是**数量**而不是下标——渲染端从自己数组的末尾往前数同样
 * 多块即可，不必假设两边下标对齐。
 *
 * @param blocks 本轮累积块（主进程 acc.blocks / 渲染端合并块均可）
 */
export function answerTrailingCount(blocks: readonly AnswerBlockLike[]): number {
  let cut = blocks.length
  let sawText = false
  while (cut > 0) {
    const type = blocks[cut - 1]?.type
    if (type === 'text') {
      sawText = true
      cut -= 1
      continue
    }
    if (type === 'reasoning') {
      cut -= 1
      continue
    }
    break
  }
  // 整段以思考结尾（本轮被中止等）时不成立：没有交付给用户的答复，
  // 交给折叠统一收着，别把「没有答复的消息」搬到折叠外（旧实现同款判据）
  return sawText ? blocks.length - cut : 0
}

/**
 * 本轮终局标记（随 `harness-stream-done` 下发）。
 *
 * 这些事实主进程在收尾时已经全部拿到（见 ipc/harness.ts 的收尾判定），
 * 以前只写进日志，前端拿不到——于是渲染端只能靠 loading 猜。
 */
export interface TurnFinal {
  /** 本次流是否自然跑完（false = 用户停止 / 渲染帧失效中止；错误另有 stream-error 事件） */
  settled: boolean
  /** 本轮是否目标自动续跑轮 */
  goalRound: boolean
  /** 目标轮次号（非目标轮为 undefined） */
  round?: number
  /** 轮次结束时目标是否已完成 */
  goalClosed?: boolean
  /** 是否还会自动续跑下一轮（false = UI 可以确定「这就是最后一轮」） */
  goalWillContinue?: boolean
  /** 最终答复在**主进程累积块**里的起始下标（null = 本轮没有答复） */
  answerFrom: number | null
  /** 最终答复包含的块数（渲染端据此从自己数组末尾往前数；线上口径见 answerTrailingCount） */
  answerBlocks: number
}
