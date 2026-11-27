import React, { useCallback, useEffect, useState } from 'react'
import { theme } from 'antd'
import { useNavigate } from 'react-router-dom'
import {
  RiApps2Line,
  RiArrowRightSLine,
  RiCompass3Line,
  RiFolder3Line,
  RiGlobalLine,
  RiTerminalBoxLine
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { usePtyTerminalStats } from '../hooks/usePtyTerminalStats'
import { requestHarnessPanel } from '../utils/harness/panel-launch'

/**
 * 「开始」页：工具选择入口（用户 2026-11-27 截图设计）。
 *
 * 顶部栏不再放终端按钮；从侧栏「开始」进入这里，选择：工作区文件 / 新建终端 / 浏览器 /
 * 更多工具。选中后面板在 `/harness` 右侧列打开（sessionStorage 传一次启动意图）。
 *
 * 终端卡片和侧栏角标共用 `usePtyTerminalStats()`（主进程真源 + 会话变化事件）。
 */

interface StartCard {
  key: 'workspace' | 'terminal' | 'browser' | 'more'
  icon: React.ReactNode
  title: string
  description: string
  shortcut?: string
  badge?: string
}

const StartPage: React.FC = () => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const terminalAlive = usePtyTerminalStats()
  const [moreOpen, setMoreOpen] = useState(false)

  const openPanel = useCallback(
    (kind: 'workspace' | 'terminal' | 'browser'): void => {
      requestHarnessPanel(kind)
      navigate('/harness')
    },
    [navigate]
  )

  // 快捷键与卡片上的提示一致（Ctrl/Cmd + P / ` / T）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey
      if (!mod || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'p') {
        event.preventDefault()
        openPanel('workspace')
      } else if (key === '`') {
        event.preventDefault()
        openPanel('terminal')
      } else if (key === 't') {
        event.preventDefault()
        openPanel('browser')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openPanel])

  const shortcut = (value: string): string =>
    (window.navigator.platform || '').toLowerCase().includes('mac') ? `⌘ ${value}` : `Ctrl + ${value}`

  const cards: StartCard[] = [
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
    },
    {
      key: 'more',
      icon: <RiApps2Line size={22} style={{ color: token.colorTextSecondary }} />,
      title: t('harness.startPage.more.title'),
      description: t('harness.startPage.more.description')
    }
  ]

  const moreItems = [
    { key: 'skills', label: t('settings.nav.skills') },
    { key: 'mcp', label: t('settings.nav.mcp') },
    { key: 'memory', label: t('settings.nav.memory') },
    { key: 'agents', label: t('settings.nav.agents') }
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
          {cards.map((card) => {
            const selected = card.key === 'more' && moreOpen
            return (
              <React.Fragment key={card.key}>
                <button
                  type="button"
                  data-start-card={card.key}
                  onClick={() => {
                    if (card.key === 'more') {
                      setMoreOpen((prev) => !prev)
                    } else {
                      openPanel(card.key)
                    }
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    width: '100%',
                    textAlign: 'left',
                    padding: '14px 18px',
                    minHeight: 64,
                    border: `1px solid ${selected ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
                    borderRadius: 14,
                    background: token.colorFillQuaternary,
                    cursor: 'pointer',
                    color: token.colorText,
                    transition: 'border-color .15s ease, background .15s ease'
                  }}
                >
                  <span style={{ width: 26, display: 'grid', placeItems: 'center' }}>
                    {card.icon}
                  </span>
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
                      {card.key === 'more' ? (
                        <RiArrowRightSLine
                          size={15}
                          style={{
                            transform: moreOpen ? 'rotate(90deg)' : 'none',
                            transition: 'transform .15s ease',
                            color: token.colorTextTertiary
                          }}
                        />
                      ) : null}
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
                  {card.shortcut ? (
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
                  ) : null}
                </button>
                {selected
                  ? moreItems.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        data-start-more-item={item.key}
                        onClick={() => navigate(`/more/${item.key}`)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          height: 42,
                          marginLeft: 40,
                          padding: '0 14px',
                          border: `1px solid ${token.colorBorderSecondary}`,
                          borderRadius: 10,
                          background: token.colorFillQuaternary,
                          color: token.colorTextSecondary,
                          fontSize: 12.5,
                          cursor: 'pointer'
                        }}
                      >
                        {item.label}
                        <RiArrowRightSLine
                          size={14}
                          style={{ marginLeft: 'auto', color: token.colorTextTertiary }}
                        />
                      </button>
                    ))
                  : null}
              </React.Fragment>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default StartPage
