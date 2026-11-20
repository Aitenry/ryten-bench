import React from 'react'
import { theme } from 'antd'

/* 设置页统一视觉：页头 + 分区卡片（标题栏 + 行式条目，发丝线分隔），
   参考 Obsidian / Linear 的设置布局。 */

const ROW_DIVIDER_STYLE = `
.sui-rows > .sui-row + .sui-row { border-top: 1px solid var(--sui-hairline); }
.sui-rows > .sui-row:last-child { border-bottom: none; }
`

/** 页头：标题 + 描述（右侧可放操作按钮） */
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

/** 分区卡片：可选标题栏（图标 + 标题 + 描述 + 右侧操作） */
export const SettingsSection: React.FC<{
  title?: string
  description?: string
  icon?: React.ReactNode
  extra?: React.ReactNode
  /** 无标题栏且直接放内容的场景，body 是否需要内边距 */
  bodyPadding?: number
  children: React.ReactNode
}> = ({ title, description, icon, extra, bodyPadding = 0, children }) => {
  const { token } = theme.useToken()
  return (
    <div
      className="sui-section"
      style={
        {
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: 14,
          background: token.colorBgContainer,
          overflow: 'hidden',
          marginBottom: 14,
          '--sui-hairline': token.colorBorderSecondary,
          '--sui-bg': token.colorBgContainer
        } as React.CSSProperties
      }
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
      <div className="sui-rows" style={bodyPadding ? { padding: bodyPadding } : undefined}>
        {children}
      </div>
    </div>
  )
}

/** 行式条目：左侧标题 + 说明，右侧控件 */
export const SettingRow: React.FC<{
  title: string
  description?: string
  control: React.ReactNode
  /** 非行式内容（如输入区/图表）直接放入 */
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

/** 分区内的一块说明文字（独立段落，带内边距） */
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
