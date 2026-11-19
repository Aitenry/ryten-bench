import { app } from 'electron'
import logger from 'electron-log'

/**
 * 渲染进程内存采样（OOM 可观测性）。
 *
 * 背景（2026-09-17 排查 reason=oom / exitCode=-536870904）：崩溃时主进程只留一行
 * `[Window] 渲染进程退出 reason=oom exitCode=-536870904`，没有任何内存数字——只能靠
 * 「历史消息多 + 工具输出大」推断根因，无法确认是哪一段流量把水位推上去的。
 *
 * 数据源用 `app.getAppMetrics()`（Electron 官方、同步、按进程给 workingSetSize /
 * peakWorkingSetSize / privateBytes），只统计 type='Tab' 的渲染进程。
 *
 * 行为：
 * - 流式期间每 {@link RENDERER_MEM_SAMPLE_MS} 采一次，常规日志节流到每
 *   {@link RENDERER_MEM_LOG_EVERY_S} 秒一条，便于在日志里看曲线；
 * - 工作集超过 {@link RENDERER_MEM_WARN_MB} 时每次都记并标 ⚠，便于直接 grep；
 * - 渲染进程崩溃/被杀时由主窗口的 render-process-gone 调用 {@link dumpRendererMemory}，
 *   输出**最后一份采样 + 最近趋势（含增速）**——崩溃后进程已消失，只能靠缓存。
 *
 * 只读内存指标，不改变任何业务行为。
 */

/** 采样间隔（毫秒） */
const RENDERER_MEM_SAMPLE_MS = 5_000
/** 常规日志节流（秒） */
const RENDERER_MEM_LOG_EVERY_S = 20
/** 工作集告警阈值（MiB）：超过则每次采样都记一条 */
const RENDERER_MEM_WARN_MB = 1500
/** 崩溃时认为「采样仍然新鲜」的窗口（毫秒） */
const RENDERER_MEM_STALE_MS = 15_000
/** 趋势窗口：保留最近这么多个采样点用于算增速 */
const RENDERER_MEM_TREND_POINTS = 12

interface MemorySnapshot {
  at: number
  /** 渲染进程工作集合计（KiB） */
  workingSetKb: number
  /** 渲染进程私有内存合计（KiB，win32 才有；含 JS 堆与 DOM 内容，OOM 主指标） */
  privateKb: number
  /** 渲染进程历史峰值工作集合计（KiB） */
  peakKb: number
  /** 渲染进程个数 */
  count: number
  /** 上下文标签（如 `topic=205`） */
  label?: string
}

const trend: MemorySnapshot[] = []
let timer: ReturnType<typeof setInterval> | null = null
/** 采样会话引用计数：目标自动轮与用户轮可能并发，最后一个结束才停表 */
let activeSessions = 0
let firstSampleLogged = false
let lastLogAt = 0

const mib = (kb: number): string => (kb / 1024).toFixed(1)

/** 采集当前渲染进程内存（同步；非渲染进程类型一律忽略） */
function collect(label?: string): MemorySnapshot | null {
  let metrics: Electron.ProcessMetric[]
  try {
    metrics = app.getAppMetrics()
  } catch (err) {
    logger.debug('[Memory] getAppMetrics 失败:', err)
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

/** 组装一行日志：工作集 / 私有内存 / 峰值 / 进程数 / 上下文 */
function formatSnapshot(snap: MemorySnapshot): string {
  const label = snap.label ? ` (${snap.label})` : ''
  const procs = snap.count > 1 ? ` procs=${snap.count}` : ''
  return (
    `workingSet=${mib(snap.workingSetKb)}MB` +
    (snap.privateKb > 0 ? ` private=${mib(snap.privateKb)}MB` : '') +
    ` peak=${mib(snap.peakKb)}MB${procs}${label}`
  )
}

/** 趋势摘要：首尾差值与平均增速（每 10s），用于判断「缓涨」还是「陡增」 */
function formatTrend(): string {
  if (trend.length < 2) return ''
  const first = trend[0]
  const last = trend[trend.length - 1]
  const spanS = (last.at - first.at) / 1000
  if (spanS <= 0) return ''
  const deltaMb = (last.workingSetKb - first.workingSetKb) / 1024
  const perTenS = (deltaMb / spanS) * 10
  return `；最近 ${Math.round(spanS)}s 变化 ${deltaMb >= 0 ? '+' : ''}${deltaMb.toFixed(1)}MB（约 ${perTenS >= 0 ? '+' : ''}${perTenS.toFixed(1)}MB/10s）`
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
  const warn = heavy ? ` ⚠ 内存水位偏高（>${RENDERER_MEM_WARN_MB}MB）` : ''
  logger.info(`[Memory] 渲染进程 ${formatSnapshot(snap)}${formatTrend()}${warn}`)
}

/** 开始采样（引用计数，可并发调用） */
export function startRendererMemorySampling(label?: string): void {
  activeSessions += 1
  if (timer) return
  firstSampleLogged = false
  lastLogAt = 0
  trend.length = 0
  // 立即采一次：拿到「本轮开始时的基线」，方便对比本轮涨了多少
  sample(label)
  timer = setInterval(() => sample(label), RENDERER_MEM_SAMPLE_MS)
}

/** 结束采样（引用计数归零才真正停表） */
export function stopRendererMemorySampling(): void {
  activeSessions = Math.max(0, activeSessions - 1)
  if (activeSessions > 0) return
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/**
 * 崩溃时落一份内存快照 + 崩溃原因。
 * 渲染进程已经没了，这里只能用最后一次成功采样（通常距今不超过一个采样间隔）。
 */
export function dumpRendererMemory(reason: string, exitCode: number): void {
  const head = `[Memory] 渲染进程退出 reason=${reason} exitCode=${exitCode}`
  const last = trend[trend.length - 1]
  if (!last) {
    logger.error(`${head}，崩溃前无内存采样记录`)
    return
  }
  const ageS = Math.round((Date.now() - last.at) / 1000)
  const stale = Date.now() - last.at > RENDERER_MEM_STALE_MS ? '（陈旧）' : ''
  logger.error(
    `${head}；崩溃前最后一次采样${stale}（${ageS}s 前）：${formatSnapshot(last)}${formatTrend()}`
  )
}
