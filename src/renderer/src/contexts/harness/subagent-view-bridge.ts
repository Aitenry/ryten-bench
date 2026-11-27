import { createContext, useContext } from 'react'

/**
 * 从消息流打开「后台子代理会话视图」的桥。
 *
 * 背景：主对话里 task(background=true) 的「已派发」轻量卡只有名称、简述与会话 id；
 * 用户要回看它的完整流式会话，除了顶部栏入口，点这张卡也应该能直接进同一个视图。
 *
 * 为什么用 Context 而不是给 AssistantMessage 加回调 props：
 * - AssistantMessage 对每个 block 有渲染缓存（WeakMap，key = block 对象身份），
 *   函数 props 不在缓存 key 里；如果做成 props，缓存命中时可能拿不到最新回调
 *   （与 contexts/harness/workspace-bridge.ts 记录的是同一个坑）。
 * - 页面级桥对象用 useMemo 固定引用，block 渲染期直接 useContext 永远拿到最新实现，
 *   且不影响缓存命中率。
 */
export interface SubagentViewBridge {
  /** 按会话 id 打开该后台子代理的流式会话视图（agentId 形如 subagent-1） */
  openSubagent: (agentId: string) => void
}

export const SubagentViewContext = createContext<SubagentViewBridge | null>(null)

/** 读取桥；不在 Harness 页内时返回 null（消息卡片退化为不可点） */
export const useSubagentViewBridge = (): SubagentViewBridge | null =>
  useContext(SubagentViewContext)
