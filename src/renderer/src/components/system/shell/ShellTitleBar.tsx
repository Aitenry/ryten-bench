import React, { useLayoutEffect } from 'react'
import { Dropdown, theme } from 'antd'
import type { MenuProps } from 'antd'
import { useTranslation } from '@renderer/i18n'
import { useTheme } from '@renderer/hooks/useTheme'

/**
 * Custom-drawn title bar (Window Controls Overlay approach for Windows / macOS).
 *
 * Why it is needed: user feedback on 2026-11-19 — after "remove the in-app custom window buttons",
 * the main window fell back to the system default "icon + app name + buttons" title bar, which did
 * not match the intended form (an app menu on the left and system window buttons on the right of a
 * dark title strip). So:
 * - Minimize / maximize / close are **still drawn by the system** (`titleBarStyle: 'hidden'` +
 *   `titleBarOverlay`); they are real system buttons, not fake icons drawn here;
 * - The renderer only draws the title strip itself: the "App / Edit" menus on the left plus the
 *   full-width drag area;
 * - The overlay background/foreground colors of the system buttons follow the theme via
 *   `setTitleBarOverlay` (see the effect below).
 *
 * Linux has no WCO; the main process falls back to the native system frame and AppShell does not
 * mount this component.
 */

const api = (): Window['api'] => window.api

const ShellTitleBar: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { effectiveTheme } = useTheme()
  const platform = api().platform
  const isMac = platform === 'darwin'

  /**
   * The colors of the system-drawn window buttons follow the app theme.
   *
   * **The background must exactly match the custom title strip** (user feedback on 2026-11-19:
   * "the colors differ"): the overlay is a separate region the system draws above the web content,
   * and its color is set independently via `setTitleBarOverlay`; a hard-coded color here would
   * differ slightly from `--shell-titlebar-bg` in CSS (derived from antd token.colorBgLayout),
   * leaving a visible seam of different color on the right side of the title strip. Reusing the
   * same token here keeps them identical by construction.
   *
   * symbolColor must be a **solid color**: Electron's rgba() parsing is unreliable, and passing
   * token.colorText (values like rgba(0,0,0,0.88)) degrades to the default color, making white
   * symbols almost invisible on a white background in the light theme.
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
      // Platform does not support WCO: keep the system default title bar
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
