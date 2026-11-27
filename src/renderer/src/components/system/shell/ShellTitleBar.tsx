import React, { useLayoutEffect } from 'react'
import { Dropdown, theme } from 'antd'
import type { MenuProps } from 'antd'
import { useTranslation } from '@renderer/i18n'
import { useTheme } from '@renderer/hooks/useTheme'

/**
 * 自绘标题栏（Windows / macOS 的 Window Controls Overlay 方案）。
 *
 * 为什么需要它：用户 2026-11-19 反馈——「移除应用内的自绘窗口按钮」之后，主窗口退成了
 * 系统默认的「图标 + 应用名 + 按钮」标题栏，和参考形态（左侧一条应用菜单、右侧系统窗口
 * 按钮的深色标题条）不一致。所以：
 * - 最小化 / 最大化 / 关闭**仍由系统绘制**（`titleBarStyle: 'hidden'` + `titleBarOverlay`），
 *   是真正的系统按钮，不是这里画的假图标；
 * - 渲染层只画标题条本身：左侧「应用 / 编辑」两个菜单 + 整条拖拽区；
 * - 系统按钮覆盖层的底色/前景色由 `setTitleBarOverlay` 跟随主题同步（见下方 effect）。
 *
 * Linux 没有 WCO，主进程回退系统原生边框，AppShell 也不会挂载本组件。
 */

const api = () => window.api

const ShellTitleBar: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { effectiveTheme } = useTheme()
  const platform = api().platform
  const isMac = platform === 'darwin'

  /**
   * 系统绘制的窗口按钮配色跟随应用主题。
   *
   * **底色必须和自绘标题条严格一致**（用户 2026-11-19 反馈「颜色不一样」）：覆盖层是系统
   * 画在网页内容之上的独立区域，颜色由 `setTitleBarOverlay` 单独指定；若这里手写死色，
   * 就会和 CSS 里的 `--shell-titlebar-bg`（来自 antd token.colorBgLayout）差一点点，
   * 标题条右侧出现一条可见的色差缝。这里直接复用同一个 token，天然同色。
   *
   * symbolColor 必须是**实色**：Electron 对 rgba() 解析不稳，传 token.colorText
   * （rgba(0,0,0,0.88) 这类）会退化成默认色，亮色主题下白符号压在白底上几乎看不见。
   */
  useLayoutEffect(() => {
    if (platform === 'linux') return
    const isDark = effectiveTheme === 'dark'
    try {
      api().window.setTitleBarOverlay({
        color: token.colorBgLayout,
        symbolColor: isDark ? '#e6e6e9' : '#1f1f1f',
        height: 36
      })
    } catch {
      // 平台不支持 WCO：保持系统默认标题栏即可
    }
  }, [platform, effectiveTheme, token.colorBgLayout])

  const onAppMenu: MenuProps['onClick'] = ({ key }) => {
    if (key === 'settings') {
      window.dispatchEvent(new CustomEvent('open-system-settings', {}))
      return
    }
    if (key === 'reload') {
      api().window.reload()
      return
    }
    if (key === 'quit') {
      api().window.quit()
    }
  }

  const onEditMenu: MenuProps['onClick'] = ({ key }) => {
    api().window.edit(key as Parameters<Window['api']['window']['edit']>[0])
  }

  const appItems: MenuProps['items'] = [
    { key: 'settings', label: t('shell.titleBar.settings') },
    { type: 'divider' },
    { key: 'reload', label: t('shell.titleBar.reload') },
    { key: 'quit', label: t('shell.titleBar.quit') }
  ]

  const editItems: MenuProps['items'] = [
    { key: 'undo', label: t('shell.titleBar.undo'), extra: 'Ctrl+Z' },
    { key: 'redo', label: t('shell.titleBar.redo'), extra: 'Ctrl+Shift+Z' },
    { type: 'divider' },
    { key: 'cut', label: t('shell.titleBar.cut'), extra: 'Ctrl+X' },
    { key: 'copy', label: t('shell.titleBar.copy'), extra: 'Ctrl+C' },
    { key: 'paste', label: t('shell.titleBar.paste'), extra: 'Ctrl+V' },
    { type: 'divider' },
    { key: 'selectAll', label: t('shell.titleBar.selectAll'), extra: 'Ctrl+A' }
  ]

  return (
    <div className="shell-titlebar" style={isMac ? { paddingLeft: 78 } : undefined}>
      <Dropdown
        menu={{ items: appItems, onClick: onAppMenu }}
        trigger={['click']}
        placement="bottomLeft"
      >
        <button type="button" className="shell-titlebar-menu">
          {t('shell.titleBar.app')}
        </button>
      </Dropdown>
      <Dropdown
        menu={{ items: editItems, onClick: onEditMenu }}
        trigger={['click']}
        placement="bottomLeft"
      >
        <button type="button" className="shell-titlebar-menu">
          {t('shell.titleBar.edit')}
        </button>
      </Dropdown>
    </div>
  )
}

export default ShellTitleBar
