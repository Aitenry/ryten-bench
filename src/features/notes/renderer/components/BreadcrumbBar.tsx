import React from 'react'
import { theme } from 'antd'
import { RiHome4Line, RiArrowRightSLine } from '@remixicon/react'

export interface BreadcrumbItem {
  label: string
  onClick?: () => void
}

interface BreadcrumbBarProps {
  items: BreadcrumbItem[]
  /** 右侧操作区 */
  actions?: React.ReactNode
}

const BreadcrumbBar: React.FC<BreadcrumbBarProps> = ({ items, actions }) => {
  const { token } = theme.useToken()

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 37,
        flexShrink: 0,
        padding: '0 12px',
        gap: 2,
        /* 主区卡片顶部的分隔行，不再独立成卡（参考 Harness 头部行） */
        borderBottom: `1px solid ${token.colorBorderSecondary}`
      }}
    >
      {items.map((item, index) => {
        const last = index === items.length - 1
        const clickable = Boolean(item.onClick) && !last
        return (
          <React.Fragment key={`${item.label}-${index}`}>
            {index > 0 && (
              <RiArrowRightSLine
                size={14}
                style={{ color: token.colorTextTertiary, flexShrink: 0 }}
              />
            )}
            <span
              onClick={item.onClick}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 13,
                fontWeight: last ? 600 : 400,
                color: last
                  ? token.colorText
                  : clickable
                    ? token.colorTextSecondary
                    : token.colorTextTertiary,
                cursor: clickable ? 'pointer' : 'default',
                padding: '2px 5px',
                borderRadius: 6,
                whiteSpace: 'nowrap'
              }}
              onMouseEnter={
                clickable
                  ? (e) => {
                      e.currentTarget.style.background = token.colorFillTertiary
                      e.currentTarget.style.color = token.colorText
                    }
                  : undefined
              }
              onMouseLeave={
                clickable
                  ? (e) => {
                      e.currentTarget.style.background = 'transparent'
                      e.currentTarget.style.color = token.colorTextSecondary
                    }
                  : undefined
              }
            >
              {index === 0 && <RiHome4Line size={14} />}
              {item.label}
            </span>
          </React.Fragment>
        )
      })}
      <span style={{ flex: 1 }} />
      {actions}
    </div>
  )
}

export default React.memo(BreadcrumbBar)
