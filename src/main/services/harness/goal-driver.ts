import logger from 'electron-log'
import { goalStore, MIN_ROUNDS_FOR_BLOCK } from '../../runtime/harness/goal'
import type { TurnMeta } from './types'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'

/**
 * 目标轮次驱动器（goal-round-driver）— 对应 deepseek-harness 的 dsh-goal-round-driver
 *
 * 机制（适配 RytenBench 无事件总线的结构）：
 * - 用户轮次完成后调用 maybeDrive：目标 active + armed（内存武装态）且未达轮次上限时，
 *   自动发起下一轮（注入 <goal_round> 消息 + 目标来源元信息）；
 * - 轮次计数：roundsStarted 表示「已开始的自动续跑轮数」，创建目标的用户轮不计入
 *   （goal.ts create 时 roundsStarted=0），自动轮在派发时结算（roundsStarted + 1，
 *   首次续跑即第 1 轮），保证轮内 update_goal(complete/blocked) 的
 *   「精确命中当前目标轮」校验能匹配，也让注入提示词的 "round N/M"、
 *   消息徽标「第 N 轮」与目标栏计数三处一致；
 * - 每话题互斥：同一时间一个话题至多一个自动轮在跑（用户消息被 UI 层串行化，实际不重叠）；
 * - 用户取消自动轮 → 目标 disarm（停止自动续跑，等用户要求「继续」→ resume 重新武装）；
 * - 达轮次上限 → blocked(round-limit) 并停止。
 */

/** 执行一轮对话的回调（由 IPC 层注入，复用 runHarnessTurn 管线） */
export type DriveTurnFn = (params: {
  topicId: number
  question: string
  turnMeta: TurnMeta
}) => Promise<{ topicId: number; cancelled: boolean }>

export class GoalRoundDriver {
  private readonly running = new Set<number>()

  isRunning(topicId: number): boolean {
    return this.running.has(topicId)
  }

  /** 轮次结束后调度：满足条件则自动发起下一轮（循环派发直至停止条件） */
  async maybeDrive(topicId: number, drive: DriveTurnFn): Promise<void> {
    if (this.running.has(topicId)) return
    // 先占位再 await（修复：此前占用点位于多个 await 之后，「守卫通过」与「占用」之间
    // 存在竞态窗口，两个并发完成点可重复 incrementRound 并双派发自动轮）
    this.running.add(topicId)
    try {
      while (await this.driveOnce(topicId, drive)) {
        // 一轮完成且未达停止条件：继续派发下一轮
      }
    } finally {
      this.running.delete(topicId)
    }
  }

  /** 检查并派发一轮；返回 true 表示本轮已派发完成且应继续检查下一轮 */
  private async driveOnce(topicId: number, drive: DriveTurnFn): Promise<boolean> {
    const goal = await goalStore.load(topicId)
    if (!goal || goal.phase !== 'active' || !goalStore.isArmed(topicId)) {
      if (goal && goal.phase === 'active' && !goalStore.isArmed(topicId)) {
        logger.info(`[GoalDriver] topicId=${topicId} 目标 active 但未武装，不自动续跑`)
      }
      return false
    }

    // 达轮次上限：标记 blocked(round-limit) 并停止
    if (goal.roundsStarted >= goal.maxGoalRounds) {
      try {
        await goalStore.update(topicId, goal.id, goal.revision, 'blocked', {
          blockedReason: {
            code: 'round-limit',
            message: mainFormat(getAgentToolTexts().goalDriver.roundLimitReached, {
              rounds: goal.maxGoalRounds
            })
          }
        })
      } catch (err) {
        logger.warn('[GoalDriver] 标记 round-limit 失败:', err)
      }
      return false
    }

    // 派发时结算：roundsStarted + 1（round = 结算后的轮次号）
    const updated = await goalStore.incrementRound(topicId)
    if (!updated || updated.phase !== 'active') return false

    const round = updated.roundsStarted
    const question = `<goal_round>
Objective: ${updated.objective}
(Automatic continuation round ${round}/${updated.maxGoalRounds}. Keep pushing the objective forward — do not ask the user for confirmation.)
- If the objective is fully achieved: call update_goal(action: "complete").
- If you hit a blocker you cannot resolve on your own and at least ${MIN_ROUNDS_FOR_BLOCK} rounds have passed: call update_goal(action: "blocked", blocked_reason: { code, message }).
- Otherwise just keep working. When you finish, give a short summary of what this round accomplished.
</goal_round>`
    const turnMeta: TurnMeta = {
      source: 'goal-round',
      goalId: updated.id,
      goalRevision: updated.revision,
      goalRound: round,
      objective: updated.objective
    }

    logger.info(
      `[GoalDriver] 派发自动轮 topicId=${topicId} round=${round}/${updated.maxGoalRounds} goalId=${updated.id}`
    )
    try {
      const result = await drive({ topicId, question, turnMeta })
      if (result.cancelled) {
        // 用户取消自动轮：停止自动续跑（armed → disarmed），目标保持 active
        logger.info('[GoalDriver] 自动轮被用户取消，目标 disarm')
        goalStore.disarm(topicId)
        return false
      }
    } catch (err) {
      logger.warn('[GoalDriver] 自动轮执行失败，目标 disarm:', err)
      goalStore.disarm(topicId)
      return false
    }

    return true
  }
}

/** 进程级单例 */
export const goalRoundDriver = new GoalRoundDriver()
