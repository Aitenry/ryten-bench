/**
 * 定时任务领域类型（纯类型，无 DB / electron 依赖）。
 *
 * 存储层（数据库 mapper）与业务层（工具、执行器、页面 IPC）共用这一份形状；
 * `schedule-core` 只关心规则本身，这里把「任务」和「执行记录」分开。
 */
import type { ScheduleWhen } from './schedule-core'

/** 单次执行状态 */
export type ScheduleRunStatus = 'completed' | 'cancelled' | 'failed'

/** 一条执行记录（永久保存，不裁剪） */
export interface ScheduleRunRecord {
  /** 实际开始执行的时间（ISO UTC） */
  at: string
  status: ScheduleRunStatus
  /** 失败原因等补充信息（可选） */
  detail?: string | null
}

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
  /** 冗余的工作区归属（旧数据可能为空） */
  workspaceId: number | null
  createdAt: string
  updatedAt: string
  /** 下一次触发（ISO UTC）；已停用或一次性任务执行完为 null */
  nextRunAt: string | null
  lastRunAt?: string
  lastStatus?: ScheduleRunStatus
  /** 仅在按需加载时填充（列表页不自动带执行记录） */
  runs?: ScheduleRunRecord[]
}

export interface ScheduleCreateInput {
  title: string
  prompt: string
  when: ScheduleWhen
  topicId: number
  workspaceId?: number | null
  nextRunAt: string
}

/** 可更新字段（id / createdAt 不可改） */
export type ScheduledTaskPatch = Partial<
  Omit<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'runs'>
>

/** 任务数量上限（防止无限创建） */
export const MAX_SCHEDULED_TASKS = 50

/** 列表页分页读取执行记录的默认条数 */
export const DEFAULT_RUNS_PAGE_SIZE = 20
