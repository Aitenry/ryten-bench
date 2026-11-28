import React, { useMemo } from 'react'
import { theme } from 'antd'
import { useTranslation } from '@renderer/i18n'
import { filterSlashCommands, type HarnessSlashCommandId } from './slashCommands'

/**
 * Slash command panel for the input box — opened by typing `/` at the **start** of the input.
 *
 * It is a normal (in-flow) row of the input stack, mounted at the top of the column above the
 * goal / plan / task cards: opening it grows the input area upwards instead of drawing an overlay
 * on top of the cards. Group header "Add" plus one row per command: icon + localized name +
 * English alias + description on the right. The first row is highlighted by default; arrow keys
 * move and Enter picks (keyboard handling lives in the input's handleKeyDown).
 *
 * Only the two goal/plan commands are kept for now (the remaining rows in the mock were struck
 * out):
 * - goal: open the goal dialog to set or review the long-running task objective;
 * - plan: enter / leave plan mode.
 *
 * Filtering is a case-insensitive substring match against the query after `/` (localized name /
 * English alias / description). The parent parses the query from the editor text and closes the
 * menu on whitespace or an over-long query so it does not cover normal input.
 */

interface HarnessSlashMenuProps {
  /** Query text after `/` */
  query: string
  /** Keyboard highlight index (maintained by the parent, kept in sync with scroll/mouse) */
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onPick: (id: HarnessSlashCommandId) => void
  /** Floating panel container ref (the parent uses it to tell whether a click is inside) */
  menuRef?: React.RefObject<HTMLDivElement | null>
  style?: React.CSSProperties
}

const HarnessSlashMenu: React.FC<HarnessSlashMenuProps> = ({
  query,
  activeIndex,
  onActiveIndexChange,
  onPick,
  menuRef,
  style
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const rows = useMemo(() => filterSlashCommands((key) => t(key), query), [query, t])
  const active = rows.length === 0 ? -1 : Math.min(Math.max(activeIndex, 0), rows.length - 1)

  return (
    <div
      ref={menuRef}
      role="listbox"
      aria-label={t('harness.input.commands.aria')}
      data-harness-slash-menu="1"
      style={{
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 14,
        boxShadow: '0 18px 48px rgba(0, 0, 0, 0.32)',
        padding: '5px 0 4px',
        overflow: 'hidden',
        ...style
      }}
    >
      {/* Group header: both commands currently belong to "Add" */}
      <div
        style={{
          padding: '5px 14px 4px',
          fontSize: 11.5,
          lineHeight: '16px',
          color: token.colorTextTertiary,
          userSelect: 'none'
        }}
      >
        {t('harness.input.commands.groupAdd')}
      </div>

      {rows.length === 0 ? (
        <div
          style={{
            padding: '10px 14px 12px',
            fontSize: 12.5,
            color: token.colorTextTertiary
          }}
        >
          {t('harness.input.commands.empty')}
        </div>
      ) : (
        rows.map((command, index) => {
          const label = t(command.labelKey)
          // Skip the alias when the localized label differs from it only by case
          const showAlias = label.toLowerCase() !== command.alias.toLowerCase()
          const Icon = command.icon
          const selected = index === active
          return (
            <button
              key={command.id}
              type="button"
              role="option"
              aria-selected={selected}
              data-harness-slash-command={command.id}
              // mousedown instead of click: do not move focus out of the editor
              onMouseDown={(event) => {
                event.preventDefault()
                onPick(command.id)
              }}
              onMouseMove={() => {
                if (!selected) onActiveIndexChange(index)
              }}
              style={{
                width: '100%',
                height: 40,
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '0 14px',
                border: 'none',
                background: selected ? token.colorFillTertiary : 'transparent',
                color: token.colorText,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 0.12s'
              }}
            >
              <Icon size={16} style={{ color: token.colorTextSecondary, flexShrink: 0 }} />
              <span style={{ fontSize: 13.5, fontWeight: 500, lineHeight: '18px' }}>{label}</span>
              {showAlias ? (
                <span style={{ fontSize: 12, color: token.colorTextTertiary, lineHeight: '18px' }}>
                  {command.alias}
                </span>
              ) : null}
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 12,
                  color: token.colorTextTertiary,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  paddingLeft: 16
                }}
              >
                {t(command.descriptionKey)}
              </span>
            </button>
          )
        })
      )}
    </div>
  )
}

export default HarnessSlashMenu
