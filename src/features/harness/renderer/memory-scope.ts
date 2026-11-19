import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  isChatScope,
  normalizeMemoryScope,
  pluginIdOfMemoryScope
} from '../shared/memory-scope'
import { harnessApi } from './api'

/**
 * 当前会话的记忆作用域（渲染层共享的极简 store）。
 *
 * 为什么放在模块级单例里而不是走 props / Context：同一个作用域有**两个读取方**——
 * 侧栏底部的「记忆」块（在 HarnessProvider 之下，拿得到 props）和 设置 → 记忆页
 * （由宿主的设置弹窗渲染，不在插件 Provider 之下，拿不到任何 props）。两边必须显示同一份
 * 记忆，所以值放在这里，各自订阅（用户口径 2026-09-28「插件的记忆，并没有像工作里面的
 * 记忆一样显示在侧边栏」+「设置 → 记忆页跟着同一个作用域」）。
 *
 * 值的口径与主进程完全一致：`harness_topic.memory_scope` 的字符串形态
 * （`plugin:<插件 id>` / `chat`），null = 跟当前工作区走（见 shared/memory-scope.ts）。
 * 写入方是 useHarnessHandlers：切会话 → 用话题行上存的作用域；插件行 /「对话」模式点 ＋
 * （还没有话题）→ 用挂起的作用域。
 */
let scope: string | null = null
const listeners = new Set<() => void>()

/** 当前会话的记忆作用域（供非 React 场景/回调里读） */
export function getMemoryScope(): string | null {
  return scope
}

/** 设置当前会话的记忆作用域（非法值 / 插件 id 为空一律归零 = 工作区） */
export function setMemoryScope(next: string | null): void {
  const normalized = normalizeMemoryScope(next)
  if (normalized === scope) return
  scope = normalized
  for (const listener of listeners) listener()
}

function subscribeScope(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 订阅当前会话的记忆作用域 */
export function useMemoryScope(): string | null {
  return useSyncExternalStore(subscribeScope, getMemoryScope)
}

/** 当前作用域指向的插件 id（工作区作用域 / 「对话」模式 = null） */
export function useMemoryPluginId(): string | null {
  return pluginIdOfMemoryScope(useMemoryScope())
}

/** 当前作用域是不是「对话」模式的（设置 → 记忆页据此标注） */
export function useIsChatScope(): boolean {
  return isChatScope(useMemoryScope())
}

/**
 * 当前作用域的**显示名**：
 * - 插件作用域 → 插件草稿的展示名（拿不到就退回 id）；
 * - 「对话」模式 → `chatName`（调用方给译文，见 设置 → 记忆页）；
 * - 工作区作用域 → null。
 *
 * 只有 设置 → 记忆页 用它（侧栏那一行**不标作用域**：用户口径 2026-09-28「不需要
 * （记忆 · 个人记账台账）这个内容」——那块本来就在会话侧，读哪一套由当前会话决定）。
 * 名字一律取插件自己的名字（用户口径 2026-09-26「要用 mcp 的名称」同一套：条目/选项/分组
 * 都用真实名称，不写笼统的类别名）。草稿改名（workshop-changed 广播）后跟着刷新。
 */
export function useMemoryScopeName(chatName: string): string | null {
  const pluginId = useMemoryPluginId()
  const [name, setName] = useState<string | null>(null)

  useEffect(() => {
    if (!pluginId) {
      setName(null)
      return
    }
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const drafts = await harnessApi.workshop.list()
        if (alive) setName(drafts.find((draft) => draft.id === pluginId)?.title ?? pluginId)
      } catch {
        // 工坊没接线（例如插件刚停用）：退回 id，至少让人知道这份记忆属于谁
        if (alive) setName(pluginId)
      }
    }
    void load()
    const off = harnessApi.workshop.onChanged(() => void load())
    return () => {
      alive = false
      off()
    }
  }, [pluginId])

  // 「对话」模式的记忆是**整个模式共用**的一份，没有名字可取，用调用方给的译文
  return useIsChatScope() ? chatName : name
}
