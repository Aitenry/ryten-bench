import logger from 'electron-log'
import { getTopicTeamMode, setTopicTeamMode } from '../../database/mapper/harness/harness'

/**
 * Agent Teams toggle (opt-in, persisted per topic) — the `agent-team` mode switch.
 *
 * Team collaboration is off by default; the root session mounts the `tool-agent-team`
 * tools and injects the team prompt section only after explicitly enabling it. This
 * follows the plan_mode approach:
 * - state lives in `harness_topic.team_mode`, surviving restarts and topic switches;
 * - the Runtime assembles the prompt and tool list per request, so the main process reads
 *   the state from an in-memory cache and backfills it from the database via
 *   `ensure(topicId)` before each turn starts;
 * - when disabled, `team_task_*` tools are **not injected** and the team prompt section is
 *   not appended; the same applies to subagents.
 *
 * Team collaboration is only an enhancement: a read failure is treated as disabled and
 * must not fail the whole turn.
 */

export interface TeamModeView {
  topicId: number
  enabled: boolean
}

/** Team task board prompt section for the main agent (empty when disabled, adding no tokens) */
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

/** Team collaboration prompt section for subagents (separate from the main agent's: subagents are members claiming/completing their own part) */
export function subagentTeamPromptSection(enabled: boolean): string {
  return enabled
    ? `\n\n## Team task board
You share a task board with the main agent and the other subagents (team_task_list / team_task_create / team_task_claim / team_task_update). Before starting delegated work, call team_task_list; claim the matching task with team_task_claim (it becomes in_progress, owned by you) and mark it completed with team_task_update when done. If a claimed task turns out blocked, report it in your final answer instead of silently leaving it in_progress.`
    : ''
}

export type TeamModeListener = (view: TeamModeView) => void

/** Team mode store (process-level singleton, isolated by topicId; the database is the source of truth) */
export class TeamModeStore {
  private readonly cache = new Map<number, boolean>()

  /** Change callback (the IPC layer broadcasts it to the UI for menu checks / top-bar hints) */
  onChange?: TeamModeListener

  /** Backfill a topic's team mode from the database (return the cache when present; read failure means disabled) */
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

  /** Synchronous read (reliable only for topics already ensured; not loaded means disabled) */
  isEnabled(topicId: number): boolean {
    return this.cache.get(topicId) === true
  }

  /** Toggle and persist; broadcast on success and return the final state */
  async setEnabled(topicId: number, enabled: boolean): Promise<TeamModeView> {
    if (topicId <= 0) return { topicId, enabled: false }
    await setTopicTeamMode(topicId, enabled)
    this.cache.set(topicId, enabled)
    const view = { topicId, enabled }
    logger.info(`[TeamMode] Team mode ${enabled ? 'enabled' : 'disabled'} for topic ${topicId}`)
    try {
      this.onChange?.(view)
    } catch (err) {
      // A broadcast failure (e.g. window destroyed) does not affect the state itself
      logger.warn('[TeamMode] Failed to broadcast team mode change:', err)
    }
    return view
  }

  /** Drop the cache when a topic is deleted (the row is cascade-deleted with the topic) */
  forget(topicId: number): void {
    this.cache.delete(topicId)
  }

  /** Drop all in-memory state (used when switching account data spaces) */
  reset(): void {
    this.cache.clear()
  }
}

/** Process-level singleton */
export const teamModeStore = new TeamModeStore()
