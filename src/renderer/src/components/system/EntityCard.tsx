import React from 'react'
import { theme } from 'antd'
import { entityGradient } from '@renderer/utils/entityColor'

/**
 * Generic entity card (plugin / agent / skill / MCP server / …).
 *
 * Visual language follows the card style common in modern desktop products:
 * - a single gradient icon tile is the only colored element; everything else uses theme tokens;
 * - title + meta + two-line description + footer actions, a fixed hierarchy that stays steady
 *   while scanning;
 * - hover only adds a slight lift and a brighter border, no decorative animation.
 *
 * The card does not set its own width or height: the parent lays it out with a CSS grid
 * (`repeat(auto-fill, minmax(232px, 1fr))`).
 */

/** Small pill inside the card meta row (version, model, built-in marker…) */
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
  /** Entity id: used to derive a stable gradient (`gradient` takes priority) */
  id?: string
  gradient?: [string, string]
  icon: React.ReactNode
  title: string
  /** Meta row under the title (EntityChip recommended) */
  meta?: React.ReactNode
  description?: string
  /** Extra content between the description and the footer (connection target, tool count…) */
  children?: React.ReactNode
  footerStart?: React.ReactNode
  footerEnd?: React.ReactNode
  onClick?: () => void
  minHeight?: number
  /** Stable hooks (for fixture targeting) */
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
