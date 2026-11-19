import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import logger from 'electron-log'
import { getGoalByTopic, upsertGoal, deleteGoalByTopic, type GoalRow } from '../db/mapper/goal'
import { mainFormat } from '../../../../main/i18n'
import { getAgentToolTexts } from '../../../../main/i18n/tool-results-agent'

/**
 * 对话目标系统（goal）— 对应 deepseek-harness 的 dsh-goal / dsh-tool-goal 体系
 *
 * 机制（参考 DSH，适配 RytenBench 按 topicId 组织的对话）：
 * - 每个话题至多一个当前目标（单目标语义）；revision 每次变更 +1，工具更新
 *   必须携带 {goal_id, revision}（CAS 乐观并发，过期即拒 GOAL_STALE_REVISION）；
 * - 状态机：active ⇄ paused / → blocked / → complete；blocked 仅可从 active 进入；
 * - activation（armed/disarmed）为内存态：armed 才允许轮次驱动器自动续跑；
 *   进程重启一律 disarmed（激活态不持久化），用户要求「继续」→ resume 重新武装；
 * - authority 执行期校验：create/edit/pause/resume 须「人类直接请求」（本轮为用户
 *   消息发起）；complete/blocked 接受「人类直接请求」或「精确命中当前目标轮」
 *   （自动续跑轮注入的 goal 来源）；自主轮 blocked 另须 roundsStarted ≥ 3
 *   （即至少完成 3 次自动续跑，与注入提示词里 "at least 3 rounds have passed" 对齐）。
 */

/** 目标视图（工具输出与前端展示共用） */
export interface GoalView {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  roundsStarted: number
  maxGoalRounds: number
  blockedReason?: { code: string; message: string }
  /** 内存态：armed=自动续跑已武装 / disarmed=停止自动续跑 */
  activation: 'armed' | 'disarmed'
}

/** 阻塞原因（DSH 使用稳定小写 kebab code 分类） */
export interface GoalBlockedReason {
  code: string
  message: string
}

/** 更新动作（与 DSH update_goal 一致） */
export type GoalUpdateAction = 'edit' | 'pause' | 'resume' | 'complete' | 'blocked'

/**
 * 自主轮（模型自报）允许 blocked 的最小已进行轮数（DSH 默认阈值）。
 * 以「自动续跑轮」计数：轮次在派发时结算，故达到该值时正处于第 3 次自动续跑轮内
 * （与注入提示词 "at least 3 rounds have passed" 同义）。
 */
export const MIN_ROUNDS_FOR_BLOCK = 3
/** 默认轮次上限（DSH goal 默认值） */
export const DEFAULT_MAX_GOAL_ROUNDS = 256

/** 本轮来源（经 graph configurable.turnSource 注入） */
export type TurnSource = 'user' | 'goal-round'

/** 目标轮来源信息（自动续跑轮由驱动器注入，用于 complete/blocked 的轮级权威校验） */
export interface GoalRoundSource {
  goalId: string
  revision: number
  round: number
}

/** 目标工具调用的 configurable 快照 */
interface GoalToolConfig {
  turnSource?: TurnSource
  goalRound?: GoalRoundSource
}

export type GoalUpdateListener = (topicId: number, goal: GoalView | null) => void

/** 目标存储（进程级单例，按 topicId 隔离；PGlite 持久化 + 内存 armed 态） */
export class GoalStore {
  private readonly cache = new Map<number, GoalView>()
  private readonly armedTopics = new Set<number>()

  /** 变更回调（主进程注入，广播 harness-goal-updated） */
  onChange?: GoalUpdateListener

  private static fromRow(row: GoalRow): GoalView {
    let blockedReason: GoalView['blockedReason']
    if (row.blocked_reason) {
      try {
        blockedReason = JSON.parse(row.blocked_reason) as GoalBlockedReason
      } catch {
        blockedReason = { code: 'unknown', message: row.blocked_reason }
      }
    }
    return {
      id: row.goal_id,
      revision: row.revision,
      objective: row.objective,
      phase: row.phase,
      roundsStarted: row.rounds_started,
      maxGoalRounds: row.max_goal_rounds,
      blockedReason,
      activation: 'disarmed'
    }
  }

  /** 读取话题当前目标（DB → 缓存）；armed 态按内存 Set 叠加 */
  async load(topicId: number): Promise<GoalView | null> {
    const cached = this.cache.get(topicId)
    if (cached) {
      return { ...cached, activation: this.armedTopics.has(topicId) ? 'armed' : 'disarmed' }
    }
    try {
      const row = await getGoalByTopic(topicId)
      if (!row) return null
      const view = GoalStore.fromRow(row)
      this.cache.set(topicId, view)
      return { ...view, activation: 'disarmed' }
    } catch (err) {
      logger.error('[Goal] 读取目标失败:', err)
      return null
    }
  }

  /**
   * 本轮结束后，驱动器还会不会自动派发下一轮？（轮次收尾类兜底的判定依据）
   *
   * 与 GoalRoundDriver.driveOnce 的派发门槛逐条对齐——那里的三道门是「phase === 'active'」
   * 「isArmed」「roundsStarted < maxGoalRounds（否则标 blocked 并停止）」，等价于这里的三行。
   * 刻意收在 store 里而不是散在调用点：目标一停，清单的「进行中」就再没人去收（用户
   * 2026-09-23 报的「任务都完成了还显示最后一项没完成」就是这么来的），这个判定写错的代价
   * 是前端永远转圈，所以只能有一处。工装 test/verify-todo-closeout.mjs 直接跑这个方法。
   */
  async willContinue(topicId: number): Promise<boolean> {
    const goal = await this.load(topicId)
    if (goal?.phase !== 'active' || !this.isArmed(topicId)) return false
    return goal.roundsStarted < goal.maxGoalRounds
  }

  /** 持久化并刷新缓存、广播变更 */
  private async persist(topicId: number, view: GoalView): Promise<GoalView> {
    await upsertGoal({
      topic_id: topicId,
      goal_id: view.id,
      revision: view.revision,
      objective: view.objective,
      phase: view.phase,
      rounds_started: view.roundsStarted,
      max_goal_rounds: view.maxGoalRounds,
      blocked_reason: view.blockedReason ? JSON.stringify(view.blockedReason) : null
    })
    this.cache.set(topicId, view)
    logger.info(
      `[Goal] 目标已持久化 topicId=${topicId} id=${view.id} phase=${view.phase} round=${view.roundsStarted}/${view.maxGoalRounds} revision=${view.revision}`
    )
    this.onChange?.(topicId, { ...view, activation: this.isArmed(topicId) ? 'armed' : 'disarmed' })
    return view
  }

  /** CAS 校验：目标 id + revision 必须与当前一致 */
  private assertCurrent(goalId: string, revision: number, view: GoalView | null): GoalView {
    const m = getAgentToolTexts()
    if (!view) throw new Error(m.goal.noGoal)
    if (view.id !== goalId || view.revision !== revision) {
      throw new Error(
        mainFormat(m.goal.staleRevision, {
          marker: 'GOAL_STALE_REVISION',
          current: view.revision,
          provided: revision
        })
      )
    }
    return view
  }

  /**
   * 创建目标：仅「无目标」或「已有目标已完成」时可创建（DSH create 语义）。
   * 成功后武装自动续跑（armed）。
   *
   * roundsStarted 从 **0** 起算：它表示「已开始的自动续跑轮数」，创建目标的那个用户轮**不算**一轮。
   * （此前从 1 起算，导致第一次自动续跑被标成「第 2 轮」——消息徽标写第 2 轮、目标栏显示 2/40，
   * 而实际只续跑了 1 次；给模型的提示词也写着 "Automatic continuation round 2/40"。
   * 计数与「自动轮」语义对齐后，三处数字一致：第 1 次续跑 = 第 1 轮。）
   */
  async create(
    topicId: number,
    objective: string,
    maxGoalRounds = DEFAULT_MAX_GOAL_ROUNDS
  ): Promise<GoalView> {
    const current = await this.load(topicId)
    if (current && current.phase !== 'complete') {
      throw new Error(
        mainFormat(getAgentToolTexts().goal.alreadyInProgress, { phase: current.phase })
      )
    }
    const view: GoalView = {
      id: `goal-${randomUUID()}`,
      revision: 1,
      objective: objective.trim(),
      phase: 'active',
      roundsStarted: 0,
      maxGoalRounds,
      activation: 'armed'
    }
    const persisted = await this.persist(topicId, view)
    // 持久化成功后再武装（修复：先改内存态后落库,落库失败会留下 armed 但无目标的假状态）
    this.armedTopics.add(topicId)
    logger.info(
      `[Goal] 目标已创建 topicId=${topicId} id=${view.id}（maxGoalRounds=${maxGoalRounds}，自动续跑轮从第 1 轮起算）`
    )
    return persisted
  }

  /** 更新目标（CAS + 状态机转移；authority 由调用方（工具层）先行校验） */
  async update(
    topicId: number,
    goalId: string,
    revision: number,
    action: GoalUpdateAction,
    fields?: {
      objective?: string
      maxGoalRounds?: number
      blockedReason?: GoalBlockedReason
    }
  ): Promise<GoalView> {
    const current = await this.load(topicId)
    // 浅拷贝后再修改（修复：此前直接改 load 返回的缓存对象——persist 失败时缓存已携带
    // 未落库的假状态，后续 load/CAS 读到脏数据）
    const base = this.assertCurrent(goalId, revision, current)
    const view: GoalView = { ...base }
    const m = getAgentToolTexts()
    let armChange: 'add' | 'delete' | null = null

    switch (action) {
      case 'edit': {
        if (fields?.objective != null) view.objective = fields.objective.trim()
        if (fields?.maxGoalRounds != null && fields.maxGoalRounds > 0) {
          view.maxGoalRounds = fields.maxGoalRounds
        }
        break
      }
      case 'pause': {
        if (view.phase !== 'active') {
          throw new Error(mainFormat(m.goal.cannotPause, { phase: view.phase }))
        }
        view.phase = 'paused'
        armChange = 'delete'
        break
      }
      case 'resume': {
        if (view.phase === 'complete') throw new Error(m.goal.cannotResumeComplete)
        if (view.roundsStarted >= view.maxGoalRounds) {
          throw new Error(mainFormat(m.goal.cannotResumeRoundLimit, { limit: view.maxGoalRounds }))
        }
        view.phase = 'active'
        view.blockedReason = undefined
        armChange = 'add'
        break
      }
      case 'complete': {
        if (view.phase === 'complete') throw new Error(m.goal.alreadyComplete)
        view.phase = 'complete'
        armChange = 'delete'
        break
      }
      case 'blocked': {
        if (view.phase !== 'active') {
          throw new Error(mainFormat(m.goal.cannotBlock, { phase: view.phase }))
        }
        view.phase = 'blocked'
        view.blockedReason = fields?.blockedReason ?? {
          code: 'unspecified',
          message: m.goal.defaultBlockedReason
        }
        armChange = 'delete'
        break
      }
      default:
        throw new Error(mainFormat(m.goal.unknownAction, { action }))
    }

    view.revision += 1
    const persisted = await this.persist(topicId, view)
    // 落库成功后再应用武装态变更（修复：先改内存态后落库，失败时状态分歧）
    if (armChange === 'add') {
      this.armedTopics.add(topicId)
    } else if (armChange === 'delete') {
      this.armedTopics.delete(topicId)
    }
    return persisted
  }

  /** 自动续跑轮次结算：roundsStarted + 1（驱动器在轮次完成后调用） */
  async incrementRound(topicId: number): Promise<GoalView | null> {
    const current = await this.load(topicId)
    if (!current || current.phase !== 'active') return current
    // 拷贝后修改（修复：直接改缓存对象，persist 失败留下未落库的假状态）
    return this.persist(topicId, {
      ...current,
      roundsStarted: current.roundsStarted + 1,
      revision: current.revision + 1
    })
  }

  /** 话题删除时清理目标（DB + 缓存 + 武装态） */
  async delete(topicId: number): Promise<void> {
    this.cache.delete(topicId)
    this.armedTopics.delete(topicId)
    try {
      await deleteGoalByTopic(topicId)
    } catch (err) {
      logger.error('[Goal] 删除目标失败:', err)
    }
  }

  isArmed(topicId: number): boolean {
    return this.armedTopics.has(topicId)
  }

  arm(topicId: number): void {
    this.armedTopics.add(topicId)
  }

  disarm(topicId: number): void {
    this.armedTopics.delete(topicId)
  }
}

/** 进程级单例：跨请求共享（与 todoStore 同一模式） */
export const goalStore = new GoalStore()

/** 从工具 config 提取本轮来源信息 */
function readToolConfig(config?: Record<string, unknown>): GoalToolConfig {
  const c = (config ?? {}) as unknown as GoalToolConfig
  return { turnSource: c.turnSource, goalRound: c.goalRound }
}

/** 是否「人类直接请求」：本轮由用户消息发起（自动续跑轮为 goal-round 来源） */
function isDirectHuman(cfg: GoalToolConfig): boolean {
  return cfg.turnSource !== 'goal-round'
}

/** 是否精确命中当前目标轮（自动续跑轮携带的 goal 来源与当前目标全等） */
function isExactGoalRound(cfg: GoalToolConfig, goal: GoalView): boolean {
  if (cfg.turnSource !== 'goal-round' || !cfg.goalRound) return false
  return (
    cfg.goalRound.goalId === goal.id &&
    cfg.goalRound.revision === goal.revision &&
    cfg.goalRound.round === goal.roundsStarted
  )
}

/** 目标视图 → 工具返回文本（JSON 序列化，模型与前端共用） */
function formatGoal(view: GoalView | null): string {
  if (!view) return JSON.stringify({ goal: null })
  return JSON.stringify({ goal: view })
}

/**
 * 构建目标工具集（仅注入主代理；子代理不持有目标工具）。
 * authority 校验在工具执行期完成（参考 dsh-tool-goal）。
 */
export function buildGoalTools(store: GoalStore, topicId: number): StructuredToolInterface[] {
  const getCurrent = (): Promise<GoalView | null> => store.load(topicId)

  return [
    tool(
      async ({ objective, max_goal_rounds }, config) => {
        const m = getAgentToolTexts()
        const cfg = readToolConfig((config?.configurable ?? {}) as Record<string, unknown>)
        if (!isDirectHuman(cfg)) {
          return m.goal.createRequiresHumanRequest
        }
        try {
          const view = await store.create(topicId, objective, max_goal_rounds)
          return formatGoal(view)
        } catch (err) {
          return mainFormat(m.goal.createFailed, { message: (err as Error).message })
        }
      },
      {
        name: 'create_goal',
        description:
          'Create a long-running goal that advances automatically across turns: each round auto-continues until the goal is completed, blocked, or the round limit is reached. Only one goal may be in progress at a time; an existing goal must first be complete or blocked before a new one can be created. Use only when the user expresses a clear long-horizon intent; do not create a goal for simple Q&A.',
        schema: z.object({
          objective: z
            .string()
            .describe(
              'Concrete objective to achieve: an outcome that can be verified independently'
            ),
          max_goal_rounds: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(`Round limit for auto-continuation (default ${DEFAULT_MAX_GOAL_ROUNDS})`)
        })
      }
    ),
    tool(
      async () => {
        try {
          const view = await getCurrent()
          return formatGoal(view)
        } catch (err) {
          return mainFormat(getAgentToolTexts().goal.readFailed, {
            message: (err as Error).message
          })
        }
      },
      {
        name: 'get_goal',
        description:
          'Read the current goal state for this topic (id/revision/phase/rounds and so on).',
        schema: z.object({})
      }
    ),
    tool(
      async ({ goal_id, revision, action, objective, max_goal_rounds, blocked_reason }, config) => {
        const m = getAgentToolTexts()
        const cfg = readToolConfig((config?.configurable ?? {}) as Record<string, unknown>)
        try {
          const current = await getCurrent()
          if (!current) return m.goal.noGoal

          // authority：edit/pause/resume 仅限人类直接请求；
          // complete/blocked 允许人类直接请求或精确命中当前目标轮（自动续跑轮）
          const direct = isDirectHuman(cfg)
          const exactRound = isExactGoalRound(cfg, current)
          if (action === 'edit' || action === 'pause' || action === 'resume') {
            if (!direct) {
              return mainFormat(m.goal.requiresHumanRequest, { action })
            }
          } else if (action === 'complete' || action === 'blocked') {
            if (!direct && !exactRound) {
              return mainFormat(m.goal.notAuthorized, { action })
            }
            if (action === 'blocked' && !direct && current.roundsStarted < MIN_ROUNDS_FOR_BLOCK) {
              return mainFormat(m.goal.blockedMinRounds, {
                minRounds: MIN_ROUNDS_FOR_BLOCK,
                rounds: current.roundsStarted
              })
            }
          }

          const view = await store.update(topicId, goal_id, revision, action, {
            objective,
            maxGoalRounds: max_goal_rounds,
            blockedReason: blocked_reason
              ? { code: blocked_reason.code, message: blocked_reason.message }
              : undefined
          })

          // 自主轮 complete/blocked：注入收尾指引（参考 DSH wrapup 指令，不硬截断）
          if (!direct && exactRound && (action === 'complete' || action === 'blocked')) {
            const wrapup =
              action === 'complete'
                ? m.goal.wrapupComplete
                : mainFormat(m.goal.wrapupBlocked, {
                    code: view.blockedReason?.code ?? 'unspecified'
                  })
            return `${formatGoal(view)}\n\n${wrapup}`
          }
          return formatGoal(view)
        } catch (err) {
          return mainFormat(m.goal.updateFailed, { message: (err as Error).message })
        }
      },
      {
        name: 'update_goal',
        description:
          'Update the current goal. Actions: edit (change the objective or the round limit), pause (stop auto-continuation), resume (restore and resume auto-continuation), complete (mark as completed), blocked (mark as blocked; a reason is required). Always pass goal_id and the latest revision (call get_goal first). edit/pause/resume require a direct human request; complete/blocked may be called from an auto-continuation round (blocked then requires at least 3 rounds already started).',
        schema: z.object({
          goal_id: z.string().describe('Goal ID (from create_goal / get_goal)'),
          revision: z
            .number()
            .int()
            .positive()
            .describe('Current revision (a stale revision is rejected; call get_goal first)'),
          action: z
            .enum(['edit', 'pause', 'resume', 'complete', 'blocked'])
            .describe('Action to perform'),
          objective: z.string().optional().describe('(edit) New objective'),
          max_goal_rounds: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('(edit) New round limit'),
          blocked_reason: z
            .object({
              code: z
                .string()
                .describe(
                  'Stable lowercase kebab-case category, e.g. round-limit / model-reported / user-paused'
                ),
              message: z.string().describe('Explanation of the blocking condition')
            })
            .optional()
            .describe('(blocked) Reason the goal is blocked')
        })
      }
    )
  ]
}
