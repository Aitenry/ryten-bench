import React, { useCallback, useState } from 'react'
import { Badge, Button, Progress, Tag, theme } from 'antd'
import {
  RiCheckDoubleLine,
  RiCheckboxCircleLine,
  RiLoader4Line,
  RiNotification3Line
} from '@remixicon/react'
import { useNotification } from '@renderer/hooks/useNotification'
import { useTranslation } from '@renderer/i18n'
import type { NotificationItem } from '@renderer/types/notification'

/**
 * Notification list (shell).
 *
 * The **container** of notifications belongs to the shell, their **shape** to the plugin that
 * produces them: core reads only generic fields by name (title/description) plus known progress
 * fields (phaseLabel/overallProgress/completed; a missing field means that fragment is not
 * rendered). A disabled plugin no longer produces new notifications, but past ones still render
 * fine.
 *
 * Visual: a small 340-wide card — header with "messages + unread count + mark all read", below it
 * row entries (type icon / title / description / time / progress bar); the empty state shows an
 * icon and an explanation instead of a bare line of text.
 */
interface NotificationListProps {
  onClose: () => void
}

/** Display fields of progress notifications (plugin extension fields; the fragment is not rendered when absent) */
interface ProgressNotificationFields {
  phaseLabel?: string
  overallProgress?: number
  completed?: boolean
}

const SMALL_TAG_STYLE: React.CSSProperties = {
  fontSize: 10.5,
  lineHeight: '17px',
  margin: 0,
  paddingInline: 6,
  borderRadius: 6
}

/** Notification time: "just now" within a minute, N minutes ago within an hour, N hours ago within 24 hours, otherwise month/day */

const NotificationList: React.FC<NotificationListProps> = ({ onClose }) => {
  const { token } = theme.useToken()
  const { notifications, unreadCount, markAllRead } = useNotification()
  const { t } = useTranslation()
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  /** Notification time: "just now" within a minute, N minutes ago within an hour, N hours ago within 24 hours, otherwise month/day */
  const formatTime = useCallback(
    (timestamp: number): string => {
      const diffMinutes = Math.floor((Date.now() - timestamp) / 60_000)
      if (diffMinutes < 1) return t('shell.notificationList.timeJustNow')
      if (diffMinutes < 60)
        return t('shell.notificationList.timeMinutesAgo', { count: diffMinutes })
      const hours = Math.floor(diffMinutes / 60)
      if (hours < 24) return t('shell.notificationList.timeHoursAgo', { count: hours })
      const date = new Date(timestamp)
      return `${date.getMonth() + 1}/${date.getDate()}`
    },
    [t]
  )

  const handleItemClick = useCallback(
    (item: NotificationItem) => {
      item.onClick?.()
      onClose()
    },
    [onClose]
  )

  const emptyState = (
    <div style={{ padding: '26px 20px 30px', textAlign: 'center' }}>
      <div
        style={{
          width: 46,
          height: 46,
          margin: '0 auto 12px',
          borderRadius: 15,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: token.colorFillSecondary,
          color: token.colorTextTertiary
        }}
      >
        <RiNotification3Line size={21} />
      </div>
      <div style={{ fontSize: 13, color: token.colorText, fontWeight: 500 }}>
        {t('shell.notificationList.empty')}
      </div>
      <div
        style={{
          marginTop: 5,
          fontSize: 11.5,
          lineHeight: '17px',
          color: token.colorTextTertiary
        }}
      >
        {t('shell.notificationList.emptyHint')}
      </div>
    </div>
  )

  return (
    <div style={{ width: '100%' }}>
      {/* Header: title + unread count + mark all read */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '12px 14px 9px'
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: token.colorText }}>
          {t('shell.notificationList.title')}
        </span>
        {unreadCount > 0 && (
          <Badge
            count={unreadCount}
            size="small"
            style={{ background: token.colorPrimary, boxShadow: 'none' }}
          />
        )}
        <span style={{ flex: 1 }} />
        {unreadCount > 0 && (
          <Button
            type="text"
            size="small"
            icon={<RiCheckDoubleLine size={14} />}
            onClick={markAllRead}
            style={{
              height: 24,
              paddingInline: 7,
              fontSize: 12,
              color: token.colorTextSecondary
            }}
          >
            {t('shell.notificationList.markAllRead')}
          </Button>
        )}
      </div>

      {notifications.length === 0 ? (
        emptyState
      ) : (
        <div
          className="custom-scrollbar"
          style={{ maxHeight: 360, overflowY: 'auto', padding: '0 8px 8px' }}
        >
          {notifications.map((item) => {
            const progress: ProgressNotificationFields | null =
              item.type === 'build_progress'
                ? (item as unknown as ProgressNotificationFields)
                : null
            const percent = Math.max(0, Math.min(100, Math.round(progress?.overallProgress ?? 0)))
            const isBuilding = Boolean(progress) && progress?.completed !== true
            const isDone = progress?.completed === true
            const hovered = hoveredId === item.id
            const iconColor = isDone
              ? token.colorSuccess
              : isBuilding
                ? token.colorPrimary
                : token.colorTextSecondary
            const iconBg = isDone
              ? token.colorSuccessBg
              : isBuilding
                ? token.colorPrimaryBg
                : token.colorFillSecondary

            return (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                onClick={() => handleItemClick(item)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleItemClick(item)
                  }
                }}
                onMouseEnter={() => setHoveredId(item.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  display: 'flex',
                  gap: 10,
                  padding: '10px 8px',
                  borderRadius: 10,
                  cursor: 'pointer',
                  background: hovered ? token.colorFillQuaternary : 'transparent',
                  transition: 'background 0.15s'
                }}
              >
                <span
                  style={{
                    width: 30,
                    height: 30,
                    flexShrink: 0,
                    borderRadius: 9,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: iconBg,
                    color: iconColor
                  }}
                >
                  {isDone ? (
                    <RiCheckboxCircleLine size={16} />
                  ) : isBuilding ? (
                    <RiLoader4Line size={16} className="animate-spin" />
                  ) : (
                    <RiNotification3Line size={15} />
                  )}
                </span>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 13,
                        fontWeight: item.read ? 400 : 500,
                        color: item.read ? token.colorTextSecondary : token.colorText,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {item.title}
                    </span>
                    {!item.read && (
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          flexShrink: 0,
                          borderRadius: '50%',
                          background: token.colorPrimary
                        }}
                      />
                    )}
                    <span
                      style={{
                        fontSize: 10.5,
                        flexShrink: 0,
                        color: token.colorTextTertiary
                      }}
                    >
                      {formatTime(item.timestamp)}
                    </span>
                  </div>

                  <div
                    style={{
                      marginTop: 2,
                      fontSize: 12,
                      lineHeight: '17px',
                      color: token.colorTextTertiary,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden'
                    }}
                  >
                    {item.description}
                  </div>

                  {(isBuilding || isDone) && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                      {isDone && (
                        <Tag color="success" style={SMALL_TAG_STYLE}>
                          {t('shell.notificationList.completed')}
                        </Tag>
                      )}
                      {isBuilding && progress?.phaseLabel && (
                        <Tag color="processing" style={SMALL_TAG_STYLE}>
                          {progress.phaseLabel}
                        </Tag>
                      )}
                      {isBuilding && (
                        <>
                          <Progress
                            percent={percent}
                            size="small"
                            strokeColor={token.colorPrimary}
                            showInfo={false}
                            style={{ flex: 1, margin: 0 }}
                          />
                          <span
                            style={{
                              fontSize: 10.5,
                              flexShrink: 0,
                              color: token.colorTextTertiary
                            }}
                          >
                            {percent}%
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default NotificationList
