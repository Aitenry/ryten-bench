import type React from 'react'
import type { MessageInstance } from 'antd/es/message/interface'
import type { LockUnlockResult } from './settings'

/**
 * Component props / context types shared by core.
 *
 * Ownership: **plugin-specific props do not belong here** — a reverse import of plugin types from
 * core would blur the "plugins are disableable" boundary. The notes props (`GraphViewProps` /
 * `GraphCanvasProps` / `GraphToolbarProps` / `EntityDetailProps` / `BuildProgressProps` /
 * `WikiEditModalProps` / `WikiCardProps` / `DocPreviewModalProps` / `TodoListProps`) all live in
 * `src/renderer/src/types/notes.ts`; the graph build progress Provider props moved along with the
 * plugin as well.
 *
 * Cleanup in core: removed types that no longer have consumers (`StatusOption` / `SidebarProps` /
 * `MainRoutesProps` / `WeatherData`+`WorkTimeData`+`CardItemProps` — the bottom bar weather card
 * and the sidebar/routes each define their props locally).
 *
 * What remains here is what the shell and shared UI genuinely use together: markdown rendering,
 * the lock screen, the message context, and the model Provider options (shared by the graph
 * settings page and the harness agent settings page).
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
  /** Submit the 6-digit unlock code; validation happens in the main process (salted scrypt + failure backoff), returning the failure reason / remaining attempts */
  onUnlock: (password: string) => Promise<LockUnlockResult>
}

/* ── Sidebar ── */

/* Sidebar props are defined locally in `components/system/frame/Sidebar.tsx` (private, not shared). */

/* ── Route ── */

/* Route props are defined locally in `route/MainRoutes.tsx` (private, not shared). */

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

/* ── Settings (model Provider options: shared by the graph settings page and the harness agent settings page) ── */

export interface ProviderOption {
  id: number
  name: string
  model: string
  provider: string
  metadata: Record<string, unknown> | null
}
