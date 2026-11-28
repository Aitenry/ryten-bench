import React from 'react'
import { theme } from 'antd'

/* Unified settings page visuals: page header + section cards (title bar + row items
   separated by hairlines). */

const ROW_DIVIDER_STYLE = `
.sui-rows > .sui-row + .sui-row { border-top: 1px solid var(--sui-hairline); }
.sui-rows > .sui-row:last-child { border-bottom: none; }
`

/** Page header: title + description (action buttons can go on the right) */
export const SettingsPageHeader: React.FC<{
  title: string
  description?: string
  extra?: React.ReactNode
}> = ({ title, description, extra }) => {
  const { token } = theme.useToken()
  return (
    <div
      className="sui-page-header"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        marginBottom: 22
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h2
          style={{
            margin: 0,
            fontSize: 20,
            lineHeight: 1.25,
            fontWeight: 600,
            letterSpacing: '-0.015em',
            color: token.colorText
          }}
        >
          {title}
        </h2>
        {description && (
          <p
            style={{
              margin: '7px 0 0',
              fontSize: 13,
              lineHeight: 1.65,
              color: token.colorTextSecondary
            }}
          >
            {description}
          </p>
        )}
      </div>
      {extra && <div style={{ flexShrink: 0, display: 'flex', gap: 8 }}>{extra}</div>}
    </div>
  )
}

/** Section card: optional title bar (icon + title + description + right-side actions) */
export const SettingsSection: React.FC<{
  title?: string
  description?: string
  icon?: React.ReactNode
  extra?: React.ReactNode
  /** When there is no title bar and content is placed directly, whether the body needs padding */
  bodyPadding?: number
  /** Outer card style (the skills page uses it to make the list fill the remaining height) */
  style?: React.CSSProperties
  /** Content area style (same as above: `flex:1 + overflow` lets the list scroll on its own) */
  bodyStyle?: React.CSSProperties
  bodyClassName?: string
  children: React.ReactNode
}> = ({
  title,
  description,
  icon,
  extra,
  bodyPadding = 0,
  style,
  bodyStyle,
  bodyClassName,
  children
}) => {
  const { token } = theme.useToken()
  return (
    <div
      className="sui-section"
      style={{
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 14,
        background: token.colorBgContainer,
        overflow: 'hidden',
        marginBottom: 14,
        '--sui-hairline': token.colorBorderSecondary,
        '--sui-bg': token.colorBgContainer,
        ...style
      } as React.CSSProperties}
    >
      <style>{ROW_DIVIDER_STYLE}</style>
      {title && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '14px 18px',
            borderBottom: `1px solid ${token.colorBorderSecondary}`
          }}
        >
          {icon && (
            <span style={{ color: token.colorTextSecondary, display: 'flex', flexShrink: 0 }}>
              {icon}
            </span>
          )}
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: '-0.005em',
              color: token.colorText
            }}
          >
            {title}
          </span>
          {description && (
            <span
              style={{ fontSize: 12, color: token.colorTextTertiary, marginLeft: 4, minWidth: 0 }}
            >
              {description}
            </span>
          )}
          {extra && <span style={{ marginLeft: 'auto', flexShrink: 0 }}>{extra}</span>}
        </div>
      )}
      <div
        className={`sui-rows${bodyClassName ? ` ${bodyClassName}` : ''}`}
        style={bodyStyle ?? (bodyPadding ? { padding: bodyPadding } : undefined)}
      >
        {children}
      </div>
    </div>
  )
}

/** Row item: title + description on the left, control on the right */
export const SettingRow: React.FC<{
  title: string
  description?: string
  control: React.ReactNode
  /** Non-row content (such as an input area / chart) is placed directly */
  children?: React.ReactNode
}> = ({ title, description, control, children }) => {
  const { token } = theme.useToken()
  return (
    <div
      className="sui-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '15px 18px',
        minHeight: 52
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13.5, color: token.colorText, lineHeight: '20px' }}>{title}</div>
        {description && (
          <div
            style={{
              fontSize: 12,
              color: token.colorTextTertiary,
              marginTop: 3,
              lineHeight: '17px'
            }}
          >
            {description}
          </div>
        )}
        {children}
      </div>
      <div style={{ flexShrink: 0 }}>{control}</div>
    </div>
  )
}

/** A block of explanatory text inside a section (standalone paragraph with padding) */
export const SettingBlock: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token } = theme.useToken()
  return (
    <div
      style={{
        padding: '4px 16px 14px',
        fontSize: 12,
        lineHeight: '18px',
        color: token.colorTextTertiary
      }}
    >
      {children}
    </div>
  )
}
