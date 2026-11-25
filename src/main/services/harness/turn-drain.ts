import type { QueuedMessage } from './queue-store'

/**
 * 排队消息的接续循环（纯逻辑，便于在 `tests/` 里直接跑断言）。
 *
 * 语义（对应产品口径「生成中发的消息，等这一轮跑完自动继续」）：
 *  - 严格 FIFO：一轮结束 → 取队首 → 作为新一轮发出 → 这一轮结束 → 再取队首……
 *    旧的实现只接一条就收工（接续轮自己的收尾不会再触发接续），队列里第二条起永远发不出去；
 *  - 不抢跑：话题上还有回合在跑、或目标自动续跑正在跑，都不接续（交给收尾的那一方）；
 *  - 用户中止：那一轮之后的排队消息保留在队列里，不自动续（避免「停止后又自己跑起来」）；
 *  - 起轮失败：记一次错误就停，不无限重试（队列内容仍在，用户看得到也能删）。
 *
 * 循环上限只是防御（正常会被队列长度或上面四条终止条件结束）。
 */

/** 接续循环依赖（真实实现在 ipc/harness/harness.ts，测试里用假实现） */
export interface DrainTurnDeps {
  /** 话题上是否已有回合在跑 */
  isTurnActive: () => boolean
  /** 目标自动续跑是否在跑 */
  isGoalRunning: () => boolean
  /** 是否还有排队消息 */
  hasPending: () => boolean
  /** 取出队首一条（取出即消费） */
  shift: () => QueuedMessage | null
  /** 把它当作新一轮发出，并等这一轮结束（cancelled=true 表示用户中止） */
  runTurn: (item: QueuedMessage) => Promise<{ cancelled: boolean } | null>
  /** 即将接续某一条（写日志用） */
  onContinue?: (item: QueuedMessage, index: number) => void
  /** 起轮抛错（记日志并停止接续） */
  onError?: (error: unknown, item: QueuedMessage) => void
  /** 防御性上限（默认 50 轮） */
  maxTurns?: number
}

/**
 * 逐条接续排队消息，返回真正起过的轮数。
 *
 * 注意：调用方要保证「上一轮已经收尾」（回合登记已清），否则循环第一次检查就会退出。
 */
export async function drainPendingTurns(deps: DrainTurnDeps): Promise<number> {
  const maxTurns = deps.maxTurns ?? 50
  let drained = 0

  while (drained < maxTurns) {
    if (deps.isTurnActive()) break
    if (deps.isGoalRunning()) break
    if (!deps.hasPending()) break
    const item = deps.shift()
    if (!item) break

    deps.onContinue?.(item, drained)
    let outcome: { cancelled: boolean } | null
    try {
      outcome = await deps.runTurn(item)
    } catch (error) {
      deps.onError?.(error, item)
      break
    }
    // 用户中止了这一轮：剩余的排队消息留在队列里，等用户下一次发送再决定
    if (!outcome || outcome.cancelled) break
    drained += 1
  }

  return drained
}
