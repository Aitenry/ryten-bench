import { useSyncExternalStore } from 'react'

/**
 * 原生窗口标题（Windows 系统绘制的那条标题栏）的状态。
 *
 * 用户 2026-11-20 口径：标题要显示成 `当前内容 - RytenBench`，
 * 内容取决于当前选中的东西：插件名称、或模式（对话模式 / 工作模式 / 插件模式）、
 * 或系统页面（资料库 / 插件仓库）。
 *
 * 三类来源，优先级 plugin > route > harness：
 * - `plugin`：插件详情页等明确知道插件名的页面；
 * - `route`：系统页面（资料库 / 插件仓库 / 第三方插件路由）；
 * - `harness`：对话页内部的工作/对话/插件模式（由侧栏模式切换写入）。
 */
const APP_NAME = 'RytenBench'

type TitleSource = 'route' | 'harness' | 'plugin'

const parts: Record<TitleSource, string> = { route: '', harness: '', plugin: '' }

const resolve = (): string => {
  const part = (parts.plugin || parts.route || parts.harness || '').trim()
  return part ? `${part} - ${APP_NAME}` : APP_NAME
}

let current = resolve()
const listeners = new Set<() => void>()

function emit(): void {
  const next = resolve()
  if (next === current) return
  current = next
  listeners.forEach((listener) => listener())
}

/** 设置某一类来源的标题片段（空串表示不提供） */
export function setWindowTitleSource(source: TitleSource, part: string): void {
  const next = part.trim()
  if (parts[source] === next) return
  parts[source] = next
  emit()
}

export function getWindowTitle(): string {
  return current
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 组件里订阅当前窗口标题（变化时同步给主进程） */
export function useWindowTitle(): string {
  return useSyncExternalStore(subscribe, getWindowTitle, () => APP_NAME)
}
