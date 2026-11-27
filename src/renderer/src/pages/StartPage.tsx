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
 * 「开始」页：工具选择入口（用户 2026-11-27 截图设计，后续按反馈移到对话窗口侧栏）。
 *
 * 入口在**对话窗口侧栏**（HarnessSidebar 的「开始」按钮），不是系统外壳侧栏；
 * 页面在助手页主内容区渲染（对话区让位），选择后打开右列对应面板：
 * 工作区文件 / 新建终端 / 浏览器。「更多工具」按用户要求移除。
 *
 * 终端卡片与侧栏入口共用 `usePtyTerminalStats()`（主进程真源 + 会话变化事件）。
 */

export type StartToolKind = 'workspace' | 'terminal' | 'browser'

interface StartPageProps {
  onSelect: (kind: StartToolKind) => void
}

const StartPage: React.FC<StartPageProps> = ({ onSelect }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const terminalAlive = usePtyTerminalStats()

  // 快捷键与卡片上的提示一致（Ctrl/Cmd + P / ` / T）
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
      icon: <RiFolder3Line size={22} style={{ color: '#e8b339' }} />,
      title: t('harness.startPage.workspace.title'),
      description: t('harness.startPage.workspace.description'),
      shortcut: shortcut('P')
    },
    {
      key: 'terminal',
      icon: <RiTerminalBoxLine size={22} style={{ color: '#4d6bfe' }} />,
      title: t('harness.startPage.terminal.title'),
      description: t('harness.startPage.terminal.description'),
      shortcut: shortcut('`'),
      badge: terminalAlive > 0 ? t('harness.startPage.terminal.running', { count: terminalAlive }) : ''
    },
    {
      key: 'browser',
      icon: <RiGlobalLine size={22} style={{ color: '#4d9bfe' }} />,
      title: t('harness.startPage.browser.title'),
      description: t('harness.startPage.browser.description'),
      shortcut: shortcut('T')
    }
  ]

  return (
    <div
      className="h-full overflow-y-auto custom-scrollbar"
      style={{ background: token.colorBgContainer }}
      data-start-page="1"
    >
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '28px 24px 64px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: token.colorText }}>
          <RiCompass3Line size={17} />
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{t('harness.startPage.title')}</span>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            margin: '72px 0 44px',
            color: token.colorTextTertiary
          }}
        >
          <span
            style={{
              width: 58,
              height: 58,
              borderRadius: '50%',
              border: `2px solid ${token.colorBorderSecondary}`,
              display: 'grid',
              placeItems: 'center'
            }}
          >
            <RiCompass3Line size={26} />
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-start-cards="1">
          {cards.map((card) => (
            <button
              key={card.key}
              type="button"
              data-start-card={card.key}
              onClick={() => onSelect(card.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                width: '100%',
                textAlign: 'left',
                padding: '14px 18px',
                minHeight: 64,
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 14,
                background: token.colorFillQuaternary,
                cursor: 'pointer',
                color: token.colorText
              }}
            >
              <span style={{ width: 26, display: 'grid', placeItems: 'center' }}>{card.icon}</span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 14.5,
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
                        height: 18,
                        padding: '0 7px',
                        borderRadius: 999,
                        background: 'rgba(73,170,25,.14)',
                        color: '#3f9414',
                        fontSize: 10,
                        fontWeight: 600
                      }}
                    >
                      {card.badge}
                    </span>
                  ) : null}
                </span>
                <span style={{ fontSize: 11.5, color: token.colorTextTertiary }}>
                  {card.description}
                </span>
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 11,
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
