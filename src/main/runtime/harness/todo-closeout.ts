import type { TodoItem, TodoStore } from './todo'

/**
 * 对话计划清单（write_todos）的收尾收敛 —— 「本轮结束后不再有『进行中』」的兜底。
 *
 * 为什么需要它：清单是模型自己写的，而收尾书写并不可靠。2026-09-18 实例：六项工作全部
 * 做完、回答也交付了，最后一次 write_todos 仍留一项 in_progress，卡片于是永远停在
 * 「5/6 已完成 · 1 进行中」；目标自动续跑下更明显——末轮把目标标成完成，清单里那一项
 * 却再没有人去收（用户 2026-09-23：「明明任务已经完成了，页面还是显示有最后一个任务没完成」）。
 *
 * 判断依据只有一条：**本轮结束后还会不会有下一轮去接手这份清单**。
 *   - 会（目标 active + armed，驱动器马上派发下一轮）→ 不动，清单交给模型继续维护；
 *   - 不会（用户轮结束、目标完成/阻塞/被 disarm、以及被停止或报错后留下的那轮）→ 就地收尾。
 *
 * 「本轮被停止 / 流失败」同样收尾：那时什么都没在跑，留着转圈的「进行中」是假状态，
 * 应用重开后前端还会从 store 里把它读回来。收尾只动这一个进程内缓存（不落库），
 * 模型的计划能力不受影响（下一次 write_todos 本来就是整份覆盖）。
 */

/** 判断收尾所需的外部事实（全部由调用方注入：本模块不碰 DB / 目标存储 / 提问服务） */
export interface CloseOutSources {
  /** 本轮是否被目标自动续跑驱动器接管（source === 'goal-round'） */
  isGoalRound: boolean
  /** 该话题的目标是否还会自动续跑下一轮（active + 已武装，且未达轮次上限） */
  goalWillContinue: () => Promise<boolean>
  /** 该话题是否正挂着待回答的提问（模型在等用户，任务确实还在中途） */
  hasPendingQuestion: () => boolean
}

/** 收尾决策结果：收不收、以及不收的原因（原因进日志，便于排查「为什么卡片没收」） */
export type CloseOutDecision =
  { close: true } | { close: false; reason: 'pending-question' | 'goal-continues' }

/**
 * 收尾决策（纯逻辑 + 两个异步查询，无副作用；工装 test/verify-todo-closeout.mjs 直接跑真代码）。
 *
 * 提问优先判定：模型挂着提问时，无论第几轮都不收尾——它正在等用户回答，任务确实没干完。
 */
export async function decideCloseOutOnTurnEnd(sources: CloseOutSources): Promise<CloseOutDecision> {
  if (sources.hasPendingQuestion()) return { close: false, reason: 'pending-question' }
  if (sources.isGoalRound && (await sources.goalWillContinue())) {
    return { close: false, reason: 'goal-continues' }
  }
  return { close: true }
}

/** 收尾结果：收敛后的完成计数（未写入时返回 null） */
export interface CloseOutResult {
  /** 本次被结掉的「进行中」项数 */
  closed: number
  /** 收敛后清单里已完成项数 */
  completed: number
  /** 清单总项数 */
  total: number
}

/**
 * 把仍停在 in_progress 的项结为 completed（没有进行中项时返回 null，不产生多余的广播）。
 *
 * 写入走 store.set，因此照常触发 onChange → harness-todos-updated 广播，
 * 前端输入框上方的任务卡片随之从「1 进行中」变为「全部完成」。
 */
export function closeOutInProgress(store: TodoStore, topicId: number): CloseOutResult | null {
  const todos = store.get(topicId)
  const running = todos.filter((t) => t.status === 'in_progress')
  if (running.length === 0) return null
  const closed: TodoItem[] = todos.map((t) =>
    t.status === 'in_progress' ? { ...t, status: 'completed' as const, activeForm: undefined } : t
  )
  store.set(topicId, closed)
  return {
    closed: running.length,
    completed: closed.filter((t) => t.status === 'completed').length,
    total: closed.length
  }
}
