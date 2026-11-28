import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, theme, Tooltip } from 'antd'
import {
  RiArrowLeftLine,
  RiArrowRightLine,
  RiArrowDownSLine,
  RiAddLine,
  RiSearchLine,
  RiGlobalLine,
  RiRefreshLine,
  RiArrowUpSLine
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

/**
 * In-app browser panel (docked on the right, Chrome-style tabs + tab search).
 *
 * Spec as of 2026-11-27:
 * - Top tab bar: the left arrow opens the **tab search panel** (search / open tabs / recently
 *   closed), then the tabs (title + ✕), and a "+" button on the right to create a tab;
 * - Second-row toolbar: back / forward / reload + site icon + address input (**no "Open" button**,
 *   Enter submits);
 * - Opening the browser shows a blank page: no preset URL and no blank-page explanatory text;
 * - No scrollbars inside the panel (the tab strip, address bar and page container do not scroll;
 *   the dropdown list scrolls on its own but hides its scrollbar).
 *
 * Each tab has its own webview; blank tabs mount no webview and only load once the user enters a URL.
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

const RECENT_CLOSED_KEY = 'rytenbench:browser-recently-closed'
const MAX_RECENT_CLOSED = 20

interface BrowserPanelProps {
  isDarkMode: boolean
  colorBgContainer: string
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  colorBorderSecondary: string
}

interface BrowserTab {
  id: string
  /** Target URL the user entered / the tab loads (empty string = blank start page); only changed by the address bar or tab restore */
  url: string
  /** URL the page is actually on (synced after webview navigation, shown in the address bar and lists; does not drive src, to avoid a second load) */
  displayUrl: string
  title: string
  loading: boolean
  error: string | null
  canBack: boolean
  canForward: boolean
}

interface RecentlyClosedTab {
  url: string
  title: string
  closedAt: number
}

function newTab(): BrowserTab {
  return {
    id: `browser-tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    url: '',
    displayUrl: '',
    title: '',
    loading: false,
    error: null,
    canBack: false,
    canForward: false
  }
}

/** Input normalization: empty → null (keep the blank page); looks like a URL → add a protocol; otherwise treat as a search term */
function normalizeUrl(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  if (/^(https?|about|data|file|chrome):/i.test(text)) return text
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(text) || /^localhost(:\d+)?(\/.*)?$/.test(text)) {
    return `https://${text}`
  }
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`
}

function loadRecentlyClosed(): RecentlyClosedTab[] {
  try {
    const raw = window.localStorage.getItem(RECENT_CLOSED_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as unknown
    if (!Array.isArray(list)) return []
    return list
      .filter(
        (item): item is RecentlyClosedTab =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as RecentlyClosedTab).url === 'string' &&
          typeof (item as RecentlyClosedTab).closedAt === 'number'
      )
      .slice(0, MAX_RECENT_CLOSED)
  } catch {
    return []
  }
}

function saveRecentlyClosed(list: RecentlyClosedTab[]): void {
  try {
    window.localStorage.setItem(RECENT_CLOSED_KEY, JSON.stringify(list.slice(0, MAX_RECENT_CLOSED)))
  } catch {
    // localStorage unavailable: keep the records in memory only
  }
}

/** Real page container for a single tab: owns only the webview lifecycle + reports state to the parent */
const BrowserTabView: React.FC<{
  tab: BrowserTab
  active: boolean
  onWebviewReady: (tabId: string, element: ElectronWebviewElement | null) => void
  onUpdate: (tabId: string, patch: Partial<BrowserTab>) => void
}> = ({ tab, active, onWebviewReady, onUpdate }) => {
  const webviewRef = useRef<ElectronWebviewElement | null>(null)

  useEffect(() => {
    if (tab.url) return
    onWebviewReady(tab.id, null)
  }, [onWebviewReady, tab.id, tab.url])

  useEffect(() => {
    const view = webviewRef.current
    if (!view || !tab.url) return
    onWebviewReady(tab.id, view)
    const onStart = (): void => onUpdate(tab.id, { loading: true, error: null })
    const onStop = (): void => {
      try {
        onUpdate(tab.id, {
          loading: false,
          canBack: view.canGoBack(),
          canForward: view.canGoForward(),
          displayUrl: view.getURL() || tab.url
        })
      } catch {
        onUpdate(tab.id, { loading: false })
      }
    }
    const onNavigate = (event: Event): void => {
      const url = (event as Event & { url?: string }).url
      onUpdate(tab.id, {
        displayUrl: url || tab.url,
        canBack: view.canGoBack(),
        canForward: view.canGoForward()
      })
    }
    const onTitle = (event: Event): void => {
      const title = (event as Event & { title?: string }).title
      onUpdate(tab.id, { title: title || '' })
    }
    const onFail = (event: Event): void => {
      const detail = event as Event & {
        errorCode?: number
        errorDescription?: string
        isMainFrame?: boolean
      }
      if (detail.isMainFrame === false || detail.errorCode === -3) return
      onUpdate(tab.id, {
        loading: false,
        error: detail.errorDescription || `加载失败（${detail.errorCode ?? 'unknown'}）`
      })
    }
    const onNewWindow = (event: Event): void => {
      event.preventDefault()
      const url = (event as Event & { url?: string }).url
      const target = url ? normalizeUrl(url) : null
      if (target) void view.loadURL(target)
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
      onWebviewReady(tab.id, null)
    }
  }, [onUpdate, onWebviewReady, tab.id, tab.url])

  if (!tab.url) return null
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: active ? 'block' : 'none',
        background: '#fff'
      }}
    >
      <WebviewTag
        ref={webviewRef}
        src={tab.url}
        partition="persist:ryten-browser"
        allowpopups={false}
        data-browser-webview={tab.id}
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  )
}

const BrowserPanel: React.FC<BrowserPanelProps> = ({
  isDarkMode,
  colorBgContainer,
  colorText,
  colorTextSecondary,
  colorTextTertiary,
  colorBorderSecondary
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [newTab()])
  const [activeId, setActiveId] = useState<string>(() => '')
  const [address, setAddress] = useState('')
  const [tabSearchOpen, setTabSearchOpen] = useState(false)
  const [tabSearchQuery, setTabSearchQuery] = useState('')
  const [recentOpen, setRecentOpen] = useState(true)
  const [recentlyClosed, setRecentlyClosed] = useState<RecentlyClosedTab[]>(() => loadRecentlyClosed())
  const webviewsRef = useRef(new Map<string, ElectronWebviewElement>())
  const addressRef = useRef<HTMLInputElement>(null)
  const tabSearchInputRef = useRef<HTMLInputElement>(null)
  const tabSearchRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setActiveId((prev) => prev || tabs[0]?.id || '')
  }, [tabs])

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0]

  useEffect(() => {
    setAddress(activeTab?.displayUrl || activeTab?.url || '')
  }, [activeId, activeTab?.displayUrl, activeTab?.url])

  // Ctrl+Shift+A opens tab search (matching the hint in the UI); Ctrl+T creates a new tab
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey
      if (!mod) return
      if (event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setTabSearchOpen(true)
      } else if (!event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        openNewTab()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Focus the input once tab search opens; close on outside click / Esc
  useEffect(() => {
    if (!tabSearchOpen) return
    window.setTimeout(() => tabSearchInputRef.current?.focus(), 30)
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Element | null
      if (tabSearchRef.current?.contains(target as Node)) return
      // The tab search button itself opens/closes via its own onClick, avoiding close-then-open
      if (target?.closest('[data-browser-tab-search]')) return
      setTabSearchOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setTabSearchOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [tabSearchOpen])

  const updateTab = useCallback((tabId: string, patch: Partial<BrowserTab>): void => {
    setTabs((prev) => prev.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)))
  }, [])

  const onWebviewReady = useCallback(
    (tabId: string, element: ElectronWebviewElement | null): void => {
      if (element) webviewsRef.current.set(tabId, element)
      else webviewsRef.current.delete(tabId)
    },
    []
  )

  const openNewTab = useCallback((): void => {
    const tab = newTab()
    setTabs((prev) => [...prev, tab])
    setActiveId(tab.id)
    setAddress('')
    setTabSearchOpen(false)
    window.setTimeout(() => addressRef.current?.focus(), 40)
  }, [])

  const closeTab = useCallback(
    (tabId: string): void => {
      const closing = tabs.find((tab) => tab.id === tabId)
      if (closing?.url) {
        const nextRecent = [
          { url: closing.displayUrl || closing.url, title: closing.title, closedAt: Date.now() },
          ...recentlyClosed
        ].slice(0, MAX_RECENT_CLOSED)
        setRecentlyClosed(nextRecent)
        saveRecentlyClosed(nextRecent)
      }
      const remaining = tabs.filter((tab) => tab.id !== tabId)
      const nextTabs = remaining.length > 0 ? remaining : [newTab()]
      if (activeId === tabId) {
        const closingIndex = tabs.findIndex((tab) => tab.id === tabId)
        setActiveId(nextTabs[Math.min(closingIndex, nextTabs.length - 1)]?.id ?? nextTabs[0].id)
      }
      setTabs(nextTabs)
      webviewsRef.current.delete(tabId)
    },
    [activeId, recentlyClosed, tabs]
  )

  const reopenRecentlyClosed = useCallback(
    (entry: RecentlyClosedTab): void => {
      const tab = newTab()
      tab.url = entry.url
      tab.displayUrl = entry.url
      tab.title = entry.title
      setTabs((prev) => [...prev, tab])
      setActiveId(tab.id)
      setTabSearchOpen(false)
      const nextRecent = recentlyClosed.filter((item) => item !== entry)
      setRecentlyClosed(nextRecent)
      saveRecentlyClosed(nextRecent)
    },
    [recentlyClosed]
  )

  const navigate = useCallback((): void => {
    const target = normalizeUrl(address)
    if (!target || !activeTab) {
      if (address.trim()) addressRef.current?.focus()
      return
    }
    updateTab(activeTab.id, {
      url: target,
      displayUrl: target,
      title: '',
      error: null,
      loading: true,
      canBack: false,
      canForward: false
    })
    setAddress(target)
  }, [activeTab, address, updateTab])

  const activeWebview = activeTab ? webviewsRef.current.get(activeTab.id) : undefined
  const goBack = useCallback((): void => {
    activeWebview?.goBack()
  }, [activeWebview])
  const goForward = useCallback((): void => {
    activeWebview?.goForward()
  }, [activeWebview])
  const reload = useCallback((): void => {
    if (!activeTab?.url) return
    if (activeTab.loading) activeWebview?.stop()
    else activeWebview?.reload()
  }, [activeTab?.loading, activeTab?.url, activeWebview])

  const query = tabSearchQuery.trim().toLowerCase()
  const filterByQuery = useCallback(
    (title: string, url: string): boolean =>
      !query || title.toLowerCase().includes(query) || url.toLowerCase().includes(query),
    [query]
  )
  const openTabsFiltered = useMemo(
    () => tabs.filter((tab) => filterByQuery(tab.title, tab.url)),
    [filterByQuery, tabs]
  )
  const recentlyClosedFiltered = useMemo(
    () => recentlyClosed.filter((item) => filterByQuery(item.title, item.url)),
    [filterByQuery, recentlyClosed]
  )

  const relativeTime = useCallback(
    (at: number): string => {
      const diff = Math.max(0, Date.now() - at)
      if (diff < 60_000) return t('harness.browserPanel.timeJustNow')
      if (diff < 3_600_000) {
        return t('harness.browserPanel.timeMinutesAgo', { count: Math.floor(diff / 60_000) })
      }
      if (diff < 86_400_000) {
        return t('harness.browserPanel.timeHoursAgo', { count: Math.floor(diff / 3_600_000) })
      }
      return t('harness.browserPanel.timeDaysAgo', { count: Math.floor(diff / 86_400_000) })
    },
    [t]
  )

  const titleOf = (tab: BrowserTab): string =>
    tab.title || tab.url || t('harness.browserPanel.blankTab')
  const urlOf = (tab: BrowserTab): string => tab.displayUrl || tab.url || 'chrome://newtab'

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
      style={{ background: colorBgContainer, borderRadius: token.borderRadiusLG, position: 'relative' }}
      data-browser-panel="1"
    >
      {/* Tab bar: tab search + tabs + new tab + collapse panel */}
      <div
        className="flex items-center overflow-hidden"
        style={{
          height: 40,
          flex: '0 0 40px',
          gap: 4,
          padding: '0 6px',
          background: isDarkMode ? '#252526' : '#f0f0f2',
          borderBottom: `1px solid ${isDarkMode ? '#1e1e1e' : '#e2e2e5'}`
        }}
      >
        <Tooltip title={t('harness.browserPanel.tabSearch')}>
          <button
            type="button"
            data-browser-tab-search="1"
            className="browser-icon-btn"
            onClick={() => setTabSearchOpen((prev) => !prev)}
            style={{
              width: 26,
              height: 26,
              flex: '0 0 auto',
              border: 'none',
              borderRadius: 7,
              background: tabSearchOpen ? (isDarkMode ? '#3a3a3f' : '#e3e3e6') : 'transparent',
              color: tabSearchOpen ? colorText : colorTextSecondary,
              cursor: 'pointer',
              display: 'grid',
              placeItems: 'center'
            }}
          >
            <RiArrowDownSLine
              size={16}
              style={{
                transform: tabSearchOpen ? 'rotate(180deg)' : 'none',
                transition: 'transform .15s ease'
              }}
            />
          </button>
        </Tooltip>
        <div
          className="browser-tabstrip flex items-center"
          style={{ flex: 1, minWidth: 0, height: '100%', gap: 2, overflowX: 'auto', overflowY: 'hidden' }}
        >
          {tabs.map((tab) => {
            const active = tab.id === activeTab?.id
            return (
              <button
                key={tab.id}
                type="button"
                data-browser-tab-id={tab.id}
                onClick={() => setActiveId(tab.id)}
                className="browser-tab-btn flex items-center"
                style={{
                  gap: 5,
                  flex: '0 1 auto',
                  minWidth: 64,
                  maxWidth: 140,
                  height: 30,
                  margin: 0,
                  padding: '0 7px 0 8px',
                  fontSize: 11.5,
                  color: active ? colorText : colorTextSecondary,
                  background: active
                    ? colorBgContainer
                    : isDarkMode
                      ? 'rgba(255,255,255,.045)'
                      : 'rgba(0,0,0,.045)',
                  borderRadius: 8,
                  border: `1px solid ${active ? colorBorderSecondary : 'transparent'}`,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'background .12s ease'
                }}
              >
                {tab.loading ? (
                  <RiRefreshLine size={12} className="animate-spin" />
                ) : (
                  <RiGlobalLine size={12} />
                )}
                <span className="truncate" style={{ flex: 1, textAlign: 'left' }}>
                  {titleOf(tab)}
                </span>
                <span
                  role="presentation"
                  data-browser-close-tab={tab.id}
                  onClick={(event) => {
                    event.stopPropagation()
                    closeTab(tab.id)
                  }}
                  className="browser-tab-close"
                  style={{
                    width: 16,
                    height: 16,
                    flex: '0 0 auto',
                    display: 'grid',
                    placeItems: 'center',
                    borderRadius: 4,
                    color: colorTextTertiary,
                    fontSize: 10
                  }}
                >
                  ✕
                </span>
              </button>
            )
          })}
          <button
            type="button"
            data-browser-new-tab="1"
            title={t('harness.browserPanel.newTab')}
            className="browser-icon-btn"
            onClick={openNewTab}
            style={{
              width: 26,
              height: 26,
              flex: '0 0 auto',
              border: 'none',
              borderRadius: 7,
              background: 'transparent',
              color: colorTextSecondary,
              cursor: 'pointer',
              display: 'grid',
              placeItems: 'center',
              marginLeft: 2
            }}
          >
            <RiAddLine size={15} />
          </button>
        </div>
      </div>

      {/* Toolbar: back/forward/reload + site icon + address input (no "Open" button, Enter submits) */}
      <div
        className="flex items-center"
        style={{
          height: 40,
          flex: '0 0 40px',
          gap: 2,
          padding: '0 6px',
          borderBottom: `1px solid ${colorBorderSecondary}`
        }}
      >
        <Tooltip title={t('harness.browserPanel.back')}>
          <Button
            type="text"
            size="small"
            data-browser-back="1"
            disabled={!activeTab?.canBack}
            icon={<RiArrowLeftLine size={14} />}
            onClick={goBack}
          />
        </Tooltip>
        <Tooltip title={t('harness.browserPanel.forward')}>
          <Button
            type="text"
            size="small"
            data-browser-forward="1"
            disabled={!activeTab?.canForward}
            icon={<RiArrowRightLine size={14} />}
            onClick={goForward}
          />
        </Tooltip>
        <Tooltip title={t('harness.browserPanel.reload')}>
          <Button
            type="text"
            size="small"
            data-browser-reload="1"
            disabled={!activeTab?.url}
            icon={<RiRefreshLine size={14} />}
            onClick={reload}
          />
        </Tooltip>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            height: 30,
            marginLeft: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 10px',
            border: `1px solid ${colorBorderSecondary}`,
            borderRadius: 8,
            background: isDarkMode ? '#1f1f22' : '#fff'
          }}
        >
          <RiGlobalLine size={13} style={{ color: colorTextTertiary, flex: '0 0 auto' }} />
          <input
            ref={addressRef}
            data-browser-address="1"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                navigate()
              }
            }}
            spellCheck={false}
            placeholder={t('harness.browserPanel.addressPlaceholder')}
            style={{
              flex: 1,
              minWidth: 0,
              height: '100%',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: colorText,
              fontSize: 12
            }}
          />
        </div>
      </div>

      {activeTab?.error ? (
        <div style={{ padding: '8px 12px', fontSize: 11.5, color: token.colorError }}>
          {t('harness.browserPanel.loadFailed', { reason: activeTab.error })}
        </div>
      ) : null}

      {/* Page area: the blank page shows nothing; the webview mounts only after a URL is entered */}
      <div
        style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}
        data-browser-blank={tabs.every((tab) => !tab.url) ? '1' : undefined}
      >
        {tabs.map((tab) => (
          <BrowserTabView
            key={tab.id}
            tab={tab}
            active={tab.id === activeTab?.id}
            onWebviewReady={onWebviewReady}
            onUpdate={updateTab}
          />
        ))}
      </div>

      {/* Tab search panel (open tabs + recently closed) */}
      {tabSearchOpen ? (
        <div
          ref={tabSearchRef}
          data-browser-tab-search-panel="1"
          style={{
            position: 'absolute',
            top: 40,
            left: 6,
            right: 6,
            zIndex: 20,
            maxHeight: 'min(560px, calc(100% - 48px))',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            border: `1px solid ${colorBorderSecondary}`,
            borderRadius: 12,
            background: token.colorBgElevated,
            boxShadow: '0 18px 42px rgba(0,0,0,.32)'
          }}
        >
          <div
            className="flex items-center"
            style={{
              gap: 8,
              padding: '0 12px',
              height: 44,
              flex: '0 0 44px',
              borderBottom: `1px solid ${colorBorderSecondary}`
            }}
          >
            <RiSearchLine size={15} style={{ color: colorTextTertiary }} />
            <input
              ref={tabSearchInputRef}
              data-browser-tab-search-input="1"
              value={tabSearchQuery}
              onChange={(event) => setTabSearchQuery(event.target.value)}
              placeholder={t('harness.browserPanel.tabSearchPlaceholder')}
              style={{
                flex: 1,
                minWidth: 0,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: colorText,
                fontSize: 12.5
              }}
            />
            <span style={{ fontSize: 10.5, color: colorTextTertiary }}>
              {t('harness.browserPanel.tabSearchShortcut')}
            </span>
          </div>
          <div className="browser-tabsearch-list" style={{ overflowY: 'auto', minHeight: 0 }}>
            <div
              style={{
                padding: '10px 12px 6px',
                fontSize: 11,
                color: colorTextSecondary,
                fontWeight: 600
              }}
            >
              {t('harness.browserPanel.openTabs')}
            </div>
            {openTabsFiltered.length === 0 ? (
              <div style={{ padding: '6px 12px 10px', fontSize: 11, color: colorTextTertiary }}>
                {t('harness.browserPanel.noMatchingTabs')}
              </div>
            ) : (
              openTabsFiltered.map((tab) => (
                <div
                  key={tab.id}
                  data-browser-tab-row={tab.id}
                  onClick={() => {
                    setActiveId(tab.id)
                    setTabSearchOpen(false)
                  }}
                  className="flex items-center"
                  style={{
                    gap: 10,
                    padding: '8px 12px',
                    cursor: 'pointer',
                    background:
                      tab.id === activeTab?.id
                        ? isDarkMode
                          ? 'rgba(255,255,255,.06)'
                          : 'rgba(0,0,0,.045)'
                        : 'transparent'
                  }}
                >
                  <span
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 7,
                      background: isDarkMode ? '#2f2f33' : '#ececef',
                      display: 'grid',
                      placeItems: 'center',
                      color: colorTextSecondary,
                      flex: '0 0 auto'
                    }}
                  >
                    <RiGlobalLine size={14} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <div
                      className="truncate"
                      style={{ fontSize: 12.5, color: colorText, fontWeight: 500 }}
                    >
                      {titleOf(tab)}
                    </div>
                    <div className="truncate" style={{ fontSize: 10.5, color: colorTextTertiary }}>
                      {urlOf(tab)}
                    </div>
                  </span>
                  <span
                    role="presentation"
                    data-browser-tab-search-close={tab.id}
                    onClick={(event) => {
                      event.stopPropagation()
                      closeTab(tab.id)
                    }}
                    style={{ color: colorTextTertiary, fontSize: 11, padding: 4 }}
                  >
                    ✕
                  </span>
                </div>
              ))
            )}

            <div
              className="flex items-center"
              onClick={() => setRecentOpen((prev) => !prev)}
              style={{
                gap: 6,
                marginTop: 6,
                padding: '10px 12px 6px',
                fontSize: 11,
                color: colorTextSecondary,
                fontWeight: 600,
                cursor: 'pointer',
                borderTop: `1px solid ${colorBorderSecondary}`
              }}
            >
              {t('harness.browserPanel.recentlyClosed')}
              <span style={{ marginLeft: 'auto', color: colorTextTertiary }}>
                {recentOpen ? <RiArrowUpSLine size={14} /> : <RiArrowDownSLine size={14} />}
              </span>
            </div>
            {recentOpen ? (
              recentlyClosedFiltered.length === 0 ? (
                <div style={{ padding: '6px 12px 12px', fontSize: 11, color: colorTextTertiary }}>
                  {t('harness.browserPanel.noRecentlyClosed')}
                </div>
              ) : (
                recentlyClosedFiltered.map((item, index) => (
                  <div
                    key={`${item.url}-${item.closedAt}-${index}`}
                    data-browser-recent-row="1"
                    onClick={() => reopenRecentlyClosed(item)}
                    className="flex items-center"
                    style={{ gap: 10, padding: '8px 12px', cursor: 'pointer' }}
                  >
                    <span
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 7,
                        background: isDarkMode ? '#2f2f33' : '#ececef',
                        display: 'grid',
                        placeItems: 'center',
                        color: colorTextSecondary,
                        flex: '0 0 auto'
                      }}
                    >
                      <RiGlobalLine size={14} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <div
                        className="truncate"
                        style={{ fontSize: 12.5, color: colorText, fontWeight: 500 }}
                      >
                        {item.title || item.url}
                      </div>
                      <div className="truncate" style={{ fontSize: 10.5, color: colorTextTertiary }}>
                        {item.url} · {relativeTime(item.closedAt)}
                      </div>
                    </span>
                  </div>
                ))
              )
            ) : null}
          </div>
        </div>
      ) : null}
      <style>{browserPanelStyles}</style>
    </div>
  )
}

const browserPanelStyles = `
.browser-icon-btn:hover { background: rgba(127,127,127,.14); }
.browser-tab-btn:hover { background: rgba(127,127,127,.12); }
.browser-tab-close:hover { background: rgba(127,127,127,.2); color: inherit; }
.browser-tabstrip { scrollbar-width: none; -ms-overflow-style: none; }
.browser-tabstrip::-webkit-scrollbar { display: none; width: 0; height: 0; }
.browser-tabsearch-list { scrollbar-width: none; -ms-overflow-style: none; }
.browser-tabsearch-list::-webkit-scrollbar { display: none; width: 0; height: 0; }
`

export default BrowserPanel
