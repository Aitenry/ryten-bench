import React, { useEffect, useState } from 'react'
import { theme } from 'antd'
import { useTranslation } from '@renderer/i18n'
import { harnessApi } from '../../api/harness'
import {
  buildUsageSummary,
  formatCompactTokens,
  type UsageSummary
} from '../../utils/harness/usage'

/**
 * 输入框底栏右侧的会话用量状态条：`2.5M tok · 缓存命中 98%  ◯ 8%`
 *
 * 结构（左 → 右）：累计 token → 缓存命中率 → 上下文占用圆环。
 * **不带行首图标**（用户口径：图标多余，只留数字）。
 *
 * 数值全部来自 `harness_dialogue_usage`（模型真实回传的 token，按话题整段累加）：
 * - 累计 token：各轮 total 之和；
 * - 缓存命中：缓存读取 / 输入 token；
 * - 圆环：最近一次模型调用的上下文规模 / 模型档案里的 `context_window`。
 *
 * 任何一项拿不到就不画那一项（没有缓存明细 → 不显示「缓存命中」；模型档案没填
 * 上下文窗口 → 不画圆环；整段会话没有用量 → 整条不渲染），不做估算。
 */

/**
 * 圆环直径 / 线宽 / 光学偏移。
 *
 * - 直径取 14（比文字 `1em` 略大）：8% 这种小占比只剩一小段弧，环越小越像"一个点"；
 * - 线宽 2.5（不是 2）：细环在浅色主题下几乎读不出"进度"，加粗后弧段才有分量；
 * - 光学偏移 +1px：flex 的 `align-items: center` 对齐的是**行盒**，而数字的视觉中心
 *   比行盒中心低约 1px（行盒含降部空间），不补偿的话圆环看起来比「8%」高半拍。
 */
const RING_SIZE = 14
const RING_STROKE = 2.5
const RING_OPTICAL_OFFSET = 1

const ContextRing: React.FC<{ percent: number; color: string; track: string }> = ({
  percent,
  color,
  track
}) => {
  const center = RING_SIZE / 2
  const radius = (RING_SIZE - RING_STROKE) / 2
  const circumference = 2 * Math.PI * radius
  const filled = Math.max(0, Math.min(100, percent))
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden="true"
      style={{
        flexShrink: 0,
        display: 'block',
        transform: `translateY(${RING_OPTICAL_OFFSET}px)`
      }}
    >
      {/* 底环：整圈暗色轨道，表示窗口总量 */}
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={track}
        strokeWidth={RING_STROKE}
      />
      {/* 占用环：从 12 点方向顺时针画到 percent */}
      {filled > 0 && (
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={`${(circumference * filled) / 100} ${circumference}`}
          transform={`rotate(-90 ${center} ${center})`}
        />
      )}
    </svg>
  )
}

interface HarnessUsageMeterProps {
  /** 当前话题；null = 还没有会话（新对话第一轮），整条不显示 */
  topicId: number | null
  /** 当前模型的上下文窗口（供应商档案 metadata.context_window）；null = 未知 */
  contextWindow: number | null
  /** 生成中：本轮还没落库，保留上一次的数字，等结束再拉 */
  streaming: boolean
}

const HarnessUsageMeter: React.FC<HarnessUsageMeterProps> = ({
  topicId,
  contextWindow,
  streaming
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  /** 汇总连同它属于哪个话题一起存：切话题时旧数值立刻失效，不会串到新会话上 */
  const [snapshot, setSnapshot] = useState<{ topicId: number; summary: UsageSummary } | null>(null)

  useEffect(() => {
    if (topicId === null) {
      setSnapshot(null)
      return
    }
    // 生成中这一轮还没写库：先留着当前的数值，等流结束再拉一次，底栏不会闪空
    if (streaming) return
    let cancelled = false
    void harnessApi.harness
      .getUsageByTopic(topicId)
      .then((rows) => {
        const summary = buildUsageSummary(rows)
        if (cancelled) return
        setSnapshot(summary ? { topicId, summary } : null)
      })
      .catch((err) => {
        // 通道不可用（插件停用等）时静默：底栏少一行不影响输入框其余功能
        console.warn('[harness-usage-meter] load usage failed:', err)
      })
    return () => {
      cancelled = true
    }
  }, [topicId, streaming])

  // 切话题后旧快照不再作数（还没有新数就整条不画，宁可空一下也不显示别的会话的用量）
  const summary = snapshot && snapshot.topicId === topicId ? snapshot.summary : null
  if (!summary) return null

  /** 缓存命中率按百分比四舍五入；个别协议的缓存字段口径会超过 100%，显示上封顶 */
  const cachePercent =
    summary.cacheHitRate === null
      ? null
      : Math.min(100, Math.max(0, Math.round(summary.cacheHitRate * 100)))
  const contextPercent =
    contextWindow !== null && contextWindow > 0 && summary.contextTokens !== null
      ? Math.min(100, Math.max(0, Math.round((summary.contextTokens / contextWindow) * 100)))
      : null

  return (
    <div
      style={{
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingRight: 2,
        fontSize: 11.5,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
        color: token.colorTextTertiary
      }}
    >
      <span>
        {t('harness.usageMeter.tokens', { value: formatCompactTokens(summary.totalTokens) })}
      </span>
      {cachePercent !== null && (
        <>
          <span aria-hidden="true">·</span>
          <span>{t('harness.usageMeter.cacheHit', { percent: cachePercent })}</span>
        </>
      )}
      {contextPercent !== null && contextWindow !== null && (
        <span
          title={t('harness.usageMeter.contextAria', {
            percent: contextPercent,
            window: formatCompactTokens(contextWindow)
          })}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 2 }}
        >
          {/* 轨道用 colorBorder、进度用 colorText：两档都不透明到「看不见」的程度，
              黑白主题下都读得出「用了多少」。原先 colorFillTertiary(≈4%) 在白底上
              几乎消失，只剩一小段弧，看着像凭空挂了个逗号。 */}
          <ContextRing percent={contextPercent} color={token.colorText} track={token.colorBorder} />
          <span>{contextPercent}%</span>
        </span>
      )}
    </div>
  )
}

export default HarnessUsageMeter
