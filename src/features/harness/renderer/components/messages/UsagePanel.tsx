import React from 'react'
import { theme } from 'antd'
import { RiDatabase2Line } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import type { UsageDetails } from '../../utils/usage'

/**
 * 「本轮用量」面板（悬停用量徽标时弹出；默认挂在徽标上方，上方余量不够时翻到下方）。
 *
 * 结构：标题（左标签 / 右总量）→ 发丝线 → 提供方 / 模型（长文本单独占一行，
 * 塞进右对齐的值列会被折断）→ dt/dd 数值明细 → 输出下的推理子行。
 * 数据全部来自模型真实回传的 token（归一化见 utils/usage.ts），
 * 字段缺失的行不渲染——例如没有缓存明细就不显示「缓存命中」。
 *
 * 宽度由调用方给：窗口/消息区变窄时要跟着收窄，写死宽度会顶破裁剪容器
 * （见 MessageActions 的 measureUsagePanel）。
 */

/** 千分位（面板里显示精确值） */
const exact = (value: number): string => value.toLocaleString('en-US')

const UsagePanel: React.FC<{ details: UsageDetails; width: number }> = ({ details, width }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const rows: { label: string; value: string; dim?: boolean }[] = []
  if (details.hasCache) {
    if (details.inputTokens > 0) {
      rows.push({
        label: t('harness.usagePanel.cacheHit'),
        value: `${((details.cacheReadTokens / details.inputTokens) * 100).toFixed(1)}%`
      })
    }
    rows.push({
      label: t('harness.usagePanel.uncachedInput'),
      value: `${exact(details.inputTokens - details.cacheReadTokens)} tok`
    })
    rows.push({
      label: t('harness.usagePanel.cacheRead'),
      value: `${exact(details.cacheReadTokens)} tok`
    })
    if (details.cacheWriteTokens > 0) {
      rows.push({
        label: t('harness.usagePanel.cacheWrite'),
        value: `${exact(details.cacheWriteTokens)} tok`
      })
    }
  } else {
    rows.push({ label: t('harness.usagePanel.input'), value: `${exact(details.inputTokens)} tok` })
  }
  rows.push({ label: t('harness.usagePanel.output'), value: `${exact(details.outputTokens)} tok` })
  if (details.hasReasoning) {
    rows.push({
      label: t('harness.usagePanel.reasoning'),
      value: `${exact(details.reasoningTokens)} tok`,
      dim: true
    })
  }
  if (details.calls > 1) {
    rows.push({
      label: t('harness.usagePanel.calls'),
      value: t('harness.usagePanel.callsValue', { count: details.calls })
    })
  }

  return (
    <div
      role="dialog"
      aria-label={t('harness.usagePanel.title')}
      style={{
        width,
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 10,
        padding: '10px 12px',
        boxShadow: token.boxShadowSecondary,
        pointerEvents: 'none'
      }}
    >
      {/* 标题：左「本轮用量」，右总量 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12.5,
            color: token.colorTextSecondary
          }}
        >
          <RiDatabase2Line size={14} />
          {t('harness.usagePanel.title')}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: token.colorText,
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {exact(details.totalTokens)} tok
        </span>
      </div>

      <div style={{ height: 1, background: token.colorBorderSecondary, margin: '8px 0' }} />

      {/* 提供方 / 模型：长路径独占一行，不塞进右对齐的值列 */}
      {details.route && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11.5, color: token.colorTextTertiary }}>
            {t('harness.usagePanel.route')}
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: token.colorText,
              marginTop: 2,
              wordBreak: 'break-all'
            }}
          >
            {details.route}
          </div>
        </div>
      )}

      {/* 数值明细：dt 左 / dd 右对齐等宽数字 */}
      <dl
        style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          rowGap: 6,
          columnGap: 12
        }}
      >
        {rows.map((row) => (
          <React.Fragment key={row.label}>
            <dt
              style={{
                fontSize: 11.5,
                color: row.dim ? token.colorTextQuaternary : token.colorTextTertiary
              }}
            >
              {row.dim ? `└ ${row.label}` : row.label}
            </dt>
            <dd
              style={{
                margin: 0,
                textAlign: 'right',
                fontSize: row.dim ? 11.5 : 12.5,
                color: row.dim ? token.colorTextTertiary : token.colorText,
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {row.value}
            </dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  )
}

export default UsagePanel
