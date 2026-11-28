/**
 * Scheduled-task domain types (types only, no DB / electron dependency).
 *
 * The storage layer (database mapper) and the business layer (tools, runner, page IPC) share this
 * one shape; `schedule-core` only cares about the rule itself, while "task" and "run record" are
 * kept separate here.
 */
import type { AgentSelection } from '../../../shared/harness/agent-config'
import type { ScheduleWhen } from './schedule-core'

/** Status of one run */
export type ScheduleRunStatus = 'completed' | 'cancelled' | 'failed'

/** Token usage of one run (aggregated over the turn's model calls) */
export interface ScheduleRunUsage {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  /** Wall-clock duration of the turn */
  durationMs: number | null
}

/** One tool step inside a run (the panel's "process" timeline) */
export interface ScheduleRunStep {
  name: string
  /** File / directory the step touched, when the tool card has one */
  path: string | null
  status: 'ok' | 'error'
}

/** One artifact produced by a run */
export interface ScheduleRunArtifact {
  /** file = written/edited workspace file; deliverable = declared with the `present` tool */
  kind: 'file' | 'deliverable'
  path: string
  description: string | null
}

/** One run record (kept forever, never trimmed) */
export interface ScheduleRunRecord {
  /** When execution actually started (ISO UTC) */
  at: string
  status: ScheduleRunStatus
  /** Extra info such as the failure reason (optional) */
  detail?: string | null
  /** Conversation this run executed in */
  topicId?: number | null
  /** Assistant dialogue row produced by this run */
  dialogueId?: number | null
  usage?: ScheduleRunUsage | null
  steps?: ScheduleRunStep[] | null
  artifacts?: ScheduleRunArtifact[] | null
}

/** One scheduled task */
export interface ScheduledTask {
  id: string
  title: string
  /** Text delivered to the model as the user message on trigger */
  prompt: string
  when: ScheduleWhen
  enabled: boolean
  /**
   * Target session: required for fixed-session tasks; `null` = create a new session on every
   * trigger (see the three target columns below for mode/workspace/memory scope).
   */
  topicId: number | null
  /** Redundant workspace ownership (may be empty for old data) */
  workspaceId: number | null
  /** Target mode (chat/work/plugin); null = old data */
  targetMode: 'chat' | 'work' | 'plugin' | null
  /** Target workspace for new-session tasks (chat root / plugin workspace / user workspace) */
  targetWorkspaceId: number | null
  /** Memory scope for new-session tasks (chat / plugin:<id> / null = workspace) */
  targetMemoryScope: string | null
  /** Task-level run selection (overrides the session-level selection) */
  agentConfig: AgentSelection | null
  createdAt: string
  updatedAt: string
  /** Next trigger (ISO UTC); null when disabled or after a one-off task has run */
  nextRunAt: string | null
  lastRunAt?: string
  lastStatus?: ScheduleRunStatus
  /** Only filled on demand (the list page does not include run records) */
  runs?: ScheduleRunRecord[]
}

export interface ScheduleCreateInput {
  title: string
  prompt: string
  when: ScheduleWhen
  /** Fixed session; null = create a new session on every trigger */
  topicId: number | null
  workspaceId?: number | null
  /** Target mode (optional for fixed-session tasks, required for new-session tasks) */
  targetMode?: 'chat' | 'work' | 'plugin' | null
  targetWorkspaceId?: number | null
  targetMemoryScope?: string | null
  agentConfig?: AgentSelection | null
  nextRunAt: string
}

/** Updatable fields (id / createdAt are immutable) */
export type ScheduledTaskPatch = Partial<
  Omit<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'runs'>
>

/** Task count cap (prevents unlimited creation) */
export const MAX_SCHEDULED_TASKS = 50

/** Default page size for reading run records on the list page */
export const DEFAULT_RUNS_PAGE_SIZE = 20
