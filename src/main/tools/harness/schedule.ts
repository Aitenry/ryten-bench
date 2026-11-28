/**
 * Scheduled task tools: `schedule_create` / `schedule_list` / `schedule_view` / `schedule_edit`.
 *
 * Recurrence rules use an explicit subset (once / every / daily) instead of RFC 5545 rrules; a
 * task belongs to the conversation in which it was created. Actual firing is handled by the main
 * process's `schedule-runner` (starts a turn with a headless sender while the window exists).
 *
 * The tool surface mirrors the Schedules page one-for-one (2026-11-28 redesign):
 * - create: title / prompt / rule / target (this conversation or a new one per run) / run
 *   selection (tools, skills, MCP) / model override;
 * - edit: **partial** — only the fields passed are written; `null` clears a value.
 *
 * The "pure" mapping (args → store input / patch, target derivation rules) lives in
 * `runtime/harness/schedule-tool-core.ts` and `schedule-target.ts` so it can be tested without
 * electron; this file only does validation, wiring and result text.
 */
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { mainFormat } from '../../i18n'
import { getScheduleToolTexts } from '../../i18n/tool-results-schedule'
import type { ToolInfo } from '../../plugins/tool-contract'
import {
  MAX_SCHEDULED_TASKS,
  isScheduleStoreConfigured,
  scheduleStore
} from '../../runtime/harness/schedule-store'
import type { ScheduleRunRecord, ScheduledTask } from '../../runtime/harness/schedule-types'
import {
  computeNextRun,
  describeScheduleWhen,
  validateScheduleWhen,
  type ScheduleValidationFailure,
  type ScheduleWhen
} from '../../runtime/harness/schedule-core'
import {
  buildCreateInput,
  buildUpdatePatch,
  findUnknownSelectionValues,
  type ScheduleCreateFailure,
  type ScheduleEditField,
  type ScheduleEditFailure,
  type ScheduleSelectionCatalog,
  type TargetSession,
  type UnknownSelectionValues
} from '../../runtime/harness/schedule-tool-core'
import {
  isScheduleConversationResolverConfigured,
  resolveScheduleConversation
} from '../../runtime/harness/schedule-target'
import { scheduleSelectionValues, modelSelectionValues } from './capabilities'

/** Only topicId is needed from the tool invoke config */
interface ScheduleToolConfig {
  configurable?: { topicId?: unknown }
}

const whenSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('once'),
    at: z.string().describe('ISO 8601 timestamp of the single run, e.g. 2026-11-28T09:00:00+08:00')
  }),
  z.object({
    kind: z.literal('every'),
    minutes: z.number().int().describe('Run every N minutes (5-10080)')
  }),
  z.object({
    kind: z.literal('daily'),
    time: z.string().describe('Run every day at this local time, HH:MM (24h; midnight is "00:00")')
  })
])

/** Where the task runs (mirrors the page's "conversation" field) */
const targetSessionSchema = z
  .enum(['this', 'new'])
  .describe(
    '"this" (default) = keep running in this conversation; "new" = open a brand-new conversation on every run (same mode / workspace / memory as this one)'
  )

/** Task-level run selection (mirrors the page's tools / skills / MCP fields) */
const selectionSchema = z.object({
  tools: z
    .array(z.string())
    .nullish()
    .describe(
      'Selectable tool names exactly as returned by list_capabilities with kind:"tools" (e.g. "personal_ledger", "schedule-tasks"). ' +
        'MCP servers belong in mcpTools (`mcp@<namespace>`), not here. ' +
        'Runtime built-in tools (task, read_file, write_file, execute, ask_user_question, skill, …) are provided automatically by the runtime and must NOT be listed here. ' +
        'Any unknown name rejects the whole call.'
    ),
  skills: z
    .array(z.string())
    .nullish()
    .describe(
      'Skill ids exactly as returned by list_capabilities with kind:"skills" (omit / null = no skills); unknown ids reject the whole call'
    ),
  mcpTools: z
    .array(z.string())
    .nullish()
    .describe(
      'MCP server values exactly as returned by list_capabilities with kind:"mcp", e.g. "mcp@filesystem" (omit / null = no MCP); unknown values reject the whole call'
    )
})

/** Model override: `provider:model` exactly as listed by list_capabilities (kind:"models") */
const modelSchema = z
  .string()
  .nullish()
  .describe(
    'Model for every run as "provider:model", exactly as returned by list_capabilities with kind:"models" (e.g. "deepseek:deepseek-chat"). ' +
      'Omit / null = use the app default model; an unknown value rejects the call. If the chosen provider is later disabled or deleted, the run falls back to the default model.'
  )

/** Current conversation id (used as task ownership at creation and as the "this" target; <=0 = none) */
function topicIdOf(config: unknown): number {
  const cfg = config as ScheduleToolConfig | undefined
  const id = cfg?.configurable?.topicId
  return typeof id === 'number' && id > 0 ? id : 0
}

/** Trigger rule validation failure → readable text */
function invalidWhenText(reason: ScheduleValidationFailure): string {
  const texts = getScheduleToolTexts()
  const detail = texts.reasons[reason] ?? reason
  return mainFormat(texts.invalidWhen, { reason: detail })
}

/** Create failure → readable text */
function createFailureText(reason: ScheduleCreateFailure): string {
  const texts = getScheduleToolTexts()
  if (reason === 'no-topic') return texts.noTopic
  return texts.noTargetResolved
}

/** Edit failure → readable text */
function editFailureText(reason: ScheduleEditFailure): string {
  const texts = getScheduleToolTexts()
  if (reason === 'no-topic') return texts.noTopic
  if (reason === 'no-target') return texts.noTargetResolved
  return texts.nothingChanged
}

/**
 * Unknown `agentConfig` values → readable text.
 *
 * Rejecting (instead of silently dropping) keeps "what the model asked for" and "what is stored"
 * identical: a bad value would otherwise override the conversation's selection with names the
 * run-time registry drops, leaving the run without the tools the user picked in the input box.
 */
function invalidSelectionText(unknown: UnknownSelectionValues): string {
  const texts = getScheduleToolTexts()
  const details: string[] = []
  if (unknown.tools.length > 0) {
    details.push(mainFormat(texts.selectionUnknownTools, { values: unknown.tools.join(', ') }))
  }
  if (unknown.skills.length > 0) {
    details.push(mainFormat(texts.selectionUnknownSkills, { values: unknown.skills.join(', ') }))
  }
  if (unknown.mcp.length > 0) {
    details.push(mainFormat(texts.selectionUnknownMcp, { values: unknown.mcp.join(', ') }))
  }
  return mainFormat(texts.invalidSelection, { details: details.join(texts.selectionSeparator) })
}

/**
 * Validate the task's model override against the enabled model routes.
 *
 * `undefined` = keep the current value (edit) / use the default (create); `null`/empty = clear the
 * override. An unknown non-empty spec is rejected: silently substituting a different model would
 * make the task run on something the user did not choose. A spec that becomes unavailable *later*
 * (provider disabled/deleted) falls back to the default at run time, which the user cannot act on
 * from the tool call.
 */
async function validateScheduleModel(
  raw: string | null | undefined
): Promise<{ ok: true; value: string | null | undefined } | { ok: false; error: string }> {
  if (raw === undefined) return { ok: true, value: undefined }
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return { ok: true, value: null }
  const texts = getScheduleToolTexts()
  const models = await modelSelectionValues()
  if (!models.has(value)) {
    const ids = Array.from(models).join(', ') || texts.none
    return { ok: false, error: mainFormat(texts.invalidModel, { model: value, ids }) }
  }
  return { ok: true, value }
}

/** Run state → localized label */
function runStatusText(
  texts: ReturnType<typeof getScheduleToolTexts>,
  status: ScheduledTask['lastStatus']
): string {
  if (status === 'completed') return texts.runStatusCompleted
  if (status === 'cancelled') return texts.runStatusCancelled
  if (status === 'failed') return texts.runStatusFailed
  return texts.none
}

/** Human-readable target for list/detail views */
function describeTarget(
  texts: ReturnType<typeof getScheduleToolTexts>,
  task: ScheduledTask
): string {
  if (task.topicId != null) return mainFormat(texts.targetThis, { topicId: String(task.topicId) })
  return mainFormat(texts.targetNew, { mode: task.targetMode ?? texts.targetModeWork })
}

/** Human-readable task-level selection: "—" everywhere means "follow the conversation" */
function describeSelection(
  texts: ReturnType<typeof getScheduleToolTexts>,
  task: ScheduledTask
): string {
  const selection = task.agentConfig
  const join = (names: string[] | null | undefined): string =>
    names && names.length > 0 ? names.join(', ') : texts.selectionNone
  return mainFormat(texts.viewSelection, {
    tools: join(selection?.tools),
    skills: join(selection?.skills),
    mcp: join(selection?.mcpTools)
  })
}

/** Detail text for one task (run records are read by the caller as needed) */
function viewText(task: ScheduledTask, runs: ScheduleRunRecord[]): string {
  const texts = getScheduleToolTexts()
  const lines = [
    mainFormat(texts.viewHeader, { id: task.id, title: task.title }),
    mainFormat(texts.viewWhen, { when: describeScheduleWhen(task.when) }),
    mainFormat(texts.viewState, {
      state: task.enabled ? texts.stateEnabled : texts.statePaused
    }),
    mainFormat(texts.viewNext, { next: task.nextRunAt ?? texts.none }),
    mainFormat(texts.viewTarget, { target: describeTarget(texts, task) }),
    mainFormat(texts.viewModel, { model: task.model ?? texts.modelDefault }),
    describeSelection(texts, task),
    mainFormat(texts.viewTopic, { topicId: String(task.topicId ?? texts.none) }),
    mainFormat(texts.viewPrompt, { prompt: task.prompt })
  ]
  if (task.lastRunAt) {
    lines.splice(
      4,
      0,
      mainFormat(texts.viewLast, {
        last: task.lastRunAt,
        status: runStatusText(texts, task.lastStatus)
      })
    )
  }
  if (runs.length > 0) {
    lines.push(texts.viewRecentRuns)
    for (const run of runs.slice(-3)) {
      lines.push(
        mainFormat(texts.viewRunItem, { time: run.at, status: runStatusText(texts, run.status) })
      )
    }
  }
  return lines.join('\n')
}

/** Changed-field list → readable labels ("标题、触发规则") */
function describeFields(
  texts: ReturnType<typeof getScheduleToolTexts>,
  fields: ScheduleEditField[]
): string {
  const labels: Record<ScheduleEditField, string> = {
    title: texts.fieldTitle,
    prompt: texts.fieldPrompt,
    when: texts.fieldWhen,
    target: texts.fieldTarget,
    agentConfig: texts.fieldSelection,
    model: texts.fieldModel,
    enabled: texts.fieldEnabled
  }
  return fields.map((field) => labels[field]).join(texts.fieldSeparator)
}

/** Dependencies the schedule tools need from the registry (injected by builders.ts) */
export interface ScheduleToolDeps {
  /**
   * Selectable tool catalog — the same source as the Schedules page and `list_capabilities`.
   * Called per invocation so plugin enable/disable and MCP changes are reflected immediately.
   */
  availableTools: () => ToolInfo[]
}

/** Build the four scheduled-task tools */
export function buildScheduleTools(deps: ScheduleToolDeps): StructuredToolInterface[] {
  /** Values the Schedules page could pick (same source as list_capabilities) */
  const selectionCatalog = (): ScheduleSelectionCatalog =>
    scheduleSelectionValues(deps.availableTools())

  const create = tool(
    async (
      { title, prompt, when, targetSession, targetConversationId, agentConfig, model },
      config
    ) => {
      const texts = getScheduleToolTexts()
      if (!isScheduleStoreConfigured()) return texts.notConfigured
      const callerTopicId = topicIdOf(config)
      if (callerTopicId <= 0) return texts.noTopic
      const unknownSelection = findUnknownSelectionValues(agentConfig, selectionCatalog())
      if (unknownSelection) return invalidSelectionText(unknownSelection)
      const modelCheck = await validateScheduleModel(model)
      if (!modelCheck.ok) return modelCheck.error
      const validated = validateScheduleWhen(when as ScheduleWhen)
      if (!validated.ok) return invalidWhenText(validated.reason)
      // Explicit conversation wins over "this"; "new" still inherits from the caller's conversation
      const topicId = targetConversationId ?? callerTopicId
      // Needed for the "this" target's workspace columns and for the "new" target's mode /
      // workspace / memory scope (null when the resolver is not wired)
      const conversation = isScheduleConversationResolverConfigured()
        ? await resolveScheduleConversation(topicId)
        : null
      const built = buildCreateInput(
        {
          title,
          prompt,
          when: when as ScheduleWhen,
          targetSession: (targetConversationId != null
            ? 'this'
            : (targetSession ?? 'this')) as TargetSession,
          agentConfig,
          model: modelCheck.value
        },
        { topicId, conversation, nextRunAt: validated.nextRunAt }
      )
      if (!built.ok) return createFailureText(built.reason)
      try {
        const task = await scheduleStore.create(built.input)
        return mainFormat(texts.created, {
          id: task.id,
          title: task.title,
          when: describeScheduleWhen(task.when),
          next: task.nextRunAt ?? texts.none
        })
      } catch (err) {
        const message = (err as Error).message
        if (message.includes('too many')) {
          return mainFormat(texts.tooMany, { max: MAX_SCHEDULED_TASKS })
        }
        return message
      }
    },
    {
      name: 'schedule_create',
      description:
        'Create a scheduled task (same fields as the Schedules page): a message containing your prompt is delivered as a new user turn at the given time(s), so you can do recurring work (reminders, periodic checks, daily summaries). ' +
        '`when`: {kind:"once", at: ISO time} | {kind:"every", minutes: 5-10080} | {kind:"daily", time: "HH:MM"} in local 24-hour time (midnight is "00:00"; "24:00" is rejected). ' +
        '`targetSession`: "this" (default) keeps running in this conversation, "new" opens a brand-new conversation on every run (inheriting this conversation\'s mode, workspace and memory). ' +
        '`targetConversationId`: run in another existing conversation instead (id from conversation_list). ' +
        "`agentConfig`: the tools / skills / MCP servers used on every run; omit it to follow this conversation's own selection. Before filling it, call list_capabilities (kind: tools / skills / mcp) to get the exact values — pass an id as query to read one item in full. " +
        '`model`: optional model override "provider:model" for every run (from list_capabilities kind:"models"); omit it to use the app default model. ' +
        'Only values returned by list_capabilities are accepted: built-in runtime tools (task, read_file, write_file, execute, ask_user_question, skill, …) are provided automatically by the runtime and must not be listed; a name outside the catalog rejects the call. ' +
        'Scheduled runs are unattended: ask_user_question / plan-approval and other blocking interactions are not mounted, so write the prompt so the task can finish without user input. ' +
        'Use this whenever the user asks for something recurring or at a fixed time ("every day / every week", 每天/每晚/每周/定时) — do not turn such requests into a long-running goal. Tasks fire while the app is running; missed runs are skipped, not replayed.',
      schema: z.object({
        title: z.string().describe('Short title shown in the task list (<=120 chars)'),
        prompt: z
          .string()
          .describe(
            'The message to deliver when the task fires; write it as a complete instruction'
          ),
        when: whenSchema,
        targetSession: targetSessionSchema.optional(),
        targetConversationId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Run in that existing conversation instead of this one (id from conversation_list). Ignored when targetSession is "new".'
          ),
        agentConfig: selectionSchema.nullish(),
        model: modelSchema
      })
    }
  )

  const list = tool(
    async () => {
      const texts = getScheduleToolTexts()
      if (!isScheduleStoreConfigured()) return texts.notConfigured
      const tasks = (await scheduleStore.list()).sort(
        (a, b) => Date.parse(a.nextRunAt ?? '0') - Date.parse(b.nextRunAt ?? '0')
      )
      if (tasks.length === 0) return texts.listEmpty
      const header = mainFormat(texts.listHeader, { count: String(tasks.length) })
      const rows = tasks.map((task) =>
        mainFormat(texts.listItem, {
          id: task.id,
          title: task.title,
          when: describeScheduleWhen(task.when),
          state: task.enabled ? texts.stateEnabled : texts.statePaused,
          next:
            task.enabled && task.nextRunAt
              ? mainFormat(texts.nextSuffix, { next: task.nextRunAt })
              : ''
        })
      )
      return [header, ...rows].join('\n')
    },
    {
      name: 'schedule_list',
      isConcurrencySafe: () => true,
      description:
        'List the scheduled tasks of this app (id, title, rule, state, next run). Use schedule_view for the full prompt, target and run selection of one task.',
      schema: z.object({})
    }
  )

  const view = tool(
    async ({ id }) => {
      const texts = getScheduleToolTexts()
      if (!isScheduleStoreConfigured()) return texts.notConfigured
      const task = await scheduleStore.get(id)
      if (!task) return mainFormat(texts.notFound, { id })
      const runs = await scheduleStore.listRuns(id, 5)
      return viewText(task, runs)
    },
    {
      name: 'schedule_view',
      isConcurrencySafe: () => true,
      description:
        'Read one scheduled task in full: rule, state, next run, target conversation, model, run selection (tools / skills / MCP) and prompt.',
      schema: z.object({ id: z.string().describe('Task id from schedule_list') })
    }
  )

  const edit = tool(
    async (
      {
        id,
        action,
        title,
        prompt,
        when,
        agentConfig,
        model,
        targetSession,
        targetConversationId,
        enabled
      },
      config
    ) => {
      const texts = getScheduleToolTexts()
      if (!isScheduleStoreConfigured()) return texts.notConfigured
      const task = await scheduleStore.get(id)
      if (!task) return mainFormat(texts.notFound, { id })

      if (action === 'delete') {
        await scheduleStore.remove(id)
        return mainFormat(texts.deleted, { id })
      }

      if (agentConfig !== undefined) {
        const unknownSelection = findUnknownSelectionValues(agentConfig, selectionCatalog())
        if (unknownSelection) return invalidSelectionText(unknownSelection)
      }
      const modelCheck = await validateScheduleModel(model)
      if (!modelCheck.ok) return modelCheck.error

      const callerTopicId = topicIdOf(config)
      const normalizedWhen = when as ScheduleWhen | undefined
      let nextRunAt: string | null | undefined
      if (normalizedWhen !== undefined) {
        const validated = validateScheduleWhen(normalizedWhen)
        if (!validated.ok) return invalidWhenText(validated.reason)
        nextRunAt = validated.nextRunAt
      }
      // An explicit conversation points the task at that topic ("this" semantics); otherwise the
      // target change applies to the conversation the tool was called from
      const topicId = targetConversationId ?? callerTopicId
      const effectiveTargetSession: TargetSession | undefined =
        targetConversationId != null ? 'this' : targetSession
      const conversation =
        effectiveTargetSession !== undefined && isScheduleConversationResolverConfigured()
          ? await resolveScheduleConversation(topicId)
          : null
      const built = buildUpdatePatch(
        {
          title,
          prompt,
          when: normalizedWhen,
          agentConfig,
          model: modelCheck.value,
          targetSession: effectiveTargetSession,
          enabled
        },
        task,
        { topicId, conversation }
      )
      if (!built.ok) return editFailureText(built.reason)

      // Paused tasks have no next run; re-enabling recomputes it from "now" (a missed run is not
      // replayed, see schedule-core)
      if (built.patch.enabled === false) nextRunAt = null
      if (built.patch.enabled === true && nextRunAt === undefined) {
        const next = computeNextRun(built.patch.when ?? task.when, new Date())
        nextRunAt = next ? next.toISOString() : null
      }
      if (nextRunAt !== undefined) built.patch.nextRunAt = nextRunAt
      const updated = await scheduleStore.update(id, built.patch)
      if (!updated) return mainFormat(texts.notFound, { id })

      const nextText =
        updated.nextRunAt && updated.enabled
          ? mainFormat(texts.nextSuffixInResult, { next: updated.nextRunAt })
          : ''
      return mainFormat(texts.updatedFields, {
        id,
        title: updated.title,
        fields: describeFields(texts, built.changed),
        next: nextText
      })
    },
    {
      name: 'schedule_edit',
      description:
        'Update a scheduled task. Only the fields you pass are written — everything else stays as it is (undefined = keep, null = clear). ' +
        'Fields: title, prompt, when (same rules as schedule_create), targetSession ("this" conversation or "new" conversation per run), targetConversationId (move the task to that existing conversation), ' +
        'agentConfig (tools / skills / MCP for every run; pass null to clear it and follow the conversation again), model (provider:model for every run; pass null to return to the default model), enabled (false = pause, true = resume). ' +
        'For agentConfig / model values, call list_capabilities (kind: tools / skills / mcp / models) first; pass an id as query to read one item in full. ' +
        'Only catalog values are accepted — built-in runtime tools (task, read_file, execute, …) are provided automatically by the runtime and must not be listed; an unknown name rejects the call. ' +
        'Use action:"delete" to delete the task.',
      schema: z.object({
        id: z.string().describe('Task id from schedule_list'),
        action: z.enum(['update', 'delete']).optional().describe('"update" (default) or "delete"'),
        title: z.string().optional().describe('New title'),
        prompt: z.string().optional().describe('New delivered prompt'),
        when: whenSchema.optional().describe('New schedule rule'),
        targetSession: targetSessionSchema.optional(),
        targetConversationId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Move the task to that existing conversation (id from conversation_list); ignored when targetSession is "new"'
          ),
        agentConfig: selectionSchema.nullish(),
        model: modelSchema,
        enabled: z.boolean().optional().describe('false = pause, true = resume')
      })
    }
  )

  return [create, list, view, edit]
}
