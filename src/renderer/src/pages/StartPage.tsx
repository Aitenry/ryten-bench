import React, { useCallback, useEffect } from 'react'
import { theme } from 'antd'
import {
  RiCompass3Line,
  RiFolder3Line,
  RiGlobalLine,
  RiTerminalBoxLine
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { usePtyTerminalStats } from '../hooks/usePtyTerminalStats'

/**
 * "Start" panel: tool picker on the right side (user wording 2026-11-27).
 *
 * - The entry lives in the **chat sidebar** (the "Start" button in HarnessSidebar); clicking it opens this page in the **right panel**,
 *   without taking over the chat content area and without opening the file explorer by default;
 * - Three tools: workspace files / new terminal / browser; "More tools" was removed as the user requested;
 * - After a selection the panel switches to that tool (same column, same width); the terminal card and the sidebar entry share the running-count badge.
 */

export type StartToolKind = 'workspace' | 'terminal' | 'browser'

interface StartPageProps {
  onSelect: (kind: StartToolKind) => void
}

const StartPage: React.FC<StartPageProps> = ({ onSelect }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const terminalAlive = usePtyTerminalStats()

  // Shortcuts match the hints on the cards (Ctrl/Cmd + P / ` / T)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey
      if (!mod || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'p') {
        event.preventDefault()
        onSelect('workspace')
      } else if (key === '`') {
        event.preventDefault()
        onSelect('terminal')
      } else if (key === 't') {
        event.preventDefault()
        onSelect('browser')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onSelect])

  const shortcut = useCallback(
    (value: string): string =>
      (window.navigator.platform || '').toLowerCase().includes('mac')
        ? `⌘ ${value}`
        : `Ctrl + ${value}`,
    []
  )

  const cards: Array<{
    key: StartToolKind
    icon: React.ReactNode
    title: string
    description: string
    shortcut: string
    badge?: string
  }> = [
    {
      key: 'workspace',
      icon: <RiFolder3Line size={19} style={{ color: '#e8b339' }} />,
      title: t('harness.startPage.workspace.title'),
      description: t('harness.startPage.workspace.description'),
      shortcut: shortcut('P')
    },
    {
      key: 'terminal',
      icon: <RiTerminalBoxLine size={19} style={{ color: '#4d6bfe' }} />,
      title: t('harness.startPage.terminal.title'),
      description: t('harness.startPage.terminal.description'),
      shortcut: shortcut('`'),
      badge:
        terminalAlive > 0 ? t('harness.startPage.terminal.running', { count: terminalAlive }) : ''
    },
    {
      key: 'browser',
      icon: <RiGlobalLine size={19} style={{ color: '#4d9bfe' }} />,
      title: t('harness.startPage.browser.title'),
      description: t('harness.startPage.browser.description'),
      shortcut: shortcut('T')
    }
  ]

  return (
    <div
      className="flex flex-col h-full overflow-y-auto custom-scrollbar"
      style={{ background: token.colorBgContainer, borderRadius: token.borderRadiusLG }}
      data-start-page="1"
    >
      {/* Title bar: same as the other right-side panels */}
      <div
        className="flex items-center"
        style={{
          height: 34,
          flex: '0 0 34px',
          gap: 7,
          padding: '0 12px',
          background: token.colorFillQuaternary,
          borderBottom: `1px solid ${token.colorBorderSecondary}`
        }}
      >
        <RiCompass3Line size={15} style={{ color: token.colorTextSecondary }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: token.colorText }}>
          {t('harness.startPage.title')}
        </span>
      </div>

      <div style={{ padding: '18px 12px 16px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            margin: '12px 0 22px',
            color: token.colorTextTertiary
          }}
        >
          <span
            style={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              border: `2px solid ${token.colorBorderSecondary}`,
              display: 'grid',
              placeItems: 'center'
            }}
          >
            <RiCompass3Line size={20} />
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-start-cards="1">
          {cards.map((card) => (
            <button
              key={card.key}
              type="button"
              data-start-card={card.key}
              onClick={() => onSelect(card.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                width: '100%',
                textAlign: 'left',
                padding: '11px 12px',
                minHeight: 56,
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 12,
                background: token.colorFillQuaternary,
                cursor: 'pointer',
                color: token.colorText
              }}
            >
              <span style={{ width: 22, display: 'grid', placeItems: 'center' }}>{card.icon}</span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6
                  }}
                >
                  {card.title}
                  {card.badge ? (
                    <span
                      data-start-terminal-badge="1"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        height: 17,
                        padding: '0 6px',
                        borderRadius: 999,
                        background: 'rgba(73,170,25,.14)',
                        color: '#3f9414',
                        fontSize: 9.5,
                        fontWeight: 600
                      }}
                    >
                      {card.badge}
                    </span>
                  ) : null}
                </span>
                <span
                  style={{
                    fontSize: 10.5,
                    color: token.colorTextTertiary,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                >
                  {card.description}
                </span>
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 10,
                  color: token.colorTextTertiary,
                  whiteSpace: 'nowrap'
                }}
              >
                {card.shortcut}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default StartPage
