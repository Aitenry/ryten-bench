import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button, theme, Tooltip } from 'antd'
import { RiAddLine, RiCloseLine, RiLayoutRightLine, RiTerminalBoxLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { harnessApi, type TerminalSessionView } from '../../api/harness'

/**
 * 右侧「终端」面板（持久终端会话的用户侧入口）。
 *
 * 口径与设计稿（2026-11-27 用户确认）：
 * - **右侧停靠、直接占用布局宽度**，结构与右侧工作区面板同构（标题栏 / 页签 / 分隔条由外层给）；
 * - **没有单独的命令输入框**：点击终端区后直接在页面上打字，Enter 发送、Backspace 删除；
 * - 终端内容跟随主题（亮色浅底深字、暗色深底浅字），不显示「完全权限专用」这类底部提示；
 * - 与模型侧 `terminal_*` 工具共用会话管理器：模型开的会话会出现在页签里，面板里敲的
 *   命令也进入模型的可见输出（读取走非消费的 peek，不抢模型的未读缓冲）。
 *
 * 安全边界：新建会话 / 发送命令只在 `danger-full-access` 档允许（主进程仍会再校验），
 * 查看与关闭永远可用。
 */

interface TerminalPanelProps {
  /** 当前话题；null = 没有选中会话，面板只显示空态 */
  topicId: number | null
  isDarkMode: boolean
  colorBgContainer: string
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  colorBorderSecondary: string
  /** 运行中会话数量回传给顶栏按钮（角标用） */
  onRunningCountChange?: (count: number) => void
  /** 顶部栏按钮收起面板 */
  onClosePanel?: () => void
}

/** 稳定错误码 → 界面文案（主进程返回的 error 是稳定代码） */
const TERMINAL_ERROR_KEYS = {
  'permission-denied': 'harness.terminalPanel.notFullAccess',
  'too-many-sessions': 'harness.terminalPanel.tooMany',
  'no-shell': 'harness.terminalPanel.noShell',
  'session-busy': 'harness.terminalPanel.busy',
  'session-exited': 'harness.terminalPanel.exited',
  'invalid-topic': 'harness.terminalPanel.noWorkspace',
  'topic-not-found': 'harness.terminalPanel.noWorkspace',
  'workspace-not-found': 'harness.terminalPanel.noWorkspace',
  'empty-command': 'harness.terminalPanel.emptyCommand',
  'command-too-long': 'harness.terminalPanel.tooLong'
} as const

type TerminalErrorKey =
  (typeof TERMINAL_ERROR_KEYS)[keyof typeof TERMINAL_ERROR_KEYS] | 'harness.terminalPanel.failed'

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
  colorBorderSecondary,
  onRunningCountChange,
  onClosePanel
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const [sessions, setSessions] = useState<TerminalSessionView[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** 非消费快照（输出正文；轮询整体替换，不做增量拼接） */
  const [snapshot, setSnapshot] = useState<{
    text: string
    cwd: string
    shell: string
    alive: boolean
    truncated: boolean
    binary: boolean
  } | null>(null)
  /** 在终端页面上直接输入的当前行（没有输入框，这一行渲染在终端内容末尾） */
  const [buffer, setBuffer] = useState('')
  const [busy, setBusy] = useState(false)
  const [focused, setFocused] = useState(false)
  /** 列表/新建都按 topicId ?? 0 归属：没有选中会话时也能用终端（落到用户主目录） */
  const sessionKey = topicId ?? 0

  const surfaceRef = useRef<HTMLDivElement>(null)
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId

  const termBg = isDarkMode ? '#16181d' : '#f7f8fa'
  const termText = isDarkMode ? '#d7dae0' : '#2b3038'
  const promptColor = isDarkMode ? '#7ee787' : '#0b7a3b'
  const cwdColor = isDarkMode ? '#79c0ff' : '#0b5cad'
  const cursorColor = isDarkMode ? '#7ee787' : '#2b3038'

  const loadSessions = useCallback(async (): Promise<TerminalSessionView[]> => {
    try {
      const result = await harnessApi.terminal.list(topicId ?? 0)
      const list = result.ok ? result.sessions : []
      setSessions(list)
      setActiveId((prev) =>
        prev && list.some((s) => s.sessionId === prev) ? prev : (list[0]?.sessionId ?? null)
      )
      onRunningCountChange?.(list.length)
      return list
    } catch (err) {
      console.warn('[terminal] Failed to list sessions:', err)
      return []
    }
  }, [onRunningCountChange, topicId])

  useEffect(() => {
    setSessions([])
    setActiveId(null)
    setSnapshot(null)
    setBuffer('')
    setError(null)
    setNotice(null)
    setLoading(true)
    void (async () => {
      await loadSessions()
      setLoading(false)
    })()
  }, [loadSessions, sessionKey])

  // 轮询：会话列表（存活状态）+ 当前会话输出快照。peek 不消费未读缓冲。
  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      const list = await loadSessions()
      if (cancelled) return
      const id = activeIdRef.current
      if (!id) {
        if (list.length > 0) setActiveId(list[0].sessionId)
        return
      }
      try {
        const peek = await harnessApi.terminal.peek({ sessionId: id, maxChars: 30_000 })
        if (cancelled) return
        if (peek.ok) {
          setSnapshot({
            text: peek.text,
            cwd: peek.cwd,
            shell: peek.shell,
            alive: peek.alive,
            truncated: peek.truncated,
            binary: peek.binary
          })
        } else if (peek.error === 'session-not-found') {
          setActiveId(null)
          setSnapshot(null)
        }
      } catch (err) {
        console.warn('[terminal] peek failed:', err)
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 900)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [loadSessions, topicId])

  // 输出 / 输入变化后贴底
  useEffect(() => {
    const el = surfaceRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [snapshot, buffer])

  // 面板打开或切换会话后把焦点放回终端（直接打字，没有输入框）
  useEffect(() => {
    if (activeId) surfaceRef.current?.focus()
  }, [activeId])

  const openSession = useCallback(async (): Promise<void> => {
    if (opening) return
    setOpening(true)
    setError(null)
    try {
      const result = await harnessApi.terminal.open({ topicId: topicId ?? 0 })
      if (!result.ok) {
        setError(t(errorKey(result.error)))
        return
      }
      setNotice(null)
      const list = await loadSessions()
      setActiveId(result.session.sessionId)
      if (list.length === 0) await loadSessions()
    } catch (err) {
      setError(String(err))
    } finally {
      setOpening(false)
    }
  }, [loadSessions, opening, t, topicId])

  const closeSession = useCallback(
    async (sessionId: string): Promise<void> => {
      try {
        await harnessApi.terminal.close(sessionId)
      } catch (err) {
        console.warn('[terminal] close failed:', err)
      }
      if (activeIdRef.current === sessionId) {
        setActiveId(null)
        setSnapshot(null)
      }
      await loadSessions()
    },
    [loadSessions]
  )

  const sendCommand = useCallback(async (): Promise<void> => {
    const id = activeIdRef.current
    const command = buffer.trim()
    if (!id || busy || !command) return
    setBusy(true)
    setError(null)
    setNotice(null)
    setBuffer('')
    try {
      const result = await harnessApi.terminal.send({
        topicId: topicId ?? 0,
        sessionId: id,
        command,
        // 命令可能长跑：先等一小段拿即时输出，其余交给 peek 轮询
        waitMs: 400
      })
      if (!result.ok) {
        setError(t(errorKey(result.error)))
        // 发送失败时把命令放回输入行，避免用户重打
        setBuffer(command)
      } else if (result.result.timedOut) {
        setNotice(t('harness.terminalPanel.stillRunning'))
      }
    } catch (err) {
      setError(String(err))
      setBuffer(command)
    } finally {
      setBusy(false)
    }
  }, [buffer, busy, t, topicId])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.metaKey || event.ctrlKey) return
      if (event.key === 'Enter') {
        event.preventDefault()
        void sendCommand()
        return
      }
      if (event.key === 'Backspace') {
        event.preventDefault()
        setBuffer((prev) => prev.slice(0, -1))
        return
      }
      if (event.key.length === 1) {
        event.preventDefault()
        setBuffer((prev) => (prev.length >= 2000 ? prev : prev + event.key))
        return
      }
      if (event.key === 'Escape') {
        event.currentTarget.blur()
      }
    },
    [sendCommand]
  )

  const onPaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>): void => {
    const text = event.clipboardData?.getData('text') ?? ''
    if (!text) return
    event.preventDefault()
    // 终端面板只接受单行命令：换行折叠成空格（多行脚本请用 && / ; 串联）
    setBuffer((prev) => (prev + text.replace(/\r?\n+/g, ' ')).slice(0, 2000))
  }, [])

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
            <span
              style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor' }}
            />
            {t('harness.terminalPanel.runningCount', { count: sessions.length })}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <Tooltip title={t('harness.terminalPanel.newSession')}>
          <Button
            type="text"
            size="small"
            data-terminal-action="new"
            aria-label={t('harness.terminalPanel.newSession')}
            disabled={opening}
            loading={opening}
            icon={<RiAddLine size={14} />}
            onClick={() => void openSession()}
          />
        </Tooltip>
        {activeId ? (
          <Tooltip title={t('harness.terminalPanel.closeSession')}>
            <Button
              type="text"
              size="small"
              data-terminal-action="close-session"
              aria-label={t('harness.terminalPanel.closeSession')}
              icon={<RiCloseLine size={14} />}
              onClick={() => activeId && void closeSession(activeId)}
            />
          </Tooltip>
        ) : null}
        {onClosePanel ? (
          <Tooltip title={t('harness.terminalPanel.hidePanel')}>
            <Button
              type="text"
              size="small"
              aria-label={t('harness.terminalPanel.hidePanel')}
              icon={<RiLayoutRightLine size={14} />}
              onClick={onClosePanel}
            />
          </Tooltip>
        ) : null}
      </div>

      {/* 会话页签：与编辑器页签同款（激活白底 + 顶部主色条） */}
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
        {sessions.length < 3 ? (
          <button
            type="button"
            title={t('harness.terminalPanel.newSession')}
            disabled={opening}
            onClick={() => void openSession()}
            style={{
              width: 33,
              height: 33,
              border: 'none',
              background: 'transparent',
              color: colorTextTertiary,
              cursor: 'pointer'
            }}
          >
            ＋
          </button>
        ) : null}
      </div>

      {/* 终端内容：点击就直接打字（没有输入框） */}
      <div
        ref={surfaceRef}
        tabIndex={0}
        data-terminal-surface="1"
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          margin: 10,
          borderRadius: 10,
          background: termBg,
          border: `1px solid ${focused ? token.colorPrimaryBorder : colorBorderSecondary}`,
          boxShadow: focused ? `0 0 0 2px ${token.colorPrimaryBg}` : undefined,
          padding: '12px 14px',
          fontFamily: '"Cascadia Mono", Consolas, "SFMono-Regular", monospace',
          fontSize: 11.8,
          lineHeight: 1.78,
          color: termText,
          outline: 'none',
          cursor: 'text'
        }}
      >
        {loading ? (
          <div style={{ color: colorTextTertiary }}>{t('harness.terminalPanel.loading')}</div>
        ) : error ? (
          <div style={{ color: token.colorError, whiteSpace: 'pre-wrap' }}>{error}</div>
        ) : sessions.length === 0 ? (
          <div style={{ color: isDarkMode ? '#8b949e' : '#8a8f99', fontSize: 12 }}>
            <div style={{ marginBottom: 6 }}>{t('harness.terminalPanel.empty')}</div>
            <div style={{ marginBottom: 10 }}>{t('harness.terminalPanel.emptyHint')}</div>
            <Button size="small" icon={<RiAddLine size={13} />} onClick={() => void openSession()}>
              {t('harness.terminalPanel.newSession')}
            </Button>
          </div>
        ) : snapshot ? (
          <>
            {snapshot.text ? (
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{snapshot.text}</div>
            ) : null}
            {snapshot.truncated ? (
              <div style={{ color: isDarkMode ? '#e3b341' : '#a86f0d', marginTop: 4 }}>
                {t('harness.terminalPanel.truncated')}
              </div>
            ) : null}
            {snapshot.binary ? (
              <div style={{ color: isDarkMode ? '#e3b341' : '#a86f0d', marginTop: 4 }}>
                {t('harness.terminalPanel.binary')}
              </div>
            ) : null}
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 2 }}>
              <span style={{ color: cwdColor }}>{snapshot.cwd || '~'}</span>{' '}
              <span style={{ color: promptColor }}>❯</span> {buffer}
              <span
                style={{
                  display: 'inline-block',
                  width: 7,
                  height: 13,
                  verticalAlign: '-2px',
                  background: cursorColor,
                  opacity: focused ? 0.85 : 0.35,
                  marginLeft: 1
                }}
              />
            </div>
            {!snapshot.alive ? (
              <div style={{ color: colorTextTertiary, marginTop: 4 }}>
                {t('harness.terminalPanel.exited')}
              </div>
            ) : null}
          </>
        ) : (
          <div style={{ color: colorTextTertiary }}>{t('harness.terminalPanel.loading')}</div>
        )}
        {notice ? (
          <div style={{ color: isDarkMode ? '#e3b341' : '#a86f0d', marginTop: 4 }}>{notice}</div>
        ) : null}
      </div>
    </div>
  )
}

export default TerminalPanel
