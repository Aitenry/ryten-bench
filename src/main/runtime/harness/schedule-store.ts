/**
 * **Facade** for scheduled-task storage: the business layer (tool / runner / IPC) depends only on
 * this interface.
 *
 * The real backend is injected by the system wiring layer:
 * - app runtime: `DbScheduleStore` (`src/main/database/schedule-db.ts`, PGlite tables);
 * - tests: an in-memory fake (just `configureScheduleStoreBackend(fake)`).
 *
 * This keeps drizzle / PGlite out of the module graph of the tool and runner, which keeps tests
 * and packaging lighter; when no backend is configured, `isScheduleStoreConfigured()` is false and
 * the tool reports "temporarily unavailable" instead of silently returning an empty table.
 */
import type {
  ScheduleCreateInput,
  ScheduleRunArtifact,
  ScheduleRunRecord,
  ScheduleRunStatus,
  ScheduleRunStep,
  ScheduleRunUsage,
  ScheduledTask,
  ScheduledTaskPatch
} from './schedule-types'

export type { ScheduleCreateInput, ScheduleRunRecord, ScheduleRunStatus, ScheduledTask, ScheduledTaskPatch }
export type { ScheduleRunArtifact, ScheduleRunStep, ScheduleRunUsage }
export { MAX_SCHEDULED_TASKS, DEFAULT_RUNS_PAGE_SIZE } from './schedule-types'

/** Storage backend (async; shared by the database and in-memory implementations) */
export interface ScheduleStore {
  list(): Promise<ScheduledTask[]>
  get(id: string): Promise<ScheduledTask | undefined>
  create(input: ScheduleCreateInput): Promise<ScheduledTask>
  update(id: string, patch: ScheduledTaskPatch): Promise<ScheduledTask | undefined>
  remove(id: string): Promise<boolean>
  markRun(
    id: string,
    result: {
      status: ScheduleRunStatus
      ranAt: string
      nextRunAt: string | null
      enabled?: boolean
      detail?: string | null
      /** Run detail for the "execution details" panel (all optional: old runs have none) */
      topicId?: number | null
      dialogueId?: number | null
      usage?: ScheduleRunUsage | null
      steps?: ScheduleRunStep[] | null
      artifacts?: ScheduleRunArtifact[] | null
    }
  ): Promise<ScheduledTask | undefined>
  /** Permanent run records (paginated, newest first) */
  listRuns(taskId: string, limit?: number, offset?: number): Promise<ScheduleRunRecord[]>
  countRuns(taskId: string): Promise<number>
}

/** Currently injected backend (set by system wiring; cleared on exit) */
let backend: ScheduleStore | null = null

/** Inject/replace the storage backend (undefined means not configured) */
export function configureScheduleStoreBackend(next?: ScheduleStore): void {
  backend = next ?? null
}

/** Whether a backend is configured (the tool uses this to report "temporarily unavailable") */
export function isScheduleStoreConfigured(): boolean {
  return backend !== null
}

/** Get the backend; throws when not configured (the caller turns this into user-readable text) */
function requireBackend(): ScheduleStore {
  if (!backend) throw new Error('schedule store is not configured')
  return backend
}

/** Generate a task id (time plus random suffix, stable and readable) */
export function createTaskId(): string {
  return `sched-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** Process-level facade: the business layer accesses storage only through this */
export const scheduleStore: ScheduleStore = {
  // Everything is wrapped in async: without a backend it fails as a **Promise reject** (not a
  // synchronous throw), so await / assert.rejects behave consistently in the tool layer and tests.
  list: async () => requireBackend().list(),
  get: async (id) => requireBackend().get(id),
  create: async (input) => requireBackend().create(input),
  update: async (id, patch) => requireBackend().update(id, patch),
  remove: async (id) => requireBackend().remove(id),
  markRun: async (id, result) => requireBackend().markRun(id, result),
  listRuns: async (taskId, limit, offset) => requireBackend().listRuns(taskId, limit, offset),
  countRuns: async (taskId) => requireBackend().countRuns(taskId)
}
