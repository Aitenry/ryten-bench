/**
 * Pure mapping between "what the model asked for" and "what the store accepts" for the scheduled
 * task tools (no electron / no DB / no runtime imports, so it can be unit tested under plain Node).
 *
 * Two jobs:
 * 1. **Form parity**: everything the Schedules page can set (target conversation / new session per
 *    run, task-level tools-skills-MCP) can also be set by `schedule_create` / `schedule_edit`;
 * 2. **True partial updates**: `schedule_edit` only touches the fields the caller passed. `undefined`
 *    means "leave it alone", `null` means "clear it" (for `agentConfig`: follow the conversation /
 *    defaults again) — the two must never collapse into each other, otherwise "change only the
 *    prompt" would silently reset the tool selection.
 *
 * The target rules mirror what the page IPC enforces (main/ipc/harness: `resolveScheduleTargetPayload`):
 * - chat → workspace kind `chat`, memory scope `chat`;
 * - plugin → workspace kind `plugin`, memory scope `plugin:<draftId>`;
 * - work → workspace kind `user`, memory scope null (follows the workspace).
 */
import type { AgentSelection } from '../../../shared/harness/agent-config'
import type { ScheduleCreateInput, ScheduledTask, ScheduledTaskPatch } from './schedule-types'
import type { ScheduleWhen } from './schedule-core'
import type {
  ScheduleConversationInfo,
  ScheduleTargetMode,
  ScheduleTaskTarget
} from './schedule-target'

/** Where the task runs */
export type TargetSession = 'this' | 'new'

/** Task-level run selection as accepted from the model (all dimensions optional) */
export interface ScheduleSelectionInput {
  tools?: string[] | null
  skills?: string[] | null
  mcpTools?: string[] | null
}

/** Fields a caller may create with */
export interface ScheduleCreateArgs {
  title: string
  prompt: string
  when: ScheduleWhen
  /** `this` (default) = the current conversation; `new` = a fresh conversation on every run */
  targetSession?: TargetSession
  /** `undefined`/`null` = follow the conversation / defaults */
  agentConfig?: ScheduleSelectionInput | null
}

/** Context the tool must supply when creating */
export interface ScheduleCreateContext {
  /** Conversation the tool was called from (0 = none) */
  topicId: number
  /** That conversation's workspace / memory scope (null when it could not be read) */
  conversation: ScheduleConversationInfo | null
  /** First trigger, already validated by the caller */
  nextRunAt: string
}

export type ScheduleCreateFailure = 'no-topic' | 'no-target'

/** Fields a caller may update (undefined = untouched, null = clear) */
export interface ScheduleEditArgs {
  title?: string
  prompt?: string
  when?: ScheduleWhen
  /** `null` clears the task-level selection (run with the conversation's own selection) */
  agentConfig?: ScheduleSelectionInput | null
  targetSession?: TargetSession
  enabled?: boolean
}

/** Context the tool must supply when editing */
export interface ScheduleEditContext {
  topicId: number
  conversation: ScheduleConversationInfo | null
}

/** Which fields an edit actually changed (used for the tool's result text) */
export type ScheduleEditField =
  | 'title'
  | 'prompt'
  | 'when'
  | 'target'
  | 'agentConfig'
  | 'enabled'

export type ScheduleEditFailure = 'no-topic' | 'no-target' | 'empty'

export type ScheduleCreateResult =
  | { ok: true; input: ScheduleCreateInput }
  | { ok: false; reason: ScheduleCreateFailure }

export type ScheduleEditResult =
  | { ok: true; patch: ScheduledTaskPatch; changed: ScheduleEditField[] }
  | { ok: false; reason: ScheduleEditFailure }

// ── Selection ────────────────────────────────────────────────────────

/** Trim / dedupe a name list; anything that is not an array yields null */
function cleanNames(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = item.trim()
    if (!value || out.includes(value)) continue
    out.push(value)
  }
  return out
}

/**
 * Selection from the model → stored shape.
 *
 * An all-empty selection is stored as `null` (the same "nothing chosen" value the page writes),
 * so a task created with an empty tool list behaves like a task created from the page with nothing
 * ticked: it follows the conversation's own selection.
 */
export function normalizeSelectionInput(
  raw: ScheduleSelectionInput | null | undefined
): AgentSelection | null {
  if (!raw || typeof raw !== 'object') return null
  const tools = cleanNames(raw.tools)
  const skills = cleanNames(raw.skills)
  const mcpTools = cleanNames(raw.mcpTools)
  // `[]` from the model means "nothing", not "an explicit empty override"
  const normalized = {
    tools: tools && tools.length > 0 ? tools : null,
    skills: skills && skills.length > 0 ? skills : null,
    mcpTools: mcpTools && mcpTools.length > 0 ? mcpTools : null
  }
  if (normalized.tools === null && normalized.skills === null && normalized.mcpTools === null) {
    return null
  }
  return normalized
}

// ── Target ───────────────────────────────────────────────────────────

/** `harness_topic.memory_scope === 'chat'` */
function isChatScope(raw: unknown): boolean {
  return raw === 'chat'
}

/** `harness_topic.memory_scope === 'plugin:<id>'` → the plugin id */
function pluginIdOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('plugin:')) return null
  const id = raw.slice('plugin:'.length).trim()
  return id || null
}

/** Normalize a memory scope string (`chat` / `plugin:<id>` / anything else → null) */
function normalizeScope(raw: unknown): string | null {
  if (isChatScope(raw)) return 'chat'
  const pluginId = pluginIdOf(raw)
  return pluginId ? `plugin:${pluginId}` : null
}

/** Conversation mode from the workspace kind (memory scope is the fallback for legacy rows) */
function modeOf(info: ScheduleConversationInfo): ScheduleTargetMode {
  if (info.workspaceKind === 'chat') return 'chat'
  if (info.workspaceKind === 'plugin') return 'plugin'
  if (isChatScope(info.memoryScope)) return 'chat'
  if (pluginIdOf(info.memoryScope)) return 'plugin'
  return 'work'
}

/**
 * "Run in this conversation": all target columns are derived from the conversation itself.
 *
 * Returns null when the conversation is unknown (the topic was deleted between the tool call and
 * the lookup), so the caller can report a readable failure instead of creating a task that can
 * never fire.
 */
export function targetForConversation(
  info: ScheduleConversationInfo | null
): ScheduleTaskTarget | null {
  if (!info) return null
  return {
    topicId: info.topicId,
    workspaceId: info.workspaceId,
    targetMode: modeOf(info),
    // A fixed-session task does not need these, but keeping them in sync makes "switch to a new
    // session later" (schedule_edit) work from the stored row without another lookup.
    targetWorkspaceId: info.workspaceId,
    targetMemoryScope: normalizeScope(info.memoryScope)
  }
}

/**
 * "Open a brand-new conversation on every run": inherit the creating conversation's mode,
 * workspace and memory scope.
 *
 * Returns null when the target cannot be expressed (a plugin session without `plugin:<id>`, or a
 * conversation whose workspace is gone): scheduling into a half-specified target would fail at
 * trigger time, which is much worse than telling the model now.
 */
export function targetForNewConversation(
  info: ScheduleConversationInfo | null
): ScheduleTaskTarget | null {
  if (!info || !info.workspaceId) return null
  const mode = modeOf(info)
  if (mode === 'chat') {
    return {
      topicId: null,
      workspaceId: null,
      targetMode: 'chat',
      targetWorkspaceId: info.workspaceId,
      targetMemoryScope: 'chat'
    }
  }
  if (mode === 'plugin') {
    const pluginId = pluginIdOf(info.memoryScope)
    if (!pluginId) return null
    return {
      topicId: null,
      workspaceId: null,
      targetMode: 'plugin',
      targetWorkspaceId: info.workspaceId,
      targetMemoryScope: `plugin:${pluginId}`
    }
  }
  return {
    topicId: null,
    workspaceId: null,
    targetMode: 'work',
    targetWorkspaceId: info.workspaceId,
    targetMemoryScope: null
  }
}

/**
 * Resolve the target columns for one of the two supported targets.
 *
 * "this" degrades to a topicId-only target when the conversation row could not be read (or the
 * resolver is not wired): a fixed-session task only needs `topic_id`, and the runner resolves the
 * workspace from the topic at trigger time. "new" cannot degrade — a half-specified new-session
 * target would fail at trigger time instead.
 */
function targetOf(
  kind: TargetSession,
  conversation: ScheduleConversationInfo | null,
  topicId: number
): ScheduleTaskTarget | null {
  if (kind === 'new') return targetForNewConversation(conversation)
  const resolved = targetForConversation(conversation)
  if (resolved) return resolved
  if (!Number.isFinite(topicId) || topicId <= 0) return null
  return {
    topicId,
    workspaceId: null,
    targetMode: null,
    targetWorkspaceId: null,
    targetMemoryScope: null
  }
}

// ── Create / edit ────────────────────────────────────────────────────

/** Build a create input (validation of the rule itself happens in the tool, see schedule-core) */
export function buildCreateInput(
  args: ScheduleCreateArgs,
  ctx: ScheduleCreateContext
): ScheduleCreateResult {
  if (!Number.isFinite(ctx.topicId) || ctx.topicId <= 0) return { ok: false, reason: 'no-topic' }
  const target = targetOf(args.targetSession ?? 'this', ctx.conversation, ctx.topicId)
  if (!target) return { ok: false, reason: 'no-target' }
  return {
    ok: true,
    input: {
      title: args.title.trim(),
      prompt: args.prompt.trim(),
      when: args.when,
      topicId: target.topicId,
      workspaceId: target.workspaceId,
      targetMode: target.targetMode,
      targetWorkspaceId: target.targetWorkspaceId,
      targetMemoryScope: target.targetMemoryScope,
      agentConfig: normalizeSelectionInput(args.agentConfig),
      nextRunAt: ctx.nextRunAt
    }
  }
}

/**
 * Build a patch that contains **only** the fields the caller passed.
 *
 * `nextRunAt` is deliberately not computed here: it depends on the current clock and on the rule
 * validation, which belong to the tool (see schedule-core); the tool sets it after this returns.
 */
export function buildUpdatePatch(
  args: ScheduleEditArgs,
  task: ScheduledTask,
  ctx: ScheduleEditContext
): ScheduleEditResult {
  const patch: ScheduledTaskPatch = {}
  const changed: ScheduleEditField[] = []

  if (typeof args.title === 'string') {
    const title = args.title.trim()
    if (title && title !== task.title) {
      patch.title = title
      changed.push('title')
    }
  }
  if (typeof args.prompt === 'string') {
    const prompt = args.prompt.trim()
    if (prompt && prompt !== task.prompt) {
      patch.prompt = prompt
      changed.push('prompt')
    }
  }
  if (args.when !== undefined) {
    patch.when = args.when
    changed.push('when')
  }
  if (args.agentConfig !== undefined) {
    const next = normalizeSelectionInput(args.agentConfig)
    const current = task.agentConfig ?? null
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      patch.agentConfig = next
      changed.push('agentConfig')
    }
  }
  if (args.enabled !== undefined && args.enabled !== task.enabled) {
    patch.enabled = args.enabled
    changed.push('enabled')
  }
  if (args.targetSession !== undefined) {
    // "this" needs a conversation to point at; "new" needs a workspace to inherit from
    if (args.targetSession === 'this' && !(Number.isFinite(ctx.topicId) && ctx.topicId > 0)) {
      return { ok: false, reason: 'no-topic' }
    }
    const target = targetOf(args.targetSession, ctx.conversation, ctx.topicId)
    if (!target) return { ok: false, reason: 'no-target' }
    if (
      task.topicId !== target.topicId ||
      task.targetMode !== target.targetMode ||
      task.targetWorkspaceId !== target.targetWorkspaceId ||
      task.targetMemoryScope !== target.targetMemoryScope
    ) {
      patch.topicId = target.topicId
      patch.workspaceId = target.workspaceId
      patch.targetMode = target.targetMode
      patch.targetWorkspaceId = target.targetWorkspaceId
      patch.targetMemoryScope = target.targetMemoryScope
      changed.push('target')
    }
  }

  if (changed.length === 0) return { ok: false, reason: 'empty' }
  return { ok: true, patch, changed }
}
