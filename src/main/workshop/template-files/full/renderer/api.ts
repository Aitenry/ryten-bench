import type { ${vars.pascal}Item, ${vars.pascal}ItemInput, ${vars.pascal}Settings } from '../shared/types'

/**
 * ${vars.title} 主进程通道的薄封装。
 *
 * 组件里**不直接写通道名**：改通道只动这一处，类型也只有这一处需要维护。
 * 走的是 preload 唯一暴露的通用桥（`window.api.plugin.invoke` / `.on`）。
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
  /** 记录变了（主进程推送）——返回取消订阅的函数 */
  onItemsChanged: (callback: () => void): (() => void) =>
    window.api.plugin.on('plugin:${vars.id}:items-changed', () => callback())
}

export default api
