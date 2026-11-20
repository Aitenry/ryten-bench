import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import logger from 'electron-log'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'

/**
 * 后台任务系统（jobs）— 对应 deepseek-harness 的 dsh-jobs / dsh-tool-jobs 体系
 *
 * 机制（参考 DSH，适配 RytenBench 按 topicId 组织的对话）：
 * - 进程级注册表：ID 形如 `<kind>-N`（kind=subagent/workflow/…）；
 * - owner 隔离按 topicId：模型工具只能看到本话题的任务；
 * - job_output 流式增量读取（单消费游标）：每次返回上次以来的新增输出，
 *   终态时返回最终输出（幂等）并标记 reported；
 * - wait 语义：阻塞至终态或超时，超时不取消任务、返回当前快照（[status: running]）；
 * - kill：先取消再置 stopping → 终态 killed；已终态返回 already-finished；
 * - settlement first-wins：先提交终态并释放等待者，后广播。
 */

export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/** 任务快照（模型工具与前端共用） */
export interface JobSnapshot {
  id: string
  kind: string
  label: string
  status: JobStatus
  detail?: string
  startedAt: number
  finishedAt?: number
}

interface JobRecord extends JobSnapshot {
  topicId: number
  outputFrames: string[]
  cancelFn?: (reason?: string) => void
  /** 输出游标（job_output 已读取到的帧位置） */
  cursor: number
  /** 终态输出是否已被 job_output 取走 */
  reported: boolean
  settleResolvers: Array<() => void>
}

/** 任务句柄：运行者用它推送输出与结算 */
export interface JobHandle {
  id: string
  /** 追加一段输出（触发等待者） */
  appendOutput: (text: string) => void
  /** 请求取消（由 kill 调用；运行者应尽快结束） */
  cancel: (reason?: string) => void
  /** 结算（first-wins）：completed / failed / killed（取消路径由运行者结算） */
  settle: (status: 'completed' | 'failed' | 'killed', output?: string, error?: string) => void
}

export type JobsUpdateListener = (topicId: number, jobs: JobSnapshot[]) => void

/** 后台任务注册表（进程级单例，按 topicId 隔离） */
export class JobsRegistry {
  private readonly jobs = new Map<string, JobRecord>()
  private readonly counters = new Map<string, number>()

  /** 每个话题最多保留的「已上报终态」任务数（修复：此前终态任务永不清理，
   *  long-running 会话中 job_list 全量序列化与广播输出线性膨胀） */
  private static readonly MAX_TERMINAL_PER_TOPIC = 50

  /** 变更回调（主进程注入，广播 harness-jobs-updated） */
  onChange?: JobsUpdateListener

  /** 启动任务：返回句柄（ID 自动分配 `<kind>-N`；idOverride 用于会话型任务复用固定 ID） */
  start(topicId: number, kind: string, label: string, idOverride?: string): JobHandle {
    const id =
      idOverride ??
      ((): string => {
        const n = (this.counters.get(kind) ?? 0) + 1
        this.counters.set(kind, n)
        return `${kind}-${n}`
      })()
    if (idOverride) {
      const match = /^(.+)-(\d+)$/.exec(idOverride)
      if (match) {
        const n = Number(match[2])
        if (Number.isFinite(n) && n > (this.counters.get(match[1]) ?? 0)) {
          this.counters.set(match[1], n)
        }
      }
    }
    const record: JobRecord = {
      id,
      kind,
      label,
      status: 'running',
      startedAt: Date.now(),
      topicId,
      outputFrames: [],
      cursor: 0,
      reported: false,
      settleResolvers: []
    }
    this.jobs.set(id, record)
    this.broadcast(topicId)
    return {
      id,
      appendOutput: (text) => {
        if (record.status !== 'running') return
        record.outputFrames.push(text)
        this.wakeWaiters(record)
      },
      cancel: (reason) => {
        record.cancelFn?.(reason)
      },
      settle: (status, output, error) => {
        if (record.status !== 'running' && record.status !== 'stopping') return // first-wins
        if (output) record.outputFrames.push(output)
        record.status = status
        record.finishedAt = Date.now()
        if (error) record.detail = error
        this.wakeWaiters(record)
        this.broadcast(topicId)
        this.pruneTerminal(topicId)
        logger.info(`[Jobs] 任务 ${id} 结算为 ${status}`)
      }
    }
  }

  /** 绑定取消回调（运行者在启动时注册） */
  attachCancel(id: string, fn: (reason?: string) => void): void {
    const record = this.jobs.get(id)
    if (record) record.cancelFn = fn
  }

  /** 话题内任务快照列表 */
  list(topicId: number): JobSnapshot[] {
    return [...this.jobs.values()].filter((j) => j.topicId === topicId).map((j) => this.snapshot(j))
  }

  get(id: string): JobSnapshot | undefined {
    const record = this.jobs.get(id)
    return record ? this.snapshot(record) : undefined
  }

  /** 增量读取：返回上次以来的新增输出；终态时返回最终输出（幂等，标记 reported） */
  read(id: string, topicId: number): { text: string; job: JobSnapshot | undefined } {
    const record = this.jobs.get(id)
    if (!record || record.topicId !== topicId) {
      return {
        text: mainFormat(getAgentToolTexts().jobs.notFoundInTopic, { id }),
        job: undefined
      }
    }
    const frames = record.outputFrames.slice(record.cursor)
    record.cursor = record.outputFrames.length
    let text = frames.join('\n')
    const terminal = record.status !== 'running' && record.status !== 'stopping'
    if (terminal && !record.reported) {
      record.reported = true
      if (!text) {
        text =
          record.detail ??
          mainFormat(getAgentToolTexts().jobs.terminalNoOutput, { status: record.status })
      }
    }
    return { text, job: this.snapshot(record) }
  }

  /** 等待任务至终态或超时（超时不取消任务） */
  async wait(
    id: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ text: string; job: JobSnapshot | undefined; timedOut: boolean }> {
    const record = this.jobs.get(id)
    if (!record) {
      return {
        text: mainFormat(getAgentToolTexts().jobs.notFound, { id }),
        job: undefined,
        timedOut: false
      }
    }
    const terminal = (r: JobRecord): boolean => r.status !== 'running' && r.status !== 'stopping'
    if (terminal(record)) return { ...this.read(id, record.topicId), timedOut: false }
    const deadline = Date.now() + timeoutMs
    while (!terminal(record) && Date.now() < deadline && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        record.settleResolvers.push(resolve)
        setTimeout(resolve, Math.min(250, Math.max(10, deadline - Date.now())))
      })
    }
    if (!terminal(record)) {
      return {
        text: this.read(id, record.topicId).text,
        job: this.snapshot(record),
        timedOut: true
      }
    }
    return { ...this.read(id, record.topicId), timedOut: false }
  }

  /** 终止任务：已终态返回 already-finished；否则 cancel + stopping → killed */
  kill(
    id: string,
    topicId: number,
    reason?: string
  ): {
    outcome: 'cancellation-requested' | 'already-finished' | 'not-found'
    job: JobSnapshot | undefined
  } {
    const record = this.jobs.get(id)
    if (!record || record.topicId !== topicId) {
      return { outcome: 'not-found', job: undefined }
    }
    const terminal = record.status !== 'running' && record.status !== 'stopping'
    if (terminal) return { outcome: 'already-finished', job: this.snapshot(record) }
    record.status = 'stopping'
    record.detail = reason || getAgentToolTexts().jobs.userKillReason
    record.cancelFn?.(reason)
    // 运行者应在 cancel 后自行 settle(killed)；兜底：5 秒后仍未结算则强制 killed
    setTimeout(() => {
      const current = this.jobs.get(id)
      if (current && (current.status === 'stopping' || current.status === 'running')) {
        current.status = 'killed'
        current.finishedAt = Date.now()
        this.wakeWaiters(current)
        this.broadcast(current.topicId)
        logger.warn(`[Jobs] 任务 ${id} 取消超时，强制 killed`)
      }
    }, 5000)
    this.broadcast(topicId)
    return { outcome: 'cancellation-requested', job: this.snapshot(record) }
  }

  /** 话题删除时清理任务（先全部 kill） */
  clearTopic(topicId: number): void {
    for (const record of [...this.jobs.values()]) {
      if (record.topicId !== topicId) continue
      if (record.status === 'running' || record.status === 'stopping') {
        record.cancelFn?.(getAgentToolTexts().jobs.topicDeletedReason)
        record.status = 'killed'
        record.finishedAt = Date.now()
      }
      this.jobs.delete(record.id)
    }
  }

  /** 裁剪已上报的终态任务：每个话题保留最近 MAX_TERMINAL_PER_TOPIC 条 */
  private pruneTerminal(topicId: number): void {
    const terminals = [...this.jobs.values()].filter(
      (j) =>
        j.topicId === topicId && j.status !== 'running' && j.status !== 'stopping' && j.reported
    )
    if (terminals.length <= JobsRegistry.MAX_TERMINAL_PER_TOPIC) return
    terminals
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
      .slice(0, terminals.length - JobsRegistry.MAX_TERMINAL_PER_TOPIC)
      .forEach((j) => this.jobs.delete(j.id))
  }

  private snapshot(record: JobRecord): JobSnapshot {
    return {
      id: record.id,
      kind: record.kind,
      label: record.label,
      status: record.status,
      detail: record.detail,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt
    }
  }

  private wakeWaiters(record: JobRecord): void {
    while (record.settleResolvers.length > 0) {
      record.settleResolvers.shift()?.()
    }
  }

  private broadcast(topicId: number): void {
    this.onChange?.(topicId, this.list(topicId))
  }
}

/** 进程级单例 */
export const jobsRegistry = new JobsRegistry()

/** job_output 默认/上限等待时间（对齐 DSH：默认 30s、上限 10min） */
export const JOB_WAIT_DEFAULT_MS = 30_000
export const JOB_WAIT_MAX_MS = 600_000

/** 构建后台任务工具集（仅注入主代理；任务归属当前话题） */
export function buildJobTools(registry: JobsRegistry, topicId: number): StructuredToolInterface[] {
  return [
    tool(
      async ({ job_id, wait, timeout_ms }, config) => {
        const m = getAgentToolTexts()
        if (wait) {
          const timeout = Math.min(JOB_WAIT_MAX_MS, Math.max(1, timeout_ms ?? JOB_WAIT_DEFAULT_MS))
          const result = await registry.wait(job_id, timeout, config?.signal ?? undefined)
          const text = result.text || mainFormat(m.jobs.noNewOutput, { id: job_id })
          const statusLine = result.timedOut
            ? '\n[status: running]'
            : `\n[status: ${result.job?.status ?? 'unknown'}]`
          return `${text}${statusLine}`
        }
        const { text, job } = registry.read(job_id, topicId)
        const statusLine = job ? `\n[status: ${job.status}]` : ''
        return `${text || mainFormat(m.jobs.noNewOutput, { id: job_id })}${statusLine}`
      },
      {
        name: 'job_output',
        description:
          'Read new output from a background job (incremental since the previous read). With wait=true it blocks until the job reaches a terminal state or the timeout expires; a timeout does not cancel the job and marks [status: running].',
        schema: z.object({
          job_id: z
            .string()
            .describe('Job ID (returned by the tool that started the job, e.g. subagent-1)'),
          wait: z
            .boolean()
            .optional()
            .describe(
              `Whether to wait for the job to finish (default false: return immediately; wait cap ${JOB_WAIT_MAX_MS / 1000} s)`
            ),
          timeout_ms: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              `Milliseconds to wait when wait=true (default ${JOB_WAIT_DEFAULT_MS}, cap ${JOB_WAIT_MAX_MS})`
            )
        })
      }
    ),
    tool(
      async () => {
        return JSON.stringify({ jobs: registry.list(topicId) })
      },
      {
        name: 'job_list',
        description:
          'List all background jobs owned by this topic (running and terminal) and their statuses.',
        schema: z.object({})
      }
    ),
    tool(
      async ({ job_id, reason }) => {
        const { outcome, job } = registry.kill(job_id, topicId, reason)
        return JSON.stringify({ outcome, job: job ?? null })
      },
      {
        name: 'job_kill',
        description:
          'Terminate a background job by requesting cancellation; if the job already finished, returns already-finished.',
        schema: z.object({
          job_id: z.string().describe('Job ID to terminate'),
          reason: z.string().optional().describe('Reason for termination (optional)')
        })
      }
    )
  ]
}
