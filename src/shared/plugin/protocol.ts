/**
 * 插件系统的 IPC 通道常量 + plugin:// URL 工具 + 通道命名规范（三端共用）。
 *
 * 通道命名规范：
 * - 插件 invoke 通道：`plugin:<命名空间>:<channel>`，命名空间 = 插件 id 去掉开头的 `plugin.`
 *   段（plugin.demo → plugin:demo:*，内置 planner → plugin:planner:*），主进程权威校验、
 *   preload 白名单缓存；
 * - 主进程 → 渲染层的事件通道同规则命名（如 `plugin:planner:tasks-updated`），
 *   由插件在主进程 `ctx.registerEvent(...)` 声明后才进白名单；
 * - **core 自己的通道不进这个命名空间**（扁平名）——原先那批扁平插件通道
 *   （'todo-items-get-paginate' 等）已随四个内置插件迁走，core 现在只剩
 *   window-* / setting / provider-* / plugins-* / weather-* 等外壳能力；
 * - 管理通道为 kebab-case（plugins-*），与现有主进程风格一致。
 */

/** 主进程 → 渲染层：已启用插件通道清单推送（preload 更新本地白名单缓存） */
export const IPC_PLUGIN_CHANNELS_UPDATED = 'plugin-channels-updated'

/**
 * 渲染层 → 主进程：**同步**取一次当前通道清单（`ipcRenderer.sendSync`）。
 *
 * 为什么需要它：`IPC_PLUGIN_CHANNELS_UPDATED` 是推送（did-finish-load 补推），
 * 而渲染层的首个订阅（插件 Provider 的 useEffect）发生在页面脚本执行期——
 * 早于 did-finish-load，于是「首帧就订阅事件通道」必然撞上白名单还没到的竞态
 * （当时表现为 `window.api.plugin.on` 抛「插件通道未启用」；现在订阅只告警，
 * 但白名单没到就会刷出无意义的告警）。preload 在启动时用一次
 * 同步 IPC 取回权威清单，之后仍由推送增量刷新。
 */
export const IPC_PLUGIN_CHANNELS_SYNC = 'plugin-channels-sync'

/**
 * 渲染层 → 主进程：**同步**取一次插件启用清单（`ipcRenderer.sendSync`）。
 *
 * 为什么需要它（2026-09-26 用户实测报错「插件通道未启用: plugin:music:play-track」）：
 * 渲染层宿主在构造期会**同步预装载**内置插件（否则首帧没有路由/菜单），但它此前只能先按
 * manifest 默认值（内置=启用）装载，等异步 `plugins-list` 回来才把用户停用的插件卸掉。
 * 这个空窗期里被停用插件的 Provider 已经挂载并订阅事件通道，而主进程根本没装载它的通道
 * → preload 白名单拒绝订阅（当时直接抛错）→ 被 ErrorBoundary 接住（整页 RUNTIME ERROR）。
 * preload 在启动时用一次同步 IPC 取回权威启用态，渲染层即可**一开始就只装载启用的插件**。
 */
export const IPC_PLUGINS_LIST_SYNC = 'plugins-list-sync'

/** 主进程 → 渲染层：插件启停/安装/卸载后的状态广播 */
export const IPC_PLUGIN_STATE_CHANGED = 'plugin-state-changed'

export const IPC_PLUGINS_LIST = 'plugins-list'
export const IPC_PLUGINS_SET_ENABLED = 'plugins-set-enabled'
export const IPC_PLUGINS_INSTALL = 'plugins-install'

/** 从**本地路径**安装插件（`.zip` 压缩包或插件包目录；工装与拖入路径走它） */
export const IPC_PLUGINS_INSTALL_LOCAL = 'plugins-install-local'

/** 弹系统选择框挑一个本地来源（`'zip'` = 压缩包 / `'dir'` = 文件夹）并安装 */
export const IPC_PLUGINS_PICK_LOCAL = 'plugins-pick-local'

export const IPC_PLUGINS_UNINSTALL = 'plugins-uninstall'

/**
 * 渲染层 → 主进程：上报宿主 UI 表的「键 → 导出名」清单（单向 send，无返回值）。
 *
 * 为什么需要：插件渲染包的 `@host/**` 说明符被改写成 `plugin://host/ui.js?m=<key>`，
 * 桥模块由主进程按这份清单生成 ESM（`export const X = m["X"]`）——而 ESM 的具名导出
 * 必须静态写死，主进程无法反射渲染进程的模块命名空间。渲染层在启动最早期
 * （`installHostUi()`，早于任何插件渲染模块的 fetch）发一次即可。
 */
export const IPC_PLUGIN_HOST_UI_EXPORTS = 'plugin-host-ui-exports'

/**
 * 渲染层 → 主进程：查询当前已装载的插件**来自哪个文件**（只读诊断）。
 *
 * 用于验证「music 由磁盘包接管」而不是静态注册表：返回
 * `{ id: { source: 'package' | 'builtin' | 'absent', file?: string } }`。
 */
export const IPC_PLUGINS_LOADED_FROM = 'plugins-loaded-from'

/** 外部插件通道前缀校验正则（plugin:<命名空间>:...，命名空间允许字母数字 . _ -） */
export const PLUGIN_CHANNEL_RE = /^plugin:[A-Za-z0-9._-]+:/

/** 从通道名提取命名空间；非插件通道返回 null（注意：命名空间不含 id 开头的 `plugin.` 段） */
export function pluginIdFromChannel(channel: string): string | null {
  const m = /^plugin:([A-Za-z0-9._-]+):/.exec(channel)
  return m ? m[1] : null
}

/**
 * 从 `plugin://<id>/<relPath>?<query>` 解析出插件 id 与相对路径。
 *
 * 用 URL 解析而不是手写正则（2026-09-26 修复）：`plugin://host/ui.js?m=…` 这种带
 * **查询串**的写法里，`?m=…` 不属于路径，正则的 `(\/.*)?$` 会直接匹配失败（`?` 不在
 * 允许集合内）→ 协议处理器判成「非法 URL」/「找不到模块」，宿主 UI 桥整条链路 404。
 * URL 解析还顺带处理了 authority 段与百分号编码。
 */
export function parsePluginUrl(url: string): { id: string; relPath: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'plugin:') return null
  const id = parsed.hostname || parsed.pathname.replace(/^\/+/, '').split('/')[0] || ''
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null
  // `plugin://<id>/a/b.js` 里 hostname 就是 id、pathname 是 `/a/b.js`；
  // `plugin:///<id>/a/b.js`（无 authority）则要把 pathname 里的 id 段切掉。
  const rawPath = parsed.hostname
    ? parsed.pathname
    : parsed.pathname.replace(new RegExp(`^/+${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '')
  let relPath = rawPath
  try {
    relPath = decodeURIComponent(rawPath)
  } catch {
    // 编码非法：保留原文（下游会当成普通路径处理）
  }
  return { id, relPath: relPath.replace(/^\/+/, '') }
}

/** 插件文件 URL helper：plugin://<id>/<relPath> */
export function pluginUrl(id: string, relPath: string): string {
  return `plugin://${id}/${relPath.replace(/^\/+/, '')}`
}
