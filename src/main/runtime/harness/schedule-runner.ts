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
import type {
  ScheduledTask,
  ScheduleRunArtifact,
  ScheduleRunRecord,
  ScheduleRunStatus,
  ScheduleRunStep,
  ScheduleRunUsage
} from './schedule-types'

/** One trigger request */
export interface ScheduledTurnRequest {
  task: ScheduledTask
  /** Text handed to the model as the user message (including the schedule note) */
  question: string
}

/**
 * Result of one triggered turn.
 *
 * `cancelled` is the only field the scheduler itself acts on; everything else is **run detail**
 * stored with the run record so the UI can show "what actually happened" (which conversation, which
 * reply, how many tokens, which files). All optional: an older wiring layer returns nothing.
 */
export interface ScheduledTurnResult {
  cancelled?: boolean
  /** Failure reason / short summary stored on the run record */
  detail?: string
  /** Conversation the run executed in (new-session tasks create one per run) */
  topicId?: number | null
  /** Assistant dialogue row produced by the run */
  dialogueId?: number | null
  usage?: ScheduleRunUsage | null
  steps?: ScheduleRunStep[] | null
  artifacts?: ScheduleRunArtifact[] | null
}

/** Start a turn; cancelled=true means it did not run (e.g. the topic already has a turn running) */
export type ScheduleDriveFn = (request: ScheduledTurnRequest) => Promise<ScheduledTurnResult | void>

/** Result of manually re-running one existing record */
export type ScheduleRerunResult =
  | { ok: true; run: ScheduleRunRecord }
  | {
      ok: false
      error:
        | 'unavailable'
        | 'busy'
        | 'not-found'
        | 'run-not-found'
        | 'target-missing'
        | 'not-executed'
        | 'record-failed'
    }

/** Default delivery text (English; the wiring layer can inject a localized version) */
export function defaultScheduleQuestion(task: ScheduledTask): string {
  // No "delivered automatically / do not ask" suffix: the task prompt is the whole instruction.
  return [`[Scheduled task: ${task.title}]`, task.prompt].join('\n')
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
      /** Run detail reported by the wiring layer (empty for older wiring / early failures) */
      let run: ScheduledTurnResult = {}
      try {
        const result = await drive({ task, question: this.buildQuestion(task) })
        if (result) {
          run = result
          if (result.cancelled) status = 'cancelled'
        }
      } catch (err) {
        status = 'failed'
        run = { detail: err instanceof Error ? err.message : String(err) }
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
          enabled: status === 'cancelled' ? true : nextRunAt !== null,
          detail: run.detail ?? null,
          topicId: run.topicId ?? null,
          dialogueId: run.dialogueId ?? null,
          usage: run.usage ?? null,
          steps: run.steps ?? null,
          artifacts: run.artifacts ?? null
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

  /**
   * Re-run one existing record and **overwrite it in place** (same row id and `ran_at`, so the
   * history does not grow and the record keeps its position).
   *
   * The task's schedule is deliberately untouched: a manual re-run is not a new occurrence, so
   * `next_run_at` / `last_run_at` / `last_status` still describe the real schedule. If the turn
   * cannot start (task already running, target conversation gone), the stored record is left
   * untouched instead of being replaced by a "cancelled" result.
   */
  async rerun(taskId: string, runId: number): Promise<ScheduleRerunResult> {
    const drive = this.drive
    if (!drive) return { ok: false, error: 'unavailable' }
    if (this.running.has(taskId)) return { ok: false, error: 'busy' }
    // Claim the task synchronously, before the first await: otherwise a tick could start the same
    // task while this lookup is in flight and both turns would run concurrently.
    this.running.add(taskId)
    let task: ScheduledTask
    let existing: ScheduleRunRecord | undefined
    try {
      const found = await this.store.get(taskId)
      if (!found) return { ok: false, error: 'not-found' }
      task = found
      existing = await this.store.getRun(taskId, runId)
      if (!existing) return { ok: false, error: 'run-not-found' }
    } catch (err) {
      logger.warn(`[Schedule] Failed to prepare re-run of task #${taskId}:`, err)
      return { ok: false, error: 'not-executed' }
    }

    let status: ScheduleRunStatus = 'completed'
    let run: ScheduledTurnResult = {}
    try {
      const result = await drive({ task, question: this.buildQuestion(task) })
      if (result) {
        run = result
        if (result.cancelled) status = 'cancelled'
      }
    } catch (err) {
      status = 'failed'
      run = { detail: err instanceof Error ? err.message : String(err) }
      logger.error(`[Schedule] Re-run of task #${task.id} (${task.title}) failed:`, err)
    } finally {
      this.running.delete(taskId)
    }

    // Nothing actually executed: keep the previous record intact rather than stamping it
    // "cancelled". A deleted target conversation gets its own code so the page can say what to fix.
    if (status === 'cancelled') {
      return {
        ok: false,
        error: run.detail === 'target-missing' ? 'target-missing' : 'not-executed'
      }
    }

    try {
      const updated = await this.store.replaceRun(taskId, runId, {
        status,
        detail: run.detail ?? null,
        topicId: run.topicId ?? null,
        dialogueId: run.dialogueId ?? null,
        usage: run.usage ?? null,
        steps: run.steps ?? null,
        artifacts: run.artifacts ?? null
      })
      if (!updated) return { ok: false, error: 'run-not-found' }
      // Keep the task card consistent when the re-run record is the one it reports as "last run":
      // only the status is refreshed, the actual schedule times stay untouched.
      if (task.lastRunAt && existing.at === task.lastRunAt) {
        await this.store
          .update(taskId, { lastStatus: updated.status })
          .catch((err) => logger.warn('[Schedule] Failed to sync last status after re-run:', err))
      }
      return { ok: true, run: updated }
    } catch (err) {
      logger.warn(`[Schedule] Failed to overwrite run #${runId} of task #${task.id}:`, err)
      return { ok: false, error: 'record-failed' }
    }
  }
}

/** Process-level singleton: started/stopped by system wiring; IPC injects drive and localized texts */
export const scheduleRunner = new ScheduleRunner({ store: scheduleStore })
