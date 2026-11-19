import type { MessageBlock, ToolCall } from '../shared/types'

/**
 * harness 插件的渲染层类型：**纯前端**的视图模型与展示形状。
 *
 * 跨进程 DTO（消息块 / 工具卡片 / 各运行时视图行）在 `../shared/types.ts`——
 * 这里的类型只在渲染进程里构造与消费，不会经 IPC 传输，也不会落库。
 */

/** 聊天消息（渲染端的会话模型：由库内的对话行 + 流式 chunk 组装而成） */
export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  blocks: MessageBlock[]
  timestamp: number
  toolCalls?: ToolCall[]
  loading?: boolean
  reasoning_content?: string
  /** 最后收到流式 chunk 的时间戳（渲染端瞬时字段，不落库；供静默指示判定） */
  lastChunkAt?: number
  /**
   * 该条助手消息在库里的对话行 id。
   * 流式期间消息用的是临时 id，主进程保存后随 harness-stream-done 回传并写回这里，
   * 用量行（harness_dialogue_usage.dialogue_id）靠它对上号，无需重新加载会话。
   */
  dialogueId?: number
  /**
   * 「最终答复」在本条消息 `blocks` 数组里的下标集合（协议层真源，渲染端只读不猜）。
   *
   * - `Set`：这些块是本轮的答复，渲染在任务折叠之外常显；
   * - `null`：主进程明确说本轮没有答复（中止 / 只有工具与思考），或已撤回标记；
   * - `undefined`：主进程没给结论（旧版本或异常路径）——保留旧的「整轮结束再摘」行为。
   *
   * 来源见 main/service/answer-boundary.ts 与主进程下发的 `answer` chunk。
   */
  answer?: Set<number> | null
}

/** 附件（渲染端持有 dataUrl，不落库） */
export interface Attachment {
  dataUrl: string
  fileName: string
  isImage: boolean
}

/**
 * 工具清单行（`plugin:harness:harness-get-tools` 的返回形状）。
 *
 * 主进程按 `mainMessages().tools` 的文案字典给每个工具补 `label`，`icon`/`color` 是设置页
 * 下拉项的展示元数据。原先借用 core 的 `resource/types/window` 里的 `ToolInfo`，
 * 那其实是 window/api 类型表里的遗留副本，随本轮收进插件自己的渲染层类型。
 */
export interface HarnessToolInfo {
  name: string
  label: string
  description: string
  icon: string
  color: string
}
