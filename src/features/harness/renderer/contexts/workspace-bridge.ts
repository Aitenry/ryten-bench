import { createContext, useContext } from 'react'
import type { ToolCardKind } from '../../shared/types'

/**
 * 聊天 → 右侧工作区面板的桥。
 *
 * 为什么用 Context 而不是继续往下传 props：工具卡片渲染在 AssistantMessage 的
 * **块级渲染缓存**里（见 AssistantMessage.renderBlockAt：按块对象身份缓存 React 元素，
 * 缓存键只有主题/语言/颜色这些）。如果把回调当 props 传下去，回调换了身份也进不了
 * 缓存键，缓存里的旧节点会一直持有旧闭包（这是本项目踩过的坑）。放在 Context 里、
 * 由卡片组件自己订阅，就不存在这个失配：回调永远取到最新值，也不影响块缓存命中率。
 */

export interface ToolDetailRequest {
  /** 话题 id（主进程按 topicId + callId 定位结果详情） */
  topicId: number
  /** 工具调用 id（tool.id） */
  callId: string
  /** 卡片语义分类：决定详情页签的呈现方式 */
  kind: ToolCardKind
  /** 页签名（命令 / 模式 / 路径）与页签内标题 */
  title: string
  /** execute：退出码 */
  exitCode?: number
  /** 结果是否被截断（详情页签给出提示） */
  truncated?: boolean
  /** 命中数量等附加说明 */
  summary?: string
}

export interface WorkspaceBridge {
  /** 打开虚拟路径指向的文件（read_file / write_file / edit_file 卡片） */
  openFile: (virtualPath: string) => void
  /**
   * 在右侧资源管理器中定位目录（ls 卡片）。
   * 返回是否已定位——路径不在工作区内（如 /memories/...）时返回 false，卡片据此退回详情页签。
   */
  revealPath: (virtualPath: string) => boolean
  /** 打开工具结果详情页签（glob / grep / execute 卡片） */
  openToolDetail: (request: ToolDetailRequest) => void
}

export const WorkspaceBridgeContext = createContext<WorkspaceBridge | null>(null)

/** 取桥；未挂载 Provider 时返回 null（卡片仍可渲染，只是不可点击） */
export function useWorkspaceBridge(): WorkspaceBridge | null {
  return useContext(WorkspaceBridgeContext)
}
