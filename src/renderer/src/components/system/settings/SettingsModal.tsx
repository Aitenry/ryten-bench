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
 * 设置弹窗 = shell 核心页（静态）+ 系统级功能页（systemSettingsSections）。
 *
 * - 核心页：general / model / system，始终存在；
 * - 系统页：agents / skills / memory / mcp（助手）、graph（资料库）——随应用一起启动；
 * - **不含**插件相关页：插件工坊、第三方插件自己的设置页、以及原来的「插件」管理页，
 *   全部收进「插件仓库」页（用户 2026-11-19 口径「移除设置里面的这两个内容/插件」——
 *   插件相关的查看、安装、卸载、设置都在插件仓库里做，设置弹窗只放应用自己的配置）。
 * - 聚焦模式（assistant）：只显示 assistant 分组页 + model（智能体 → 模型 → 技能 → 记忆 → MCP）。
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
const GROUP_ASSISTANT = 'settings.nav.groupAssistant'

/** 设置弹窗的展示范围：full = 全部设置页；assistant = 聚焦模式 */
export type SettingsScope = 'full' | 'assistant'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
  /** 展示范围：assistant = 聚焦模式（只显示助手页 + 模型页）；默认 full = 全部设置页 */
  scope?: SettingsScope
}

const SettingsModal: React.FC<SettingsModalProps> = ({ open, onClose, scope = 'full' }) => {
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

  // 系统级设置页（AI 助手 / 资料库）。第三方插件的设置页不在这里，见插件仓库。
  const allSections = systemSettingsSections

  /** 全部页签元数据（图标常驻，文案随语言变化；系统页来自 systemSettingsSections） */
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

  /** 分组结构：general（核心页 + 系统通用页）、assistant（助手页） */
  const navGroupDefs = useMemo<GroupDef[]>(() => {
    const groups: GroupDef[] = []
    const generalItems = [
      ...Object.entries(STATIC_TABS).map(([key, d]) => ({ key, order: d.order })),
      ...allSections
        .filter((s) => s.group === 'general')
        .map((s) => ({ key: s.tabKey, order: s.order }))
    ].sort((a, b) => a.order - b.order)
    if (generalItems.length > 0) groups.push({ labelKey: GROUP_GENERAL, items: generalItems })
    const assistantItems = allSections
      .filter((s) => s.group === 'assistant')
      .map((s) => ({ key: s.tabKey, order: s.order }))
      .sort((a, b) => a.order - b.order)
    if (assistantItems.length > 0) groups.push({ labelKey: GROUP_ASSISTANT, items: assistantItems })
    return groups
  }, [allSections])

  /** 聚焦模式页签：助手分组页 + model 页（模型排在首项之后，维持 智能体 → 模型 → … 惯例） */
  const focusedTabs = useMemo<string[]>(() => {
    const assistant = navGroupDefs.find((g) => g.labelKey === GROUP_ASSISTANT)?.items ?? []
    const sorted = [...assistant].sort((a, b) => a.order - b.order).map((i) => i.key)
    if (sorted.length === 0) return ['model']
    return [sorted[0], 'model', ...sorted.slice(1)]
  }, [navGroupDefs])

  const onlyTabs = scope === 'assistant' ? focusedTabs : null

  const firstTab = (): string => {
    if (onlyTabs && onlyTabs.length > 0) return onlyTabs[0]
    const firstGroup = navGroupDefs[0]?.items[0]
    return firstGroup?.key ?? 'general'
  }

  const pickTab = (tab: SettingsTab | undefined): SettingsTab => {
    if (onlyTabs && onlyTabs.length > 0) {
      return tab && onlyTabs.includes(tab) ? tab : onlyTabs[0]
    }
    if (tab && tabMeta[tab]) return tab
    return firstTab()
  }

  /**
   * 当前页签存在**模块级 store** 里（`settings-modal-state.ts`），不放在组件 state：
   * 插件启停会让 Provider 链变化 → 其下整棵外壳子树重挂 → 本组件被重建，
   * 组件内 state 会丢（表现为「点插件开关，设置内容刷新并跳回通用」）。
   * 这里只做「把 store 里的 tab 解析成当前可用的页签」，失效的 tab 自然回退到首个可用页签。
   */
  const storedTab = useSyncExternalStore(subscribeSettingsModalState, getSettingsModalState).tab as
    SettingsTab | undefined
  const activeTab = pickTab(storedTab)
  const setActiveTab = useCallback((tab: SettingsTab) => setSettingsModalTab(tab), [])

  /**
   * 状态自愈：store 里的 tab 若已不可用（所属插件的设置页被停用、或聚焦模式下不在白名单里），
   * 把解析后的实际页签写回 store。否则会出现「UI 显示 A 页、store 记着 B 页」，
   * 等 B 页恢复可用（插件重新启用）就莫名其妙跳回去。
   */
  useEffect(() => {
    if (open && storedTab !== activeTab) setSettingsModalTab(activeTab)
  }, [open, storedTab, activeTab])

  /** 聚焦模式只渲染白名单内的分组，其余系统级页面整组隐藏 */
  const navGroups = useMemo(
    () =>
      (onlyTabs ? navGroupDefs.filter((g) => g.labelKey === GROUP_ASSISTANT) : navGroupDefs).map(
        (group) => ({
          label: t(group.labelKey as never),
          items: group.items
            .filter((i) => !onlyTabs || onlyTabs.includes(i.key))
            .map((i) => tabMeta[i.key])
        })
      ),
    [onlyTabs, navGroupDefs, tabMeta, t]
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
        // 系统级设置页（agents / skills / memory / mcp / graph）——应用自身代码，无需插件隔离
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
        {/* 左侧分组导航 */}
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

        {/* 右侧内容 */}
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
