import React, { useCallback, useEffect, useRef, useState } from 'react'
import { theme } from 'antd'
import { createPortal } from 'react-dom'
import { RiCheckLine, RiCloseLine, RiLoader4Line, RiRestartLine } from '@remixicon/react'
import logo from '@renderer/assets/logo.png'
import { useTranslation } from '@renderer/i18n'
import { useAppUpdate } from '@renderer/hooks/useAppUpdate'
import { useTheme } from '@renderer/hooks/useTheme'
import type { AppUpdateStage } from '@shared/update/types'

interface AppUpdateEntryProps {
  /** Version of the running app (from the main process), used in the restart prompt. */
  currentVersion?: string
}

const AppUpdateEntry: React.FC<AppUpdateEntryProps> = ({ currentVersion }) => {
  const { token } = theme.useToken()
  const { effectiveTheme } = useTheme()
  const { t } = useTranslation()
  const { state: updateState, download, restart } = useAppUpdate()
  const [modalOpen, setModalOpen] = useState(false)
  /** Shows the restart spinner immediately; the main process confirms with a `restarting` snapshot. */
  const [restartRequested, setRestartRequested] = useState(false)
  const previousStageRef = useRef<AppUpdateStage>('idle')
  const dialogRef = useRef<HTMLDivElement>(null)
  const restartingRef = useRef(false)

  const stage: AppUpdateStage = updateState?.stage ?? 'idle'
  const restarting = stage === 'restarting' || restartRequested
  const isDark = effectiveTheme === 'dark'

  useEffect(() => {
    restartingRef.current = restarting
  }, [restarting])

  /**
   * Open the restart prompt automatically only on the transition into `ready`. Dismissing it
   * must not make it pop back on later state pushes (e.g. a duplicate ready snapshot).
   */
  useEffect(() => {
    const previousStage = previousStageRef.current
    previousStageRef.current = stage
    if (stage === 'ready') {
      if (previousStage !== 'ready') setModalOpen(true)
      setRestartRequested(false)
    } else if (stage === 'restarting') {
      setRestartRequested(true)
    } else {
      setModalOpen(false)
      setRestartRequested(false)
    }
  }, [stage])

  /**
   * Custom dialog shell (no Modal component): body scroll lock, initial focus, Escape and a
   * simple Tab loop, plus focus restoration to the entry that opened it.
   */
  useEffect(() => {
    if (!modalOpen) return
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusTimer = window.setTimeout(() => dialogRef.current?.focus(), 50)

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (restartingRef.current) return
        event.preventDefault()
        setModalOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const buttons = Array.from(
        dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []
      )
      if (buttons.length === 0) {
        event.preventDefault()
        dialogRef.current?.focus()
        return
      }
      const first = buttons[0]
      const last = buttons[buttons.length - 1]
      if (document.activeElement === dialogRef.current) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
        return
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
    }
  }, [modalOpen])

  const dismissModal = useCallback((): void => {
    if (restarting) return
    setModalOpen(false)
  }, [restarting])

  const handleDownload = useCallback((): void => {
    download()
  }, [download])

  const handleRestart = useCallback((): void => {
    if (restarting) return
    setRestartRequested(true)
    void restart().then((accepted) => {
      // The app normally quits right after this; if the request was rejected, let the user try
      // again instead of leaving the dialog stuck on the spinner.
      if (!accepted) setRestartRequested(false)
    })
  }, [restarting, restart])

  if (stage === 'idle') return null

  const progress = updateState?.progress ?? 0
  const newVersion = updateState?.version
  const contentUpdate = Boolean(updateState?.contentUpdate)
  const versionLabel = newVersion ? `v${newVersion}` : t('shell.update.newVersionFallback')
  const accent =
    stage === 'ready' || stage === 'restarting' ? token.colorSuccess : token.colorPrimary

  const entryVars = {
    '--app-update-accent': accent,
    '--app-update-bg':
      stage === 'ready' || stage === 'restarting' ? token.colorSuccessBg : token.colorPrimaryBg,
    '--app-update-border':
      stage === 'ready' || stage === 'restarting'
        ? token.colorSuccessBorder
        : token.colorPrimaryBorder,
    '--app-update-hover-bg':
      stage === 'ready' || stage === 'restarting'
        ? token.colorSuccessBgHover
        : token.colorPrimaryBgHover,
    '--app-update-hover-border':
      stage === 'ready' || stage === 'restarting'
        ? token.colorSuccessBorderHover
        : token.colorPrimaryBorderHover,
    '--app-update-fg': accent
  } as React.CSSProperties

  const restartingLabel = t('shell.update.restartingAction')
  const dialogOpen = modalOpen && (stage === 'ready' || stage === 'restarting')
  const runningVersion = currentVersion || updateState?.currentVersion
  const fromVersion = runningVersion ? `v${runningVersion.replace(/^v/i, '')}` : null
  const updateError = updateState?.error
  const availableTitle = updateError
    ? t('shell.update.retryTitle', { error: updateError })
    : contentUpdate
      ? t('shell.update.contentAvailableTitle', { version: versionLabel })
      : newVersion
        ? t('shell.update.availableTitle', { version: versionLabel })
        : t('shell.update.availableTitleNoVersion')
  const readyTitle = contentUpdate
    ? t('shell.update.contentReadyTitle', { version: versionLabel })
    : t('shell.update.readyTitle', { version: versionLabel })

  /* Custom dialog palette: a quiet frosted card in the app's own language, not an antd Modal.
     The primary action is the inverse of the surface (light on dark / dark on light), matching the
     shell's white mode thumb instead of introducing a generic blue CTA. */
  const surface = isDark ? 'rgba(24, 25, 29, 0.97)' : 'rgba(255, 255, 255, 0.97)'
  const dialogVars = {
    '--app-update-panel': surface,
    '--app-update-dialog-border': isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(15, 23, 42, 0.08)',
    '--app-update-dialog-shadow': isDark
      ? '0 34px 100px rgba(0, 0, 0, 0.68), 0 4px 16px rgba(0, 0, 0, 0.4)'
      : '0 34px 100px rgba(15, 23, 42, 0.22), 0 4px 16px rgba(15, 23, 42, 0.08)',
    '--app-update-dialog-text': token.colorText,
    '--app-update-dialog-muted': token.colorTextSecondary,
    '--app-update-dialog-faint': token.colorTextTertiary,
    '--app-update-dialog-chip': isDark ? 'rgba(255, 255, 255, 0.045)' : 'rgba(15, 23, 42, 0.035)',
    '--app-update-dialog-primary': isDark ? '#f0f0f2' : '#1f1f23',
    '--app-update-dialog-primary-fg': isDark ? '#18181b' : '#ffffff',
    '--app-update-dialog-highlight': isDark
      ? 'rgba(255, 255, 255, 0.18)'
      : 'rgba(255, 255, 255, 0.9)',
    '--app-update-dialog-focus': token.colorPrimary,
    '--app-update-accent': token.colorSuccess
  } as React.CSSProperties

  return (
    <>
      {stage === 'available' && (
        <button
          type="button"
          data-app-update="available"
          className="app-update"
          style={entryVars}
          title={availableTitle}
          aria-label={availableTitle}
          onClick={handleDownload}
        >
          <span className="app-update-dot" aria-hidden />
          <span>{updateError ? t('shell.update.retry') : t('shell.update.action')}</span>
        </button>
      )}

      {stage === 'downloading' && (
        <div
          data-app-update="downloading"
          className="app-update app-update--progress"
          style={entryVars}
          role="status"
          aria-live="polite"
          aria-label={t('shell.update.downloadingTitle', {
            percent: progress,
            version: versionLabel
          })}
          title={t('shell.update.downloadingTitle', {
            percent: progress,
            version: versionLabel
          })}
        >
          <svg
            className="app-update-ring"
            width={15}
            height={15}
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <circle
              cx="8"
              cy="8"
              r="6.1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              opacity="0.18"
            />
            <circle
              cx="8"
              cy="8"
              r="6.1"
              fill="none"
              stroke={accent}
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 6.1}
              strokeDashoffset={2 * Math.PI * 6.1 * (1 - progress / 100)}
              transform="rotate(-90 8 8)"
              style={{ transition: 'stroke-dashoffset 160ms linear' }}
            />
          </svg>
          <span className="app-update-percent">{progress}%</span>
        </div>
      )}

      {(stage === 'ready' || stage === 'restarting') && (
        <button
          type="button"
          data-app-update={stage}
          className="app-update app-update--ready"
          style={entryVars}
          title={stage === 'restarting' ? t('shell.update.restartingTitle') : readyTitle}
          aria-label={stage === 'restarting' ? t('shell.update.restartingTitle') : readyTitle}
          disabled={stage === 'restarting'}
          onClick={() => setModalOpen(true)}
        >
          {stage === 'restarting' ? (
            <RiLoader4Line size={13} className="app-update-spin" aria-hidden />
          ) : (
            <RiRestartLine size={13} aria-hidden />
          )}
          <span>{stage === 'restarting' ? restartingLabel : t('shell.update.readyAction')}</span>
        </button>
      )}

      {dialogOpen &&
        createPortal(
          <div
            className={`app-update-overlay app-update-overlay--${isDark ? 'dark' : 'light'}`}
            style={dialogVars}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !restarting) setModalOpen(false)
            }}
          >
            <div
              ref={dialogRef}
              className="app-update-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="app-update-dialog-title"
              aria-describedby="app-update-dialog-copy"
              aria-busy={restarting}
              tabIndex={-1}
            >
              <span className="app-update-dialog-aura" aria-hidden="true" />
              <button
                type="button"
                className="app-update-dialog-close"
                aria-label={t('common.action.close')}
                title={t('common.action.close')}
                disabled={restarting}
                onClick={dismissModal}
              >
                <RiCloseLine size={16} />
              </button>

              <div className="app-update-dialog-head">
                <div className="app-update-dialog-emblem">
                  <img src={logo} alt="" draggable={false} />
                  <span
                    className="app-update-dialog-badge"
                    style={{
                      background: restarting ? token.colorPrimary : token.colorSuccess,
                      boxShadow: `0 0 0 3px ${surface}`
                    }}
                  >
                    {restarting ? (
                      <span className="app-update-dialog-mini-spinner" aria-hidden="true" />
                    ) : (
                      <RiCheckLine size={11} color="#fff" aria-hidden="true" />
                    )}
                  </span>
                </div>

                <div className="app-update-dialog-heading">
                  <h2 id="app-update-dialog-title">
                    {restarting
                      ? t('shell.update.restartingModalTitle')
                      : t('shell.update.modalTitle')}
                  </h2>
                  <div className="app-update-dialog-version">
                    {contentUpdate ? (
                      <>
                        <strong>{versionLabel}</strong>
                        <span className="app-update-dialog-content-tag">
                          {t('shell.update.contentUpdate')}
                        </span>
                      </>
                    ) : (
                      <>
                        {fromVersion && (
                          <>
                            <span>{fromVersion}</span>
                            <span className="app-update-dialog-arrow" aria-hidden="true">
                              →
                            </span>
                          </>
                        )}
                        <strong>{versionLabel}</strong>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <p id="app-update-dialog-copy" className="app-update-dialog-copy">
                {restarting ? t('shell.update.restartingBody') : t('shell.update.modalBody')}
              </p>

              <div
                className={`app-update-dialog-status${restarting ? ' app-update-dialog-status--busy' : ''}`}
              >
                <span className="app-update-dialog-status-dot" aria-hidden="true" />
                <span>
                  {restarting ? t('shell.update.statusInstalling') : t('shell.update.statusReady')}
                </span>
                {!restarting && <span className="app-update-dialog-status-percent">100%</span>}
              </div>

              <div className="app-update-dialog-actions">
                <button
                  type="button"
                  className="app-update-dialog-later"
                  disabled={restarting}
                  onClick={dismissModal}
                >
                  {t('shell.update.later')}
                </button>
                <button
                  type="button"
                  className="app-update-dialog-confirm"
                  disabled={restarting}
                  onClick={handleRestart}
                >
                  {restarting ? (
                    <span className="app-update-dialog-spinner" aria-hidden="true" />
                  ) : (
                    <RiRestartLine size={14} aria-hidden="true" />
                  )}
                  {restarting ? t('shell.update.restartingAction') : t('shell.update.restart')}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}

export default AppUpdateEntry
