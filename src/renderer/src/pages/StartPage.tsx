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
 * 「开始」面板：右侧工具选择入口（用户 2026-11-27 口径）。
 *
 * - 入口在**对话窗口侧栏**（HarnessSidebar 的「开始」按钮），点击后在**右侧面板**打开本页，
 *   不占对话主内容区、也不默认弹资源管理器；
 * - 三个工具：工作区文件 / 新建终端 / 浏览器；「更多工具」按用户要求移除；
 * - 选择后面板切换为对应工具（同一列、同一宽度）；终端卡片与侧栏入口共用运行数角标。
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
      {/* 标题栏：与其他右侧面板同款 */}
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
