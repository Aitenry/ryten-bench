import React, { useCallback, useEffect, useRef, useState } from 'react'
import { theme } from 'antd'
import {
  RiTerminalBoxLine
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { harnessApi, type PtySessionView } from '../../api/harness'
import TerminalEmulator from './TerminalEmulator'

/**
 * 右侧「终端」面板（用户侧**真**终端）。
 *
 * 渲染/输入：xterm.js；进程壳：主进程 node-pty（真 TTY）。打开面板且没有会话时默认
 * 自动新建一个；关闭页签才杀进程，收起面板不会终止终端（重开可回放缓冲继续用）。
 *
 * 与模型侧 `terminal_*` 工具的行模式会话是两套实现：那套供模型调用，这套供人使用。
 */

interface TerminalPanelProps {
  /** 当前话题；null 也允许用（会话归属 0，cwd 落到用户主目录） */
  topicId: number | null
  isDarkMode: boolean
  colorBgContainer: string
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  onRunningCountChange?: (count: number) => void
  onClosePanel?: () => void
}

const TERMINAL_ERROR_KEYS = {
  'too-many-sessions': 'harness.terminalPanel.tooMany',
  'no-shell': 'harness.terminalPanel.noShell',
  'spawn-failed': 'harness.terminalPanel.failed'
} as const

type TerminalErrorKey =
  | (typeof TERMINAL_ERROR_KEYS)[keyof typeof TERMINAL_ERROR_KEYS]
  | 'harness.terminalPanel.failed'

const errorKey = (code: string | undefined): TerminalErrorKey => {
  if (code && code in TERMINAL_ERROR_KEYS) {
    return TERMINAL_ERROR_KEYS[code as keyof typeof TERMINAL_ERROR_KEYS]
  }
  return 'harness.terminalPanel.failed'
}

const TerminalPanel: React.FC<TerminalPanelProps> = ({
  topicId,
  isDarkMode,
  colorBgContainer,
  colorText,
  colorTextSecondary,
  colorTextTertiary,
  onRunningCountChange,
  onClosePanel
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const [sessions, setSessions] = useState<PtySessionView[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId
  /** 自动新建只尝试一次（手动关掉最后一个会话后不反复重建；重开面板会复位） */
  const autoOpenedRef = useRef(false)

  const loadSessions = useCallback(async (): Promise<PtySessionView[]> => {
    try {
      const result = await harnessApi.ptyTerminal.list(topicId ?? 0)
      const list = result.ok ? result.sessions : []
      setSessions(list)
      setActiveId((prev) =>
        prev && list.some((session) => session.sessionId === prev)
          ? prev
          : (list[0]?.sessionId ?? null)
      )
      onRunningCountChange?.(list.filter((session) => session.alive).length)
      return list
    } catch (err) {
      console.warn('[pty-terminal] Failed to list sessions:', err)
      return []
    }
  }, [onRunningCountChange, topicId])

  const openSession = useCallback(async (): Promise<void> => {
    if (opening) return
    setOpening(true)
    setError(null)
    try {
      const result = await harnessApi.ptyTerminal.open({
        topicId: topicId ?? 0,
        // 初始尺寸给个常见值，挂载后 FitAddon 会立刻 resize
        cols: 100,
        rows: 30
      })
      if (!result.ok) {
        setError(t(errorKey(result.error)))
        return
      }
      await loadSessions()
      setActiveId(result.session.sessionId)
    } catch (err) {
      setError(String(err))
    } finally {
      setOpening(false)
    }
  }, [loadSessions, opening, t, topicId])

  const closeSession = useCallback(
    async (sessionId: string): Promise<void> => {
      try {
        await harnessApi.ptyTerminal.close(sessionId)
      } catch (err) {
        console.warn('[pty-terminal] close failed:', err)
      }
      if (activeIdRef.current === sessionId) setActiveId(null)
      await loadSessions()
    },
    [loadSessions]
  )

  // 话题切换 / 首次挂载：重新拉列表（自动新建标记复位）
  useEffect(() => {
    setSessions([])
    setActiveId(null)
    setError(null)
    autoOpenedRef.current = false
    setLoading(true)
    void loadSessions().finally(() => setLoading(false))
  }, [loadSessions])

  // 打开面板且没有会话 → 默认自动新建一个真终端（只发生在首次加载完成时；
  // 之后用户手动关掉最后一个会话不再自动重建）
  useEffect(() => {
    if (loading || autoOpenedRef.current) return
    autoOpenedRef.current = true
    if (sessions.length === 0 && !error) void openSession()
  }, [error, loading, openSession, sessions.length])

  // 会话列表变化（模型/其他窗口新建、进程退出、关闭）时刷新页签
  useEffect(() => {
    const unsubscribe = harnessApi.ptyTerminal.onSessionsChanged(() => {
      void loadSessions()
    })
    return unsubscribe
  }, [loadSessions])

  // alive 数量同步给顶栏角标
  useEffect(() => {
    onRunningCountChange?.(sessions.filter((session) => session.alive).length)
  }, [onRunningCountChange, sessions])

  /**
   * 没有终端就不保留空面板（用户 2026-11-27 口径）：
   * 创建失败，或用户关掉最后一个会话 → 自动收起整个终端侧栏。
   * 初次打开且没有会话时由上面的自动新建负责，不在这里关。
   */
  const hadSessionsRef = useRef(false)
  useEffect(() => {
    if (sessions.length > 0) hadSessionsRef.current = true
  }, [sessions.length])
  useEffect(() => {
    if (loading || opening) return
    if (sessions.length > 0) return
    if (error || hadSessionsRef.current) onClosePanel?.()
  }, [error, loading, onClosePanel, opening, sessions.length])

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
      style={{ background: colorBgContainer, borderRadius: token.borderRadiusLG }}
      data-terminal-panel="1"
    >
      {/* 标题栏：与工作区面板同款浅灰条 */}
      <div
        className="flex items-center"
        style={{
          height: 34,
          flex: '0 0 34px',
          gap: 7,
          padding: '0 8px 0 12px',
          background: isDarkMode ? '#252526' : '#f3f3f3',
          borderBottom: `1px solid ${isDarkMode ? '#1e1e1e' : '#e4e4e4'}`
        }}
      >
        <RiTerminalBoxLine size={15} style={{ color: colorTextSecondary }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: colorText }}>
          {t('harness.terminalPanel.title')}
        </span>
        {sessions.length > 0 ? (
          <span
            className="inline-flex items-center"
            style={{
              gap: 5,
              height: 18,
              padding: '0 7px',
              borderRadius: 999,
              background: 'rgba(73,170,25,.14)',
              color: '#3f9414',
              fontSize: 10,
              fontWeight: 600
            }}
          >
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor' }} />
            {t('harness.terminalPanel.runningCount', {
              count: sessions.filter((session) => session.alive).length
            })}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
      </div>

      {/* 会话页签 */}
      <div
        className="flex items-stretch overflow-hidden"
        style={{
          height: 33,
          flex: '0 0 33px',
          background: isDarkMode ? '#252526' : '#f3f3f3',
          borderBottom: `1px solid ${isDarkMode ? '#1e1e1e' : '#e0e0e0'}`
        }}
      >
        {sessions.map((session) => {
          const active = session.sessionId === activeId
          return (
            <button
              key={session.sessionId}
              type="button"
              data-terminal-session-id={session.sessionId}
              onClick={() => setActiveId(session.sessionId)}
              className="flex items-center"
              style={{
                gap: 6,
                height: 33,
                maxWidth: 170,
                padding: '0 9px 0 11px',
                fontSize: 11.5,
                color: active ? colorText : colorTextSecondary,
                background: active ? colorBgContainer : isDarkMode ? '#2d2d2d' : '#ececec',
                border: 'none',
                borderTop: `2px solid ${active ? token.colorPrimary : 'transparent'}`,
                borderRight: `1px solid ${isDarkMode ? '#1e1e1e' : '#e0e0e0'}`,
                cursor: 'pointer',
                whiteSpace: 'nowrap'
              }}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: session.alive ? '#49aa19' : '#b9bec7',
                  flex: '0 0 auto'
                }}
              />
              <span className="truncate" style={{ maxWidth: 96 }}>
                {session.shell}
              </span>
              <span
                role="presentation"
                data-terminal-close-tab="1"
                onClick={(event) => {
                  event.stopPropagation()
                  void closeSession(session.sessionId)
                }}
                style={{ color: colorTextTertiary, fontSize: 10, marginLeft: 2 }}
              >
                ✕
              </span>
            </button>
          )
        })}
      </div>

      {/* 终端主体：xterm.js + node-pty（没有会话时面板会被自动关闭，不再显示空态/新建入口） */}
      {loading ? (
        <div style={{ padding: 14, fontSize: 12, color: colorTextTertiary }}>
          {t('harness.terminalPanel.loading')}
        </div>
      ) : sessions.length > 0 ? (
        <TerminalEmulator
          key={activeId ?? 'none'}
          sessionId={activeId ?? ''}
          isDarkMode={isDarkMode}
          onExited={() => void loadSessions()}
        />
      ) : null}
    </div>
  )
}

export default TerminalPanel
