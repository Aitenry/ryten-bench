/**
 * 定时任务存储的**门面**（facade）：业务层（工具 / 执行器 / IPC）只依赖这个接口。
 *
 * 真正的存储后端由系统装配层注入：
 * - 应用运行期：`DbScheduleStore`（`src/main/database/schedule-db.ts`，PGlite 表）；
 * - 测试：内存假实现（直接 `configureScheduleStoreBackend(fake)`）。
 *
 * 这样工具与 runner 的模块图里**不会**出现 drizzle / PGlite，测试与打包都更轻；
 * 未装配后端时 `isScheduleStoreConfigured()` 为 false，工具给出「暂不可用」而不是静默空表。
 */
import type {
  ScheduleCreateInput,
  ScheduleRunRecord,
  ScheduleRunStatus,
  ScheduledTask,
  ScheduledTaskPatch
} from './schedule-types'

export type { ScheduleCreateInput, ScheduleRunRecord, ScheduleRunStatus, ScheduledTask, ScheduledTaskPatch }
export { MAX_SCHEDULED_TASKS, DEFAULT_RUNS_PAGE_SIZE } from './schedule-types'

/** 存储后端（异步；数据库实现与内存实现共用） */
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
    }
  ): Promise<ScheduledTask | undefined>
  /** 永久执行记录（倒序分页） */
  listRuns(taskId: string, limit?: number, offset?: number): Promise<ScheduleRunRecord[]>
  countRuns(taskId: string): Promise<number>
}

/** 当前注入的后端（系统装配时设置；退出时清空） */
let backend: ScheduleStore | null = null

/** 注入/替换存储后端（传 undefined 表示未装配） */
export function configureScheduleStoreBackend(next?: ScheduleStore): void {
  backend = next ?? null
}

/** 是否已装配后端（工具据此给出「暂不可用」提示） */
export function isScheduleStoreConfigured(): boolean {
  return backend !== null
}

/** 取后端；未装配时抛错（调用方负责翻成用户可读文案） */
function requireBackend(): ScheduleStore {
  if (!backend) throw new Error('schedule store is not configured')
  return backend
}

/** 生成任务 id（时间 + 随机后缀，稳定可读） */
export function createTaskId(): string {
  return `sched-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** 进程级门面：业务层统一从这里访问存储 */
export const scheduleStore: ScheduleStore = {
  // 全部包成 async：未装配后端时以 **Promise reject** 的形式失败（而不是同步 throw），
  // 工具层/测试里的 await / assert.rejects 语义才一致。
  list: async () => requireBackend().list(),
  get: async (id) => requireBackend().get(id),
  create: async (input) => requireBackend().create(input),
  update: async (id, patch) => requireBackend().update(id, patch),
  remove: async (id) => requireBackend().remove(id),
  markRun: async (id, result) => requireBackend().markRun(id, result),
  listRuns: async (taskId, limit, offset) => requireBackend().listRuns(taskId, limit, offset),
  countRuns: async (taskId) => requireBackend().countRuns(taskId)
}
