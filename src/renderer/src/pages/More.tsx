import React from 'react'
import { theme } from 'antd'
import { Navigate, useParams } from 'react-router-dom'
import { useTranslation } from '@renderer/i18n'
import { systemSettingsSections } from '@renderer/components/system/settings/sections'

/**
 * 「更多」里的助手设置页 —— 侧栏「更多」菜单选中的那一项，在这里完整展示。
 *
 * 只有助手这一组设置（智能体 / 技能 / 记忆 / MCP）走独立页面（用户 2026-11-20
 * 「只要助手的」）；常规设置仍在设置弹窗里。
 *
 * 页面不再带左侧菜单：入口改成侧栏的「更多」下拉菜单（见 AppShell.tsx），
 * 菜单只负责选择，选中后整页就是该项内容——顶部 icon + 大标题 + 描述，
 * 下面沿用设置页的分区卡片（`SettingsSection` 已按更宽松的 toC 样式重构）。
 * 页面自己的 `SettingsPageHeader` 在独立页面里隐藏（描述已经在 hero 里），
 * 由 `main.css` 的 `.more-detail .sui-page-header` 控制。
 */

const ASSISTANT_SECTIONS = systemSettingsSections
  .filter((section) => section.group === 'assistant')
  .sort((a, b) => a.order - b.order)

const More: React.FC = () => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const { tab } = useParams()

  /**
   * 路由里的 tab 不存在（旧链接 / 手改地址）时**重定向**到第一个可用页签，不白屏、也不
   * 让地址栏停在一个不存在的路径上——旧实现只做内容回落，用户看到的是「智能体」页而
   * 地址栏仍是 /more/workshop，侧栏再点同一条也只会重复导航同一个地址（表现为卡住）。
   */
  const known = ASSISTANT_SECTIONS.find((section) => section.tabKey === tab)
  if (!known) {
    return <Navigate to={`/more/${ASSISTANT_SECTIONS[0]?.tabKey ?? 'agents'}`} replace />
  }

  const active = known
  const ActiveView = active.Component

  /** 页头图标：注册表里是 16px 的导航图标，hero 里放大到 22px */
  const heroIcon = React.isValidElement(active.icon)
    ? React.cloneElement(active.icon as React.ReactElement<{ size?: number }>, { size: 20 })
    : active.icon

  return (
    <div
      className="more-detail h-full flex-1"
      data-more-page="1"
      data-more-tab={active.tabKey}
      style={{
        overflowY: 'auto',
        background: token.colorBgContainer,
        borderTopLeftRadius: token.borderRadiusLG
      }}
    >
      <div style={{ width: '100%', padding: '18px 24px 44px' }}>
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

        <div style={{ marginTop: 22 }}>
          <ActiveView />
        </div>
      </div>
    </div>
  )
}

export default More
