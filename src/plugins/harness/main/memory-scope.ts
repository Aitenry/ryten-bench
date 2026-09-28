import * as path from 'path'

/**
 * 记忆作用域：一套记忆（热记忆 USER.md / MEMORY.md + 档案 + 记忆空间）落在哪个目录。
 *
 * 两种：
 * - `workspace`：工作模式的会话，按工作区隔离 —— `<memoryPath>/workspace-<id>/`（既有口径）；
 * - `plugin`：从插件行「＋ 新建会话」开出来的会话，按**插件**隔离 —— `<memoryPath>/plugin-<插件 id>/`。
 *
 * 为什么要分（用户口径 2026-09-28「插件里面的记忆应该是独立的，现在是直接使用工作里面之前选中的
 * 记忆上下文，会导致有问题」）：插件会话是「做插件」的上下文，跟工作记忆混在一起两边都会脏——
 * 助手在插件会话里记下的东西不该进工作记忆，工作记忆也不该主导插件会话。
 *
 * 作用域存进 `harness_topic.memory_scope`（`plugin:<id>`；工作区留空 = 默认），
 * 因此**重开会话仍然用它自己的记忆**，不依赖渲染层记得住。
 */
export type MemoryScope =
  { kind: 'workspace'; workspaceId: number } | { kind: 'plugin'; pluginId: string }

/** 工作区作用域（最常用，给个短名字） */
export function workspaceScope(workspaceId: number): MemoryScope {
  return { kind: 'workspace', workspaceId }
}

/** 插件作用域 */
export function pluginScope(pluginId: string): MemoryScope {
  return { kind: 'plugin', pluginId }
}

/**
 * 作用域目录名（`workspace-<id>` / `plugin-<id>`）。
 *
 * 插件 id 正常是小写 kebab（工坊建草稿时就校验过），这里**再兜一层**：把路径分隔符、
 * 上跳、冒号等一律换成 `-`，绝不允许靠 id 跳出 `memoryPath`（记忆目录是模型可写的挂载点）。
 */
export function memoryScopeDirName(scope: MemoryScope): string {
  if (scope.kind === 'plugin') {
    const safe = String(scope.pluginId ?? '')
      .trim()
      .replace(/[^A-Za-z0-9._-]/g, '-')
    return `plugin-${safe || 'unknown'}`
  }
  return `workspace-${scope.workspaceId}`
}

/** 作用域根目录（未配置记忆目录时 undefined） */
export function memoryScopeRoot(
  memoryPath: string | undefined,
  scope: MemoryScope
): string | undefined {
  if (!memoryPath) return undefined
  return path.join(memoryPath, memoryScopeDirName(scope))
}

/** 存进 `harness_topic.memory_scope` 的字符串；工作区作用域存 null（老数据不用回填） */
export function serializeMemoryScope(scope: MemoryScope): string | null {
  return scope.kind === 'plugin' ? `plugin:${scope.pluginId}` : null
}

/** 解析 `harness_topic.memory_scope`（空 / 非法 / 老数据 → 工作区作用域） */
export function parseMemoryScope(raw: unknown, workspaceId: number): MemoryScope {
  if (typeof raw === 'string' && raw.startsWith('plugin:')) {
    const pluginId = raw.slice('plugin:'.length).trim()
    if (pluginId) return pluginScope(pluginId)
  }
  return workspaceScope(workspaceId)
}

/** 该作用域是否独立于工作区（给日志/界面用的判断） */
export function isPluginScope(scope: MemoryScope): boolean {
  return scope.kind === 'plugin'
}
