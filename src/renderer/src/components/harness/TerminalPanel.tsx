import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button, theme, Tooltip } from 'antd'
import {
  RiAddLine,
  RiCloseLine,
  RiLayoutRightLine,
  RiTerminalBoxLine
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { harnessApi, type TerminalSessionView } from '../../api/harness'
import TerminalEmulator, {
  type TerminalEmulatorHandle
} from './TerminalEmulator'

/**
 * 右侧「终端」面板（持久终端会话的用户侧入口）。
 *
 * 渲染/输入交给开源组件 **xterm.js**（TerminalEmulator），满足「不自己造轮子」；
 * 本组件只保留面板壳（标题栏 / 会话页签 / 空态 / 会话生命周期）。
 *
 * 口径（2026-11-27 用户确认后持续迭代）：
 * - 打开面板且没有会话时**默认自动新建一个终端**（不再要求先点「新建」）；
 * - 与模型侧 `terminal_*` 工具共用会话管理器；peek 走非消费快照，不抢模型的未读输出；
 * - 用户侧终端不受会话权限档限制（模型侧工具仍限完全权限档）。
 */

interface TerminalPanelProps {
  /** 当前话题；null = 没有选中会话，也允许用（会话归属 0，cwd 落到用户主目录） */
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

  const [sessions, setSessions] = useState<TerminalSessionView[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [snapshot, setSnapshot] = useState<{
    text: string
    cwd: string
    shell: string
    alive: boolean
    truncated: boolean
    binary: boolean
  } | null>(null)

  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId
  const emulatorRef = useRef<TerminalEmulatorHandle>(null)
  /** 自动新建只尝试一次（失败或用户手动关闭后不反复重建；重开面板时组件重挂载会复位） */
  const autoOpenedRef = useRef(false)

  const loadSessions = useCallback(async (): Promise<TerminalSessionView[]> => {
    try {
      const result = await harnessApi.terminal.list(topicId ?? 0)
      const list = result.ok ? result.sessions : []
      setSessions(list)
      setActiveId((prev) =>
        prev && list.some((session) => session.sessionId === prev)
          ? prev
          : (list[0]?.sessionId ?? null)
      )
      onRunningCountChange?.(list.length)
      return list
    } catch (err) {
      console.warn('[terminal] Failed to list sessions:', err)
      return []
    }
  }, [onRunningCountChange, topicId])

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
      await loadSessions()
      setActiveId(result.session.sessionId)
    } catch (err) {
      setError(String(err))
    } finally {
      setOpening(false)
    }
  }, [loadSessions, opening, t, topicId])

  // 话题切换 / 首次挂载：清空列表与快照（自动新建标记复位）
  useEffect(() => {
    setSessions([])
    setActiveId(null)
    setSnapshot(null)
    setError(null)
    autoOpenedRef.current = false
    setLoading(true)
    void loadSessions().finally(() => setLoading(false))
  }, [loadSessions])

  // 打开面板且没有会话 → 默认自动新建一个终端（用户 2026-11-27 口径）
  useEffect(() => {
    if (loading || opening || error) return
    if (sessions.length > 0 || autoOpenedRef.current) return
    autoOpenedRef.current = true
    void openSession()
  }, [error, loading, openSession, opening, sessions.length])

  // 轮询：会话列表（存活状态）+ 当前会话**原始**输出快照（保留 ANSI 给 xterm）
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
        const peek = await harnessApi.terminal.peek({
          sessionId: id,
          maxChars: 30_000,
          raw: true
        })
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

  /** 命令发送：走已有会话通道；错误/超时以终端内一行提示呈现（不再是底部说明条） */
  const handleSendCommand = useCallback(
    async (command: string): Promise<void> => {
      const id = activeIdRef.current
      if (!id || busy) return
      setBusy(true)
      try {
        const result = await harnessApi.terminal.send({
          topicId: topicId ?? 0,
          sessionId: id,
          command,
          waitMs: 400
        })
        if (!result.ok) {
          emulatorRef.current?.writeLine(`\x1b[31m${t(errorKey(result.error))}\x1b[0m`)
        } else if (result.result.timedOut) {
          emulatorRef.current?.writeLine(`\x1b[33m${t('harness.terminalPanel.stillRunning')}\x1b[0m`)
        }
        emulatorRef.current?.focus()
      } catch (err) {
        emulatorRef.current?.writeLine(`\x1b[31m${String(err)}\x1b[0m`)
      } finally {
        setBusy(false)
      }
    },
    [busy, t, topicId]
  )

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
            disabled={opening || sessions.length >= 3}
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

      {/* 终端主体：xterm.js */}
      {loading ? (
        <div style={{ padding: 14, fontSize: 12, color: colorTextTertiary }}>
          {t('harness.terminalPanel.loading')}
        </div>
      ) : error ? (
        <div style={{ padding: 14, fontSize: 12, color: token.colorError }}>
          {error}
          <div style={{ marginTop: 10 }}>
            <Button size="small" icon={<RiAddLine size={13} />} onClick={() => void openSession()}>
              {t('harness.terminalPanel.newSession')}
            </Button>
          </div>
        </div>
      ) : sessions.length === 0 ? (
        <div style={{ padding: 14, fontSize: 12, color: colorTextTertiary }}>
          <div style={{ marginBottom: 6 }}>{t('harness.terminalPanel.empty')}</div>
          <div style={{ marginBottom: 10 }}>{t('harness.terminalPanel.emptyHint')}</div>
          <Button size="small" icon={<RiAddLine size={13} />} onClick={() => void openSession()}>
            {t('harness.terminalPanel.newSession')}
          </Button>
        </div>
      ) : (
        <TerminalEmulator
          key={activeId ?? 'none'}
          ref={emulatorRef}
          output={snapshot?.text ?? ''}
          isDarkMode={isDarkMode}
          busy={busy}
          onSend={(command) => void handleSendCommand(command)}
        />
      )}
    </div>
  )
}

export default TerminalPanel
