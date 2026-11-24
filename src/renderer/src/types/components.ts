import type React from 'react'
import type { MessageInstance } from 'antd/es/message/interface'
import type { LockUnlockResult } from './settings'

/**
 * core 共享的组件 props / 上下文类型。
 *
 * 归属划分：**插件自己的 props 不放这里**——core 反向 import 插件类型会让
 * 「插件可停用」的边界失真。notes 的 props（`GraphViewProps` / `GraphCanvasProps` /
 * `GraphToolbarProps` / `EntityDetailProps` / `BuildProgressProps` / `WikiEditModalProps` /
 * `WikiCardProps` / `DocPreviewModalProps` / `TodoListProps`）都在
 * `src/renderer/src/types/notes.ts`；图谱构建进度的 Provider props 也随插件收走。
 *
 * core 收尾清理：删掉已无消费方的类型（`StatusOption` / `SidebarProps` / `MainRoutesProps` /
 * `WeatherData`+`WorkTimeData`+`CardItemProps`——底栏天气卡与侧栏/路由各自就地定义 props）。
 *
 * 留在这里的是外壳与共享 UI 真正共用的部分：markdown 渲染、锁屏、消息上下文，
 * 以及模型 Provider 选项（图谱设置页与 harness 智能体设置页共用）。
 */

/* ── Markdown ── */

export interface MarkdownViewProps {
  content: string
  isDarkMode?: boolean
}

export interface HeadingItem {
  id: string
  level: number
  text: string
  children: HeadingItem[]
}

export interface TocItemProps {
  item: HeadingItem
  isDarkMode?: boolean
  expandedIds: Set<string>
  onToggle: (id: string) => void
  onNavigate: (id: string) => void
}

export interface TableOfContentsProps {
  headings: HeadingItem[]
  isDarkMode?: boolean
  onNavigate: (id: string) => void
}

/* ── Lock Screen ── */

export interface LockScreenProps {
  /** 提交 6 位解锁码；校验在主进程完成（加盐 scrypt + 失败退避），返回失败原因/剩余尝试次数 */
  onUnlock: (password: string) => Promise<LockUnlockResult>
}

/* ── Sidebar ── */

/* 侧栏的 props 就地定义在 `components/system/frame/Sidebar.tsx`（自用，不外借）。 */

/* ── Route ── */

/* 路由 props 就地定义在 `route/MainRoutes.tsx`（自用，不外借）。 */

/* ── Provider / Context ── */

export interface MessageContextType {
  messageApi?: MessageInstance
  viewMessage: (
    key: string,
    type: 'loading' | 'success' | 'info' | 'warning' | 'error',
    content: string,
    duration?: number
  ) => void
}

export interface MessageProviderProps {
  children: React.ReactNode
}

/* ── Settings（模型 Provider 选项：图谱设置页与 harness 智能体设置页共用） ── */

export interface ProviderOption {
  id: number
  name: string
  model: string
  provider: string
  metadata: Record<string, unknown> | null
}
