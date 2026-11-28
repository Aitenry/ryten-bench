import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'
import logger from 'electron-log'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'
import { appendFrameWithinCap } from './jobs-buffer'

/**
 * Background jobs system (jobs)
 *
 * Mechanics (adapted to conversations organized by topicId in this project):
 * - Process-level registry: IDs look like `<kind>-N` (kind=subagent/workflow/...);
 * - Owner isolation by topicId: model tools only see jobs of the current topic;
 * - job_output reads incrementally (single consumer cursor): each call returns the output added
 *   since the previous read, and at a terminal state returns the final output (idempotent) and marks
 *   it reported;
 * - wait semantics: block until the terminal state or timeout; a timeout does not cancel the job and
 *   returns the current snapshot ([status: running]);
 * - kill: cancel first, then set stopping → terminal state killed; if already terminal, returns
 *   already-finished;
 * - settlement is first-wins: commit the terminal state and release waiters first, broadcast after.
 */

export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/** Job snapshot (shared by the model tools and the frontend) */
export interface JobSnapshot {
  id: string
  kind: string
  label: string
  status: JobStatus
  detail?: string
  startedAt: number
  finishedAt?: number
}

/**
 * Job output snapshot for frontend inspection (`peek`).
 *
 * Difference from `read`: it **does not advance the model-side consumer cursor** — the top-bar
 * button's polling and the model calling job_output are two independent consumers; a glance at the
 * UI must not eat the increment the model is supposed to read. Only the tail is kept
 * (`JOB_PEEK_MAX_CHARS`) so a chatty dev server does not push hundreds of KB through IPC into the
 * renderer every second.
 */
export interface JobOutputView {
  text: string
  /** Output exceeded the retention cap and only the tail was returned */
  truncated: boolean
  job?: JobSnapshot
}

/** Tail cap for frontend peek (characters) */
export const JOB_PEEK_MAX_CHARS = 40_000

interface JobRecord extends JobSnapshot {
  topicId: number
  outputFrames: string[]
  /** Total number of buffered output characters (for an O(1) check of whether pruning is needed, avoiding a full find/join count every time) */
  bufferedChars: number
  /**
   * Separator between output frames.
   *
   * Semantic frames (subagent text/tool lines) are each a standalone sentence, joined by newlines;
   * command output is a **slice of a byte stream** and must be concatenated as-is (using a newline
   * would insert fake line breaks between stdout chunks and chop up a dev server's progress bar or
   * logs).
   */
  frameSeparator: string
  cancelFn?: (reason?: string) => void
  /** Output cursor (frame position already read by job_output) */
  cursor: number
  /** Whether the terminal output has already been taken by job_output */
  reported: boolean
  settleResolvers: Array<() => void>
}

/** Job handle: the runner uses it to push output and settle */
export interface JobHandle {
  id: string
  /** Append a chunk of output (wakes waiters) */
  appendOutput: (text: string) => void
  /** Request cancellation (called by kill; the runner should finish as soon as possible) */
  cancel: (reason?: string) => void
  /** Settle (first-wins): completed / failed / killed (the cancel path is settled by the runner) */
  settle: (status: 'completed' | 'failed' | 'killed', output?: string, error?: string) => void
}

export type JobsUpdateListener = (topicId: number, jobs: JobSnapshot[]) => void

/** Background job registry (process-level singleton, isolated by topicId) */
export class JobsRegistry {
  private readonly jobs = new Map<string, JobRecord>()
  private readonly counters = new Map<string, number>()

  /** Maximum number of "already reported terminal" jobs kept per topic (fix: terminal jobs used to
   * never be cleaned up, so job_list serialization and broadcast output grew linearly in
   * long-running sessions) */
  private static readonly MAX_TERMINAL_PER_TOPIC = 50

  /**
   * Output cache caps for running jobs (fix: outputFrames used to be unbounded; a long-running dev
   * server produces many output frames per second, main-process memory grew without bound, and the
   * frontend's per-second `peek` joined everything before truncating). Beyond the cap the oldest
   * frames are dropped from the head and the consumer cursor is rolled back in sync — `job_output`
   * still reads later increments, only the earlier history is marked as truncated (`peek`'s
   * truncated field).
   */
  private static readonly MAX_BUFFERED_CHARS = 1_000_000
  private static readonly MAX_BUFFERED_FRAMES = 20_000

  /** Append an output frame and prune to the caps (keep cursor pointing at the right position when dropping the oldest frames) */
  private appendFrame(record: JobRecord, text: string): void {
    appendFrameWithinCap(record, text, {
      maxChars: JobsRegistry.MAX_BUFFERED_CHARS,
      maxFrames: JobsRegistry.MAX_BUFFERED_FRAMES
    })
  }

  /** Change callback (injected by the main process, broadcasts harness-jobs-updated) */
  onChange?: JobsUpdateListener

  /** Start a job: returns a handle (ID auto-assigned as `<kind>-N`; idOverride reuses a fixed ID for session-style jobs) */
  start(
    topicId: number,
    kind: string,
    label: string,
    idOverride?: string,
    options?: { frameSeparator?: string }
  ): JobHandle {
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
      bufferedChars: 0,
      frameSeparator: options?.frameSeparator ?? '\n',
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
        this.appendFrame(record, text)
        this.wakeWaiters(record)
      },
      cancel: (reason) => {
        record.cancelFn?.(reason)
      },
      settle: (status, output, error) => {
        if (record.status !== 'running' && record.status !== 'stopping') return // first-wins
        if (output) this.appendFrame(record, output)
        record.status = status
        record.finishedAt = Date.now()
        if (error) record.detail = error
        this.wakeWaiters(record)
        this.broadcast(topicId)
        this.pruneTerminal(topicId)
        logger.info(`[Jobs] Job ${id} settled as ${status}`)
      }
    }
  }

  /** Bind the cancel callback (the runner registers it at startup) */
  attachCancel(id: string, fn: (reason?: string) => void): void {
    const record = this.jobs.get(id)
    if (record) record.cancelFn = fn
  }

  /** Snapshot list of jobs in the topic */
  list(topicId: number): JobSnapshot[] {
    return [...this.jobs.values()].filter((j) => j.topicId === topicId).map((j) => this.snapshot(j))
  }

  get(id: string): JobSnapshot | undefined {
    const record = this.jobs.get(id)
    return record ? this.snapshot(record) : undefined
  }

  /** Incremental read: return output added since the last read; at a terminal state return the final output (idempotent, marks reported) */
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
    let text = frames.join(record.frameSeparator)
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

  /**
   * Frontend inspection: return all current output (tail-truncated) **without** moving job_output's
   * consumer cursor.
   *
   * The top-bar "background jobs" popup polls once per second while a job runs; reusing `read` would
   * mean a later job_output call from the model only gets content added after the UI inspection,
   * missing the earlier chunks.
   */
  peek(id: string, topicId: number): JobOutputView {
    const record = this.jobs.get(id)
    if (!record || record.topicId !== topicId) {
      return {
        text: mainFormat(getAgentToolTexts().jobs.notFoundInTopic, { id }),
        truncated: false
      }
    }
    const full = record.outputFrames.join(record.frameSeparator)
    const truncated = full.length > JOB_PEEK_MAX_CHARS
    return {
      text: truncated ? full.slice(-JOB_PEEK_MAX_CHARS) : full,
      truncated,
      job: this.snapshot(record)
    }
  }

  /** Wait for a job until its terminal state or timeout (a timeout does not cancel the job) */
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

  /** Terminate a job: already terminal returns already-finished; otherwise cancel + stopping → killed */
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
    // The runner should settle(killed) itself after cancel; fallback: force killed if still
    // unsettled after 5 seconds
    setTimeout(() => {
      const current = this.jobs.get(id)
      if (current && (current.status === 'stopping' || current.status === 'running')) {
        current.status = 'killed'
        current.finishedAt = Date.now()
        this.wakeWaiters(current)
        this.broadcast(current.topicId)
        logger.warn(`[Jobs] Job ${id} cancellation timed out, force-killed`)
      }
    }, 5000)
    this.broadcast(topicId)
    return { outcome: 'cancellation-requested', job: this.snapshot(record) }
  }

  /** Clean up jobs when a topic is deleted (kill them all first) */
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

  /**
   * App exit: terminate all still-running jobs and clear the registry.
   *
   * Background execute jobs are real system processes (dev server / watcher) and do not disappear
   * when the conversation ends; if they are not actively cancelled on exit they become orphan
   * processes holding ports. Only a synchronous abort is performed here, without waiting for the
   * processes to exit (`before-quit` must not be held up by a stuck command).
   */
  clearAll(): void {
    for (const record of this.jobs.values()) {
      if (record.status === 'running' || record.status === 'stopping') {
        record.cancelFn?.()
        record.status = 'killed'
        record.finishedAt = Date.now()
      }
    }
    this.jobs.clear()
  }

  /** Prune reported terminal jobs: keep the most recent MAX_TERMINAL_PER_TOPIC per topic */
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

/** Process-level singleton */
export const jobsRegistry = new JobsRegistry()

/** Default and maximum wait for job_output (default 30s, cap 10min) */
export const JOB_WAIT_DEFAULT_MS = 30_000
export const JOB_WAIT_MAX_MS = 600_000

/** Build the background job tool set (injected into the main agent only; jobs belong to the current topic) */
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
            .describe(
              'Job ID returned by the tool that started the job (e.g. subagent-1 or exec-1)'
            ),
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
          'List all background jobs owned by this topic (background commands and subagent sessions) and their statuses.',
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
          'Terminate a background job (a background command or subagent session) by requesting cancellation; if the job already finished, returns already-finished.',
        schema: z.object({
          job_id: z.string().describe('Job ID to terminate'),
          reason: z.string().optional().describe('Reason for termination (optional)')
        })
      }
    )
  ]
}
