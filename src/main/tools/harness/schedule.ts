/**
 * 定时任务工具：`schedule_create` / `schedule_list` / `schedule_view` / `schedule_edit`。
 *
 * 对照 DSH 的 `@deepseek-ai/dsh-tool-schedule`（RFC 5545 rrule + 会话目标）；本项目用
 * 显式子集（once / every / daily）表达重复规则，任务归属创建时所在的会话。真正的触发
 * 由主进程的 `schedule-runner` 负责（窗口存在时以无头 sender 启动一轮）。
 */
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { mainFormat } from '../../i18n'
import { getScheduleToolTexts } from '../../i18n/tool-results-schedule'
import {
  MAX_SCHEDULED_TASKS,
  isScheduleStoreConfigured,
  scheduleStore,
  type ScheduledTask
} from '../../runtime/harness/schedule-store'
import {
  computeNextRun,
  describeScheduleWhen,
  validateScheduleWhen,
  type ScheduleValidationFailure,
  type ScheduleWhen
} from '../../runtime/harness/schedule-core'

/** 工具运行配置里只需要 topicId */
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
    time: z.string().describe('Run every day at this local time, HH:MM')
  })
])

/** 当前会话 id（创建任务时归属用；<=0 视为没有会话） */
function topicIdOf(config: unknown): number {
  const cfg = config as ScheduleToolConfig | undefined
  const id = cfg?.configurable?.topicId
  return typeof id === 'number' && id > 0 ? id : 0
}

/** 触发规则校验失败 → 可读文案 */
function invalidWhenText(reason: ScheduleValidationFailure): string {
  const texts = getScheduleToolTexts()
  const detail = texts.reasons[reason] ?? reason
  return mainFormat(texts.invalidWhen, { reason: detail })
}

/** 执行状态 → 本地化标签 */
function runStatusText(
  texts: ReturnType<typeof getScheduleToolTexts>,
  status: ScheduledTask['lastStatus']
): string {
  if (status === 'completed') return texts.runStatusCompleted
  if (status === 'cancelled') return texts.runStatusCancelled
  if (status === 'failed') return texts.runStatusFailed
  return texts.none
}

/** 单条任务的详情文本 */
function viewText(task: ScheduledTask): string {
  const texts = getScheduleToolTexts()
  const lines = [
    mainFormat(texts.viewHeader, { id: task.id, title: task.title }),
    mainFormat(texts.viewWhen, { when: describeScheduleWhen(task.when) }),
    mainFormat(texts.viewState, {
      state: task.enabled ? texts.stateEnabled : texts.statePaused
    }),
    mainFormat(texts.viewNext, { next: task.nextRunAt ?? texts.none }),
    mainFormat(texts.viewTopic, { topicId: String(task.topicId) }),
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
  const runs = (task.runs ?? []).slice(-3)
  if (runs.length > 0) {
    lines.push(texts.viewRecentRuns)
    for (const run of runs) {
      lines.push(
        mainFormat(texts.viewRunItem, { time: run.at, status: runStatusText(texts, run.status) })
      )
    }
  }
  return lines.join('\n')
}

/** 构造四个定时任务工具 */
export function buildScheduleTools(): StructuredToolInterface[] {
  const create = tool(
    async ({ title, prompt, when }, config) => {
      const texts = getScheduleToolTexts()
      if (!isScheduleStoreConfigured()) return texts.notConfigured
      const topicId = topicIdOf(config)
      if (topicId <= 0) return texts.noTopic
      const validated = validateScheduleWhen(when as ScheduleWhen)
      if (!validated.ok) return invalidWhenText(validated.reason)
      try {
        const task = scheduleStore.create({
          title: title.trim(),
          prompt: prompt.trim(),
          when: when as ScheduleWhen,
          topicId,
          nextRunAt: validated.nextRunAt
        })
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
        'Create a scheduled task for THIS conversation: at the given time(s) a message containing your prompt is delivered as a new user turn, so you can do recurring work (reminders, periodic checks, daily summaries). Rules: {kind:"once", at: ISO time}, {kind:"every", minutes: 5-10080}, or {kind:"daily", time: "HH:MM" local}. Tasks run while the app is running; missed runs are skipped, not replayed.',
      schema: z.object({
        title: z.string().describe('Short title shown in the task list (<=120 chars)'),
        prompt: z
          .string()
          .describe('The message to deliver when the task fires; write it as a complete instruction'),
        when: whenSchema
      })
    }
  )

  const list = tool(
    async () => {
      const texts = getScheduleToolTexts()
      if (!isScheduleStoreConfigured()) return texts.notConfigured
      const tasks = scheduleStore
        .list()
        .sort((a, b) => Date.parse(a.nextRunAt ?? '0') - Date.parse(b.nextRunAt ?? '0'))
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
        'List the scheduled tasks of this app (id, title, rule, state, next run). Use schedule_view for the full prompt of one task.',
      schema: z.object({})
    }
  )

  const view = tool(
    async ({ id }) => {
      const texts = getScheduleToolTexts()
      if (!isScheduleStoreConfigured()) return texts.notConfigured
      const task = scheduleStore.get(id)
      return task ? viewText(task) : mainFormat(texts.notFound, { id })
    },
    {
      name: 'schedule_view',
      isConcurrencySafe: () => true,
      description: 'Read one scheduled task in full (rule, state, next run, conversation, prompt).',
      schema: z.object({ id: z.string().describe('Task id from schedule_list') })
    }
  )

  const edit = tool(
    async ({ id, action, title, prompt, when }) => {
      const texts = getScheduleToolTexts()
      if (!isScheduleStoreConfigured()) return texts.notConfigured
      const task = scheduleStore.get(id)
      if (!task) return mainFormat(texts.notFound, { id })

      if (action === 'delete') {
        scheduleStore.remove(id)
        return mainFormat(texts.deleted, { id })
      }
      if (action === 'pause') {
        scheduleStore.update(id, { enabled: false, nextRunAt: null })
        return mainFormat(texts.paused, { id, title: task.title })
      }
      if (action === 'resume') {
        const validated = validateScheduleWhen(task.when)
        if (!validated.ok) return invalidWhenText(validated.reason)
        scheduleStore.update(id, { enabled: true, nextRunAt: validated.nextRunAt })
        return mainFormat(texts.resumed, { id, title: task.title, next: validated.nextRunAt })
      }

      // update
      const nextWhen = (when as ScheduleWhen | undefined) ?? task.when
      let nextRunAt = task.nextRunAt
      if (when) {
        const validated = validateScheduleWhen(nextWhen)
        if (!validated.ok) return invalidWhenText(validated.reason)
        nextRunAt = validated.nextRunAt
      } else if (task.enabled) {
        const next = computeNextRun(task.when, new Date())
        nextRunAt = next ? next.toISOString() : null
      }
      const updated = scheduleStore.update(id, {
        title: title?.trim() || task.title,
        prompt: prompt?.trim() || task.prompt,
        when: nextWhen,
        nextRunAt,
        enabled: nextRunAt !== null
      })
      return mainFormat(texts.updated, {
        id,
        title: updated?.title ?? task.title,
        when: describeScheduleWhen(nextWhen),
        next: updated?.nextRunAt ?? texts.none
      })
    },
    {
      name: 'schedule_edit',
      description:
        'Change a scheduled task: action "update" (optionally new title/prompt/when), "pause", "resume" or "delete". Pausing keeps the rule; resuming recomputes the next run from now.',
      schema: z.object({
        id: z.string().describe('Task id from schedule_list'),
        action: z.enum(['update', 'pause', 'resume', 'delete']),
        title: z.string().optional().describe('update: new title'),
        prompt: z.string().optional().describe('update: new delivered prompt'),
        when: whenSchema.optional().describe('update: new schedule rule')
      })
    }
  )

  return [create, list, view, edit]
}
