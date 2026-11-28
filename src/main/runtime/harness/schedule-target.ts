/**
 * Where a scheduled task should run, resolved from the **conversation that creates it**.
 *
 * Why this exists: `schedule_*` tools only receive `topicId` (from the tool config), which is
 * enough for "run in this conversation" but not for the page's "open a new conversation on every
 * run" option — that target needs the workspace / mode / memory scope of the creating session.
 * The tool layer must not touch drizzle or the topic tables directly (same reason as
 * schedule-store.ts), so the wiring layer injects a resolver here and the tool only asks for the
 * info.
 *
 * This module deliberately has **no runtime imports** (types only): the pure mapping lives in
 * `schedule-tool-core.ts` and both files are unit-testable under plain Node.
 */

/** Mode of the conversation (matches the task's `targetMode` column) */
export type ScheduleTargetMode = 'chat' | 'work' | 'plugin'

/** Minimal view of a conversation needed to derive a new-session target */
export interface ScheduleConversationInfo {
  topicId: number
  workspaceId: number | null
  /** `workspace.kind` (user / chat / plugin); null when the workspace row is gone */
  workspaceKind: string | null
  /** `harness_topic.memory_scope` */
  memoryScope: string | null
}

/** Target fields stored on a task (new-session tasks have `topicId: null`) */
export interface ScheduleTaskTarget {
  topicId: number | null
  workspaceId: number | null
  targetMode: ScheduleTargetMode | null
  targetWorkspaceId: number | null
  targetMemoryScope: string | null
}

/** Injected lookup (system wiring reads the topic + workspace rows) */
export type ScheduleConversationResolver = (
  topicId: number
) => Promise<ScheduleConversationInfo | null>

let resolver: ScheduleConversationResolver | null = null

/** Inject / revoke the conversation lookup (undefined = not configured, the tool reports it) */
export function configureScheduleConversationResolver(
  next?: ScheduleConversationResolver
): void {
  resolver = next ?? null
}

/** Whether the lookup is configured (the tool turns "not configured" into readable text) */
export function isScheduleConversationResolverConfigured(): boolean {
  return resolver !== null
}

/** Resolve one conversation; failures and missing wiring both degrade to null */
export async function resolveScheduleConversation(
  topicId: number
): Promise<ScheduleConversationInfo | null> {
  if (!resolver || !Number.isFinite(topicId) || topicId <= 0) return null
  try {
    return await resolver(topicId)
  } catch {
    return null
  }
}
