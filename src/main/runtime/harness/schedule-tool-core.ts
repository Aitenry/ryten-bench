/**
 * Pure mapping between "what the model asked for" and "what the store accepts" for the scheduled
 * task tools (no electron / no DB / no runtime imports, so it can be unit tested under plain Node).
 *
 * Three jobs:
 * 1. **Form parity**: everything the Schedules page can set (target conversation / new session per
 *    run, task-level tools-skills-MCP, model override) can also be set by `schedule_create` /
 *    `schedule_edit`;
 * 2. **True partial updates**: `schedule_edit` only touches the fields the caller passed. `undefined`
 *    means "leave it alone", `null` means "clear it" (for `agentConfig`: follow the conversation /
 *    defaults again) — the two must never collapse into each other, otherwise "change only the
 *    prompt" would silently reset the tool selection;
 * 3. **Catalog filtering**: the task-level selection is a list of values the Schedules page could
 *    also pick. Built-in runtime tools (`task`, `read_file`, `execute`, …) are mounted on every
 *    turn and are absent from that catalog, so a model that copies its own toolset into
 *    `agentConfig` must be rejected instead of storing names that are silently dropped at run time.
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

/** Trim a `provider:model` override; empty / non-string collapses to null (= default model) */
function normalizeModelSpec(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return value || null
}

/**
 * Values the Schedules page could pick, built from the same sources as `list_capabilities`:
 * selectable tool names (group entries included), skill ids, and `mcp@<namespace>` values.
 *
 * `tools` also contains the MCP group values: the page's legacy migration keeps them in `tools`,
 * and `mcp` (the old all-servers marker) is still expanded at run time.
 */
export interface ScheduleSelectionCatalog {
  tools: ReadonlySet<string>
  skills: ReadonlySet<string>
  mcp: ReadonlySet<string>
  /**
   * Maps a legacy tool name to the selection value the catalog lists today (`manage_materials` →
   * `materials-tools`, `web_fetch` → `web-tools`).
   *
   * Injected by the caller (`scheduleSelectionValues`) instead of importing `canonicalToolName`
   * here: this module stays free of runtime imports so it can be unit tested under plain Node.
   * When omitted, names are matched as written.
   */
  canonicalTool?: (name: string) => string
}

/** Selection values that are not in the catalog, per dimension (caller order kept) */
export interface UnknownSelectionValues {
  tools: string[]
  skills: string[]
  mcp: string[]
}

/** Whether any dimension of an `UnknownSelectionValues` result contains something */
export function hasUnknownSelectionValues(unknown: UnknownSelectionValues): boolean {
  return unknown.tools.length > 0 || unknown.skills.length > 0 || unknown.mcp.length > 0
}

/** Filtered selection plus the values that were dropped because the catalog does not contain them */
export interface SanitizedSelection {
  selection: AgentSelection | null
  ignored: UnknownSelectionValues | null
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
  /** Model override `provider:model`; omitted/null = the default provider */
  model?: string | null
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
  /** `null` clears the model override (back to the default provider) */
  model?: string | null
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
  'title' | 'prompt' | 'when' | 'target' | 'agentConfig' | 'model' | 'enabled'

export type ScheduleEditFailure = 'no-topic' | 'no-target' | 'empty'

export type ScheduleCreateResult =
  { ok: true; input: ScheduleCreateInput } | { ok: false; reason: ScheduleCreateFailure }

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

/**
 * Drop every selection value that is not in the catalog.
 *
 * Tool names are canonicalized first (`manage_materials` / `web_fetch` / … → the current group
 * entry): tasks and forms created before the 2026-11-28 materials split still store the old name,
 * and the catalog only lists the replacement. Checking the raw name dropped a perfectly valid old
 * selection at run time, which is exactly the "I scheduled it with the knowledge-base tool, but the
 * run had no such tool" failure.
 *
 * A dimension whose values are **all** dropped becomes `null` (follow the conversation) instead of
 * an explicit empty override, so a task whose tools were all invalid still runs with the
 * conversation's own selection rather than with nothing mounted.
 */
export function sanitizeSelectionInput(
  raw: ScheduleSelectionInput | null | undefined,
  catalog: ScheduleSelectionCatalog
): SanitizedSelection {
  if (!raw || typeof raw !== 'object') return { selection: null, ignored: null }
  const filter = (
    names: string[] | null,
    isKnown: (name: string) => boolean,
    canonicalize?: (name: string) => string
  ): { kept: string[]; dropped: string[] } => {
    const kept: string[] = []
    const dropped: string[] = []
    for (const name of names ?? []) {
      const value = canonicalize ? canonicalize(name) : name
      if (isKnown(value)) {
        if (!kept.includes(value)) kept.push(value)
      } else {
        // Report the value the caller wrote, not its normalized form, so the warning stays actionable
        dropped.push(name)
      }
    }
    return { kept, dropped }
  }
  const canonicalizeTool = catalog.canonicalTool
  const tools = filter(cleanNames(raw.tools), (name) => catalog.tools.has(name), canonicalizeTool)
  const skills = filter(cleanNames(raw.skills), (name) => catalog.skills.has(name))
  const mcp = filter(cleanNames(raw.mcpTools), (name) => catalog.mcp.has(name))
  const selection = normalizeSelectionInput({
    tools: tools.kept,
    skills: skills.kept,
    mcpTools: mcp.kept
  })
  const ignored = { tools: tools.dropped, skills: skills.dropped, mcp: mcp.dropped }
  return { selection, ignored: hasUnknownSelectionValues(ignored) ? ignored : null }
}

/**
 * Values the caller passed that the Schedules page could not also pick (`null` = all valid).
 *
 * Used to reject `schedule_create` / `schedule_edit` calls that name built-in runtime tools
 * (`task`, `read_file`, `execute`, …) or anything else outside the catalog: accepting them would
 * store a tool override that the run-time registry silently drops, which replaces the
 * conversation's tool selection with an empty set.
 */
export function findUnknownSelectionValues(
  raw: ScheduleSelectionInput | null | undefined,
  catalog: ScheduleSelectionCatalog
): UnknownSelectionValues | null {
  return sanitizeSelectionInput(raw, catalog).ignored
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
      model: normalizeModelSpec(args.model),
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
  if (args.model !== undefined) {
    const next = normalizeModelSpec(args.model)
    if ((task.model ?? null) !== next) {
      patch.model = next
      changed.push('model')
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
