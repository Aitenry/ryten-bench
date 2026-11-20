import React, { useSyncExternalStore } from 'react'
import SettingsModal from './SettingsModal'
import {
  closeSettingsModal,
  getSettingsModalState,
  subscribeSettingsModalState
} from './settings-modal-state'

/**
 * 设置弹窗的挂载点。
 *
 * 为什么不放在 `CustomFrame` 里（它原来在那儿）：插件自己的 Provider 随插件装卸
 * （`ctx.use('appProvider')`），Provider 链一变，其下**整棵外壳子树都会被重建**——
 * 包括 `CustomFrame` 以及它托管的 antd Modal。弹窗被卸载重挂的后果是它的淡入/缩放动画
 * 重放一次，看起来就是「点插件开关时弹窗关掉又重新打开」一闪一闪（2026-09-26 用户反馈，
 * 工装 test/probe-plugin-toggle-remount.mjs 量到 `.ant-modal` 确实被 REMounted）。
 *
 * 挂到这里（`PluginProvidersShell` 的**兄弟位置**、插件 Provider 链之外）后：
 * - 插件启停不再重建弹窗，动画不重放；
 * - 弹窗只依赖宿主注册表（`usePluginSettingsSections`/`usePlugins`）、i18n 与 antd 的
 *   `App`（在 main.tsx 更上层），**不依赖任何插件的 Provider**（已核对 5 个插件设置页
 *   都不消费插件自身的 context）；
 * - 开合/页签/范围仍由 `settings-modal-state.ts` 的模块级 store 持有，跨重挂不丢。
 */
const SettingsHost: React.FC = () => {
  const state = useSyncExternalStore(subscribeSettingsModalState, getSettingsModalState)
  return <SettingsModal open={state.open} onClose={closeSettingsModal} />
}

export default SettingsHost
