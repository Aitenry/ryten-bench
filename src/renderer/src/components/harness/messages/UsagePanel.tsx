import React from 'react'
import { theme } from 'antd'
import { RiDatabase2Line } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import type { UsageDetails } from '../../../utils/harness/usage'

/**
 * "Usage this turn" panel (pops up when hovering the usage badge; anchored above the badge by
 * default and flipped below when there is not enough room above).
 *
 * Structure: title (label on the left / total on the right) → hairline → provider / model (long
 * text gets its own row; cramming it into the right-aligned value column would wrap it) → dt/dd
 * value rows → reasoning sub-row under output. All values come from the token counts actually
 * returned by the model (normalized in utils/usage.ts); rows for missing fields are not rendered —
 * e.g. no "cache hit" row when there are no cache details.
 *
 * The width is supplied by the caller: it must shrink along with the window/message area, since a
 * hard-coded width would break out of the clipping container
 * (see measureUsagePanel in MessageActions).
 */

/** Thousands separators (the panel shows exact values) */
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
      {/* Title: "usage this turn" on the left, total on the right */}
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

      {/* Provider / model: long paths get their own row instead of the right-aligned value column */}
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

      {/* Value details: dt on the left / dd right-aligned with tabular figures */}
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
