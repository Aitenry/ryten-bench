import React, { useEffect, useMemo, useCallback, useSyncExternalStore } from 'react'
import { Modal, theme } from 'antd'
import { RiSettings3Line, RiBrainAi3Line, RiComputerLine } from '@remixicon/react'
import GeneralSettings from './GeneralSettings'
import SystemInfo from './SystemInfo'
import ModelSettings from './ModelSettings'
import { useTranslation } from '@renderer/i18n'
import { systemSettingsSections } from './sections'
import {
  getSettingsModalState,
  setSettingsModalTab,
  subscribeSettingsModalState
} from './settings-modal-state'

/**
 * Settings modal = shell core pages (static) + knowledge-base settings (graph).
 *
 * Only **non-assistant** application settings live here: assistant-related agents / skills / memory
 * / MCP have moved out of the modal to the separate "More" page (the user's 2026-11-20 rule: "only
 * assistant content needs a separate page"), so the modal no longer has an assistant group or a
 * focused mode.
 *
 * - Core pages: general / model / system, always present;
 * - System pages: graph (knowledge base) — launched with the app;
 * - **No** plugin-related pages: the plugin workshop, third-party plugins' own settings pages, and
 *   the former "plugins" management page are all folded into the "plugin repository" page (the
 *   user's 2026-11-19 rule: "remove these two things / plugins from settings" — viewing,
 *   installing, uninstalling and configuring plugins all happen in the plugin repository; the
 *   settings modal only holds the app's own configuration).
 */

export type SettingsTab = string

interface TabItem {
  key: string
  label: string
  icon: React.ReactNode
  order: number
}

interface GroupDef {
  labelKey: string
  items: { key: string; order: number }[]
}

const STATIC_TABS = {
  general: { labelKey: 'settings.nav.general', order: 10 },
  model: { labelKey: 'settings.nav.model', order: 20 },
  system: { labelKey: 'settings.nav.system', order: 50 }
} as const

const STATIC_ICONS: Record<string, React.ReactNode> = {
  general: <RiSettings3Line size={16} />,
  model: <RiBrainAi3Line size={16} />,
  system: <RiComputerLine size={16} />
}

const GROUP_GENERAL = 'settings.nav.groupGeneral'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

const SettingsModal: React.FC<SettingsModalProps> = ({ open, onClose }) => {
  const {
    token: {
      colorTextSecondary,
      colorTextTertiary,
      colorBgContainer,
      colorFillAlter,
      colorBorderSecondary,
      borderRadiusLG,
      borderRadius,
      colorPrimary
    }
  } = theme.useToken()

  const { t } = useTranslation()

  // System-level settings pages (knowledge base graph). Assistant pages are not here, see pages/More.tsx.
  const allSections = systemSettingsSections.filter((section) => section.group !== 'assistant')

  /** Metadata for all tabs (icons are fixed, labels follow the language; system pages come from systemSettingsSections) */
  const tabMeta = useMemo<Record<string, TabItem>>(() => {
    const meta: Record<string, TabItem> = {}
    for (const [key, def] of Object.entries(STATIC_TABS)) {
      meta[key] = {
        key,
        label: t(def.labelKey as never),
        icon: STATIC_ICONS[key],
        order: def.order
      }
    }
    for (const s of allSections) {
      meta[s.tabKey] = {
        key: s.tabKey,
        label: t(s.labelKey as never),
        icon: s.icon,
        order: s.order
      }
    }
    return meta
  }, [allSections, t])

  /** Group structure: only one general group remains (core pages + knowledge-base settings) */
  const navGroupDefs = useMemo<GroupDef[]>(() => {
    const generalItems = [
      ...Object.entries(STATIC_TABS).map(([key, d]) => ({ key, order: d.order })),
      ...allSections
        .filter((s) => s.group === 'general')
        .map((s) => ({ key: s.tabKey, order: s.order }))
    ].sort((a, b) => a.order - b.order)
    return generalItems.length > 0 ? [{ labelKey: GROUP_GENERAL, items: generalItems }] : []
  }, [allSections])

  const firstTab = (): string => navGroupDefs[0]?.items[0]?.key ?? 'general'

  const pickTab = (tab: SettingsTab | undefined): SettingsTab => {
    if (tab && tabMeta[tab]) return tab
    return firstTab()
  }

  /**
   * The current tab lives in a **module-level store** (`settings-modal-state.ts`), not in component
   * state: enabling or disabling a plugin changes the Provider chain → the whole shell subtree
   * beneath it remounts → this component is rebuilt, and component state would be lost (showing up
   * as "toggling a plugin switch refreshes the settings content and jumps back to General").
   * All this does here is resolve the store's tab into a currently available tab; a stale tab
   * naturally falls back to the first available one.
   */
  const storedTab = useSyncExternalStore(subscribeSettingsModalState, getSettingsModalState).tab as
    SettingsTab | undefined
  const activeTab = pickTab(storedTab)
  const setActiveTab = useCallback((tab: SettingsTab) => setSettingsModalTab(tab), [])

  /**
   * Self-healing state: if the store's tab is no longer available (the owning plugin's settings page
   * was disabled, or it is not in the whitelist in focused mode), write the resolved actual tab back
   * to the store. Otherwise the UI could show page A while the store still remembers page B, and
   * once B becomes available again (plugin re-enabled) the UI would jump back for no reason.
   */
  useEffect(() => {
    if (open && storedTab !== activeTab) setSettingsModalTab(activeTab)
  }, [open, storedTab, activeTab])

  const navGroups = useMemo(
    () =>
      navGroupDefs.map((group) => ({
        label: t(group.labelKey as never),
        items: group.items.map((item) => tabMeta[item.key])
      })),
    [navGroupDefs, tabMeta, t]
  )

  const renderContent = (): React.ReactNode => {
    switch (activeTab) {
      case 'general':
        return <GeneralSettings />
      case 'model':
        return <ModelSettings />
      case 'system':
        return <SystemInfo />
      default: {
        // System-level settings pages (agents / skills / memory / mcp / graph) — the app's own code, no plugin isolation needed
        const section = allSections.find((s) => s.tabKey === activeTab)
        return section ? <section.Component /> : null
      }
    }
  }

  return (
    <Modal
      title={
        <div className="flex items-center gap-2">
          <RiSettings3Line size={18} style={{ color: colorPrimary }} />
          <span>{t('settings.title')}</span>
        </div>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={880}
      styles={{ body: { padding: 0 } }}
      destroyOnHidden
    >
      <div
        className="flex"
        style={{ minHeight: 540, overflow: 'hidden', borderRadius: borderRadiusLG }}
      >
        {/* Left-side grouped navigation */}
        <div
          className="flex-shrink-0 flex flex-col py-4"
          style={{
            width: 176,
            borderRight: `1px solid ${colorBorderSecondary}`,
            background: colorFillAlter
          }}
        >
          {navGroups.map((group, gi) => (
            <div key={group.label} style={{ marginTop: gi === 0 ? 0 : 16 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: 1,
                  color: colorTextTertiary,
                  padding: '0 16px 6px',
                  userSelect: 'none'
                }}
              >
                {group.label}
              </div>
              {group.items.map((item) => {
                const isActive = activeTab === item.key
                return (
                  <button
                    key={item.key}
                    onClick={() => setActiveTab(item.key)}
                    className="flex items-center w-full text-left border-none cursor-pointer transition-colors"
                    style={{
                      gap: 10,
                      margin: '1px 8px',
                      padding: '8px 12px',
                      fontSize: 13,
                      width: 'calc(100% - 16px)',
                      background: isActive ? colorBgContainer : 'transparent',
                      color: isActive ? colorPrimary : colorTextSecondary,
                      fontWeight: isActive ? 600 : 400,
                      borderRadius,
                      boxShadow: isActive ? '0 1px 4px rgba(0,0,0,0.06)' : 'none'
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) e.currentTarget.style.background = 'rgba(128,128,128,0.08)'
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) e.currentTarget.style.background = 'transparent'
                    }}
                  >
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        color: isActive ? colorPrimary : colorTextTertiary
                      }}
                    >
                      {item.icon}
                    </span>
                    {item.label}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        {/* Right-side content */}
        <div
          className="flex-1 custom-scrollbar"
          style={{
            padding: '24px 28px',
            maxHeight: 560,
            overflowY: 'auto',
            background: colorBgContainer
          }}
        >
          {renderContent()}
        </div>
      </div>
    </Modal>
  )
}

export default SettingsModal
