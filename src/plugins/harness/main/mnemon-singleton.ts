import * as path from 'path'
import { buildMnemon, type MnemonComponent } from './runtime/mnemon/index'
import { chatScope, memoryScopeRoot, workspaceScope, type MemoryScope } from './memory-scope'
import { normalizeMemoryScope, pluginIdOfMemoryScope } from '../shared/memory-scope'

/**
 * Mnemon 进程级单例 — 按存储根缓存
 *
 * HarnessService 每次请求都会新建 Runtime，但记忆系统（PGlite 数据库、文件控制面）
 * 必须是跨请求共享的进程级组件。按 storageRoot 缓存，应用退出时统一关闭。
 *
 * 存储根按**记忆作用域**隔离（一套完整的记忆系统一个目录，见 memory-scope.ts）：
 *   <memoryPath>/workspace-<workspaceId>/mnemon/   工作模式的会话（按工作区）
 *   <memoryPath>/plugin-<pluginId>/mnemon/         插件会话（按插件，用户口径 2026-09-28）
 *   <memoryPath>/chat/mnemon/                      「对话」模式的会话（该模式没有工作区）
 * 与子代理记忆目录（同级的 sub-agents/）并列。不同作用域的热记忆 / 档案 / 记忆空间互不串扰。
 */

const instances = new Map<string, MnemonComponent>()

/**
 * 获取（或创建）记忆组件；未配置记忆目录返回 undefined。
 *
 * @param scopeRaw 渲染层带回来的作用域字符串（`plugin:<id>` / `chat`；空/非法 = 当前工作区）。
 *   口径解析统一走 shared/memory-scope 的 normalizeMemoryScope —— 「对话」模式必须走它，
 *   否则 `chat` 会被当成一个插件 id 变成 `<memoryPath>/plugin-chat/`。
 */
export function getMnemonComponent(
  memoryPath?: string,
  workspaceId = 0,
  scopeRaw?: string | null
): MnemonComponent | undefined {
  const normalized = normalizeMemoryScope(scopeRaw)
  const pluginId = pluginIdOfMemoryScope(normalized)
  const scope: MemoryScope = normalized
    ? pluginId
      ? { kind: 'plugin', pluginId }
      : chatScope()
    : workspaceScope(workspaceId)
  const root = memoryScopeRoot(memoryPath, scope)
  if (!root) return undefined
  const storageRoot = path.join(root, 'mnemon')
  const existing = instances.get(storageRoot)
  if (existing) return existing
  const component = buildMnemon(storageRoot)
  instances.set(storageRoot, component)
  return component
}

/** 关闭全部记忆组件（应用退出时调用） */
export async function closeAllMnemon(): Promise<void> {
  for (const component of instances.values()) {
    try {
      await component.close()
    } catch {
      // 关闭失败不阻塞退出
    }
  }
  instances.clear()
}

/** 供诊断：当前缓存的存储根 */
export function mnemonStorageRoots(): string[] {
  return [...instances.keys()]
}
