import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button, theme, Tooltip } from 'antd'
import {
  RiArrowLeftLine,
  RiArrowRightLine,
  RiCloseLine,
  RiExternalLinkLine,
  RiHome4Line,
  RiRefreshLine,
  RiSearchLine
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

/**
 * 应用内浏览器面板（右侧停靠，和终端/工作区同一列）。
 *
 * 用 Electron `<webview>` 承载真实网页（不是 iframe：不会被 X-Frame-Options 挡），
 * 主进程侧已开启 `webviewTag` 并在 `will-attach-webview` 里强制剥掉 preload、
 * 禁 Node 集成、开上下文隔离与沙箱。
 *
 * 当前版本：单标签页 + 地址栏 + 前进/后退/刷新/主页；新窗口请求在当前页打开。
 */

interface ElectronWebviewElement extends HTMLElement {
  goBack: () => void
  goForward: () => void
  reload: () => void
  stop: () => void
  canGoBack: () => boolean
  canGoForward: () => boolean
  getURL: () => string
  loadURL: (url: string) => Promise<void>
}

const WebviewTag = 'webview' as unknown as React.ElementType

interface BrowserPanelProps {
  isDarkMode: boolean
  colorBgContainer: string
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  colorBorderSecondary: string
  onClosePanel?: () => void
}

const HOME_URL = 'https://www.bing.com'

/** 输入归一：空 → 主页；像 URL → 补协议；否则当搜索词走 Bing */
function normalizeUrl(raw: string): string {
  const text = raw.trim()
  if (!text) return HOME_URL
  if (/^(https?|about|data|file|chrome):/i.test(text)) return text
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(text) || /^localhost(:\d+)?(\/.*)?$/.test(text)) {
    return `https://${text}`
  }
  return `${HOME_URL}/search?q=${encodeURIComponent(text)}`
}

const BrowserPanel: React.FC<BrowserPanelProps> = ({
  isDarkMode,
  colorBgContainer,
  colorText,
  colorTextSecondary,
  colorTextTertiary,
  colorBorderSecondary,
  onClosePanel
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const webviewRef = useRef<ElectronWebviewElement | null>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  /** 地址的最新值（ref 与 state 双写）：导航按钮在 React 状态尚未 flush 时也能拿到当前输入 */
  const addressValueRef = useRef(HOME_URL)
  const [address, setAddress] = useState(HOME_URL)
  const [currentUrl, setCurrentUrl] = useState(HOME_URL)
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)

  const syncNavState = useCallback((): void => {
    const view = webviewRef.current
    if (!view) return
    try {
      setCanBack(view.canGoBack())
      setCanForward(view.canGoForward())
      const url = view.getURL()
      if (url) {
        setCurrentUrl(url)
        setAddress(url)
        addressValueRef.current = url
      }
    } catch {
      // guest 尚未就绪
    }
  }, [])

  // webview 事件接线（元素本身在 DOM 里即可监听，比 dom-ready 更早）
  useEffect(() => {
    const view = webviewRef.current
    if (!view) return
    const onStart = (): void => {
      setLoading(true)
      setError(null)
    }
    const onStop = (): void => {
      setLoading(false)
      syncNavState()
    }
    const onNavigate = (event: Event): void => {
      const url = (event as Event & { url?: string }).url
      if (url) {
        setCurrentUrl(url)
        setAddress(url)
      }
      syncNavState()
    }
    const onTitle = (event: Event): void => {
      const nextTitle = (event as Event & { title?: string }).title
      if (nextTitle) setTitle(nextTitle)
    }
    const onFail = (event: Event): void => {
      const detail = event as Event & {
        errorCode?: number
        errorDescription?: string
        isMainFrame?: boolean
      }
      if (detail.isMainFrame === false) return
      if (detail.errorCode === -3) return // ERR_ABORTED：导航被新请求取代
      setLoading(false)
      setError(detail.errorDescription || `加载失败（${detail.errorCode ?? 'unknown'}）`)
    }
    const onNewWindow = (event: Event): void => {
      event.preventDefault()
      const url = (event as Event & { url?: string }).url
      if (url) void view.loadURL(normalizeUrl(url))
    }
    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    view.addEventListener('did-navigate', onNavigate)
    view.addEventListener('did-navigate-in-page', onNavigate)
    view.addEventListener('page-title-updated', onTitle)
    view.addEventListener('did-fail-load', onFail)
    view.addEventListener('new-window', onNewWindow)
    return () => {
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-navigate', onNavigate)
      view.removeEventListener('did-navigate-in-page', onNavigate)
      view.removeEventListener('page-title-updated', onTitle)
      view.removeEventListener('did-fail-load', onFail)
      view.removeEventListener('new-window', onNewWindow)
    }
  }, [syncNavState])

  const navigate = useCallback((raw: string): void => {
    const view = webviewRef.current
    if (!view) return
    const target = normalizeUrl(raw)
    setAddress(target)
    setError(null)
    void view.loadURL(target).catch((err: unknown) => setError(String(err)))
  }, [])

  const goHome = useCallback((): void => navigate(HOME_URL), [navigate])
  const goBack = useCallback((): void => {
    webviewRef.current?.goBack()
    window.setTimeout(syncNavState, 120)
  }, [syncNavState])
  const goForward = useCallback((): void => {
    webviewRef.current?.goForward()
    window.setTimeout(syncNavState, 120)
  }, [syncNavState])
  const reload = useCallback((): void => {
    if (loading) webviewRef.current?.stop()
    else webviewRef.current?.reload()
  }, [loading])

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
      style={{ background: colorBgContainer, borderRadius: token.borderRadiusLG }}
      data-browser-panel="1"
    >
      {/* 标题栏：与终端/工作区面板同款 */}
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
        <RiSearchLine size={14} style={{ color: colorTextSecondary }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: colorText }}>
          {t('harness.browserPanel.title')}
        </span>
        {loading ? (
          <span style={{ fontSize: 10, color: colorTextTertiary }}>
            {t('harness.browserPanel.loading')}
          </span>
        ) : null}
        <span className="truncate" style={{ flex: 1, fontSize: 10.5, color: colorTextTertiary }}>
          {title || currentUrl}
        </span>
        {onClosePanel ? (
          <Tooltip title={t('harness.browserPanel.hidePanel')}>
            <Button
              type="text"
              size="small"
              data-browser-close="1"
              aria-label={t('harness.browserPanel.hidePanel')}
              icon={<RiCloseLine size={14} />}
              onClick={onClosePanel}
            />
          </Tooltip>
        ) : null}
      </div>

      {/* 地址栏 */}
      <div
        className="flex items-center"
        style={{
          height: 36,
          flex: '0 0 36px',
          gap: 4,
          padding: '0 8px',
          borderBottom: `1px solid ${colorBorderSecondary}`
        }}
      >
        <Tooltip title={t('harness.browserPanel.back')}>
          <Button
            type="text"
            size="small"
            data-browser-back="1"
            disabled={!canBack}
            icon={<RiArrowLeftLine size={14} />}
            onClick={goBack}
          />
        </Tooltip>
        <Tooltip title={t('harness.browserPanel.forward')}>
          <Button
            type="text"
            size="small"
            data-browser-forward="1"
            disabled={!canForward}
            icon={<RiArrowRightLine size={14} />}
            onClick={goForward}
          />
        </Tooltip>
        <Tooltip title={t('harness.browserPanel.reload')}>
          <Button
            type="text"
            size="small"
            data-browser-reload="1"
            icon={<RiRefreshLine size={14} />}
            onClick={reload}
          />
        </Tooltip>
        <Tooltip title={t('harness.browserPanel.home')}>
          <Button
            type="text"
            size="small"
            data-browser-home="1"
            icon={<RiHome4Line size={14} />}
            onClick={goHome}
          />
        </Tooltip>
        <input
          ref={addressRef}
          data-browser-address="1"
          value={address}
          onChange={(event) => {
            setAddress(event.target.value)
            addressValueRef.current = event.target.value
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              navigate(address)
            }
          }}
          spellCheck={false}
          placeholder={t('harness.browserPanel.addressPlaceholder')}
          style={{
            flex: 1,
            minWidth: 0,
            height: 28,
            marginLeft: 4,
            padding: '0 10px',
            border: `1px solid ${colorBorderSecondary}`,
            borderRadius: 8,
            background: isDarkMode ? '#1f1f22' : '#fff',
            color: colorText,
            fontSize: 12,
            outline: 'none'
          }}
        />
        <Tooltip title={t('harness.browserPanel.open')}>
          <Button
            type="text"
            size="small"
            data-browser-go="1"
            icon={<RiExternalLinkLine size={14} />}
            onClick={() => navigate(addressValueRef.current)}
          />
        </Tooltip>
      </div>

      {error ? (
        <div style={{ padding: '8px 12px', fontSize: 11.5, color: token.colorError }}>
          {t('harness.browserPanel.loadFailed', { reason: error })}
        </div>
      ) : null}

      {/* 真实网页：Electron webview（主进程已收紧 guest 安全参数） */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <WebviewTag
          ref={webviewRef}
          src={HOME_URL}
          partition="persist:ryten-browser"
          allowpopups={false}
          data-browser-webview="1"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        />
      </div>
    </div>
  )
}

export default BrowserPanel
