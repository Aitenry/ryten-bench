/**
 * Schedule runner (main-process timer plus an injectable "start a turn" callback).
 *
 * Design tradeoffs:
 * - **Injected execution entry**: what actually starts a turn is `runHarnessTurn` on the IPC side
 *   (it needs the window sender / stream event pipeline), so the runner only "nudges at the right
 *   time"; `drive` is injected by the wiring layer and the runner itself can be verified offline
 *   with a fake drive;
 * - **Single flight**: the same task never runs concurrently; when the topic already has a turn
 *   running, drive returns cancelled and the task is rescheduled for its new time (nothing lost,
 *   no pile-up);
 * - **Skip what was missed**: when several triggers were missed while the app was closed, nothing
 *   is caught up at startup; the next run is computed from "now" (catching up would flood the
 *   screen at once and old reminders are usually meaningless).
 */
import logger from 'electron-log'
import { nextRunAfterRun, selectDueTaskIds } from './schedule-core'
import { scheduleStore, type ScheduleStore } from './schedule-store'
import type { ScheduledTask } from './schedule-types'

/** One trigger request */
export interface ScheduledTurnRequest {
  task: ScheduledTask
  /** Text handed to the model as the user message (including the schedule note) */
  question: string
}

/** Start a turn; cancelled=true means it did not run (e.g. the topic already has a turn running) */
export type ScheduleDriveFn = (
  request: ScheduledTurnRequest
) => Promise<{ cancelled?: boolean } | void>

/** Default delivery text (English; the wiring layer can inject a localized version) */
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
  /** Override the delivery text (for localization) */
  buildQuestion?: (task: ScheduledTask) => string
}

/** Max tasks executed per tick (avoids starting several rounds at once on startup) */
const MAX_TASKS_PER_TICK = 3

export class ScheduleRunner {
  private readonly store: ScheduleStore
  private buildQuestion: (task: ScheduledTask) => string
  private drive: ScheduleDriveFn | null = null
  private timer: NodeJS.Timeout | null = null
  /** Ids of tasks currently executing (single flight) */
  private readonly running = new Set<string>()

  constructor(options: ScheduleRunnerOptions) {
    this.store = options.store
    this.buildQuestion = options.buildQuestion ?? defaultScheduleQuestion
  }

  /** Inject/revoke the "start a turn" implementation (injected by IPC wiring; revoked on teardown) */
  configureDrive(drive?: ScheduleDriveFn): void {
    this.drive = drive ?? null
  }

  /** Inject the delivery text builder (localized version at wiring time; defaults to English) */
  configureQuestionBuilder(builder?: (task: ScheduledTask) => string): void {
    this.buildQuestion = builder ?? defaultScheduleQuestion
  }

  /** Start the periodic check (20s by default; idempotent) */
  start(intervalMs = 20_000): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      // tick isolates failures per task, so this only catches "list tasks / compute schedule"
      // level errors: log them, otherwise a fully stalled scheduler leaves the user with no clue
      // in the settings page or the logs.
      void this.tick().catch((err) => {
        logger.error('[Schedule] Tick failed:', err)
      })
    }, intervalMs)
    // The timer must not keep the process alive by itself (it must not hold up app exit)
    this.timer.unref?.()
  }

  /** Stop the periodic check (called on teardown) */
  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Check and execute due tasks; returns how many were actually executed this round.
   *
   * Safe to call repeatedly (manual trigger / tests); a failure only affects that task, which is
   * recorded as failed while the next run is still scheduled.
   */
  async tick(now = new Date()): Promise<number> {
    const drive = this.drive
    if (!drive) return 0
    const tasks = await this.store.list()
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
      } catch (err) {
        status = 'failed'
        logger.error(`[Schedule] Task #${task.id} (${task.title}) failed:`, err)
      } finally {
        this.running.delete(task.id)
      }

      // Next trigger: a one-off task is disabled after running; others recompute from "now"
      // (missed triggers are not caught up)
      const nextRunAt = nextRunAfterRun(task.when, now)
      try {
        await this.store.markRun(task.id, {
          status,
          ranAt: now.toISOString(),
          nextRunAt,
          enabled: status === 'cancelled' ? true : nextRunAt !== null
        })
      } catch (err) {
        // A recording failure does not undo the turn just executed, but a stale schedule would
        // re-trigger or stop triggering, so it must be logged
        logger.warn(`[Schedule] Failed to record run for task #${task.id}:`, err)
      }
      executed += 1
    }
    return executed
  }
}

/** Process-level singleton: started/stopped by system wiring; IPC injects drive and localized texts */
export const scheduleRunner = new ScheduleRunner({ store: scheduleStore })
