import type { BaseNotification } from '@renderer/types/notification'

/**
 * 图谱构建进度的上下文与状态类型（notes 插件）。
 *
 * 归属（core 收尾轮）：这块原先在 core 的 `src/renderer/src/{providers,types,hooks}`，
 * 是外壳唯一「硬编码插件通道名」的地方（三个 `plugin:notes:graph-build-*`）。
 * 现在整体收进插件的 renderer：Provider / Context / useBuildProgress / 状态类型
 * 与进度弹窗同一个插件，订阅的是**本插件自己的通道**（`renderer/api.ts`），
 * 停用 notes 时 Provider 随之卸载——core 不再认识任何插件通道名。
 *
 * 通知中心（`useNotification`）是 core 服务，插件可以 import；因此构建进度仍会
 * 写进外壳的铃铛里（通知项类型见下方 `BuildProgressNotification`）。
 */

/** 通知点击「直达图谱」：外壳内的事件名（插件内派发/监听，避免 core 认识插件语义） */
export const OPEN_WIKI_GRAPH_EVENT = 'open-wiki-graph'

/** 构建进度上下文：进度弹窗与图谱视图（都在本插件内）经它交换状态 */
export interface BuildProgressContextType {
  /** 当前所有构建的状态（含已完成/已收起，由消费方自行过滤） */
  builds: BuildProgressState[]
  startBuild: (wikiId: number, wikiTitle: string) => void
  restoreBuild: (wikiId: number) => void
  /** 收起进度弹窗（仅改 minimized，不删状态） */
  minimizeBuild: (wikiId: number) => void
  navigateToGraph: (wikiId: number) => void
  subscribeToRefresh: (wikiId: number, callback: () => void) => () => void
}

/** 构建进度状态 */
export interface BuildProgressState {
  wikiId: number
  wikiTitle: string
  phase: string
  phaseLabel: string
  phaseProgress: number
  overallProgress: number
  processedDocs: number
  totalDocs: number
  processedChunks: number
  totalChunks: number
  entityCount: number
  relationCount: number
  message: string
  minimized: boolean
  completed: boolean
}

/**
 * 图谱构建进度通知（写进 core 通知中心的载荷）。
 *
 * 类型留在插件里：`NotificationItem` 在 core 只保留通用字段（字符串判别式 +
 * 可选扩展字段），通知列表按字段名渲染，因此插件不需要把自己的类型塞回 core。
 */
export interface BuildProgressNotification extends BaseNotification {
  type: 'build_progress'
  wikiId: number
  wikiTitle: string
  phaseLabel: string
  phaseProgress: number
  overallProgress: number
  entityCount: number
  relationCount: number
  message: string
  completed: boolean
  minimized: boolean
}
