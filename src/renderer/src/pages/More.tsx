import React from 'react'
import { theme } from 'antd'
import { Navigate, useParams } from 'react-router-dom'
import { useTranslation } from '@renderer/i18n'
import { systemSettingsSections } from '@renderer/components/system/settings/sections'

/**
 * Assistant settings page under "More" — the item selected in the sidebar's "More" menu is shown
 * here in full.
 *
 * Only the assistant group of settings (agents / skills / memory / MCP) gets a standalone page
 * (user feedback 2026-11-20: "assistant only"); regular settings stay in the settings modal.
 *
 * The page no longer carries a left-hand menu: the entry point is the sidebar's "More" dropdown
 * (see AppShell.tsx), which only selects; once chosen the whole page is that item's content —
 * icon, large title and description at the top, with the settings section cards below
 * (`SettingsSection` has been reworked for the roomier toC styling). The page's own
 * `SettingsPageHeader` is hidden on the standalone page (the description already lives in the
 * hero), controlled by `.more-detail .sui-page-header` in `main.css`.
 */

const ASSISTANT_SECTIONS = systemSettingsSections
  .filter((section) => section.group === 'assistant')
  .sort((a, b) => a.order - b.order)

const More: React.FC = () => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const { tab } = useParams()

  /**
   * When the tab in the route does not exist (old link / hand-edited address), **redirect** to
   * the first available tab instead of a blank screen, and never leave the address bar on a
   * nonexistent path. The old implementation only fell back in content: the user saw the "agents"
   * page while the address bar still said /more/workshop, and clicking the same item in the
   * sidebar only re-navigated to the same address (appearing stuck).
   */
  const known = ASSISTANT_SECTIONS.find((section) => section.tabKey === tab)
  if (!known) {
    return <Navigate to={`/more/${ASSISTANT_SECTIONS[0]?.tabKey ?? 'agents'}`} replace />
  }

  const active = known
  const ActiveView = active.Component
  /**
   * The skills page is the only one that "fills the remaining height": its header stays pinned at
   * the top and the skill card list scrolls on its own below. Other pages still grow with their
   * content and scroll as a whole (user feedback 2026-11-27: the skills page must not occupy only
   * half the screen, and small windows must not suddenly show a whole-page scrollbar).
   */
  const fillPage = active.tabKey === 'skills'

  /** Page header icon: the registry entry is a 16px navigation icon; the hero enlarges it to
   *  22px */
  const heroIcon = React.isValidElement(active.icon)
    ? React.cloneElement(active.icon as React.ReactElement<{ size?: number }>, { size: 20 })
    : active.icon

  return (
    <div
      className="more-detail h-full flex-1 custom-scrollbar"
      data-more-page="1"
      data-more-tab={active.tabKey}
      style={{
        overflowY: 'auto',
        background: token.colorBgContainer,
        borderTopLeftRadius: token.borderRadiusLG
      }}
    >
      <div
        style={{
          width: '100%',
          padding: fillPage ? '18px 24px 24px' : '18px 24px 44px',
          ...(fillPage
            ? {
                height: '100%',
                boxSizing: 'border-box' as const,
                display: 'flex',
                flexDirection: 'column' as const,
                minHeight: 0
              }
            : {})
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <span
            style={{
              width: 44,
              height: 44,
              flexShrink: 0,
              borderRadius: 13,
              background: token.colorFillSecondary,
              color: token.colorText,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {heroIcon}
          </span>
          <div style={{ minWidth: 0, paddingTop: 1 }}>
            <h1
              style={{
                margin: 0,
                fontSize: 20,
                lineHeight: 1.25,
                fontWeight: 600,
                letterSpacing: '-0.015em',
                color: token.colorText
              }}
            >
              {t(active.labelKey as never)}
            </h1>
            {active.descriptionKey && (
              <p
                style={{
                  margin: '5px 0 0',
                  fontSize: 12.5,
                  lineHeight: 1.6,
                  color: token.colorTextSecondary,
                  maxWidth: 860
                }}
              >
                {t(active.descriptionKey as never)}
              </p>
            )}
          </div>
        </div>

        <div
          className={fillPage ? 'more-fill-view' : undefined}
          style={{
            marginTop: 22,
            ...(fillPage
              ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' as const }
              : {})
          }}
        >
          <ActiveView />
        </div>
      </div>
    </div>
  )
}

export default More
