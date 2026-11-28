import type { ${vars.pascal}Item, ${vars.pascal}ItemInput, ${vars.pascal}Settings } from '../shared/types'

/**
 * Thin wrapper around ${vars.title}'s main-process channels.
 *
 * Components **never spell out channel names**: changing a channel touches only this file, and
 * its types are maintained only here. Calls go through the single generic bridge preload
 * exposes (`window.api.plugin.invoke` / `.on`).
 */
const invoke = window.api.plugin.invoke

export const api = {
  list: () => invoke('plugin:${vars.id}:items-list') as Promise<${vars.pascal}Item[]>,
  create: (input: ${vars.pascal}ItemInput) =>
    invoke('plugin:${vars.id}:items-create', input) as Promise<${vars.pascal}Item>,
  update: (id: number, patch: { title?: string; note?: string; done?: boolean }) =>
    invoke('plugin:${vars.id}:items-update', id, patch) as Promise<${vars.pascal}Item | null>,
  remove: (id: number) => invoke('plugin:${vars.id}:items-delete', id) as Promise<boolean>,
  getSettings: () => invoke('plugin:${vars.id}:settings-get') as Promise<${vars.pascal}Settings>,
  setSettings: (patch: Partial<${vars.pascal}Settings>) =>
    invoke('plugin:${vars.id}:settings-set', patch) as Promise<${vars.pascal}Settings>,
  /** An item changed (pushed from the main process); returns an unsubscribe function */
  onItemsChanged: (callback: () => void): (() => void) =>
    window.api.plugin.on('plugin:${vars.id}:items-changed', () => callback())
}

export default api
