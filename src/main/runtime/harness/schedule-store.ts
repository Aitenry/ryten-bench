/**
 * 定时任务存储（本地 JSON 文件，无 electron 依赖，可离线测试）。
 *
 * 为什么不用数据库：任务数量很小（上限 50），结构简单，且需要在「数据库尚未初始化」
 * 或测试环境里也能用；JSON 文件 + 原子替换就够，失败面比迁移小得多。
 * 目录由 `configureScheduleStore()` 在系统装配时注入（userData 下的 schedules/）。
 */
import * as fs from 'fs'
import * as path from 'path'
import type { ScheduleWhen } from './schedule-core'

/** 一条定时任务 */
export interface ScheduledTask {
  id: string
  title: string
  /** 触发时作为用户消息投递给模型的文本 */
  prompt: string
  when: ScheduleWhen
  enabled: boolean
  /** 任务归属的话题（创建时所在会话） */
  topicId: number
  createdAt: string
  updatedAt: string
  /** 下一次触发（ISO UTC）；已停用或一次性任务执行完为 null */
  nextRunAt: string | null
  lastRunAt?: string
  lastStatus?: 'completed' | 'cancelled' | 'failed'
  /** 最近几次执行记录（上限 {@link MAX_RUN_HISTORY}；旧记录自动丢弃） */
  runs?: ScheduleRunRecord[]
}

/** 单次执行记录 */
export interface ScheduleRunRecord {
  at: string
  status: 'completed' | 'cancelled' | 'failed'
}

/** 每个任务保留的执行记录条数 */
export const MAX_RUN_HISTORY = 5

export interface ScheduleCreateInput {
  title: string
  prompt: string
  when: ScheduleWhen
  topicId: number
  nextRunAt: string
}

/** 任务数量上限（防止模型无限创建把文件撑大） */
export const MAX_SCHEDULED_TASKS = 50

/** 生成任务 id（时间 + 随机后缀，稳定可读） */
function createTaskId(): string {
  return `sched-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export class ScheduleStore {
  private readonly dirProvider: () => string | null

  constructor(dirProvider: () => string | null) {
    this.dirProvider = dirProvider
  }

  private filePath(): string | null {
    const dir = this.dirProvider()
    return dir ? path.join(dir, 'schedules.json') : null
  }

  /** 读取全部任务（文件缺失/损坏都视为空表，不让一条坏记录卡死整个功能） */
  list(): ScheduledTask[] {
    const file = this.filePath()
    if (!file) return []
    try {
      const raw = fs.readFileSync(file, 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (item): item is ScheduledTask =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as ScheduledTask).id === 'string' &&
          typeof (item as ScheduledTask).prompt === 'string'
      )
    } catch {
      return []
    }
  }

  get(id: string): ScheduledTask | undefined {
    return this.list().find((task) => task.id === id)
  }

  private write(tasks: ScheduledTask[]): void {
    const file = this.filePath()
    if (!file) throw new Error('schedule store is not configured')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    fs.writeFileSync(temp, JSON.stringify(tasks, null, 2), 'utf-8')
    fs.renameSync(temp, file)
  }

  create(input: ScheduleCreateInput): ScheduledTask {
    const tasks = this.list()
    if (tasks.length >= MAX_SCHEDULED_TASKS) {
      throw new Error(`too many scheduled tasks (limit ${MAX_SCHEDULED_TASKS})`)
    }
    const now = new Date().toISOString()
    const task: ScheduledTask = {
      id: createTaskId(),
      title: input.title,
      prompt: input.prompt,
      when: input.when,
      enabled: true,
      topicId: input.topicId,
      createdAt: now,
      updatedAt: now,
      nextRunAt: input.nextRunAt
    }
    tasks.push(task)
    this.write(tasks)
    return task
  }

  update(id: string, patch: Partial<Omit<ScheduledTask, 'id' | 'createdAt'>>): ScheduledTask | undefined {
    const tasks = this.list()
    const index = tasks.findIndex((task) => task.id === id)
    if (index < 0) return undefined
    const updated: ScheduledTask = {
      ...tasks[index],
      ...patch,
      id: tasks[index].id,
      createdAt: tasks[index].createdAt,
      updatedAt: new Date().toISOString()
    }
    tasks[index] = updated
    this.write(tasks)
    return updated
  }

  remove(id: string): boolean {
    const tasks = this.list()
    const next = tasks.filter((task) => task.id !== id)
    if (next.length === tasks.length) return false
    this.write(next)
    return true
  }

  /**
   * 记录一次执行结果：更新 nextRunAt / enabled / lastRunAt / lastStatus，并追加一条
   * 有界的执行历史（供设置页与 schedule_view 展示）。
   *
   * `nextRunAt = null` 表示不再触发（一次性任务或已停用）。
   */
  markRun(
    id: string,
    result: {
      status: ScheduledTask['lastStatus']
      ranAt: string
      nextRunAt: string | null
      enabled?: boolean
    }
  ): ScheduledTask | undefined {
    const task = this.get(id)
    if (!task) return undefined
    const status = result.status ?? 'completed'
    const runs = [...(task.runs ?? []), { at: result.ranAt, status }].slice(-MAX_RUN_HISTORY)
    return this.update(id, {
      lastRunAt: result.ranAt,
      lastStatus: status,
      nextRunAt: result.nextRunAt,
      enabled: result.enabled ?? result.nextRunAt !== null,
      runs
    })
  }
}

/** 当前配置的存储目录（系统装配时注入；退出时清空） */
let configuredDir: string | null = null

/** 注入/重置存储目录（传 undefined 表示未配置，工具会给出不可用提示） */
export function configureScheduleStore(dir?: string): void {
  configuredDir = dir ?? null
}

/** 存储是否已装配（工具据此给出「暂不可用」而不是静默空表） */
export function isScheduleStoreConfigured(): boolean {
  return configuredDir !== null
}

/** 进程级单例 */
export const scheduleStore = new ScheduleStore(() => configuredDir)
