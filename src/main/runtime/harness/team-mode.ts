import logger from 'electron-log'
import { getTopicTeamMode, setTopicTeamMode } from '../../database/mapper/harness/harness'

/**
 * Agent Teams 开关（opt-in，按话题持久化）—— 对应 DSH 的 `agent-team` 模式开关。
 *
 * DSH 默认关闭团队协作，根会话显式开启后才挂 `tool-agent-team` 工具并注入团队提示词；
 * RytenBench 沿用 plan_mode 的做法：
 * - 状态存 `harness_topic.team_mode`，重启/切话题仍在；
 * - Runtime 的提示词与工具清单在请求期同步拼装，所以主进程用内存缓存读状态，
 *   每轮开始前 `ensure(topicId)` 从库里回填；
 * - 关闭时**不注入** `team_task_*` 工具、不追加团队提示词段；子代理同理。
 *
 * 团队协作只是增强能力：读取失败按关闭处理，不能让整轮请求失败。
 */

export interface TeamModeView {
  topicId: number
  enabled: boolean
}

/** 主智能体的团队任务板提示词段（关闭时为空串，不增加任何 token） */
export function teamModePromptSection(enabled: boolean): string {
  return enabled
    ? `\n\n## Team task board
You and your subagents share a task board (team_task_list / team_task_create / team_task_claim / team_task_update); the user can see it in the top bar. For work with more than one step or more than one collaborator:
- break it into concrete tasks with team_task_create (subject = deliverable, description = details),
- claim a task with team_task_claim before doing it (it becomes in_progress, owned by you),
- mark it completed with team_task_update as soon as it is done,
- use blockedBy and advisory writeScopes when tasks depend on each other or may touch the same files.
Keep the board current: an in_progress task nobody is working on reads as stuck to the user.`
    : ''
}

/** 子代理的团队协作提示词段（与主智能体口径分开：子代理是 member，认领/完成自己那份） */
export function subagentTeamPromptSection(enabled: boolean): string {
  return enabled
    ? `\n\n## Team task board
You share a task board with the main agent and the other subagents (team_task_list / team_task_create / team_task_claim / team_task_update). Before starting delegated work, call team_task_list; claim the matching task with team_task_claim (it becomes in_progress, owned by you) and mark it completed with team_task_update when done. If a claimed task turns out blocked, report it in your final answer instead of silently leaving it in_progress.`
    : ''
}

export type TeamModeListener = (view: TeamModeView) => void

/** 团队模式存储（进程级单例，按 topicId 隔离；数据库是唯一真源） */
export class TeamModeStore {
  private readonly cache = new Map<number, boolean>()

  /** 变更回调（IPC 层广播给界面，用于菜单勾选/顶部栏提示） */
  onChange?: TeamModeListener

  /** 从数据库回填某话题的团队模式（已有缓存直接返回；读失败按关闭处理） */
  async ensure(topicId: number): Promise<boolean> {
    if (topicId <= 0) return false
    const cached = this.cache.get(topicId)
    if (cached !== undefined) return cached
    try {
      const enabled = await getTopicTeamMode(topicId)
      this.cache.set(topicId, enabled)
      return enabled
    } catch (err) {
      logger.warn(`[TeamMode] Failed to read team mode for topic ${topicId}:`, err)
      return false
    }
  }

  /** 同步读取（只对已 ensure 过的话题可靠；未加载按关闭处理） */
  isEnabled(topicId: number): boolean {
    return this.cache.get(topicId) === true
  }

  /** 切换并持久化；成功后广播，返回最终状态 */
  async setEnabled(topicId: number, enabled: boolean): Promise<TeamModeView> {
    if (topicId <= 0) return { topicId, enabled: false }
    await setTopicTeamMode(topicId, enabled)
    this.cache.set(topicId, enabled)
    const view = { topicId, enabled }
    logger.info(`[TeamMode] Team mode ${enabled ? 'enabled' : 'disabled'} for topic ${topicId}`)
    try {
      this.onChange?.(view)
    } catch (err) {
      // 广播失败（窗口销毁等）不影响状态本身
      logger.warn('[TeamMode] Failed to broadcast team mode change:', err)
    }
    return view
  }

  /** 话题删除时丢弃缓存（行已随话题级联删除） */
  forget(topicId: number): void {
    this.cache.delete(topicId)
  }

  /** 丢弃全部内存态（账号数据空间切换时用） */
  reset(): void {
    this.cache.clear()
  }
}

/** 进程级单例 */
export const teamModeStore = new TeamModeStore()
