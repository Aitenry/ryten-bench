import type { TurnFinal } from './service/answer-boundary'

export interface HarnessOptions {
  images?: string[]
  documents?: { fileName: string; filePath: string }[]
  /** 话题 ID，HarnessService 内部会根据此 ID 从数据库加载历史对话 */
  topicId?: number
  /** 用于取消流式输出的 AbortSignal */
  signal?: AbortSignal
  /** 本轮来源元信息（目标系统 authority 校验用；用户消息为空缺省，自动续跑轮由驱动器注入） */
  turnMeta?: TurnMeta
  /** 摘要压缩开始回调：历史超长触发 LLM 压缩时立即调用（前端展示「压缩中」过渡卡） */
  onCompactionStart?: () => void
  /** 摘要压缩模型请求自动重试回调（第 attempt/retries 次；IPC 层据此推送「正在重试」过渡 chunk） */
  onCompactionRetry?: (attempt: number, retries: number) => void
  /** 历史上下文字符预算（由当前模型上下文窗口换算，最小 60,000；缺省用默认值） */
  contextBudget?: number
  /**
   * 回合内插话（steering）：图内每个工具节点执行前调用一次，把用户排队中点
   * 「立即插话」的消息并入运行中的上下文（排在本次工具结果之后），模型下一步即可读到。
   * 落库、段落切分与 steered chunk 下发都由这个回调内部一并完成（IPC 层提供）。
   * 未配置 = 关闭插话注入（子代理与非流式路径不传）。
   */
  drainInjections?: () => Promise<AgentInjection[] | null>
}

/** 一次「立即插话」注入的载荷（纯注入：只有正文，不落库、不产生对话内容） */
export interface AgentInjection {
  /** 插话正文 */
  text: string
}

/** 本轮来源元信息（经图 configurable 注入工具层，供目标工具做执行期权限校验） */
export interface TurnMeta {
  /** 来源：user=用户直接发起的轮次（缺省）；goal-round=目标自动续跑轮 */
  source?: 'user' | 'goal-round'
  /** goal-round 时携带的目标身份（精确匹配当前目标轮才有 complete/blocked 权威） */
  goalId?: string
  goalRevision?: number
  goalRound?: number
  /** goal-round 时的目标描述（前端横幅展示用） */
  objective?: string
}

export interface HarnessMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/** 工具卡片语义分类：决定前端图标、元信息与「点击后打开什么」 */
export type ToolCardKind = 'file' | 'dir' | 'search' | 'command'

/**
 * 工具定制化卡片数据（内置文件/命令工具专用）。
 *
 * 设计前提：这些工具的结果**不再随 IPC 下发、也不再落库**（见 service/tool-presentation.ts），
 * 前端只拿到这张卡片；要看内容就点卡片，去右侧面板打开真实文件或结果详情。
 * 因此卡片必须自带足够的元信息（路径、行数、条目数、退出码、失败原因）。
 */
export interface ToolCard {
  /** 卡片语义分类 */
  kind?: ToolCardKind
  /** 文件/目录路径（read_file / write_file / edit_file / ls） */
  path?: string
  /** 搜索模式（glob / grep） */
  pattern?: string
  /** 结果数量（ls / glob / grep） */
  count?: number
  /** 执行命令（execute） */
  command?: string
  /** 结果状态；error 时卡片显示失败原因 */
  status?: 'ok' | 'error'
  /** 失败原因 / 结果摘要（已截断，仅供单行展示） */
  message?: string
  /** read_file：文件总行数 */
  lines?: number
  /** read_file / execute：结果字符数 */
  chars?: number
  /** read_file：输出被内联上限截断（文件比这里显示的长） */
  truncated?: boolean
  /** read_file：按 offset/limit 读取时的行区间（1 基，闭区间） */
  range?: { start: number; end: number; total: number }
  /** write_file：写入字节数 */
  bytes?: number
  /**
   * write_file / edit_file：本次落盘新增的行数（差异规模；与改动记录同源）。
   *
   * 用户在聊天里看到的必须是「这个文件到底变了多少」，而不只是「替换了几处」：
   * 一次 replace_all 可能替换 3 处却动了 40 行。缺失 = 拿不到可靠数字（老数据、写失败），
   * 卡片宁可什么都不显示，也不用 0 冒充。
   */
  added?: number
  /** write_file / edit_file：本次落盘删除的行数 */
  removed?: number
  /** ls：子目录数 */
  dirs?: number
  /** ls / glob：文件数 */
  files?: number
  /** grep：命中的文件数（去重） */
  fileCount?: number
  /** execute：退出码 */
  exitCode?: number
  /** 本次调用有完整结果详情，点卡片可在右侧面板打开 */
  detail?: boolean
}

export interface ToolCallDetail {
  name: string
  input: Record<string, unknown>
  output: string
  status?: 'preparing' | 'executing' | 'completed'
  id?: string
  /** 定制化卡片数据，仅 deepagent 内置工具设置 */
  card?: ToolCard
}

/** 每轮注入系统提示词的热记忆内容（用于前端展示「注入记忆」） */
export interface MemoryInjection {
  /** 用户画像条目（target=user） */
  user: string[]
  /** 项目记忆条目（target=memory） */
  memory: string[]
  /** 容量信息（user/memory 的 used/limit 展示串，如 "512/4096"） */
  usage: { user: string; memory: string }
}

/** 本轮发生的早期对话摘要压缩（用于前端展示「上下文已压缩」卡片） */
export interface HistoryCompaction {
  /** 被压缩为 checkpoint 摘要的早期对话条数 */
  compressedCount: number
  /** 保持原样的最近对话条数 */
  retainedCount: number
  /** 压缩边界（被压缩段最后一条对话的 ID；边界推进才视为新的压缩事件） */
  boundaryId: number
}

/** 模型请求失败后的自动重试进度（过渡信号：前端展示「正在重试（第 N/M 次）」，不落库） */
export interface RetryInfo {
  /** 当前第几次重试（从 1 开始，如 1/2、2/2） */
  attempt: number
  /** 本轮最多重试次数 */
  retries: number
}

export interface StructuredMessage {
  tool?: ToolCallDetail
  content?: string
  reasoning_content?: string
  /**
   * 本段正文/推理是否属于这一轮的**最终答复**（协议层给结论，渲染端只读不猜）。
   *
   * - `true`：内容到达时该轮尚无工具/子代理活动，属于这一轮交付给用户的答复；
   * - `false`：**撤回**此前的标记（本轮已出现工具/子代理活动，前面的内容是探索途中的话）；
   * - 省略：本次 chunk 不表态（不是内容 chunk 时一律省略，渲染端不会被误清）。
   *
   * 真源与判定见 service/answer-boundary.ts（`answerTrailingCount`），
   * 随流结束的 `TurnFinal` 一起构成「最后一段任务里哪部分才是答复」的权威结论。
   */
  answer?: boolean
  /** 智能体活动事件 */
  subAgent?: SubAgentEvent
  /** 本轮注入的热记忆内容（Mnemon 启用且热记忆非空时，由流开头下发） */
  memoryInjected?: MemoryInjection
  /** 本轮发生的早期对话摘要压缩（历史超长被压缩为 checkpoint 时，由流开头下发） */
  historyCompacted?: HistoryCompaction
  /** 摘要压缩已开始（过渡信号：前端先显示「压缩中」，随后 historyCompacted 携带结果） */
  historyCompacting?: boolean
  /** 模型请求失败（尚无任何输出）后自动重试中（过渡信号：前端展示「正在重试」，不落库） */
  retrying?: RetryInfo
  /** 流式执行失败（部分输出后图执行失败时下发；IPC 层据此跳过把残缺回复落库） */
  streamError?: { message: string }
  /**
   * 用户插话已并入当前回合（steering 回执）。**纯注入**：不落库、不在对话流里生成
   * 新气泡，也不切分助手消息——前端只用它做一句瞬时反馈。
   */
  steered?: {
    /** 插话正文（仅供提示展示） */
    text: string
  }
}

/** IPC 发送的流式 chunk（StructuredMessage + 主进程注入的 topicId） */
export interface StreamChunk extends StructuredMessage {
  __topicId?: number
  /** 本轮终局标记（仅 `harness-stream-done` 载荷使用，见 service/answer-boundary.ts） */
  turnFinal?: TurnFinal
  /** 目标自动续跑轮的起始标记（流首 chunk；前端据此挂载新的用户消息与助手占位） */
  goalRound?: { round: number; objective: string }
}

/** 智能体定义 */
export interface SubAgentConfig {
  /** 唯一标识符，主代理通过 task() 工具调用时使用 */
  name: string
  /** 中文显示名（可选） */
  rename?: string
  /** 描述智能体的功能，主代理用于决定何时委托 */
  description: string
  /** 智能体的系统提示词 */
  systemPrompt: string
  /** 智能体可用的工具名称列表（从主代理工具集中选取） */
  tools?: string[]
  /** 可选：覆盖主代理的模型，格式 'provider:model' */
  model?: string
  /** 可选：可用的技能 ID 列表（从技能目录中选取），留空则无技能 */
  skills?: string[]
}

/** 智能体活动事件 */
export interface SubAgentEvent {
  /** 智能体名称 */
  name: string
  /** 派遣此智能体的 task 工具调用唯一 ID（用于区分同名智能体的多次调用） */
  causeId?: string
  /** 事件类型；dispatched=后台任务已派发（轻量卡：仅名称+简述+会话 id，结果在顶部栏查看） */
  status: 'started' | 'running' | 'dispatched' | 'completed' | 'error'
  /** 智能体的输出内容（completed 时） */
  output?: string
  /** 智能体执行过程中的消息 */
  message?: string
  /** 错误信息 */
  error?: string
  /** 智能体流式输出的文本增量 */
  content?: string
  /** 智能体流式输出的推理内容增量 */
  reasoning_content?: string
  /** 智能体的工具调用 */
  tool?: ToolCallDetail
  /** task 工具调用时携带的任务描述（frontend / persistence 从 task 工具输入转换） */
  taskDescription?: string
  /** 后台派发（status='dispatched'）时的会话 ID（subagent-N），供对话轻量卡展示 */
  subagentId?: string
}

/**
 * Available tool definition for the frontend dropdown.
 *
 * 定义已搬到宿主契约 `src/main/plugins/tool-contract.ts`（插件贡献工具时也要用它，
 * 放 harness 里会让插件反向 import harness），这里只做 re-export 保持既有 import 路径可用。
 */
export type { ToolInfo } from '../../../main/plugins/tool-contract'
