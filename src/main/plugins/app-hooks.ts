/**
 * 应用级生命周期钩子的**宿主契约**（主进程侧，core 所有）。
 *
 * 为什么要有它：core 的应用流程里有几个固定时机需要「插件也参与」——
 * 加载页预取数据、退出前释放资源、渲染进程崩溃时落内存快照、工作区切换后重启监听。
 * 这些动作的实现都在插件里（例如 `preloadHarnessData` / `closeAllMnemon` 属 harness），
 * 但时机属于 core。若 core 直接 `import` 插件模块，插件就不再是可停用的内容，
 * 而是长在壳上的代码（core 收尾要消除的正是这种依赖）。
 *
 * 做法：**复用多值贡献点**（`src/main/plugins/contributions.ts`），不为每处各造一套机制。
 * - `APP_PRELOAD` / `APP_BEFORE_QUIT` / `APP_RENDERER_MEMORY_DUMP` 是多值贡献点：
 *   插件在 `install(ctx)` 里 `ctx.contribute(KEY, hook)`，core 在固定时机
 *   `listContributions<AppHook>(KEY)` 后逐个执行（每个都单独 try/catch，单个插件失败不影响其他）；
 * - 贡献随 `ctx.dispose()` 摘除 ⇒ **停用插件后钩子不再执行**（本轮的验收点之一）；
 * - 工作区切换等「core 主动通知」的时机用事件总线（`app-events.ts`）：
 *   插件 `ctx.effect(() => onAppEvent(KEY, handler))` 订阅，效果随插件回滚。
 *
 * 注意：这些键只描述「谁在什么时机被调用」，不描述插件身份——core 因此完全不认识插件。
 */

/**
 * 钩子：`label` 只用于日志，`run` 是插件自己的动作（可异步）。
 *
 * `run` 的入参按贡献点不同而不同：`app.renderer-memory-dump` 收到
 * `(reason, exitCode)`（渲染进程退出原因），其余钩子忽略入参——
 * 类型上统一成 optional，调用方按需传、实现方按需声明。
 */
export interface AppHook {
  run: (reason?: string, exitCode?: number) => void | Promise<void>
  label: string
}

/** 加载页：应用初始化完成后、主窗口交接前的预取时机（可多插件贡献） */
export const APP_PRELOAD = 'app.preload'

/** 退出前：core 的 before-quit 清理阶段（支持异步，逐个等待并 catch） */
export const APP_BEFORE_QUIT = 'app.before-quit'

/** 渲染进程异常退出（崩溃/OOM）时落诊断快照的时机 */
export const APP_RENDERER_MEMORY_DUMP = 'app.renderer-memory-dump'

/**
 * core → 插件的应用事件名（主进程内，与渲染层宿主事件总线无关）。
 * 载荷见 `AppWorkspaceChangedPayload`；消费方按需读取，不必依赖载荷。
 */
export const APP_EVENT_WORKSPACE_CHANGED = 'app.workspace-changed'

/**
 * 卸载时用户勾选了「清除本机数据」，且插件的 `plugin.purge` 已执行。
 *
 * **只代表本机数据被清**：云端安装记录/数据快照保留（用户 2026-11-23 口径）。
 * 插件中心（`lattice/sync`）借此丢掉本地 `data_rev` 缓存，这样下次 pull 才会
 * 把云端数据重新写回本机（否则本地 rev 还停在旧值，会误以为「已经是最新」）。
 */
export const APP_EVENT_PLUGIN_DATA_PURGED = 'app.plugin-data-purged'

/** `app.plugin-data-purged` 载荷 */
export interface AppPluginDataPurgedPayload {
  pluginId: string
}

/** `app.workspace-changed` 载荷：切换后的活动工作区（未配置时为 null） */
export interface AppWorkspaceChangedPayload {
  /** 活动工作区 id（未配置 = null） */
  workspaceId: number | null
  /** 活动工作区绝对路径（未配置 = 空串） */
  workspacePath: string
}
