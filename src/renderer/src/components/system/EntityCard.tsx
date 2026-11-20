import React from 'react'
import { theme } from 'antd'
import { entityGradient } from '@renderer/utils/entityColor'

/**
 * 通用实体卡（插件 / 智能体 / 技能 / MCP 服务器 / …）。
 *
 * 视觉基准参考 Raycast、Linear、Vercel 一类产品的卡片语言：
 * - 一枚带渐变色的图标块作为唯一的彩色元素，其余全部走主题 token；
 * - 标题 + 元信息 + 两行描述 + 底部动作，层级固定，扫视时不会跳；
 * - 悬停只做「轻微抬升 + 描边变亮」，不加花哨的动画。
 *
 * 卡片本身不决定宽高：外层用 CSS grid 排（`repeat(auto-fill, minmax(232px, 1fr))`）。
 */

/** 卡片元信息里的小胶囊（版本、模型、内置标记…） */
export const EntityChip: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token } = theme.useToken()
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 20,
        padding: '0 8px',
        borderRadius: 999,
        border: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorFillQuaternary,
        color: token.colorTextSecondary,
        fontSize: 10.5,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }}
    >
      {children}
    </span>
  )
}

export interface EntityCardProps {
  /** 实体 id：用于稳定取渐变色（`gradient` 优先） */
  id?: string
  gradient?: [string, string]
  icon: React.ReactNode
  title: string
  /** 标题下的元信息行（建议用 EntityChip） */
  meta?: React.ReactNode
  description?: string
  /** 描述与底部之间的补充内容（连接目标、工具数量…） */
  children?: React.ReactNode
  footerStart?: React.ReactNode
  footerEnd?: React.ReactNode
  onClick?: () => void
  minHeight?: number
  /** 稳定钩子（工装定位用） */
  dataAttrs?: Record<string, string>
}

const EntityCard: React.FC<EntityCardProps> = ({
  id,
  gradient,
  icon,
  title,
  meta,
  description,
  children,
  footerStart,
  footerEnd,
  onClick,
  minHeight = 176,
  dataAttrs
}) => {
  const { token } = theme.useToken()
  const [from, to] = gradient ?? entityGradient(id ?? title)

  return (
    <div
      {...dataAttrs}
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight,
        padding: 16,
        borderRadius: 16,
        border: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgElevated,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'transform .18s ease, border-color .18s ease, box-shadow .18s ease'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-2px)'
        e.currentTarget.style.borderColor = token.colorBorder
        e.currentTarget.style.boxShadow = token.boxShadowTertiary
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'none'
        e.currentTarget.style.borderColor = token.colorBorderSecondary
        e.currentTarget.style.boxShadow = 'none'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span
          style={{
            width: 42,
            height: 42,
            borderRadius: 12,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `linear-gradient(135deg, ${from}, ${to})`,
            color: '#fff',
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.16)'
          }}
        >
          {icon}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 14.5,
              fontWeight: 600,
              letterSpacing: '-0.005em',
              color: token.colorText,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {title}
          </div>
          {meta && (
            <div
              style={{
                marginTop: 6,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'wrap'
              }}
            >
              {meta}
            </div>
          )}
        </div>
      </div>

      {description && (
        <p
          style={{
            margin: '12px 0 0',
            fontSize: 12.5,
            lineHeight: 1.65,
            color: token.colorTextSecondary,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden'
          }}
        >
          {description}
        </p>
      )}

      {children}

      {(footerStart || footerEnd) && (
        <div
          style={{
            marginTop: 'auto',
            paddingTop: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 0
          }}
        >
          {footerStart}
          {footerEnd}
        </div>
      )}
    </div>
  )
}

export default EntityCard
