/**
 * 定时任务执行器（主进程定时器 + 可注入的「起一轮」回调）。
 *
 * 设计取舍：
 * - **执行入口注入**：真正起一轮对话的是 IPC 侧的 `runHarnessTurn`（它需要窗口 sender /
 *   流事件管线），runner 只负责「到点了叫一下」，因此 `drive` 由装配层注入，runner 本身
 *   可以在离线测试里用假 drive 验证调度逻辑；
 * - **单飞**：同一任务不会并发执行；同一话题已有回合在跑时，drive 返回 cancelled，
 *   任务按新时间重新排期（不丢、不堆积）；
 * - **错过即跳过**：应用关着错过多次触发时，不在启动瞬间补跑，下一次从「现在」重新计算
 *   （与 DSH 的 scheduler 行为一致：补跑会瞬间刷屏，且旧提醒往往已无意义）。
 */
import { nextRunAfterRun, selectDueTaskIds } from './schedule-core'
import { scheduleStore, type ScheduledTask, type ScheduleStore } from './schedule-store'

/** 一次触发请求 */
export interface ScheduledTurnRequest {
  task: ScheduledTask
  /** 交给模型作为用户消息的文本（含调度说明） */
  question: string
}

/** 起一轮对话；返回 cancelled=true 表示本轮没跑（例如该话题已有回合在跑） */
export type ScheduleDriveFn = (
  request: ScheduledTurnRequest
) => Promise<{ cancelled?: boolean } | void>

/** 默认的投递文案（英文；装配层可注入本地化版本） */
export function defaultScheduleQuestion(task: ScheduledTask): string {
  return [
    `[Scheduled task: ${task.title}]`,
    task.prompt,
    '',
    '(This message was delivered automatically by a schedule the user created. Work on it now; do not ask the user for confirmation.)'
  ].join('\n')
}

export interface ScheduleRunnerOptions {
  store: ScheduleStore
  /** 覆盖投递文案（本地化用） */
  buildQuestion?: (task: ScheduledTask) => string
}

/** 一次 tick 最多执行的任务数（避免启动瞬间连开多轮） */
const MAX_TASKS_PER_TICK = 3

export class ScheduleRunner {
  private readonly store: ScheduleStore
  private buildQuestion: (task: ScheduledTask) => string
  private drive: ScheduleDriveFn | null = null
  private timer: NodeJS.Timeout | null = null
  /** 正在执行的任务 id（单飞） */
  private readonly running = new Set<string>()

  constructor(options: ScheduleRunnerOptions) {
    this.store = options.store
    this.buildQuestion = options.buildQuestion ?? defaultScheduleQuestion
  }

  /** 注入/撤销「起一轮」的实现（IPC 装配时注入；停用时撤销） */
  configureDrive(drive?: ScheduleDriveFn): void {
    this.drive = drive ?? null
  }

  /** 注入投递文案构造器（装配时传本地化版本；不传则用默认英文） */
  configureQuestionBuilder(builder?: (task: ScheduledTask) => string): void {
    this.buildQuestion = builder ?? defaultScheduleQuestion
  }

  /** 启动周期检查（默认 20 秒；重复调用幂等） */
  start(intervalMs = 20_000): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined)
    }, intervalMs)
    // 定时器不单独维持进程存活（应用退出时不能被它拖住）
    this.timer.unref?.()
  }

  /** 停止周期检查（装配卸载时调用） */
  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 检查并执行到期任务，返回本轮实际执行的任务数。
   *
   * 可重复调用（手动触发 / 测试）；执行失败只影响该任务，记 failed 并照常排下一次。
   */
  async tick(now = new Date()): Promise<number> {
    const drive = this.drive
    if (!drive) return 0
    const tasks = this.store.list()
    const dueIds = selectDueTaskIds(tasks, now, {
      running: this.running,
      limit: MAX_TASKS_PER_TICK
    })
    const byId = new Map(tasks.map((task) => [task.id, task]))
    const due = dueIds
      .map((id) => byId.get(id))
      .filter((task): task is ScheduledTask => task !== undefined)

    let executed = 0
    for (const task of due) {
      this.running.add(task.id)
      let status: 'completed' | 'cancelled' | 'failed' = 'completed'
      try {
        const result = await drive({ task, question: this.buildQuestion(task) })
        if (result && result.cancelled) status = 'cancelled'
      } catch {
        status = 'failed'
      } finally {
        this.running.delete(task.id)
      }

      // 下一次触发：一次性任务执行完即停用；其余从「现在」重新计算（错过的不补跑）
      const nextRunAt = nextRunAfterRun(task.when, now)
      try {
        this.store.markRun(task.id, {
          status,
          ranAt: now.toISOString(),
          nextRunAt,
          enabled: status === 'cancelled' ? true : nextRunAt !== null
        })
      } catch {
        // 记录失败不影响本轮已执行的对话
      }
      executed += 1
    }
    return executed
  }
}

/** 进程级单例：系统装配时 start/stop，IPC 层注入 drive 与本地化文案 */
export const scheduleRunner = new ScheduleRunner({ store: scheduleStore })
