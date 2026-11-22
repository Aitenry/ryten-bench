import React from 'react'
import { theme } from 'antd'
import { useTranslation } from '@renderer/i18n'

/**
 * 全局错误边界：渲染进程任意未捕获的 React 渲染错误都会让 React 19 卸载整棵组件树，
 * 表现是程序「白屏崩溃」。此处兜底为一张可恢复的提示卡（重新加载即回到笔记页），
 * 避免整个应用无提示地死掉。样式沿用编辑部语言：等宽标签 + 单一强调色，无花哨元素。
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
