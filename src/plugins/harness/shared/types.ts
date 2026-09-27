/**
 * harness 插件的跨进程 DTO：主进程 IPC 的入参/出参形状，渲染层只读同一份定义。
 *
 * 分两部分：
 * 1. **行类型与视图类型**：沿袭 planner/notes 的做法，由**主进程模块推导**（mapper 内部再用
 *    drizzle schema 的 `$inferSelect` 推导），不手工维护第二份字段表——schema 改一处即两端口径
 *    一致。这里只 `export type`，编译后不留任何运行期依赖：渲染层不会因此把 drizzle、main
 *    目录或 electron 打进产物（契约见 src/plugins/README.md）。
 * 2. **消息块形状**：`MessageBlock` / `ToolCard` 等是随流式 chunk 与落库 `blocks` 列跨进程的
 *    契约，原先放在 `src/renderer/src/types/harness.ts`（core），本轮随插件搬来。
 *
 * 纯前端类型（`Message` / `Attachment` 等渲染端自造的模型）在 `../renderer/types.ts`。
 */

/* ── 主进程行类型（话题 / 对话 / 用量 / 工作区） ── */
export type {
  HarnessTopicRow,
  HarnessDialogueRow,
  HarnessDialogueUsageRow,
  WorkspaceRow,
  PaginatedResult
} from '../main/db/mapper/harness'

/* ── 智能体配置（子智能体） ── */
export type {
  AgentConfigRow,
  AgentConfigInput,
  PaginatedResult as AgentPaginatedResult
} from '../main/db/mapper/agent'

/* ── 运行时视图（计划清单 / 目标 / 后台任务 / 子代理 / 提问 / 记忆整理） ── */
export type { TodoItem } from '../main/runtime/todo'
export type { GoalView } from '../main/runtime/goal'
export type { JobSnapshot } from '../main/runtime/jobs'
export type { SubagentSessionRow } from '../main/runtime/subagent-sessions'
export type { PendingQuestionView, AskAnswer } from '../main/runtime/ask'
export type { StartMemoryAgentResult } from '../main/runtime/memory-agent'

/* ── 沙箱权限（档位 + 审批弹窗视图） ── */
export type { PermissionMode, DenyReason } from '../main/runtime/permission'
export type { ApprovalRequestView, ApprovalDecision } from '../main/runtime/permission-gate'

/* ── 工作区文件改动史与文件监听 ── */
export type { FileChangeView, FileChangeContent } from '../main/workspace/file-history'
export type { WorkspaceFsChange } from '../main/workspace/watcher'

/* ── MCP 服务器（配置 / 状态 / 工具，设置 → MCP 页与工具集装的公用契约） ── */
export type {
  McpServerConfig,
  McpServerInput,
  McpServerStatus,
  McpServerView,
  McpToolInfo,
  McpTransport,
  MainAgentConfig
} from './mcp'

/* ── 流式 chunk（主进程 StructuredMessage + 注入的 topicId） ── */
export type { StreamChunk } from '../main/types'

/**
 * 本轮终局标记（主进程给出的权威结论，渲染端只读不猜）：
 * `harness-stream-done` 载荷的一部分，真源在 main/service/answer-boundary.ts。
 */
export type { TurnFinal } from '../main/service/answer-boundary'

/**
 * 生成中的插话队列条目（主进程为单一真源，广播视图不含附件正文）。
 *
 * 原先定义在 `src/renderer/resource/types/window.d.ts`（core 的 window/api 类型表）里，
 * 只被 harness 的 QueueDock 与 useHarnessHandlers 使用，随本轮搬进插件。
 */
export interface QueuedMessageView {
  id: string
  topicId: number
  text: string
  createdAt: number
  attachments: { fileName: string; isImage: boolean }[]
  /** 点过插话但本轮没等到注入边界：留在队列里，随下一次发送带出 */
  held?: boolean
}

/* ── Mnemon 三层记忆（记忆设置页读的 IPC 返回形状） ── */

/** 热记忆条目（USER 用户画像 / MEMORY 项目记忆） */
export interface MnemonRuntimeEntry {
  content: string
  created_at: string
  updated_at: string
  target: 'user' | 'memory'
  importance: 'critical' | 'normal' | 'low'
}

/** 某一层热记忆的容量占用 */
export interface MnemonTargetUsage {
  target: 'user' | 'memory'
  used: number
  limit: number
  entryCount: number
  markdownPath: string
}

/** 长期记忆空间（Memory Space）条目 */
export interface MnemonBodyItem {
  id: string
  name: string
  description: string
  active: boolean
  dbPath?: string
  healthy: boolean
  error?: string
  stats?: {
    totalInsights: number
    edgeCount: number
    deletedInsights: number
  }
}

/** 记忆空间创建/更新的回执体 */
export interface MnemonBodyRef {
  id: string
  name: string
  description: string
  active: boolean
}

/** 项目档案（Project Documents）条目 */
export interface MnemonDocumentItem {
  id: string
  title: string
  description?: string
  status: 'active' | 'archived'
  updatedAt: string
  lastAccessedAt?: string
  revision: number
  sizeBytes?: number
  healthy?: boolean
  excerpt: string
}

/** `plugin:harness:mnemon-snapshot` 的返回（未配置记忆目录时只有 configured:false） */
export interface MnemonSnapshot {
  configured: boolean
  error?: string
  runtime?: {
    revision: string
    entries: MnemonRuntimeEntry[]
    targets: Record<'user' | 'memory', MnemonTargetUsage>
  }
  bodies?: {
    items: MnemonBodyItem[]
    total: number
    activeCount: number
    directory: string
  }
  documents?: {
    total: number
    activeCount: number
    archivedCount: number
    activeBytes?: number
    limitBytes?: number
    documents: MnemonDocumentItem[]
  }
}

/** `plugin:harness:mnemon-bodies` 的返回 */
export interface MnemonBodiesView {
  items: MnemonBodyItem[]
  total: number
  activeCount: number
  directory?: string
}

/** 记忆空间内容浏览行（`plugin:harness:mnemon-body-list`） */
export interface MnemonBodyInsight {
  id: string
  content: string
  category?: string
  importance?: number
  createdAt?: string
}

/* ── 消息块（流式 chunk / 落库 blocks 列的两端契约） ── */

/** 工具卡片语义分类：决定图标、元信息与「点击后打开什么」 */
export type ToolCardKind = 'file' | 'dir' | 'search' | 'command'

/**
 * 工具定制化卡片数据（内置文件/命令工具专用）。
 *
 * 这些工具的结果不再随流下发/落库（见 main/service/tool-presentation.ts）：
 * 聊天里只有这张卡片，点开才去右侧面板看真实文件或结果详情。
 */
export interface ToolCard {
  kind?: ToolCardKind
  path?: string
  pattern?: string
  count?: number
  command?: string
  /** 结果状态；error 时卡片显示失败原因 */
  status?: 'ok' | 'error'
  /** 失败原因 / 结果摘要（单行展示） */
  message?: string
  /** read_file：文件总行数 */
  lines?: number
  /** read_file / execute：结果字符数 */
  chars?: number
  /** read_file：文件比内联上限长，输出被截断 */
  truncated?: boolean
  /** read_file：按 offset/limit 读取的行区间（1 基，闭区间） */
  range?: { start: number; end: number; total: number }
  /** write_file：写入字节数 */
  bytes?: number
  /** write_file / edit_file：本次改动新增的行数（与改动记录同源；缺失时不显示） */
  added?: number
  /** write_file / edit_file：本次改动删除的行数 */
  removed?: number
  /** ls：子目录数 */
  dirs?: number
  /** ls / glob：文件数 */
  files?: number
  /** grep：命中的文件数（去重） */
  fileCount?: number
  /** execute：退出码 */
  exitCode?: number
  /** 有完整结果详情，点卡片可在右侧面板打开 */
  detail?: boolean
}

/** 工具调用 */
export interface ToolCall {
  name: string
  input: object
  output: string
  status?: 'preparing' | 'executing' | 'completed'
  id?: string
  card?: ToolCard
}

/** 智能体活动事件 */
export interface SubAgentEvent {
  name: string
  /** 派遣此智能体的 task 工具调用唯一 ID */
  causeId?: string
  /** dispatched=后台任务已派发（轻量卡：仅名称+简述+会话 id，结果在顶部栏查看） */
  status: 'started' | 'running' | 'dispatched' | 'completed' | 'error'
  output?: string
  message?: string
  error?: string
  content?: string
  reasoning_content?: string
  tool?: ToolCall
  /** task 工具调用时携带的任务描述（仅由前端从 task 工具输入转换而来） */
  taskDescription?: string
  /** 后台派发（status='dispatched'）时的会话 ID（subagent-N） */
  subagentId?: string
}

/** 记忆注入块数据（主进程 MemoryInjection 透传） */
export interface MemoryInjectionBlock {
  /** 用户画像条目（USER） */
  user: string[]
  /** 项目记忆条目（MEMORY） */
  memory: string[]
  /** 容量信息展示串 */
  usage: { user: string; memory: string }
}

/** 早期对话摘要压缩块数据（主进程 HistoryCompaction 透传） */
export interface HistoryCompactionBlock {
  /** 被压缩为 checkpoint 摘要的早期对话条数 */
  compressedCount: number
  /** 保持原样的最近对话条数 */
  retainedCount: number
  /** 压缩边界（被压缩段最后一条对话的 ID） */
  boundaryId: number
}

/** 模型请求失败后自动重试进度（retrying 过渡块：仅当轮展示，不落库） */
export interface RetryInfoBlock {
  /** 当前第几次重试（从 1 开始，如 1/2、2/2） */
  attempt: number
  /** 本轮最多重试次数 */
  retries: number
}

/** 消息块 */
export interface MessageBlock {
  type:
    | 'text'
    | 'tool'
    | 'reasoning'
    | 'image'
    | 'document'
    | 'subAgent'
    | 'memoryInjected'
    | 'historyCompacting'
    | 'historyCompacted'
    | 'goalRound'
    | 'retrying'
    /** 回合内插话标记：主进程按它把该行排除出模型上下文（只作展示与留痕） */
    | 'interjection'
  text?: string
  tool?: ToolCall
  reasoning?: string
  image_url?: string
  fileName?: string
  subAgent?: SubAgentEvent
  /** 本轮注入的热记忆内容（memoryInjected 类型使用） */
  memory?: MemoryInjectionBlock
  /** 本轮早期对话摘要压缩信息（historyCompacted 类型使用） */
  compaction?: HistoryCompactionBlock
  /** 目标自动续跑轮次号（goalRound 类型使用） */
  round?: number
  /** 模型请求失败后自动重试进度（retrying 类型使用，过渡块不落库） */
  retrying?: RetryInfoBlock
  /** 智能体嵌套的子块（仅 subAgent 类型使用，用于流式构建智能体的 text/tool/reasoning） */
  children?: MessageBlock[]
}
