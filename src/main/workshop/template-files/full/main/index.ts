import { PLUGIN_PURGE } from '@host/main/plugins/contributions'
import { HARNESS_TOOL_CONTRIBUTION } from '@host/main/plugins/tool-contract'
// 副作用导入：装载即触发**本插件自带建表**（幂等），不必等到第一次查询
import { schemaReady } from './db/ddl'
import { ITEMS_CHANGED, createIpcHandlers, initSettings } from './ipc'
import { purgePluginData } from './purge'
import { createToolContribution } from './tools'
import type { MainPluginContext } from './context'

/**
 * ${vars.title} 的主进程入口（**只做装配**，实现分在 ./ipc ./tools ./purge ./db 下）。
 *
 * - `./db/ddl`：本插件自带建表（宿主不认识 `${vars.itemsToolName}` 这张表），幂等；
 * - `ctx.registerIpc`：6 个 `plugin:${vars.id}:*` 通道（记录增删改查 + 设置读写），
 *   停用或卸载时随 `ctx.dispose()` 一并摘除；
 * - `ctx.registerEvent`：主进程 → 渲染层的事件通道（**只有发送方**，不声明渲染层就订阅不到）；
 * - `ctx.contribute(HARNESS_TOOL_CONTRIBUTION, …)`：给助手的 AI 工具（读写同一份数据）；
 * - `ctx.contribute(PLUGIN_PURGE, …)`：卸载勾「同时删除数据」时清本插件的表行与文件。
 *
 * 有业务表的插件还应贡献 `PLUGIN_SYNC_SNAPSHOT`（export/import/hasData/count）；需要「合并两边」
 * 时按 merge base 三方语义实现 `merge(remote, { base })` 并声明 `mergeBase: true`——规范与
 * 事故清单见 `WORKSHOP.md` 第 5b 节。
 *
 * 一切副作用都放进 `ctx.effect` 并返回回滚函数：插件停用时宿主逆序撤销。
 */
export function install(ctx: MainPluginContext): void {
  // 建表是异步的：这里只是「早点开始」，mapper / purge 各自还会 await 它的承诺
  void schemaReady

  initSettings(ctx)

  ctx.registerEvent(ITEMS_CHANGED)
  ctx.registerIpc(createIpcHandlers())

  ctx.contribute(HARNESS_TOOL_CONTRIBUTION, createToolContribution())

  ctx.contribute(PLUGIN_PURGE, {
    label: '本插件的记录与设置（表 ${vars.itemsToolName} + plugin-state/${vars.id}.json）',
    run: purgePluginData
  })
}
