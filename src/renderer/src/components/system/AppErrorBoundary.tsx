import React from 'react'
import { theme } from 'antd'
import { useTranslation } from '@renderer/i18n'

/**
 * Global error boundary: any uncaught React render error in the renderer makes React 19 unmount
 * the whole component tree, which shows up as a white-screen crash. This boundary falls back to
 * a recoverable notice card (reloading returns to the notes page) so the app never dies silently.
 * Styling follows an editorial look: monospace labels plus a single accent color, nothing fancy.
 */
export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[AppErrorBoundary] Caught unhandled render error:', error, info.componentStack)
  }

  private handleReload = (): void => {
    window.location.hash = '#/notes'
    window.location.reload()
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return <BoundaryCard error={this.state.error} onReload={this.handleReload} />
    }
    return this.props.children
  }
}

const BoundaryCard: React.FC<{ error: Error; onReload: () => void }> = ({ error, onReload }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: token.colorBgLayout,
        padding: 24
      }}
    >
      <div
        style={{
          maxWidth: 460,
          width: '100%',
          background: token.colorBgContainer,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: 12,
          padding: '28px 28px 24px'
        }}
      >
        <div
          style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
            fontSize: 11,
            letterSpacing: '0.14em',
            color: token.colorError,
            marginBottom: 10
          }}
        >
          {t('shell.errorBoundary.eyebrow')}
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, color: token.colorText, marginBottom: 10 }}>
          {t('shell.errorBoundary.title')}
        </div>
        <div
          style={{
            fontSize: 12.5,
            lineHeight: 1.7,
            color: token.colorTextSecondary,
            marginBottom: 20,
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
            wordBreak: 'break-all',
            maxHeight: 120,
            overflowY: 'auto'
          }}
        >
          {error.message || String(error)}
        </div>
        <button
          onClick={onReload}
          style={{
            height: 34,
            padding: '0 18px',
            border: 'none',
            borderRadius: 8,
            background: token.colorPrimary,
            color: token.colorBgContainer,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          {t('shell.errorBoundary.reload')}
        </button>
      </div>
    </div>
  )
}

export default AppErrorBoundary
