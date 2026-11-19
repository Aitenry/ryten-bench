import type { ComponentType, CSSProperties } from 'react'
import {
  RiBrain4Line,
  RiEye2Line,
  RiFileEditLine,
  RiFolderOpenLine,
  RiListCheck,
  RiPencilLine,
  RiPlug2Line,
  RiSearchLine,
  RiTerminalBoxLine
} from '@remixicon/react'

/**
 * 前缀兜底键（名字运行期才知道的工具族）。前缀同时登记进 `TOOL_IN_PROGRESS_ICONS`
 * （键就是前缀本身），`toolIconFor` 按「精确命中 → 前缀命中」两级查找。
 */
export const MCP_TOOL_ICON_KEY = 'mcp__'
export const MNEMON_TOOL_ICON_KEY = 'mnemon_'

/**
 * 工具图标映射（单独放 .ts：这些是常量，放在组件文件里会触发
 * react-refresh/only-export-components）。
 *
 * 语义图标在「进行中」（参数构建中/执行中）与「完成态」卡片上保持一致，
 * 让同一个工具在两种状态下看着是同一个东西。
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
  write_file: RiFileEditLine,
  edit_file: RiPencilLine,
  ls: RiFolderOpenLine,
  glob: RiSearchLine,
  grep: RiSearchLine,
  execute: RiTerminalBoxLine,
  write_todos: RiListCheck,
  read_todos: RiListCheck,
  // 前缀兜底：MCP 外部工具（插头）与 Mnemon 记忆工具（大脑）——名字运行期才知道
  [MCP_TOOL_ICON_KEY]: RiPlug2Line,
  [MNEMON_TOOL_ICON_KEY]: RiBrain4Line
}

/**
 * 按工具名取图标：先精确匹配，再按已知前缀兜底（MCP / Mnemon），认不出返回 undefined。
 *
 * 调用方必须按「不摆图标」处理 undefined——渲染 undefined 组件会整条消息白屏
 * （见 AssistantMessage 的注释与回归工装）。
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

/** 完成态卡片图标（按语义分类） */
export const TOOL_CARD_ICONS: Record<
  'file' | 'dir' | 'search' | 'command',
  ComponentType<{ size?: number | string; style?: CSSProperties }>
> = {
  file: RiEye2Line,
  dir: RiFolderOpenLine,
  search: RiSearchLine,
  command: RiTerminalBoxLine
}

/** 人类可读字节数（卡片右侧元信息） */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
