import React from 'react'
import { Button, theme } from 'antd'
import { RiErrorWarningLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { usePlugins } from './PluginHostContext'

/** 出错的是插件占的哪一块界面（日志与卡片上都用它定位） */
export type PluginSurface = 'route' | 'settings' | 'provider' | 'bottomBar' | 'global'

export interface PluginCrashCardProps {
  pluginId: string
  surface: PluginSurface
  error: Error
  onRetry: () => void
}

/**
 * **插件崩溃卡片**：只写「哪个插件、什么错、能做什么」，不做装饰。
 *
 * 为什么单独一个文件、而不是留在 PluginBoundary.tsx 里做局部组件：那个文件导出的是边界本身，
 * 再放一个局部组件会让它的 fast refresh 退化成整文件重载
 * （`react-refresh/only-export-components`）。卡片只服务这个边界，没有第二个使用方。
 */
const PluginCrashCard: React.FC<PluginCrashCardProps> = ({ pluginId, surface, error, onRetry }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const plugins = usePlugins()
  const name = plugins.find((p) => p.manifest.id === pluginId)?.manifest.name ?? pluginId
  const [disabling, setDisabling] = React.useState(false)
  const [failure, setFailure] = React.useState<string | null>(null)

  const disable = async (): Promise<void> => {
    setDisabling(true)
    setFailure(null)
    try {
      await window.api.plugin.setEnabled(pluginId, false)
    } catch (err) {
      setFailure(
        t('shell.pluginBoundary.disableFailed', {
          error: err instanceof Error ? err.message : String(err)
        })
      )
    } finally {
      setDisabling(false)
    }
  }

  return (
    <div
      data-plugin-boundary={pluginId}
      data-plugin-surface={surface}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        maxWidth: 560,
        margin: '16px auto',
        padding: '14px 16px',
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <RiErrorWarningLine size={16} style={{ color: token.colorWarning }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: token.colorText }}>
          {t('shell.pluginBoundary.title', { name })}
        </span>
      </div>
      <div
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
          fontSize: 11.5,
          lineHeight: 1.6,
          color: token.colorTextSecondary,
          wordBreak: 'break-word',
          maxHeight: 76,
          overflow: 'hidden'
        }}
      >
        {error.message || String(error)}
      </div>
      <div style={{ fontSize: 11.5, lineHeight: 1.6, color: token.colorTextTertiary }}>
        {t('shell.pluginBoundary.detail')}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="small" onClick={onRetry}>
          {t('shell.pluginBoundary.retry')}
        </Button>
        <Button size="small" danger loading={disabling} onClick={() => void disable()}>
          {t('shell.pluginBoundary.disable')}
        </Button>
      </div>
      {failure ? (
        <div style={{ fontSize: 11.5, color: token.colorError }}>{failure}</div>
      ) : null}
    </div>
  )
}

export default PluginCrashCard
