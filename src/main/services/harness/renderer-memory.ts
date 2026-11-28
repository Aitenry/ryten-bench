import { app } from 'electron'
import logger from 'electron-log'

/**
 * Renderer process memory sampling (OOM observability).
 *
 * Background (2026-09-17 investigation of reason=oom / exitCode=-536870904): on crash the main
 * process only leaves a single line such as
 * `[Window] renderer process exited reason=oom exitCode=-536870904`, with no memory numbers at
 * all — the root cause could only be inferred from "many history messages + large tool outputs",
 * and it was impossible to confirm which traffic pushed the watermark up.
 *
 * The data source is `app.getAppMetrics()` (official Electron, synchronous, per-process
 * workingSetSize / peakWorkingSetSize / privateBytes); only renderer processes with type='Tab' are
 * counted.
 *
 * Behavior:
 * - During streaming, sample every {@link RENDERER_MEM_SAMPLE_MS}; regular logs are throttled to one
 *   line every {@link RENDERER_MEM_LOG_EVERY_S} seconds so curves are visible in the log;
 * - When the working set exceeds {@link RENDERER_MEM_WARN_MB}, log every sample and tag it with ⚠ so
 *   it can be grepped directly;
 * - When the renderer process crashes / is killed, the main window's render-process-gone calls
 *   {@link dumpRendererMemory}, which prints **the last sample + recent trend (including growth
 *   rate)** — after the crash the process is gone, so only cached values remain.
 *
 * Read-only memory metrics; no business behavior is changed.
 */

/** Sampling interval (ms) */
const RENDERER_MEM_SAMPLE_MS = 5_000
/** Regular log throttle (seconds) */
const RENDERER_MEM_LOG_EVERY_S = 20
/** Working set warning threshold (MiB): log every sample above it */
const RENDERER_MEM_WARN_MB = 1500
/** Window (ms) within which a sample still counts as fresh at crash time */
const RENDERER_MEM_STALE_MS = 15_000
/** Trend window: keep this many recent samples for growth-rate calculation */
const RENDERER_MEM_TREND_POINTS = 12

interface MemorySnapshot {
  at: number
  /** Total renderer working set (KiB) */
  workingSetKb: number
  /** Total renderer private memory (KiB, win32 only; includes the JS heap and DOM content, the main OOM indicator) */
  privateKb: number
  /** Total historical peak working set of renderer processes (KiB) */
  peakKb: number
  /** Number of renderer processes */
  count: number
  /** Context label (e.g. `topic=205`) */
  label?: string
}

const trend: MemorySnapshot[] = []
let timer: ReturnType<typeof setInterval> | null = null
/** Sampling session ref count: the target auto-turn and the user turn may overlap; stop the timer only when the last one ends */
let activeSessions = 0
let firstSampleLogged = false
let lastLogAt = 0

const mib = (kb: number): string => (kb / 1024).toFixed(1)

/** Collect current renderer memory (synchronous; non-renderer process types are ignored) */
function collect(label?: string): MemorySnapshot | null {
  let metrics: Electron.ProcessMetric[]
  try {
    metrics = app.getAppMetrics()
  } catch (err) {
    logger.debug('[Memory] getAppMetrics failed:', err)
    return null
  }
  const renderers = metrics.filter((m) => m.type === 'Tab')
  if (renderers.length === 0) return null
  let workingSetKb = 0
  let privateKb = 0
  let peakKb = 0
  for (const m of renderers) {
    workingSetKb += m.memory?.workingSetSize ?? 0
    privateKb += m.memory?.privateBytes ?? 0
    peakKb += m.memory?.peakWorkingSetSize ?? 0
  }
  return { at: Date.now(), workingSetKb, privateKb, peakKb, count: renderers.length, label }
}

/** Assemble one log line: working set / private memory / peak / process count / context */
function formatSnapshot(snap: MemorySnapshot): string {
  const label = snap.label ? ` (${snap.label})` : ''
  const procs = snap.count > 1 ? ` procs=${snap.count}` : ''
  return (
    `workingSet=${mib(snap.workingSetKb)}MB` +
    (snap.privateKb > 0 ? ` private=${mib(snap.privateKb)}MB` : '') +
    ` peak=${mib(snap.peakKb)}MB${procs}${label}`
  )
}

/** Trend summary: delta between first and last plus average growth per 10s, to tell "slow creep" from "steep rise" */
function formatTrend(): string {
  if (trend.length < 2) return ''
  const first = trend[0]
  const last = trend[trend.length - 1]
  const spanS = (last.at - first.at) / 1000
  if (spanS <= 0) return ''
  const deltaMb = (last.workingSetKb - first.workingSetKb) / 1024
  const perTenS = (deltaMb / spanS) * 10
  return `; last ${Math.round(spanS)}s delta ${deltaMb >= 0 ? '+' : ''}${deltaMb.toFixed(1)}MB (about ${perTenS >= 0 ? '+' : ''}${perTenS.toFixed(1)}MB/10s)`
}

function sample(label?: string): void {
  const snap = collect(label)
  if (!snap) return
  trend.push(snap)
  if (trend.length > RENDERER_MEM_TREND_POINTS) trend.shift()

  const heavy = snap.workingSetKb / 1024 >= RENDERER_MEM_WARN_MB
  const due = !firstSampleLogged || heavy || snap.at - lastLogAt >= RENDERER_MEM_LOG_EVERY_S * 1000
  if (!due) return
  firstSampleLogged = true
  lastLogAt = snap.at
  const warn = heavy ? ` ⚠ memory level high (>${RENDERER_MEM_WARN_MB}MB)` : ''
  logger.info(`[Memory] Renderer ${formatSnapshot(snap)}${formatTrend()}${warn}`)
}

/** Start sampling (ref counted, safe to call concurrently) */
export function startRendererMemorySampling(label?: string): void {
  activeSessions += 1
  if (timer) return
  firstSampleLogged = false
  lastLogAt = 0
  trend.length = 0
  // Sample immediately: capture the baseline at the start of this turn so growth can be compared
  sample(label)
  timer = setInterval(() => sample(label), RENDERER_MEM_SAMPLE_MS)
}

/** Stop sampling (the timer really stops only when the ref count reaches zero) */
export function stopRendererMemorySampling(): void {
  activeSessions = Math.max(0, activeSessions - 1)
  if (activeSessions > 0) return
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/**
 * Dump a memory snapshot + crash reason at crash time.
 * The renderer process is already gone, so only the last successful sample can be used (usually no
 * more than one sampling interval old).
 */
export function dumpRendererMemory(reason: string, exitCode: number): void {
  const head = `[Memory] Renderer process exited reason=${reason} exitCode=${exitCode}`
  const last = trend[trend.length - 1]
  if (!last) {
    logger.error(`${head}, no memory samples before crash`)
    return
  }
  const ageS = Math.round((Date.now() - last.at) / 1000)
  const stale = Date.now() - last.at > RENDERER_MEM_STALE_MS ? ' (stale)' : ''
  logger.error(
    `${head}; last sample before crash${stale} (${ageS}s ago): ${formatSnapshot(last)}${formatTrend()}`
  )
}
