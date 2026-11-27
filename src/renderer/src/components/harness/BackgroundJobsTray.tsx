import React, { useEffect, useRef, useState } from 'react'
import { theme } from 'antd'
import { RiArrowRightSLine, RiLoader4Line, RiTerminalBoxLine } from '@remixicon/react'
import dayjs from 'dayjs'
import type { TFunction } from 'i18next'
import { useTranslation } from '@renderer/i18n'
import { useTheme } from '@renderer/hooks/useTheme'

import type { JobOutputView, JobSnapshot } from '../../../../shared/harness/types'

/**
 * 后台任务内联托盘（顶部栏下方，不弹独立窗口）。
 *
 * 用户 2026-11-26 确认的样式：
 * - 每行左侧折叠按钮、右侧停止按钮；运行中才显示停止；
 * - 输出在任务行下面就地展开（单开：打开一条自动收起其他条），不打开 Modal；
 * - 完成后停止按钮消失，但保留列宽，状态/耗时不跳动；
 * - 托盘整体把消息区往下推，不覆盖对话内容。
 */
interface BackgroundJobsTrayProps {
  jobs: JobSnapshot[]
  onStop: (job: JobSnapshot) => Promise<boolean>
  peekOutput: (jobId: string) => Promise<JobOutputView>
}

/** 一条任务的输出快照（按 job id 缓存，收起后再展开先显示缓存、随后刷新） */
interface OutputState {
  text: string
  truncated: boolean
  loading: boolean
}

/** 命令/输出用等宽字形（与工具详情同一套） */
const MONO_FONT = "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace"

/** 任务是否还活着（stopping 时停止按钮变成转圈并禁用） */
const isActive = (job: JobSnapshot): boolean =>
  job.status === 'running' || job.status === 'stopping'

/** 状态文案与语义色（暗色用亮档、亮色用深档，小字也能读清） */
const statusMeta = (
  t: TFunction,
  job: JobSnapshot,
  isDarkMode: boolean
): { text: string; color: string } => {
  switch (job.status) {
    case 'running':
      return {
        text: t('harness.backgroundJobs.running'),
        color: isDarkMode ? '#69b1ff' : '#1677ff'
      }
    case 'stopping':
      return {
        text: t('harness.backgroundJobs.stopping'),
        color: isDarkMode ? '#ffc53d' : '#d48806'
      }
    case 'completed':
      return {
        text: t('harness.backgroundJobs.completed'),
        color: isDarkMode ? '#73d13d' : '#389e0d'
      }
    case 'failed':
      return {
        text: t('harness.backgroundJobs.failed'),
        color: isDarkMode ? '#ff7875' : '#cf1322'
      }
    default:
      return {
        text: t('harness.backgroundJobs.killed'),
        color: isDarkMode ? '#9e9e9e' : '#8c8c8c'
      }
  }
}

/**
 * 耗时文案：0 秒级显示 <1 秒，避免刚启动的任务看起来像卡住了；
 * 分钟/小时按设计稿显示「1 分 12 秒」「1 小时 2 分」。
 */
function formatDuration(ms: number, t: TFunction): string {
  if (!Number.isFinite(ms) || ms < 1000) {
    return t('harness.backgroundJobs.durationUnderSecond')
  }
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return t('harness.backgroundJobs.durationHours', { hours, minutes })
  }
  if (minutes > 0) {
    return t('harness.backgroundJobs.durationMinutes', { minutes, seconds })
  }
  return t('harness.backgroundJobs.durationSeconds', { count: seconds })
}

const BackgroundJobsTray: React.FC<BackgroundJobsTrayProps> = ({ jobs, onStop, peekOutput }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const { effectiveTheme } = useTheme()
  const isDarkMode = effectiveTheme === 'dark'

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [outputs, setOutputs] = useState<Record<string, OutputState>>({})
  const [following, setFollowing] = useState(true)
  const followRef = useRef(true)
  const outputRef = useRef<HTMLPreElement | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // 运行中的任务每秒刷新一次耗时（全部结束后停表）
  const hasActive = jobs.some(isActive)
  useEffect(() => {
    if (!hasActive) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [hasActive])

  // 运行中的任务优先，其余按启动时间倒序——用户先看到「还在跑」的
  const sortedJobs = [...jobs].sort((a, b) => {
    const rank = (job: JobSnapshot): number => (isActive(job) ? 0 : 1)
    const byRank = rank(a) - rank(b)
    return byRank !== 0 ? byRank : b.startedAt - a.startedAt
  })

  const expandedJob = expandedId ? jobs.find((job) => job.id === expandedId) : undefined
  const expandedActive = expandedJob ? isActive(expandedJob) : false
  const expandedExists = expandedJob != null
  const expandedOutput = expandedId ? outputs[expandedId] : undefined

  // 任务被清理（话题删除 / 终态裁剪）后，展开态自动收起
  useEffect(() => {
    if (expandedId && !jobs.some((job) => job.id === expandedId)) setExpandedId(null)
  }, [jobs, expandedId])

  // 展开某一行：立刻拉一次输出；运行中每秒刷新，终态只拉最后一份
  useEffect(() => {
    if (!expandedId || !expandedExists) return
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const result = await peekOutput(expandedId)
        if (cancelled) return
        setOutputs((prev) => ({
          ...prev,
          [expandedId]: {
            text: result.text,
            truncated: result.truncated,
            loading: false
          }
        }))
      } catch (error) {
        if (cancelled) return
        setOutputs((prev) => ({
          ...prev,
          [expandedId]: {
            text: t('harness.backgroundJobs.outputFailed', {
              reason: error instanceof Error ? error.message : String(error)
            }),
            truncated: false,
            loading: false
          }
        }))
      }
    }
    void load()
    const timer = expandedActive ? setInterval(() => void load(), 1000) : undefined
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [expandedActive, expandedExists, expandedId, peekOutput, t])

  // 输出更新时贴底；用户主动往上翻后停止自动跟随（显示「回到底部」）
  useEffect(() => {
    if (!following) return
    const el = outputRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [expandedId, expandedOutput?.text, following])

  const toggleRow = (job: JobSnapshot): void => {
    if (expandedId === job.id) {
      setExpandedId(null)
      return
    }
    setExpandedId(job.id)
    followRef.current = true
    setFollowing(true)
    // 首次展开先占位，避免闪一下「暂无输出」
    setOutputs((prev) =>
      prev[job.id] ? prev : { ...prev, [job.id]: { text: '', truncated: false, loading: true } }
    )
  }

  const handleOutputScroll = (event: React.UIEvent<HTMLPreElement>): void => {
    const el = event.currentTarget
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 24
    if (atBottom !== followRef.current) {
      followRef.current = atBottom
      setFollowing(atBottom)
    }
  }

  const scrollToBottom = (): void => {
    followRef.current = true
    setFollowing(true)
    const el = outputRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  return (
    <div
      className="harness-scrollbar"
      data-background-jobs-tray
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
        flexShrink: 0,
        maxHeight: 'min(52vh, 540px)',
        overflowY: 'auto',
        padding: '7px 12px 12px'
      }}
    >
      {sortedJobs.map((job) => {
        const expanded = expandedId === job.id
        const active = isActive(job)
        const meta = statusMeta(t, job, isDarkMode)
        const started = dayjs(job.startedAt).format('MM-DD HH:mm:ss')
        const finished = job.finishedAt ? dayjs(job.finishedAt).format('MM-DD HH:mm:ss') : null
        const rowTitle = [
          job.label || job.id,
          `${job.id} · ${t('harness.backgroundJobs.startedAt', { time: started })}`,
          finished ? t('harness.backgroundJobs.finishedAt', { time: finished }) : '',
          job.detail ?? ''
        ]
          .filter(Boolean)
          .join('\n')
        const duration = formatDuration((job.finishedAt ?? now) - job.startedAt, t)
        const output = outputs[job.id]

        return (
          <article
            key={job.id}
            style={{
              overflow: 'hidden',
              border: `1px solid ${expanded ? token.colorBorder : token.colorBorderSecondary}`,
              borderRadius: 8,
              background: token.colorFillTertiary
            }}
          >
            <div
              role="button"
              tabIndex={0}
              aria-expanded={expanded}
              data-background-job-row={job.id}
              data-background-job-expanded={expanded ? '1' : '0'}
              className="harness-bg-task-head"
              title={rowTitle}
              onClick={() => toggleRow(job)}
              onKeyDown={(event) => {
                // 停止按钮是行内子元素：它自己的键盘事件不能触发展开/收起
                if (event.target !== event.currentTarget) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  toggleRow(job)
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                height: 40,
                padding: '0 8px',
                cursor: 'pointer'
              }}
            >
              {/* 左侧折叠按钮：控制这一条任务的输出展开 */}
              <span
                aria-hidden="true"
                className="harness-bg-chevron"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 24,
                  height: 24,
                  flex: '0 0 24px',
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: 6,
                  background: token.colorFillQuaternary,
                  color: token.colorTextSecondary
                }}
              >
                <RiArrowRightSLine
                  size={13}
                  style={{
                    transform: expanded ? 'rotate(90deg)' : 'none',
                    transition: 'transform 0.18s ease'
                  }}
                />
              </span>

              <RiTerminalBoxLine
                size={15}
                style={{ color: token.colorTextSecondary, flexShrink: 0 }}
              />

              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: token.colorText,
                  fontFamily: MONO_FONT,
                  fontSize: 12
                }}
              >
                {job.label || job.id}
              </span>

              {/* 状态：彩色圆点 + 小字，避免大色块抢命令的注意力 */}
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  flexShrink: 0,
                  color: meta.color,
                  fontSize: 10.5,
                  lineHeight: 1
                }}
              >
                <span
                  className={job.status === 'running' ? 'harness-bg-dot-running' : undefined}
                  style={{
                    width: 5,
                    height: 5,
                    flex: '0 0 5px',
                    borderRadius: '50%',
                    background: meta.color
                  }}
                />
                {meta.text}
              </span>

              <span
                style={{
                  flexShrink: 0,
                  minWidth: 64,
                  textAlign: 'right',
                  color: token.colorTextTertiary,
                  fontSize: 11,
                  fontVariantNumeric: 'tabular-nums'
                }}
              >
                {duration}
              </span>

              {/* 停止槽位固定 26px：结束按钮消失后各列不跳动 */}
              <span
                onClick={(event) => event.stopPropagation()}
                style={{
                  width: 26,
                  height: 26,
                  flex: '0 0 26px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                {active ? (
                  <button
                    type="button"
                    className="harness-bg-stop"
                    data-background-job-stop={job.id}
                    title={t('harness.backgroundJobs.stop')}
                    aria-label={t('harness.backgroundJobs.stop')}
                    disabled={job.status === 'stopping'}
                    onClick={(event) => {
                      // 行本身是折叠区：停止不能顺带展开/收起
                      event.stopPropagation()
                      void onStop(job)
                    }}
                  >
                    {job.status === 'stopping' ? (
                      <RiLoader4Line size={13} className="animate-spin" />
                    ) : (
                      <span className="harness-bg-stop-square" />
                    )}
                  </button>
                ) : null}
              </span>
            </div>

            {expanded ? (
              <div
                style={{
                  borderTop: `1px solid ${token.colorBorderSecondary}`,
                  padding: '0 10px 10px 60px',
                  background: token.colorBgContainer
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '7px 2px 0',
                    color: token.colorTextTertiary,
                    fontSize: 10.5
                  }}
                >
                  <span>
                    {t('harness.backgroundJobs.output')}
                    {output?.truncated ? (
                      <span style={{ marginLeft: 6 }}>
                        {t('harness.backgroundJobs.outputTruncated')}
                      </span>
                    ) : null}
                  </span>
                  {active ? (
                    following ? (
                      <span>{t('harness.backgroundJobs.autoFollow')} ↓</span>
                    ) : (
                      <button
                        type="button"
                        className="harness-bg-follow"
                        onClick={scrollToBottom}
                        style={{ color: token.colorPrimary, fontSize: 10.5 }}
                      >
                        {t('harness.backgroundJobs.backToBottom')} ↓
                      </button>
                    )
                  ) : null}
                </div>

                <pre
                  ref={outputRef}
                  data-background-job-output={job.id}
                  onScroll={handleOutputScroll}
                  className="harness-scrollbar"
                  style={{
                    maxHeight: 182,
                    margin: '5px 0 0',
                    padding: '9px 11px',
                    overflowY: 'auto',
                    border: `1px solid ${token.colorBorderSecondary}`,
                    borderRadius: 6,
                    background: token.colorBgContainer,
                    color: token.colorText,
                    fontFamily: MONO_FONT,
                    fontSize: 11.5,
                    lineHeight: 1.65,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word'
                  }}
                >
                  {output?.text ||
                    expandedJob?.detail ||
                    (output?.loading
                      ? t('harness.backgroundJobs.loadingOutput')
                      : t('harness.backgroundJobs.noOutput'))}
                </pre>
              </div>
            ) : null}
          </article>
        )
      })}
    </div>
  )
}

export default BackgroundJobsTray
