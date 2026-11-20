import { ipcMain } from 'electron'
import logger from 'electron-log'
import { sql } from 'drizzle-orm'
import { getOrm } from '../database/orm'
import { listContributions } from '../plugins/contributions'
import { appEventListenerCount } from '../plugins/app-events'
import {
  APP_BEFORE_QUIT,
  APP_PRELOAD,
  APP_RENDERER_MEMORY_DUMP,
  APP_EVENT_WORKSPACE_CHANGED,
  type AppHook
} from '../plugins/app-hooks'

/**
 * 杂项 IPC（core）：心跳、初始化进度日志，以及**只读的宿主生命周期探针**。
 *
 * `harness-get-tools`（工具下拉清单）属于 AI 助手，在 `src/main/ipc/harness/harness.ts`，
 * 通道名 `harness:harness-get-tools`（读的是工具注册表 = 本地工具 + 内置/插件贡献）。
 *
 * 生命周期探针：第三方插件贡献的 `app.preload` / `app.before-quit` /
 * `app.renderer-memory-dump` 只存在于主进程内存里，渲染层无法直接观察——而「停用插件后
 * 这些钩子必须不再执行」是插件宿主的核心验收点，靠日志验证太脆。这里放一个**只读**的
 * 诊断通道（不改变任何行为、不暴露插件内容，只报数量与标签）。
 * 系统功能（AI 助手 / 资料库）的钩子不经过贡献点，不在这份清单里。
 *
 *   - `preload` / `beforeQuit` / `memoryDump`：当前插件贡献数与标签；
 *   - `workspaceListeners`：`app.workspace-changed` 订阅者数量（含 AI 助手与第三方插件）。
 */
export function registerMiscIpc(): void {
  ipcMain.on('ping', () => logger.info('pong'))

  ipcMain.handle('app-lifecycle-hooks', () => ({
    preload: listContributions<AppHook>(APP_PRELOAD).map((h) => h.label),
    beforeQuit: listContributions<AppHook>(APP_BEFORE_QUIT).map((h) => h.label),
    memoryDump: listContributions<AppHook>(APP_RENDERER_MEMORY_DUMP).map((h) => h.label),
    workspaceListeners: appEventListenerCount(APP_EVENT_WORKSPACE_CHANGED)
  }))

  /**
   * 只读诊断：若干张表的行数（**白名单**，核心不含任何插件表名语义）。
   *
   * 为什么 core 里会有这个：物理卸载的验收要断言「卸载并清数据后 `music_folders` /
   * `music_tracks` 行数为 0」，而卸载之后该插件的通道已经注销，渲染层没有别的办法读库。
   * 这里只暴露「表名 → count」，表名由调用方给且必须在**调用点**的白名单里——core 自己
   * 不认识这些表的归属（`music_*` 是测试工装传进来的字符串，不是 core 的常量）。
   */
  ipcMain.handle('app-table-counts', async (_event, tables: unknown) => {
    if (!Array.isArray(tables)) throw new Error('app-table-counts 需要表名数组')
    const orm = await getOrm()
    const out: Record<string, number> = {}
    for (const table of tables) {
      if (typeof table !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
        throw new Error(`非法表名: ${String(table)}`)
      }
      // 表名已按标识符规则白名单化，无法注入；值一律走参数绑定
      const result = await orm.execute<{ count: string | number }>(
        sql.raw(`SELECT count(*)::int AS count FROM "${table}"`)
      )
      const row = (result as unknown as { rows: { count: string | number }[] }).rows?.[0]
      out[table] = Number(row?.count ?? 0)
    }
    return out
  })
}
