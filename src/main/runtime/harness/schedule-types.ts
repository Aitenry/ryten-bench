/**
 * 定时任务领域类型（纯类型，无 DB / electron 依赖）。
 *
 * 存储层（数据库 mapper）与业务层（工具、执行器、页面 IPC）共用这一份形状；
 * `schedule-core` 只关心规则本身，这里把「任务」和「执行记录」分开。
 */
import type { AgentSelection } from '../../../shared/harness/agent-config'
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
  /**
   * 目标会话：固定会话型任务必填；`null` = 每次触发新建一条会话
   * （目标模式/工作区/记忆作用域见下面三列）。
   */
  topicId: number | null
  /** 冗余的工作区归属（旧数据可能为空） */
  workspaceId: number | null
  /** 目标模式（对话框/工作/插件）；null = 旧数据 */
  targetMode: 'chat' | 'work' | 'plugin' | null
  /** 新会话型任务的目标工作区（对话根 / 插件工作区 / 用户工作区） */
  targetWorkspaceId: number | null
  /** 新会话型任务的记忆作用域（chat / plugin:<id> / null=工作区） */
  targetMemoryScope: string | null
  /** 任务级运行选择（在会话级选择之上覆盖） */
  agentConfig: AgentSelection | null
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
  /** 固定会话；null = 每次触发新建会话 */
  topicId: number | null
  workspaceId?: number | null
  /** 目标模式（固定会话型可留空；新会话型必填） */
  targetMode?: 'chat' | 'work' | 'plugin' | null
  targetWorkspaceId?: number | null
  targetMemoryScope?: string | null
  agentConfig?: AgentSelection | null
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
