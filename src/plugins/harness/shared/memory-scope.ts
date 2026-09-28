/**
 * 记忆作用域的**字符串口径**（跨进程 DTO）：`plugin:<插件 id>` = 这份插件自己的记忆，
 * 空 = 跟当前工作区走。
 *
 * 为什么单独一个文件：这个字符串要同时被三处读懂——
 *  - 主进程落库（`harness_topic.memory_scope`，见 `main/db/mapper/harness.ts`）；
 *  - 主进程取记忆组件（`main/ipc/mnemon.ts` 把渲染层传回来的作用域翻成插件 id）；
 *  - 渲染层（侧栏记忆块与设置 → 记忆页按它决定「读谁的记忆」，见 `renderer/memory-scope.ts`）。
 *
 * 目录名（`plugin-<id>` / `workspace-<id>`）与路径拼接只在主进程做（`main/memory-scope.ts`），
 * 这个文件里**没有任何 path 逻辑**：渲染层拿到的东西永远只是一段可校验的字符串。
 */

/** 插件作用域前缀（改这里就等于改全链路口径） */
export const PLUGIN_SCOPE_PREFIX = 'plugin:'

/**
 * 插件 id → 作用域字符串；空 id 返回 null（= 工作区作用域）。
 *
 * 不做路径消毒：id 里的路径分隔符由主进程 `memoryScopeDirName` 统一换成 `-`，
 * 在渲染层提前改写会让「界面上显示的 id」和「目录名」对不上。
 */
export function pluginMemoryScope(pluginId: unknown): string | null {
  if (typeof pluginId !== 'string') return null
  const id = pluginId.trim()
  return id ? `${PLUGIN_SCOPE_PREFIX}${id}` : null
}

/** 作用域字符串 → 插件 id；工作区作用域 / 空 / 非法 / 老数据一律 null */
export function pluginIdOfMemoryScope(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith(PLUGIN_SCOPE_PREFIX)) return null
  const pluginId = raw.slice(PLUGIN_SCOPE_PREFIX.length).trim()
  return pluginId || null
}
