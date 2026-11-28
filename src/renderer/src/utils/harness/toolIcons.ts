import type { ComponentType, CSSProperties } from 'react'
import {
  RiBrain4Line,
  RiEye2Line,
  RiFileEditLine,
  RiFileTextLine,
  RiFolderOpenLine,
  RiFoldersLine,
  RiImageLine,
  RiListCheck,
  RiPencilLine,
  RiPlug2Line,
  RiSearchLine,
  RiShareLine,
  RiTerminalBoxLine
} from '@remixicon/react'

/**
 * Prefix fallback keys (tool families whose names are only known at runtime). The prefixes are
 * also registered in `TOOL_IN_PROGRESS_ICONS` (the key is the prefix itself), and `toolIconFor`
 * looks up in two levels: exact match → prefix match.
 */
export const MCP_TOOL_ICON_KEY = 'mcp__'
export const MNEMON_TOOL_ICON_KEY = 'mnemon_'

/**
 * Tool icon mapping (kept in a separate .ts: these are constants, and putting them in a component
 * file would trigger react-refresh/only-export-components).
 *
 * The semantic icon stays the same between the "in progress" (building arguments / running) and
 * the "completed" card, so the same tool looks like the same thing in both states.
 */
export const TOOL_IN_PROGRESS_ICONS: Record<
  string,
  ComponentType<{
    size?: number | string
    color?: string
    className?: string
    style?: CSSProperties
  }>
> = {
  read_file: RiEye2Line,
  read_image: RiImageLine,
  apply_patch: RiFileEditLine,
  write_file: RiFileEditLine,
  edit_file: RiPencilLine,
  ls: RiFolderOpenLine,
  glob: RiSearchLine,
  grep: RiSearchLine,
  execute: RiTerminalBoxLine,
  write_todos: RiListCheck,
  read_todos: RiListCheck,
  // Materials organization: domain tools behind one selectable entry (materials-tools).
  // Documents are split by intent (search / read / write / edit).
  // `manage_materials` is kept as a legacy alias for tool calls recorded before the 2026-11-28 split.
  materials_docs_search: RiSearchLine,
  materials_docs_read: RiFileTextLine,
  materials_docs_write: RiFileEditLine,
  materials_docs_edit: RiPencilLine,
  materials_todos_search: RiSearchLine,
  materials_todos_read: RiListCheck,
  materials_todos_write: RiFileEditLine,
  materials_todos_edit: RiPencilLine,
  materials_wikis: RiFoldersLine,
  materials_graph: RiShareLine,
  'materials-tools': RiFoldersLine,
  manage_materials: RiFoldersLine,
  // Prefix fallbacks: external MCP tools (plug) and Mnemon memory tools (brain) — names are only known at runtime
  [MCP_TOOL_ICON_KEY]: RiPlug2Line,
  [MNEMON_TOOL_ICON_KEY]: RiBrain4Line
}

/**
 * Get an icon by tool name: exact match first, then fall back on a known prefix (MCP / Mnemon);
 * returns undefined when unrecognised.
 *
 * Callers must treat undefined as "show no icon" — rendering an undefined component blanks the
 * whole message (see the comment in AssistantMessage and the regression harness).
 */
export function toolIconFor(
  name: string
): ComponentType<{ size?: number | string; color?: string; style?: CSSProperties }> | undefined {
  const exact = TOOL_IN_PROGRESS_ICONS[name]
  if (exact) return exact
  for (const prefix of [MCP_TOOL_ICON_KEY, MNEMON_TOOL_ICON_KEY]) {
    if (name.startsWith(prefix)) return TOOL_IN_PROGRESS_ICONS[prefix]
  }
  return undefined
}

/** Icons for completed-state cards (grouped by semantics) */
export const TOOL_CARD_ICONS: Record<
  'file' | 'dir' | 'search' | 'command',
  ComponentType<{ size?: number | string; style?: CSSProperties }>
> = {
  file: RiEye2Line,
  dir: RiFolderOpenLine,
  search: RiSearchLine,
  command: RiTerminalBoxLine
}

/** Human-readable byte count (meta info on the right of the card) */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
