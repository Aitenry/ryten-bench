import React, { useSyncExternalStore } from 'react'
import SettingsModal from './SettingsModal'
import {
  closeSettingsModal,
  getSettingsModalState,
  subscribeSettingsModalState
} from './settings-modal-state'

/**
 * Mount point for the settings modal.
 *
 * Why not inside `CustomFrame` (where it used to live): a plugin's own Provider is mounted and
 * unmounted with the plugin (`ctx.use('appProvider')`), and any change to the Provider chain
 * rebuilds the **entire shell subtree** beneath it — including `CustomFrame` and the antd Modal it
 * hosts. Unmounting and remounting the modal replays its fade/zoom animation, which looks like the
 * modal closing and reopening with a flicker whenever a plugin switch is toggled (measured with
 * test/probe-plugin-toggle-remount.mjs: `.ant-modal` really was remounted).
 *
 * Mounted here (as a **sibling** of `PluginProvidersShell`, outside the plugin Provider chain):
 * - plugin enable/disable no longer rebuilds the modal, so the animation does not replay;
 * - the modal only depends on the host registries (`usePluginSettingsSections`/`usePlugins`), i18n
 *   and antd's `App` (higher up in main.tsx), and **depends on no plugin Provider** (verified that
 *   all 5 plugin settings pages do not consume the plugin's own context);
 * - open state / tab / scope still live in the module-level store in `settings-modal-state.ts`, so
 *   they survive remounts.
 */
const SettingsHost: React.FC = () => {
  const state = useSyncExternalStore(subscribeSettingsModalState, getSettingsModalState)
  return <SettingsModal open={state.open} onClose={closeSettingsModal} />
}

export default SettingsHost
