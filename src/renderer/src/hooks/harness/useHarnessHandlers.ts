import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useLocation } from 'react-router-dom'

import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import { coalesceChunks, answerTailIndices } from '../../utils/harness/harnessHelpers'
import {
  getCapabilities,
  getProviderDisplayName,
  isEmbeddingProvider,
  sortReasoningEfforts,
  supportsCapability,
  supportsReasoningEffort
} from '@renderer/utils/providerMeta'
import { createTurnGuard } from '@renderer/utils/harness/turn-guard'
import { applyChunkToMessages } from '../../utils/harness/applyChunk'
import type {
  HarnessTopicRow,
  QueuedMessageView,
  StreamChunk
} from '../../../../shared/harness/types'
import type { Attachment, HarnessToolInfo, Message } from '../../types/harness/types'
import type { LlmProviderConfig } from '../../../../main/database/mapper/provider'
import { harnessApi, type AgentSelectionView } from '../../api/harness'
import { getMemoryScope, setMemoryScope } from '../../utils/harness/memory-scope'
import { isChatScope } from '../../../../shared/harness/memory-scope'
import { useTopicRunStatus } from './useTopicRunStatus'

const TOPICS_PAGE_SIZE = 20
const MESSAGES_PAGE_SIZE = 20 // 10对消息

// ── 流式 chunk 合批参数（渲染进程 OOM 修复）────────────────────────────
// 见 startStreamListener：高频 chunk 先排队、按自适应间隔合并为一次 React commit；
// 单条正文越长，每次 markdown 全量渲染越贵，间隔随文本长度线性放大，上限见 MAX。
const CHUNK_FLUSH_BASE_INTERVAL_MS = 33 // 常规刷新间隔（≤~30 commit/s）
const CHUNK_FLUSH_MAX_INTERVAL_MS = 300 // 超长文本自适应上限
const CHUNK_FLUSH_INTERVAL_PER_CHAR_MS = 1 / 2000 // 每 2k 字符 +1ms 间隔

const INPUT_HISTORY_STORAGE_KEY = 'rytenbench.harness.inputHistory'
const INPUT_HISTORY_MAX = 100
/** 全局输入历史缓存（localStorage 持久化，模块级单例，避免每次渲染解析存储） */
let inputHistoryCache: string[] | null = null
const loadInputHistory = (): string[] => {
  if (inputHistoryCache) return inputHistoryCache
  try {
    const raw = localStorage.getItem(INPUT_HISTORY_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    inputHistoryCache = Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string').slice(-INPUT_HISTORY_MAX)
      : []
  } catch {
    inputHistoryCache = []
  }
  return inputHistoryCache
}

/** 每个话题的会话缓存状态 */
interface SessionState {
  messages: Message[]
  inputValue: string
  attachments: Attachment[]
  sessionId: string | null
}

export interface UseHarnessHandlersReturn {
  messages: Message[]
  inputValue: string
  setInputValue: React.Dispatch<React.SetStateAction<string>>
  availableTools: HarnessToolInfo[]
  copiedId: string | null
  currentTopicId: number | null
  topics: HarnessTopicRow[]
  /** topics 所属工作区 id（null = 尚未加载过） */
  topicsWorkspaceId: number | null
  sidebarOpen: boolean
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>
  providers: LlmProviderConfig[]
  selectedProviderId: number | null
  setSelectedProviderId: React.Dispatch<React.SetStateAction<number | null>>
  attachments: Attachment[]
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>
  isLoading: boolean
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  textareaRef: React.RefObject<HTMLDivElement | null>
  /** 全局输入历史（↑/↓ 键切换浏览，handleSend 记录，localStorage 持久化，上限 100 条） */
  inputHistoryRef: { current: string[] }
  currentSessionIdRef: React.RefObject<string | null>
  currentTopicIdRef: React.RefObject<number | null>
  /** 当前会话是否已归档（只读：输入框隐藏、发送被拒） */
  currentTopicArchived: boolean
  loadingTopicIds: Set<number>
  /**
   * 正挂着提问 / 审批、等用户确认的会话（侧栏行首的黄色呼吸点）。
   * 与 loadingTopicIds 取并存的含义：进行中的会话挂起等确认时，黄点优先。
   */
  awaitingTopicIds: Set<number>
  /**
   * 刚自然跑完、还没被用户点开过的会话（侧栏行首的绿色呼吸点）。
   * 跑完时正显示在对话窗口里的那条不进这个集合（完成即自动移除）；点开即熄灭，不落盘。
   */
  completedTopicIds: Set<number>
  selectedProvider: LlmProviderConfig | null
  modelSupportsTools: boolean
  modelSupportsVision: boolean
  groupedProviderOptions: {
    label: string
    options: {
      value: number
      label: string
      providerType: string
      /** 当前模型的推理等级（null = 未设置） */
      reasoningEffort: string | null
      /** 该模型档案声明的可选档位（空数组 = 档案未收录） */
      effortLevels: string[]
      /** 当前协议是否真的会下发档位参数（未适配时界面提示「仅记录」） */
      effortControllable: boolean
    }[]
  }[]
  /** 话题分页 */
  topicsHasMore: boolean
  topicsLoading: boolean
  /** 整表刷新中（非滚动分页） */
  topicsRefreshing: boolean
  /** 消息分页（当前话题） */
  messagesHasMore: boolean
  messagesLoadingMore: boolean
  handleSelectTopic: (topic: HarnessTopicRow) => Promise<void>
  handleDeleteTopic: (topicId: number, e?: React.MouseEvent) => Promise<void>
  handleCopy: (text: string, id: string) => Promise<void>
  handleSend: () => Promise<void>
  /** 目标 Enter：以目标正文发起一轮 LLM（复用正常发送管线） */
  handleStartGoal: (objective: string) => Promise<void>
  handleNewHarness: () => void
  /** 每次「外部请求聚焦输入框」自增（见 harness-focus-input 监听）：输入框据此把光标放进去 */
  focusInputToken: number
  handleDeleteMessagePair: (msgIndex: number) => Promise<void>
  /** 进入**气泡内**编辑（孤立提问） */
  handleStartEditMessage: (msgIndex: number) => void
  /** 气泡内回车提交：就地替换该提问并重发（不新增用户气泡） */
  handleSubmitEditMessage: (msgIndex: number, content: string) => Promise<void>
  /** 取消气泡内编辑（Esc） */
  handleCancelEditMessage: () => void
  /** 正在气泡内编辑的提问 id（用于把它渲染成可编辑态） */
  editingMessageId: string | null
  /** 分支：把当前话题里到 upToIndex 为止的消息复制到新话题，并把列表与视图都切过去 */
  handleBranchConversation: (upToIndex: number) => Promise<void>
  handleKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
  handleStop: () => void
  handleLoadMoreTopics: () => Promise<void>
  handleLoadMoreMessages: () => Promise<void>
  refreshTopics: () => Promise<void>
  /** 生成中的插话队列（当前话题） */
  queuedMessages: QueuedMessageView[]
  /** 刚并入当前回合的插话正文（瞬时反馈，2.6s 后自动消失） */
  steeredNotice: string | null
  /** 删除一条排队消息 */
  handleRemoveQueued: (itemId: string) => Promise<void>
  /** 改写一条排队消息的文本 */
  handleUpdateQueued: (itemId: string, text: string) => Promise<void>
  /** 立即插话：把这条排队消息注入正在运行的回合 */
  handleSteerQueued: (itemId: string) => Promise<void>
  /**
   * 当前会话的「本轮运行选择」（工具 / 技能 / MCP，输入框下面选）。
   * 用户发送时随 startMessageStream 下发，主进程写回会话；null = 用默认。
   */
  agentSelection: AgentSelectionView | null
  setAgentSelection: React.Dispatch<React.SetStateAction<AgentSelectionView | null>>
}

/**
 * 取消息在库里的对话行 id。
 *
 * 流式期间的消息用的是临时 id（用户消息 `Date.now().toString()`、助手消息 `时间戳_话题_随机`），
 * 它们**不是** harness_dialogue 的行 id——拿去删除/关联用量都会命中不存在的行。
 * 所以：优先用主进程回传的 dialogueId；否则只接受「自增小整数」形态的 id
 *（时间戳约 1.7e12，一律视为临时 id）。
 */
function resolveDialogueId(message: Message | undefined): number | null {
  if (!message) return null
  if (typeof message.dialogueId === 'number') return message.dialogueId
  const numeric = Number(message.id)
  return Number.isInteger(numeric) && numeric > 0 && numeric < 1e10 ? numeric : null
}

/**
 * 用户插话（steering）**不改动对话流**：插话是纯注入——主进程把它并进正在运行的回合，
 * 既不落库也不切分助手消息（用户明确要求「不要形成新的对话内容和入库」）。
 *
 * 因此在渲染端插话 chunk 只作为回执被过滤掉：它带的是提示文本而不是内容/推理/工具，
 * 逐条应用只会平白触发一次无用更新。（「已插话」的瞬时反馈由队列条负责。）
 */
function isSteerChunk(chunk: StreamChunk): boolean {
  return Boolean(chunk.steered)
}

export const useHarnessHandlers = (): UseHarnessHandlersReturn => {
  const { viewMessage } = useMessage()
  const { t } = useTranslation()
  const [messages, setMessages] = useState<Message[]>([])
  const [inputValue, setInputValue] = useState('')
  /**
   * 「请把焦点放进输入框」的计数器（见下面的 harness-focus-input 监听）。
   * 输入框据此聚焦——不改内容，只是让用户点完 ＋ 就能直接打字。
   */
  const [focusInputToken, setFocusInputToken] = useState(0)
  // 会话级运行选择（工具/技能/MCP）：由输入框下面那排选择器维护，随发送下发
  const [agentSelection, setAgentSelection] = useState<AgentSelectionView | null>(null)
  /**
   * 下一条**新话题**要用的记忆作用域（插件行「＋」带过来的 `plugin:<id>`、
   * 「对话」模式带过来的 `chat`）。
   *
   * 用户口径 2026-09-28：「插件里面的记忆应该是独立的，现在是直接使用工作里面之前选中的记忆上下文，
   * 会导致有问题」——所以插件会话开话题时把 `plugin:<id>` 写进 `harness_topic.memory_scope`，
   * 之后（含重启后再打开这个会话）主进程都按话题上存的作用域走（见 main/memory-scope.ts）；
   * 「对话」模式同理写 `chat`（该模式没有工作区，记忆也不该挂到某个工作区上）。
   *
   * 三种取值各有含义，别混：
   * - `undefined` = **没人在等**：用当前话题自己存的作用域（往已有会话里发第二条消息走这条）；
   * - `null` = 显式要**工作区**那套（普通「新建会话」清掉上一条挂起值时就写它）；
   * - 字符串 = 这条新话题要用 `plugin:<id>` / `chat`。
   *
   * 只有在「还没有话题」的这一小段时间里需要它，话题一建就清掉。
   */
  const pendingMemoryScopeRef = useRef<string | null | undefined>(undefined)
  const [availableTools, setAvailableTools] = useState<HarnessToolInfo[]>([])
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLDivElement>(null)
  /** 全局输入历史（↑/↓ 键切换浏览，handleSend 记录，localStorage 持久化，上限 100 条） */
  const inputHistoryRef = useRef<string[]>(loadInputHistory())
  const currentSessionIdRef = useRef<string | null>(null)

  /** 当前活跃的工作区 ID */
  const activeWorkspaceIdRef = useRef<number>(0)
  const getActiveWorkspaceId = useCallback(async (): Promise<number> => {
    try {
      const settings = await window.api.systemSettings.getAll()
      const id = settings.harness.activeWorkspaceId ?? 0
      activeWorkspaceIdRef.current = id
      return id
    } catch {
      return activeWorkspaceIdRef.current
    }
  }, [])

  /**
   * 建完一条「对话」模式的话题后，让界面跟上**新的活动工作目录**。
   *
   * 主进程在 `harness-topic-create` 里已经把活动工作区切到 `<userData>/chat/<话题 id>/`
   * （见 ipc/harness-topic.ts），但那是主进程的设置；渲染层这边的工作区路径（资源管理器根、
   * 工具卡片 → 真实路径的映射）与侧栏活动态都靠这个事件重读。少了它，第一条消息写出来的
   * 文件在面板里会按**上一个**目录去打开（点开报「文件不存在」）。
   */
  const notifyChatTopicActivated = useCallback((workspaceId: number): void => {
    if (!workspaceId) return
    window.dispatchEvent(new CustomEvent('workspace-changed', { detail: { workspaceId } }))
  }, [])

  /** 当前活跃的智能体 causeId 集合：用于把智能体事件路由到正确块 */
  const activeSubAgentCauseIdsRef = useRef<Map<number, Set<string>>>(new Map())
  /** 取（或创建）某话题的「运行中子代理 causeId 集合」（chunk 合并 task 子代理块时用） */
  const activeCauseIdsFor = useCallback((topicId: number): Set<string> => {
    let activeCauseIds = activeSubAgentCauseIdsRef.current.get(topicId)
    if (!activeCauseIds) {
      activeCauseIds = new Set()
      activeSubAgentCauseIdsRef.current.set(topicId, activeCauseIds)
    }
    return activeCauseIds
  }, [])
  const [currentTopicId, setCurrentTopicId] = useState<number | null>(null)
  const currentTopicIdRef = useRef<number | null>(null)
  /**
   * 当前会话是不是**已归档**（只读）：打开后输入框隐藏、发送被拒（用户 2026-11-25
   * 「归档内容只能查看，不能对话」）。状态给页面渲染用，ref 给回调里判断用（避免闭包拿旧值）。
   */
  const [currentTopicArchived, setCurrentTopicArchived] = useState(false)
  const currentTopicArchivedRef = useRef(false)
  /** 同时写状态与 ref：两者必须一起变 */
  const markTopicArchived = useCallback((archived: boolean): void => {
    currentTopicArchivedRef.current = archived
    setCurrentTopicArchived(archived)
  }, [])
  /**
   * 侧栏改归档状态时（归档 / 取消归档）通知这边：**改的正是当前会话**就同步只读态。
   * 否则会出现「刚取消归档、输入框还不回来」或者「归档了当前会话、却还能接着发」。
   */
  useEffect(() => {
    const onArchiveChanged = (e: Event): void => {
      const detail = (e as CustomEvent<{ topicId?: number; archived?: boolean }>).detail
      if (detail?.topicId == null || detail.archived == null) return
      if (detail.topicId === currentTopicIdRef.current) markTopicArchived(detail.archived)
    }
    window.addEventListener('harness-topic-archive-changed', onArchiveChanged)
    return () => window.removeEventListener('harness-topic-archive-changed', onArchiveChanged)
  }, [markTopicArchived])
  /**
   * 对话页（`/harness`）此刻是不是显示在主内容区。
   *
   * 绿点的判定要用「这条会话此刻是否就摆在用户眼前」而不是只看 currentTopicId：
   * 人切到资料库 / 插件仓库时，对话窗口并不在屏幕上，那条会话跑完了仍该提醒。
   * 完成事件到达时才读（见下面的 conversationVisibleRef），所以这里用 ref 存最新值。
   */
  const location = useLocation()
  const conversationVisible =
    location.pathname === '/harness' || location.pathname.startsWith('/harness/')
  const conversationVisibleRef = useRef(conversationVisible)
  conversationVisibleRef.current = conversationVisible
  /** messages React 状态实际属于哪个话题——用于检测 handleSelectTopic 异步间隙中的跨话题污染 */
  const messagesBelongToTopicRef = useRef<number | null>(null)
  // 用 ref 持有最新消息快照（修复：handleDeleteMessagePair 此前依赖 [messages],流式期间
  // 每个 chunk 重建回调,作为 onDelete 传给全部消息组件击穿 React.memo → 每 chunk 全量重渲染历史消息）。
  // 声明在靠前位置：主进程发起轮次的挂载（mountExternalTurn）也要读它兜底会话缓存。
  const messagesSnapshotRef = useRef<Message[]>([])
  messagesSnapshotRef.current = messages
  const [topics, setTopics] = useState<HarnessTopicRow[]>([])
  /** topics 当前属于哪个工作区（切换工作区时用于避免把旧列表挂到新工作区下） */
  const [topicsWorkspaceId, setTopicsWorkspaceId] = useState<number | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [providers, setProviders] = useState<LlmProviderConfig[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState<number | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [loadingTopicIds, setLoadingTopicIds] = useState<Set<number>>(new Set())
  /**
   * 侧栏行首指示器的另外两端：等待用户确认（黄）/ 刚完成（绿）。
   * 「进行中」不在这里（见 loadingTopicIds），三者的切换规则集中在 useTopicRunStatus。
   *
   * `isTopicActive` 用来实现「当前这个会话窗口跑完不亮绿点」（用户口径 2026-11-23
   * 「如果当前是这个会话窗口，任务完成后自动移除」）：完成事件到达时按 ref 现取
   * 「当前话题 + 对话页是否显示着」，人正看着结果出来就不再用绿点提醒；
   * 人跑到资料库 / 插件仓库等别的页面时，对话窗口并不在眼前，绿点照常提醒。
   */
  const { awaitingTopicIds, completedTopicIds, beginTopicTurn, acknowledgeTopic, forgetTopic } =
    useTopicRunStatus({
      isTopicActive: (topicId) =>
        currentTopicIdRef.current === topicId && conversationVisibleRef.current
    })
  /** 正在气泡内编辑的提问 id（气泡变成可编辑态用） */
  const [editingOrphanId, setEditingOrphanId] = useState<string | null>(null)

  // ── 生成中的插话队列（主进程为单一真源，这里只保存当前话题的镜像）──
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessageView[]>([])
  /** 刚刚被并进当前回合的插话正文（只做 2.6s 瞬时反馈，不落库、不进对话流） */
  const [steeredNotice, setSteeredNotice] = useState<string | null>(null)
  const steeredNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** topicId → 该话题当前流式中的助手段落 id（插话切段时用它定位要定稿的那条）。
   *  按话题分桶：多话题可能同时有流在跑，共用一个 ref 会切错气泡。 */
  const assistantIdByTopicRef = useRef<Map<number, string>>(new Map())

  // ── 分页状态 ──
  const [topicsPage, setTopicsPage] = useState(0)
  const [topicsHasMore, setTopicsHasMore] = useState(true)
  const [topicsLoading, setTopicsLoading] = useState(false)
  /** 「整表刷新」进行中（区别于滚动分页加载更多，避免切换工作区时底部闪现分页 spinner） */
  const [topicsRefreshing, setTopicsRefreshing] = useState(false)
  const [messagesPage, setMessagesPage] = useState(0)
  const [messagesHasMore, setMessagesHasMore] = useState(true)
  const [messagesLoadingMore, setMessagesLoadingMore] = useState(false)
  /**
   * 会话列表刷新用的序号：只有**最后发起**的那次请求能把结果写回 `topics`。
   *
   * 启动恢复 / 快速连点工作区时会有多个「换工作区」几乎同时发生（每次都要重拉列表），
   * 它们的 IPC 往返顺序没有任何保证：先发的那次后回来，就会把 `topicsWorkspaceId` 写回
   * **上一个**工作区。侧栏随后按「活动工作区」渲染时，那个工作区的会话列表永远等不到数据，
   * 一直停在加载骨架（用户 2026-11-22 截图里插件行下面那 5 行就是它）。
   */
  const topicsRefreshSeqRef = useRef(0)

  // ── 多会话支持 ──
  const sessionsRef = useRef<Map<number, SessionState>>(new Map())
  /** 每个 topicId 的加载状态 */
  const isLoadingMapRef = useRef<Map<number, boolean>>(new Map())
  /** 每个 topicId 的 stream chunk 清理函数 */
  const chunkCleanupsRef = useRef<Map<number, () => void>>(new Map())
  /** 每个 topicId 的 stream done 清理函数 */
  const doneCleanupsRef = useRef<Map<number, () => void>>(new Map())
  /** 每个 topicId 的 stream error 清理函数 */
  const errorCleanupsRef = useRef<Map<number, () => void>>(new Map())

  // ── 插话队列同步 ──
  // 主进程是队列的单一真源：这里订阅广播 + 切话题时主动拉一次，本地不做乐观增删，
  // 避免「入队时前端先加一遍、广播回来再加一遍」的双份队列。
  const applyQueue = useCallback((topicId: number, queue: QueuedMessageView[]): void => {
    if (currentTopicIdRef.current !== topicId) return
    setQueuedMessages(queue)
  }, [])

  useEffect(() => {
    const api = harnessApi.harness
    const offUpdated = api.onQueueUpdated(({ topicId, queue }) => applyQueue(topicId, queue))
    const offSteered = api.onQueueSteered(({ topicId, itemId, text }) => {
      // 插话是纯注入：不产生对话流气泡，这里只把队列镜像里的那一行去掉 +
      // 给一句瞬时反馈（「已插话」）说明它真的被并进了当前回合
      if (currentTopicIdRef.current !== topicId) return
      setQueuedMessages((prev) => prev.filter((item) => item.id !== itemId))
      setSteeredNotice(text)
      if (steeredNoticeTimerRef.current != null) clearTimeout(steeredNoticeTimerRef.current)
      steeredNoticeTimerRef.current = setTimeout(() => setSteeredNotice(null), 2600)
    })
    return () => {
      offUpdated()
      offSteered()
      if (steeredNoticeTimerRef.current != null) clearTimeout(steeredNoticeTimerRef.current)
    }
  }, [applyQueue])

  /** 切话题后拉取该话题的队列（广播只覆盖「变更」，不覆盖「切换」） */
  useEffect(() => {
    if (currentTopicId == null) {
      setQueuedMessages([])
      return
    }
    void harnessApi.harness
      .listQueuedMessages(currentTopicId)
      .then((queue) => applyQueue(currentTopicId, queue))
      .catch(console.error)
  }, [currentTopicId, applyQueue])

  /** 同步 isLoadingMapRef 到 loadingTopicIds 状态 */
  const syncLoadingTopics = useCallback((): void => {
    setLoadingTopicIds(new Set(isLoadingMapRef.current.keys()))
  }, [])

  // 欢迎语打字机：见 components/WelcomeIntro.tsx（高频/无限循环动画不放在这里，
  // 否则整个聊天视图会被每秒重渲染 ~25 次）

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === selectedProviderId) ?? null,
    [providers, selectedProviderId]
  )
  const modelSupportsTools = supportsCapability(
    selectedProvider?.metadata,
    'supports_function_calling'
  )
  const modelSupportsVision = supportsCapability(selectedProvider?.metadata, 'supports_image_input')

  useEffect(() => {
    harnessApi.harness.getTools().then(setAvailableTools).catch(console.error)
  }, [])

  useEffect(() => {
    const loadProviders = async (): Promise<void> => {
      try {
        const list = await window.api.providers.getEnabled()
        const chatModels = list.filter((p) => !isEmbeddingProvider(p))
        setProviders(chatModels)

        // 模型：优先使用默认 provider
        const defaultProvider = await window.api.providers.getDefault()
        if (defaultProvider && !isEmbeddingProvider(defaultProvider)) {
          setSelectedProviderId(defaultProvider.id)
        } else if (chatModels.length > 0) {
          setSelectedProviderId(chatModels[0].id)
        }
      } catch (err) {
        console.error('Failed to load providers:', err)
      }
    }
    loadProviders().then()
    const unsubscribe = window.api.providers.onChanged(() => {
      loadProviders().then()
    })
    return unsubscribe
  }, [])

  const refreshTopics = useCallback(async (): Promise<void> => {
    const seq = ++topicsRefreshSeqRef.current
    try {
      setTopicsRefreshing(true)
      setTopicsLoading(true)
      setTopicsPage(0)
      const workspaceId = await getActiveWorkspaceId()
      const result = await harnessApi.harness.getAllTopicsPaginated(
        workspaceId,
        0,
        TOPICS_PAGE_SIZE
      )
      // 期间又发起过更新的一次刷新的：这份结果已经过期，不能覆盖更新的那一份
      // （否则 `topicsWorkspaceId` 会被写回旧工作区，侧栏那边就永远等不到活动工作区的列表）
      if (seq !== topicsRefreshSeqRef.current) return
      setTopics(result.items)
      // 标记这批 topics 属于哪个工作区：切换工作区时旧列表不能挂到新工作区行下面
      setTopicsWorkspaceId(workspaceId)
      setTopicsHasMore(result.hasMore)
    } catch (err) {
      console.error('Failed to load topics:', err)
    } finally {
      setTopicsLoading(false)
      setTopicsRefreshing(false)
    }
  }, [getActiveWorkspaceId])

  const handleLoadMoreTopics = useCallback(async (): Promise<void> => {
    if (topicsLoading || !topicsHasMore) return
    try {
      setTopicsLoading(true)
      const nextPage = topicsPage + 1
      const workspaceId = await getActiveWorkspaceId()
      const result = await harnessApi.harness.getAllTopicsPaginated(
        workspaceId,
        nextPage,
        TOPICS_PAGE_SIZE
      )
      setTopicsPage(nextPage)
      setTopics((prev) => [...prev, ...result.items])
      setTopicsWorkspaceId(workspaceId)
      setTopicsHasMore(result.hasMore)
    } catch (err) {
      console.error('Failed to load more topics:', err)
    } finally {
      setTopicsLoading(false)
    }
  }, [topicsPage, topicsHasMore, topicsLoading, getActiveWorkspaceId])

  useEffect(() => {
    refreshTopics().then()
  }, [])

  /**
   * 工作区切换（含插件行 /「在对话中修改」/「对话」模式）→ 重拉会话列表。
   *
   * 订阅必须挂在 Provider（常驻、跟着应用走），不能挂在对话页：切工作区的入口几乎都在
   * `/plugins`（插件仓库 / 插件详情）或常驻侧栏里，人根本不在 `/harness`。此前这条订阅写在
   * `pages/Harness.tsx` 里，离开对话页就没人接这个事件 ⇒ `topics` 一直停在上一个工作区的那份，
   * 侧栏里「已展开的活动工作区」永远等不到自己的会话列表，一直卡在骨架屏
   * （用户 2026-11-22 报的就是这个：插件行下面 5 行灰条不动）。
   *
   * `refreshTopics` 自己按**设置里的**活动工作区取数，所以不依赖事件 detail；
   * 并发/乱序由 `topicsRefreshSeqRef` 兜底。
   */
  useEffect(() => {
    const onWorkspaceChanged = (): void => {
      refreshTopics().then()
    }
    window.addEventListener('workspace-changed', onWorkspaceChanged)
    return () => window.removeEventListener('workspace-changed', onWorkspaceChanged)
  }, [refreshTopics])

  // 组件卸载时清理所有流监听器
  useEffect(() => {
    const chunkCleanups = chunkCleanupsRef.current
    const doneCleanups = doneCleanupsRef.current
    const errorCleanups = errorCleanupsRef.current
    return () => {
      for (const cleanup of chunkCleanups.values()) cleanup()
      for (const cleanup of doneCleanups.values()) cleanup()
      for (const cleanup of errorCleanups.values()) cleanup()
    }
  }, [])

  // ── 会话缓存管理 ──

  /** 保存当前对话窗口的状态到缓存 */
  const saveSessionToCache = useCallback((): void => {
    const topicId = currentTopicIdRef.current
    if (topicId == null) return
    sessionsRef.current.set(topicId, {
      messages: [...messages],
      inputValue,
      attachments: [...attachments],
      sessionId: currentSessionIdRef.current
    })
  }, [messages, inputValue, attachments])

  /** 从缓存恢复会话到当前对话窗口 */
  const restoreSessionFromCache = useCallback((topicId: number): boolean => {
    const cached = sessionsRef.current.get(topicId)
    if (!cached) return false
    setMessages(cached.messages)
    setInputValue(cached.inputValue)
    setAttachments(cached.attachments)
    currentSessionIdRef.current = cached.sessionId
    return true
  }, [])

  // ── 开始流式监听（每个 topic 独立） ──

  /**
   * @param expectedTurnId 本轮流监听的回合 id（主进程下发）。给了就只处理它的事件；
   *   不给（本地发起的轮次在注册时还不知道 id）就锁在**第一条到达的 chunk** 的回合上，
   *   之后属于别的回合的 chunk / done / error 一律丢弃——同话题两轮串台会让输出错乱。
   */
  const startStreamListener = useCallback(
    (topicId: number, aiMessageId: string, expectedTurnId?: number): void => {
      // 清理旧的监听器
      chunkCleanupsRef.current.get(topicId)?.()
      doneCleanupsRef.current.get(topicId)?.()
      errorCleanupsRef.current.get(topicId)?.()

      /** 回合守卫：丢弃不属于本轮的 chunk / done / error（见 utils/harness/turn-guard） */
      const matchesTurn = createTurnGuard(expectedTurnId)

      // 本轮助手消息的前端临时 id：整轮流式都写进这一条气泡
      assistantIdByTopicRef.current.set(topicId, aiMessageId)

      // ── 流式 chunk 合批（渲染进程 OOM 修复）──────────────────────────
      // 此前每条 chunk IPC 到达都立即全量重渲染整条消息：ReactMarkdown 解析 + 语法高亮 +
      // KaTeX 作用于全文，超长回复下累计 O(L²)，主线程被占满、GC 让位、IPC 事件积压，
      // 内存峰值持续走高直至渲染进程被 OOM kill。合批把高频 chunk 排队，按间隔合并成
      // 「一次会话更新 + 一次 React commit」——commit 数从「每条 chunk」降到 ~30/s 以内，
      // 内容仍按到达顺序逐 chunk 追加（与既有增量/去重约定一致，不丢内容、不改语义）。
      let pendingChunks: StreamChunk[] = []
      let flushTimer: ReturnType<typeof setTimeout> | null = null
      let flushIntervalMs = CHUNK_FLUSH_BASE_INTERVAL_MS

      /** 排空积压 chunk：按顺序逐 chunk 应用，只做一次会话缓存写入 + 一次 React commit */
      const applyPendingChunks = (): void => {
        flushTimer = null
        if (pendingChunks.length === 0) return
        const session = sessionsRef.current.get(topicId)
        if (!session) return
        // 先合并「累积形态」的同类增量：逐 chunk 应用时每步都要复制整块文本（O(L²)），
        // 合并后每批只复制一次（O(F×L)）。增量形态的段原样保留，语义不变。
        const coalesced = coalesceChunks(pendingChunks)
        pendingChunks = []
        const startedAt = performance.now()
        // 插话回执（steered）纯过滤：它不改对话流（见 isSteerChunk 的说明），
        // 助手消息继续按同一条气泡累积——一轮问答始终只有一条助手消息
        const dataChunks = coalesced.filter((chunk) => !isSteerChunk(chunk))
        let updatedMessages = session.messages
        const targetId = assistantIdByTopicRef.current.get(topicId) ?? aiMessageId
        for (const chunk of dataChunks) {
          updatedMessages = applyChunkToMessages(
            updatedMessages,
            targetId,
            chunk,
            activeCauseIdsFor(topicId)
          )
        }
        sessionsRef.current.set(topicId, { ...session, messages: updatedMessages })
        // 复用 session cache 的结果直接更新 React state
        // （避免 setMessages(prev => ...) 中 updater 被 StrictMode 双重调用导致重复块）
        if (currentTopicIdRef.current === topicId) {
          setMessages(updatedMessages)
        }
        // 自适应间隔：正文越长单次全量渲染越贵，间隔随长度线性放大；本批处理耗时
        // （工具/智能体密集批次）同样拉大间隔，给主线程与 GC 喘息
        const aiMsg = updatedMessages.find((m) => m.id === targetId)
        const textLen = Math.max(aiMsg?.content?.length ?? 0, aiMsg?.reasoning_content?.length ?? 0)
        const took = performance.now() - startedAt
        flushIntervalMs = Math.min(
          CHUNK_FLUSH_MAX_INTERVAL_MS,
          Math.max(
            CHUNK_FLUSH_BASE_INTERVAL_MS,
            CHUNK_FLUSH_BASE_INTERVAL_MS + textLen * CHUNK_FLUSH_INTERVAL_PER_CHAR_MS,
            took * 2
          )
        )
        // 排空期间到达的新 chunk 已重新入队，立即续排
        scheduleFlush()
      }

      /** 若当前没有待触发的排空定时器则安排一个 */
      const scheduleFlush = (): void => {
        if (flushTimer != null || pendingChunks.length === 0) return
        flushTimer = setTimeout(applyPendingChunks, flushIntervalMs)
      }

      const chunkCleanup = harnessApi.harness.onStreamChunk((chunk: StreamChunk) => {
        // topicId 守卫：只处理属于本话题的 chunk（Set 分发机制会使所有 handler 收到所有 chunk）
        if (chunk.__topicId !== topicId) return
        // 回合守卫：不属于本轮的 chunk（上一轮的迟到事件 / 另一轮并发）直接丢弃
        if (!matchesTurn(chunk.__turnId)) return
        if (!sessionsRef.current.get(topicId)) return
        pendingChunks.push(chunk)
        scheduleFlush()
      })
      // 注销前先落完积压 chunk（done/error/删除话题等路径），避免最后一段内容丢失
      chunkCleanupsRef.current.set(topicId, () => {
        applyPendingChunks()
        chunkCleanup()
      })

      const doneCleanup = harnessApi.harness.onStreamDone(
        ({
          topicId: doneTopicId,
          turnId: doneTurnId,
          assistantDialogueId,
          userDialogueId,
          segments,
          turnFinal
        }) => {
          // 守卫：只处理本 topic 的完成事件（Set 分发可能导致旧 handler 收到其他 topic 的事件）
          if (doneTopicId !== topicId) return
          // 回合守卫：别的回合的收尾事件不能拿来收这一轮（否则会把还在跑的轮次提前切断）
          if (!matchesTurn(doneTurnId)) return

          // 先落完积压 chunk：done 事件可能与最后一批 chunk 同 tick 到达，
          // 若不先排空，末尾正文会丢在积压队列里（随后会话缓存被清理）
          applyPendingChunks()

          // 清理对应 topic 的加载状态
          isLoadingMapRef.current.delete(doneTopicId)
          syncLoadingTopics()

          // 完成后清除缓存（后续切换回来直接读数据库）
          sessionsRef.current.delete(doneTopicId)

          // 清理智能体追踪
          activeSubAgentCauseIdsRef.current.delete(doneTopicId)
          // 本轮段落指针用完了：清掉，避免下轮误用上一轮的临时 id
          assistantIdByTopicRef.current.delete(doneTopicId)

          // 清理流监听器（doneCleanup 自身由 startStreamListener L575-576 在下一次同 topic 启动时清理）
          chunkCleanupsRef.current.get(doneTopicId)?.()
          chunkCleanupsRef.current.delete(doneTopicId)
          doneCleanupsRef.current.delete(doneTopicId)
          errorCleanupsRef.current.get(doneTopicId)?.()
          errorCleanupsRef.current.delete(doneTopicId)

          // 刷新话题列表
          refreshTopics().then()

          // 如果是当前显示的话题，更新 UI
          if (currentTopicIdRef.current === doneTopicId) {
            setIsLoading(false)
            setMessages((prev) => {
              // 本轮落库的是两条消息：最后一条流式中的助手消息 + 它前面那条用户消息。
              // 两条都要挂上库内行 id——删除「这一轮」时按 id 删，只给助手挂会导致
              // 用户那条留在库里（表现为「只删掉了助手」）
              let lastLoading = -1
              prev.forEach((msg, i) => {
                if (msg.loading) lastLoading = i
              })
              let lastUser = -1
              for (let i = lastLoading - 1; i >= 0; i--) {
                if (prev[i].role === 'user') {
                  lastUser = i
                  break
                }
              }
              // 插话切段后一段助手消息对应库里一行：按 messageId 精确贴回；
              // 没有段落表（老路径）时退回「最后一条 loading 挂 assistantDialogueId」
              const segmentIds = new Map(
                (segments ?? [])
                  .filter((seg) => seg.dialogueId != null)
                  .map((seg) => [seg.messageId, seg.dialogueId as number])
              )
              return prev.map((msg, i) => {
                if (msg.loading) {
                  // 结束兜底移除「正在重试」过渡块（成功路径在首个数据 chunk 时已移除；
                  // 此处覆盖中止/重试耗尽等未产生数据的收尾）——**先滤再算答复边界**，
                  // 否则只在渲染端存在的过渡块会把「末尾 N 块」数错位
                  const settledBlocks = msg.blocks.filter((b) => b.type !== 'retrying')
                  return {
                    ...msg,
                    loading: false,
                    /**
                     * 本轮终局：主进程在 done 事件里给出权威结论（TurnFinal）。
                     *
                     * `answerBlocks` 是最终答复的块数（0 = 本轮没有答复），用**数量**而不是
                     * 下标，因为两侧块数不一致（渲染端合并相邻 reasoning、还有过渡块）；
                     * 数量对不上本地数组时 answerTailIndices 返回 undefined，退回旧行为，
                     * 绝不错切。缺 turnFinal（老版本主进程）时同样什么都不改。
                     */
                    answer:
                      turnFinal?.answerBlocks === undefined
                        ? msg.answer
                        : (answerTailIndices(settledBlocks, turnFinal.answerBlocks) ?? undefined),
                    dialogueId:
                      segmentIds.get(msg.id) ??
                      (i === lastLoading
                        ? (assistantDialogueId ?? msg.dialogueId)
                        : msg.dialogueId),
                    blocks: settledBlocks
                  }
                }
                if (i === lastUser) {
                  return { ...msg, dialogueId: userDialogueId ?? msg.dialogueId }
                }
                return msg
              })
            })
          }
        }
      )
      doneCleanupsRef.current.set(topicId, doneCleanup)

      // 注册流错误监听：模型不存在 / 被禁用等启动阶段的错误
      const errorCleanup = harnessApi.harness.onStreamError(
        ({ error: errMsg, topicId: errorTopicId, turnId: errorTurnId }) => {
          // 守卫：只处理本 topic 的错误
          if (errorTopicId !== topicId) return
          // 回合守卫：别的回合的报错不能覆盖这一轮的内容
          if (!matchesTurn(errorTurnId)) return

          // 先落完积压 chunk，再整体替换为错误信息，避免与最后一批正文竞态
          applyPendingChunks()

          console.error(`[Stream] Error for topic ${topicId}: ${errMsg}`)

          // 更新会话缓存中的 AI 消息为错误信息（当前段落可能是插话切段后的续写段）
          const activeId = assistantIdByTopicRef.current.get(topicId) ?? aiMessageId
          const session = sessionsRef.current.get(topicId)
          if (session) {
            const updatedMessages = session.messages.map((msg) =>
              msg.id === activeId ? { ...msg, content: errMsg, blocks: [], loading: false } : msg
            )
            sessionsRef.current.set(topicId, {
              ...session,
              messages: updatedMessages
            })
          }

          // 如果当前正在显示此 topic，同步更新 React 状态
          if (currentTopicIdRef.current === topicId) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === activeId ? { ...msg, content: errMsg, blocks: [], loading: false } : msg
              )
            )
          }
        }
      )
      errorCleanupsRef.current.set(topicId, errorCleanup)
    },
    [activeCauseIdsFor, syncLoadingTopics]
  )

  // ── 主进程自行发起的轮次监听（常驻，不随普通轮的 done 清理）──
  //
  // 两类轮次用户都没有「点发送」这个动作，渲染端没有本地占位：
  // - goalRound：目标自动续跑轮；
  // - queueTurn：排队消息在上一轮结束后被自动接续发出的轮次。
  // 主进程在流首下发标记 chunk，这里据此挂上用户消息 + 助手占位并注册本轮流监听——
  // 少了这一步，消息在跑而界面上什么都没有（旧版「排队消息没发送」的直接原因）。
  useEffect(() => {
    /**
     * 挂载一条主进程发起的轮次：用户消息 + 助手占位 + 加载态 + 流监听。
     * 两种标记共用（区别只在用户消息的展示块与临时 id 前缀）。
     */
    const mountExternalTurn = (
      topicId: number,
      userMessage: Message,
      assistantId: string,
      turnId?: number
    ): void => {
      const initialAiMessage: Message = {
        id: assistantId,
        role: 'assistant',
        content: '',
        blocks: [],
        timestamp: Date.now(),
        toolCalls: [],
        loading: true
      }

      // 标记加载状态（停止按钮可用、侧边栏转圈）
      // 这一轮真的开跑了：清掉上一轮可能残留的绿点 / 黄点
      beginTopicTurn(topicId)
      isLoadingMapRef.current.set(topicId, true)
      syncLoadingTopics()
      if (currentTopicIdRef.current === topicId) {
        setIsLoading(true)
        setMessages((prev) => [...prev, userMessage, initialAiMessage])
      }

      // 更新会话缓存并启动本轮监听（后续 chunk 由本轮监听器处理）
      // 缓存可能在上一轮 done 时被清掉：当前正显示这个话题时用 React 里的列表兜底，
      // 否则本轮第一个 chunk 会把界面上的历史消息整片替换掉
      const session = sessionsRef.current.get(topicId)
      const base =
        session?.messages ??
        (currentTopicIdRef.current === topicId ? messagesSnapshotRef.current : [])
      sessionsRef.current.set(topicId, {
        messages: [...base, userMessage, initialAiMessage],
        inputValue: session?.inputValue ?? '',
        attachments: session?.attachments ?? [],
        sessionId: assistantId
      })
      currentSessionIdRef.current = assistantId
      assistantIdByTopicRef.current.set(topicId, assistantId)
      startStreamListener(topicId, assistantId, turnId)
    }

    const cleanup = harnessApi.harness.onStreamChunk((chunk: StreamChunk) => {
      const topicId = chunk.__topicId ?? 0
      if (!topicId) return

      if (chunk.goalRound) {
        const { round, objective } = chunk.goalRound
        mountExternalTurn(
          topicId,
          {
            id: `goal-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            role: 'user',
            content: objective,
            blocks: [{ type: 'goalRound', round, objective }],
            timestamp: Date.now()
          },
          `goal-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chunk.__turnId
        )
        return
      }

      if (chunk.queueTurn) {
        const { text, attachments } = chunk.queueTurn
        // 排队轮次没有 dataURL（附件正文只在主进程队列里）：这里按文件名列出来即可，
        // 气泡只负责说明「这条消息是什么」，真正的附件随请求下发
        mountExternalTurn(
          topicId,
          {
            id: `queue-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            role: 'user',
            content: text,
            blocks: attachments.map((name) => ({ type: 'document' as const, fileName: name })),
            timestamp: Date.now()
          },
          `queue-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chunk.__turnId
        )
        return
      }

      // 定时任务轮：正文就是主进程投递的消息（与落库内容一致），实时气泡与刷新后一致
      if (chunk.scheduleTurn) {
        const { text } = chunk.scheduleTurn
        mountExternalTurn(
          topicId,
          {
            id: `schedule-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            role: 'user',
            content: text,
            blocks: [],
            timestamp: Date.now()
          },
          `schedule-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chunk.__turnId
        )
      }
    })
    return cleanup
  }, [startStreamListener, syncLoadingTopics, beginTopicTurn])

  // ── Handlers ──

  const handleNewHarness = useCallback((): void => {
    saveSessionToCache()
    setMessages([])
    setCurrentTopicId(null)
    currentTopicIdRef.current = null
    // 新会话一定不是归档态：清掉只读标记，输入框回来
    currentTopicArchivedRef.current = false
    setCurrentTopicArchived(false)
    messagesBelongToTopicRef.current = null
    setInputValue('')
    setAttachments([])
    setIsLoading(false)
    // 切换/新建会话时放弃气泡内编辑状态（那条提问不属于新会话）
    setEditingOrphanId(null)
    // 新会话没有插话队列；当前段落指针也一并复位
    setQueuedMessages([])
    assistantIdByTopicRef.current.clear()
    // 普通「新建会话」不带独立记忆作用域（插件行「＋」/「对话」模式会在之后把它放进来，
    // 见 harness-focus-input）：显式写 null，把上一条挂起值清掉，别让它漏给这一条新会话
    pendingMemoryScopeRef.current = null
    // 记忆作用域同步归零：空会话 = 工作区那套（插件行「＋」是同步紧跟着派发的，会立刻改写回来）
    setMemoryScope(null)
  }, [saveSessionToCache])

  /**
   * 外部请求「开一个（可选带独立记忆作用域的）新会话，并把焦点放进输入框」（`harness-focus-input`）。
   *
   * 用途一：侧栏「插件」模式的行上点 ＋ = 针对这份插件开新会话——新会话是空白的
   * （首个话题在首次发送时才落库），**刻意不预填任何文字**（用户口径 2026-09-28
   * 「我需要的是不要显示：给插件「个人记账台账」（id: personal-ledger）这个玩意」），
   * 只把光标送进输入框 + 记住这条会话该用**哪份插件的记忆**。
   *
   * 用途二：「对话」模式的 ＋ 同名事件带 `scope: 'chat'`——记忆用该模式自己那一套。
   */
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ pluginId?: string; scope?: string; focus?: boolean }>)
        .detail
      const pluginId = detail?.pluginId
      const scope = detail?.scope === 'chat' ? 'chat' : pluginId ? `plugin:${pluginId}` : null
      pendingMemoryScopeRef.current = scope
      // 还没有话题的这段时间里，界面（侧栏记忆块 / 设置 → 记忆）也要显示这套记忆
      setMemoryScope(scope)
      // 切模式自动进入的那条空白会话只带作用域、不抢光标（用户只是在看插件这一侧的内容）
      if (detail?.focus !== false) setFocusInputToken((n) => n + 1)
    }
    window.addEventListener('harness-focus-input', handler)
    return () => window.removeEventListener('harness-focus-input', handler)
  }, [])

  const handleSelectTopic = useCallback(
    async (topic: HarnessTopicRow): Promise<void> => {
      // 不在加载时禁止切换，允许自由切换

      // 用户点开了这条会话 = 刚完成的绿点可以消失了（用户口径 2026-11-23
      // 「当用户点击这个会话时，这个绿色的点会消失」；黄点不动，见 acknowledgeTopic）
      acknowledgeTopic(topic.id)

      // 保存当前话题状态到缓存
      saveSessionToCache()

      // 切话题时放弃气泡内编辑状态：那条提问属于上一个话题
      setEditingOrphanId(null)

      // 选中的话题自带记忆作用域（存在话题行上，主进程按它走）→ 清掉「下一条新话题」的挂起值
      pendingMemoryScopeRef.current = undefined
      // 记忆跟着当前会话走：这条会话是插件会话就显示这份插件的记忆，「对话」模式的会话
      // 显示该模式自己的那份，否则回工作区
      // （重开应用后点开会话也认——作用域是话题行上存着的，不靠渲染层记得住）
      setMemoryScope(topic.memory_scope ?? null)

      currentTopicIdRef.current = topic.id
      setCurrentTopicId(topic.id)
      // 归档的会话是只读的：打开只查看历史（输入框隐藏、发送被拒）
      markTopicArchived(Boolean(topic.archived_at))

      // 先尝试从缓存恢复（进行中的会话）
      const restored = restoreSessionFromCache(topic.id)
      if (restored) {
        // 从缓存恢复，同步 loading 状态
        setIsLoading(isLoadingMapRef.current.get(topic.id) ?? false)
        messagesBelongToTopicRef.current = topic.id
        // 重置分页状态（修复：此前早退不重置,残留上一话题的 messagesPage/messagesHasMore,
        // 点「加载更多」会用上一话题的页码对当前话题取数,造成漏页/重叠）
        currentSessionIdRef.current = null
        setMessagesPage(0)
        setMessagesHasMore(true)
        return
      }

      // 缓存未命中：从数据库分页加载第一页
      currentSessionIdRef.current = null
      setIsLoading(false)
      setMessagesPage(0)
      setMessagesHasMore(true)

      try {
        const result = await harnessApi.harness.getDialoguesByTopicPaginated(
          topic.id,
          0,
          MESSAGES_PAGE_SIZE
        )
        const loadedMessages: Message[] = result.items.map((d) => ({
          id: String(d.id),
          role: d.role,
          content: d.content,
          blocks: d.blocks ? JSON.parse(d.blocks) : [],
          // created_at 库列为可空（DEFAULT NOW()），缺失时退回当前时间
          timestamp: d.created_at ? new Date(d.created_at).getTime() : Date.now(),
          loading: false
        }))
        setMessages(loadedMessages)
        setMessagesHasMore(result.hasMore)
      } catch (err) {
        console.error('Failed to load dialogues:', err)
        setMessages([])
      }

      messagesBelongToTopicRef.current = topic.id

      setInputValue('')
      setAttachments([])
    },
    [saveSessionToCache, restoreSessionFromCache, acknowledgeTopic, markTopicArchived]
  )

  /**
   * 分支：把当前话题里到 upToIndex 为止的消息复制成一个新话题。
   *
   * 三件事必须一起做，否则就是「点了没反应」：
   *  1) 新话题落库（createTopic）并逐条复制消息（addDialogue）；
   *  2) **刷新话题列表**——侧边栏读的是 topics 状态，绕过它建的话题不会出现在列表里；
   *  3) **切到新话题**——复用 handleSelectTopic，让它走正常的加载/缓存/分页流程。
   */
  const handleBranchConversation = useCallback(
    async (upToIndex: number): Promise<void> => {
      const messageKey = 'harness-branch'
      const slice = messages.slice(0, upToIndex + 1)
      if (slice.length === 0) return
      try {
        viewMessage(messageKey, 'loading', t('harness.handlers.branchCreating'))
        const workspaceId = await getActiveWorkspaceId()
        const firstQuestion =
          slice.find((m) => m.role === 'user')?.content ?? t('harness.handlers.branchUntitled')
        const title = t('harness.handlers.branchTitle', {
          title: firstQuestion.replace(/\s+/g, ' ').trim().slice(0, 30)
        })
        const branchScope = getMemoryScope()
        const newTopicId = await harnessApi.harness.createTopic(
          workspaceId,
          title,
          undefined,
          undefined,
          // 分支出来的会话跟原会话用**同一套记忆**（否则从插件会话分出来的支会掉回工作记忆）
          branchScope
        )
        // 「对话」模式的分支是**另一条会话**：它有自己的目录，主进程建话题时已切好，
        // 这里同步一次活动路径（否则新分支仍在父会话的目录里读写文件）
        if (isChatScope(branchScope)) notifyChatTopicActivated(workspaceId)
        for (const item of slice) {
          await harnessApi.harness.addDialogue({
            topic_id: newTopicId,
            role: item.role,
            content: item.content,
            blocks: JSON.stringify(item.blocks ?? [])
          })
        }
        // 先刷新列表（新话题 updated_at 最新，排在第一页首位），再从刷新结果里取出行去切换
        const result = await harnessApi.harness.getAllTopicsPaginated(
          workspaceId,
          0,
          TOPICS_PAGE_SIZE
        )
        setTopics(result.items)
        setTopicsWorkspaceId(workspaceId)
        setTopicsPage(0)
        setTopicsHasMore(result.hasMore)
        const created = result.items.find((t) => t.id === newTopicId)
        if (created) {
          await handleSelectTopic(created)
          viewMessage(
            messageKey,
            'success',
            t('harness.handlers.branchSuccess', { count: slice.length }),
            2
          )
        } else {
          await refreshTopics()
          viewMessage(messageKey, 'success', t('harness.handlers.branchListHint'), 3)
        }
      } catch (error) {
        console.error('Failed to branch conversation:', error)
        viewMessage(messageKey, 'error', t('harness.handlers.branchFailed'))
      }
    },
    [
      messages,
      getActiveWorkspaceId,
      handleSelectTopic,
      notifyChatTopicActivated,
      refreshTopics,
      viewMessage,
      t
    ]
  )

  const handleDeleteTopic = useCallback(
    async (topicId: number, e?: React.MouseEvent): Promise<void> => {
      e?.stopPropagation()
      try {
        // 如果删除的是正在流式输出的话题，先取消后端流
        if (isLoadingMapRef.current.has(topicId)) {
          harnessApi.harness.cancelStream()
        }

        await harnessApi.harness.deleteTopic(topicId)

        // 清理该话题的所有缓存和监听器
        sessionsRef.current.delete(topicId)
        isLoadingMapRef.current.delete(topicId)
        syncLoadingTopics()
        // 行首的两端标记跟着这条会话一起消失（id 之后可能被数据库复用）
        forgetTopic(topicId)
        chunkCleanupsRef.current.get(topicId)?.()
        chunkCleanupsRef.current.delete(topicId)
        doneCleanupsRef.current.get(topicId)?.()
        doneCleanupsRef.current.delete(topicId)
        errorCleanupsRef.current.get(topicId)?.()
        errorCleanupsRef.current.delete(topicId)
        activeSubAgentCauseIdsRef.current.delete(topicId)
        assistantIdByTopicRef.current.delete(topicId)

        if (currentTopicIdRef.current === topicId) {
          // 删的是**正在看的**这条：先把指针挪开再清视图。
          // `handleNewHarness()` 开头会 `saveSessionToCache()`（按 currentTopicIdRef 写缓存），
          // 指针还指着这条已删会话的话，就会把刚删掉的历史又写回 `sessionsRef`；
          // 之后任何一次「重新选中这个 id」（旧行、迟到的事件）都会命中缓存、把历史原样放回屏幕
          // ——用户口径 2026-10-26「删除的是当前的会话…内容还是选中的历史记录」。
          currentTopicIdRef.current = null
          handleNewHarness()
          // 删掉的若是归档会话：只读标记跟着清掉（新视图是空白会话，输入框要回来）
          currentTopicArchivedRef.current = false
          setCurrentTopicArchived(false)
          // 双保险：清视图过程中若又落了缓存，这里补删一次
          sessionsRef.current.delete(topicId)
        }
        await refreshTopics()
      } catch (err) {
        console.error('Failed to delete topic:', err)
      }
    },
    [handleNewHarness, syncLoadingTopics, forgetTopic]
  )

  const handleLoadMoreMessages = useCallback(async (): Promise<void> => {
    if (messagesLoadingMore || !messagesHasMore || currentTopicIdRef.current == null) return
    try {
      setMessagesLoadingMore(true)
      const nextPage = messagesPage + 1
      const result = await harnessApi.harness.getDialoguesByTopicPaginated(
        currentTopicIdRef.current,
        nextPage,
        MESSAGES_PAGE_SIZE
      )
      setMessagesPage(nextPage)
      // 更旧的消息插入到列表头部
      const olderMessages: Message[] = result.items.map((d) => ({
        id: String(d.id),
        role: d.role,
        content: d.content,
        blocks: d.blocks ? JSON.parse(d.blocks) : [],
        // created_at 库列为可空（DEFAULT NOW()），缺失时退回当前时间
        timestamp: d.created_at ? new Date(d.created_at).getTime() : Date.now(),
        loading: false
      }))
      setMessages((prev) => [...olderMessages, ...prev])
      setMessagesHasMore(result.hasMore)
    } catch (err) {
      console.error('Failed to load more messages:', err)
    } finally {
      setMessagesLoadingMore(false)
    }
  }, [messagesPage, messagesHasMore, messagesLoadingMore])

  const handleCopy = useCallback(async (text: string, id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [])

  /**
   * 一轮问答的公共管线：乐观上屏 → 确保话题 → 加载态 → 流监听 → 会话缓存 → 发起流。
   *
   * @param userMessage   这一轮的用户消息（正常发送时新建；气泡内编辑时是**就地替换**的那条）
   * @param attachments   本轮附件（图片 dataURL / 文档路径），用于传给主进程
   * @param replaceIndex  气泡内编辑：替换消息列表里的第 index 条，**不新增用户气泡**
   */
  const startTurn = useCallback(
    async (params: {
      userMessage: Message
      attachments: Attachment[]
      replaceIndex?: number
    }): Promise<void> => {
      const { userMessage, attachments: turnAttachments, replaceIndex } = params
      const currentImages = turnAttachments.filter((a) => a.isImage).map((a) => a.dataUrl)
      const currentDocuments = turnAttachments
        .filter((a) => !a.isImage)
        .map((a) => ({ fileName: a.fileName, filePath: a.dataUrl }))

      const aiMessageId = `${Date.now()}_${currentTopicIdRef.current ?? 'new'}_${Math.random().toString(36).slice(2, 8)}`
      const initialAiMessage: Message = {
        id: aiMessageId,
        role: 'assistant',
        content: '',
        blocks: [],
        timestamp: Date.now(),
        toolCalls: [],
        loading: true
      }

      // 乐观上屏：编辑时原地替换（沿用同一个 id → 同一个气泡，不会多出一条），正常发送时追加
      setMessages((prev) => [
        ...(replaceIndex != null
          ? prev.map((m, i) => (i === replaceIndex ? userMessage : m))
          : [...prev, userMessage]),
        initialAiMessage
      ])

      // ── 发出后清空输入区 ──────────────────────────────────────────────
      // 输入框只在 inputValue 变成 '' 时才清编辑器（见 HarnessInput 的同步 effect），
      // 此前这里没清 → 内容一直留在对话框中（气泡也上屏了，看起来像没发出去）。
      // 放在 startTurn 而不是 handleSend：三条入口（首次发送 / 生成中入队后接续 / 队列自动
      // 接续）都要清；气泡内编辑重发（replaceIndex != null）时输入框没内容，不动。
      if (replaceIndex == null) {
        // 竞态防御：发送是异步的，若在这期间用户又打了新内容，不能被这次发送清掉
        setInputValue((prev) => (prev.trim() === userMessage.content ? '' : prev))
        setAttachments([])
      }

      try {
        // 如果还没有 topic，先创建（让话题立即出现在侧边栏）
        let topicId = currentTopicIdRef.current
        if (!topicId) {
          const title = userMessage.content.slice(0, 50)
          const workspaceId = await getActiveWorkspaceId()
          // 记忆作用域：插件行「＋」开出来的会话带 `plugin:<id>`（这份插件自己的记忆），
          // 「对话」模式的会话带 `chat`，普通会话留空 = 跟工作区走（见 main/memory-scope.ts）。
          // 取值三种含义见 pendingMemoryScopeRef 的说明；`undefined` 时用**当前话题**存的那一份
          // （往已有会话里发消息不建话题，这里根本不会走到），兜底仍是工作区。
          const memoryScope =
            pendingMemoryScopeRef.current !== undefined
              ? pendingMemoryScopeRef.current
              : getMemoryScope()
          topicId = await harnessApi.harness.createTopic(
            workspaceId,
            title,
            undefined,
            undefined,
            memoryScope
          )
          // 作用域已经落进话题行，之后由主进程按话题读；用完就清，避免影响下一条新会话
          // （界面这一侧的作用域 store 保持不动：话题就是这条会话的作用域，等切会话时再改写）
          pendingMemoryScopeRef.current = undefined
          currentTopicIdRef.current = topicId
          setCurrentTopicId(topicId)
          // 「对话」模式的会话目录按话题 id 分：主进程建话题时已把活动目录切过去，
          // 这里广播一次让资源管理器 / 文件路径映射跟上（见 notifyChatTopicActivated）
          if (isChatScope(memoryScope)) notifyChatTopicActivated(workspaceId)
          refreshTopics().then()
        }

        // 记录本轮输入到全局输入历史（输入框 ↑/↓ 键切换用，localStorage 持久化，上限 100 条）
        const sentText = userMessage.content
        const inputHistory = inputHistoryRef.current
        if (inputHistory[inputHistory.length - 1] !== sentText) {
          inputHistory.push(sentText)
          if (inputHistory.length > INPUT_HISTORY_MAX) {
            inputHistory.splice(0, inputHistory.length - INPUT_HISTORY_MAX)
          }
          try {
            localStorage.setItem(INPUT_HISTORY_STORAGE_KEY, JSON.stringify(inputHistory))
          } catch {
            // 存储失败不影响发送流程
          }
        }

        currentSessionIdRef.current = aiMessageId

        // 这一轮开跑：上一轮留下的「刚完成」绿点作废（会话从「等你查看」回到「进行中」）
        beginTopicTurn(topicId)

        // 标记加载状态
        isLoadingMapRef.current.set(topicId, true)
        syncLoadingTopics()
        setIsLoading(true)

        // 缓存当前会话——使用 messagesBelongToTopicRef 防止跨话题污染：
        // 如果 handleSelectTopic 的异步 DB 加载尚未完成，messages 仍属于旧话题，
        // 此时应丢弃旧消息，从新对话开始（否则会把 A 的历史混入 B 的会话缓存）
        const sameTopic = messagesBelongToTopicRef.current === topicId
        const base = sameTopic ? messages : ([] as Message[])
        const withUser =
          replaceIndex != null
            ? base.map((m, i) => (i === replaceIndex ? userMessage : m))
            : [...base, userMessage]
        const currentMessages: Message[] = [...withUser, initialAiMessage]
        sessionsRef.current.set(topicId, {
          messages: currentMessages,
          inputValue: '',
          attachments: [],
          sessionId: aiMessageId
        })
        messagesBelongToTopicRef.current = topicId

        // 同步 React 状态
        setMessages(currentMessages)

        // 先问主进程「这一轮到底起没起来」，再挂流监听：
        //  - started=true → 正常挂监听（监听器按第一条 chunk 锁定回合 id）；
        //  - queued=true  → 上一轮还在跑（极小概率的竞态），这条已被收进队列，
        //    撤掉刚上屏的乐观气泡，避免出现一条永远转圈的幽灵消息。
        // 之所以不在 await 之前挂监听：那会在竞态路径上把真正在跑的那一轮的监听覆盖掉。
        const startResult = await harnessApi.harness.startMessageStream(userMessage.content, {
          images: currentImages.length > 0 ? currentImages : undefined,
          documents: currentDocuments.length > 0 ? currentDocuments : undefined,
          topicId,
          providerId: selectedProviderId ?? undefined,
          // 输入框下面选的工具/技能/MCP：主进程按它组装本轮，并写回会话配置
          agentConfig: agentSelection ?? undefined,
          // 首段助手消息的前端临时 id：插话会切段，主进程按段回传库内行 id
          messageId: aiMessageId,
          // 编辑重发：让主进程改写这条已存在的用户消息行，而不是插入新行
          // （否则库里会多出一条同内容提问，历史顺序也被挪到末尾）
          reuseUserDialogueId:
            replaceIndex != null ? (resolveDialogueId(userMessage) ?? undefined) : undefined
        })

        if (startResult?.queued) {
          const session = sessionsRef.current.get(topicId)
          if (session) {
            sessionsRef.current.set(topicId, {
              ...session,
              messages: session.messages.filter(
                (msg) => msg.id !== aiMessageId && msg.id !== userMessage.id
              )
            })
          }
          setMessages((prev) =>
            prev.filter((msg) => msg.id !== aiMessageId && msg.id !== userMessage.id)
          )
          isLoadingMapRef.current.delete(topicId)
          syncLoadingTopics()
          if (currentTopicIdRef.current === topicId) setIsLoading(false)
          return
        }

        // 启动流监听（独立于当前对话窗口，持续更新缓存）
        startStreamListener(topicId, aiMessageId)
      } catch (error) {
        console.error('Error sending message:', error)
        const errorMessage: Message = {
          id: aiMessageId,
          role: 'assistant',
          content: t('harness.handlers.sendFailed'),
          blocks: [],
          timestamp: Date.now(),
          loading: false
        }
        setMessages((prev) => prev.map((msg) => (msg.id === aiMessageId ? errorMessage : msg)))

        // 清理加载状态
        const topicId = currentTopicIdRef.current
        if (topicId != null) {
          isLoadingMapRef.current.delete(topicId)
          syncLoadingTopics()
          setIsLoading(false)
        }
      }
    },
    [
      messages,
      selectedProviderId,
      startStreamListener,
      syncLoadingTopics,
      getActiveWorkspaceId,
      notifyChatTopicActivated,
      refreshTopics,
      beginTopicTurn,
      t
    ]
  )

  /** 输入框发送：空闲时直接开一轮；生成中则交给主进程收进插话队列 */
  const handleSend = useCallback(async (): Promise<void> => {
    // 归档会话只读：输入框本来就不渲染，这里再兜一道，别的入口（快捷键等）也发不出去
    if (currentTopicArchivedRef.current) return
    if (!inputValue.trim()) return

    // 新一轮问答开始：清空输入框上方的进行中任务卡片（等待模型重新规划）
    window.dispatchEvent(new CustomEvent('harness-send-started'))

    const currentAttachments = [...attachments]
    setAttachments([])

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputValue.trim(),
      blocks: currentAttachments.map((a) =>
        a.isImage
          ? { type: 'image' as const, image_url: a.dataUrl }
          : { type: 'document' as const, fileName: a.fileName }
      ),
      timestamp: Date.now()
    }

    // 生成中（本话题有回合在跑）：不打断当前回合，消息进插话队列等用户点「立即插话」
    // 或等本轮跑完自动接续。**是否在跑一律问主进程**——本地 isLoading 在主进程自行接续
    // 排队消息 / 目标自动续跑的轮次上会滞后，据此判断会并发起第二个回合（输出错乱的根因）。
    const topicId = currentTopicIdRef.current
    if (topicId != null) {
      const turnState = await harnessApi.harness.getTurnState(topicId).catch(() => null)
      if (turnState?.active) {
        try {
          const { queued } = await harnessApi.harness.enqueueMessage({
            topicId,
            text: userMessage.content,
            attachments: {
              images: currentAttachments.filter((a) => a.isImage).map((a) => a.dataUrl),
              documents: currentAttachments
                .filter((a) => !a.isImage)
                .map((a) => ({ fileName: a.fileName, filePath: a.dataUrl }))
            }
          })
          if (queued) {
            // 已入队（按队列行显示在输入框上方），清空输入区。
            // 注意：不能直接 setInputValue('') —— 入队是异步的，期间用户可能又打了新内容；
            // 与本次入队内容一致才清，避免误删新草稿。
            setInputValue((prev) => (prev.trim() === userMessage.content ? '' : prev))
            return
          }
        } catch (err) {
          console.error('Failed to enqueue message:', err)
        }
      }
    }

    await startTurn({ userMessage, attachments: currentAttachments })
  }, [inputValue, attachments, startTurn])

  /** 目标卡片 Enter：保存目标后，以「开始执行目标」发起一轮（后续由 goal driver 自动续跑）。 */
  const handleStartGoal = useCallback(
    async (objective: string): Promise<void> => {
      const text = objective.trim()
      if (!text || currentTopicArchivedRef.current) return
      window.dispatchEvent(new CustomEvent('harness-send-started'))
      const userMessage: Message = {
        id: Date.now().toString(),
        role: 'user',
        content: `开始执行目标：${text}`,
        blocks: [{ type: 'text', text: `开始执行目标：${text}` }],
        timestamp: Date.now()
      }
      await startTurn({ userMessage, attachments: [] })
    },
    [startTurn]
  )

  /**
   * 动作卡（propose_action）点选：把选项文本作为一条用户消息发出去。
   *
   * 与手动发送走同一条路径：生成中则入队（不打断当前回合），否则直接开新一轮。
   * 卡片通过 `harness-propose-action` 窗口事件把文本交到这里。
   */
  const handleProposeAction = useCallback(
    async (text: string): Promise<void> => {
      const content = text.trim()
      if (!content || currentTopicArchivedRef.current) return
      window.dispatchEvent(new CustomEvent('harness-send-started'))
      const userMessage: Message = {
        id: Date.now().toString(),
        role: 'user',
        content,
        blocks: [{ type: 'text', text: content }],
        timestamp: Date.now()
      }
      const topicId = currentTopicIdRef.current
      if (topicId != null) {
        const turnState = await harnessApi.harness.getTurnState(topicId).catch(() => null)
        if (turnState?.active) {
          try {
            const { queued } = await harnessApi.harness.enqueueMessage({
              topicId,
              text: content,
              attachments: { images: [], documents: [] }
            })
            if (queued) return
          } catch (err) {
            console.error('Failed to enqueue proposed action:', err)
          }
        }
      }
      await startTurn({ userMessage, attachments: [] })
    },
    [startTurn]
  )

  useEffect(() => {
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<{ text?: unknown }>).detail
      if (typeof detail?.text === 'string') void handleProposeAction(detail.text)
    }
    window.addEventListener('harness-propose-action', listener)
    return () => window.removeEventListener('harness-propose-action', listener)
  }, [handleProposeAction])

  /** 删除一条排队消息（主进程为真源，删除后靠广播回同步） */
  const handleRemoveQueued = useCallback(async (itemId: string): Promise<void> => {
    const topicId = currentTopicIdRef.current
    if (topicId == null) return
    try {
      await harnessApi.harness.removeQueuedMessage(topicId, itemId)
    } catch (err) {
      console.error('Failed to remove queued message:', err)
    }
  }, [])

  /** 改写一条排队消息的文本 */
  const handleUpdateQueued = useCallback(async (itemId: string, text: string): Promise<void> => {
    const topicId = currentTopicIdRef.current
    if (topicId == null || !text.trim()) return
    try {
      await harnessApi.harness.updateQueuedMessage(topicId, itemId, text)
    } catch (err) {
      console.error('Failed to update queued message:', err)
    }
  }, [])

  /**
   * 立即插话：把这条排队消息并入**正在运行**的回合（下一个工具节点边界生效）。
   * 回执与落库由主进程在注入点统一下发（steered chunk），这里只发请求。
   */
  const handleSteerQueued = useCallback(async (itemId: string): Promise<void> => {
    const topicId = currentTopicIdRef.current
    if (topicId == null) return
    try {
      await harnessApi.harness.steerQueuedMessage(topicId, itemId)
    } catch (err) {
      console.error('Failed to steer queued message:', err)
    }
  }, [])

  /** 进入**气泡内**编辑（内容不出气泡，聊天输入框不参与） */
  const handleStartEditMessage = useCallback((msgIndex: number): void => {
    const current = messagesSnapshotRef.current[msgIndex]
    if (!current || current.role !== 'user') return
    setEditingOrphanId(current.id)
  }, [])

  /** 取消气泡内编辑（Esc） */
  const handleCancelEditMessage = useCallback((): void => {
    setEditingOrphanId(null)
  }, [])

  /**
   * 气泡内回车提交：内容**就地替换**这条提问（不新增用户气泡），随后按普通一轮发起请求；
   * 库里用 UPDATE 改写同一行（reuseUserDialogueId），行 id 与历史顺序都不变。
   */
  const handleSubmitEditMessage = useCallback(
    async (msgIndex: number, content: string): Promise<void> => {
      const current = messagesSnapshotRef.current[msgIndex]
      if (!current || current.role !== 'user') return
      const text = content.trim()
      if (!text) return
      setEditingOrphanId(null)
      window.dispatchEvent(new CustomEvent('harness-send-started'))
      await startTurn({
        userMessage: { ...current, content: text },
        attachments: [],
        replaceIndex: msgIndex
      })
    },
    [startTurn]
  )
  const handleDeleteMessagePair = useCallback(
    async (msgIndex: number): Promise<void> => {
      const msgs = [...messagesSnapshotRef.current]
      const current = msgs[msgIndex]
      if (!current) return

      const indicesToDelete: number[] = []

      if (current.role === 'user') {
        indicesToDelete.push(msgIndex)
        if (msgIndex + 1 < msgs.length && msgs[msgIndex + 1].role === 'assistant') {
          indicesToDelete.push(msgIndex + 1)
        }
      } else if (current.role === 'assistant') {
        if (msgIndex - 1 >= 0 && msgs[msgIndex - 1].role === 'user') {
          indicesToDelete.push(msgIndex - 1)
        }
        indicesToDelete.push(msgIndex)
      }

      try {
        for (const idx of indicesToDelete) {
          const dialogueId = resolveDialogueId(msgs[idx])
          if (dialogueId !== null) {
            await harnessApi.harness.deleteDialogue(dialogueId)
          } else {
            // 流式期间的消息用临时 id（Date.now() 时间戳），拿它去删会命中不存在的行
            console.warn(`[Harness] Skipping delete: message has no stored id yet (index=${idx})`)
          }
        }
      } catch (err) {
        console.error('Failed to delete dialogue:', err)
      }

      const targetIds = new Set(
        indicesToDelete.map((i) => msgs[i]?.id).filter((id): id is string => typeof id === 'string')
      )
      setMessages((prev) => {
        const next = prev.filter((m) => !targetIds.has(m.id))
        if (next.length === 0) {
          const deletedTopicId = currentTopicIdRef.current
          currentTopicIdRef.current = null
          messagesBelongToTopicRef.current = null
          setCurrentTopicId(null)
          // 会话空了 = 回到了空白态：挂起值交回**当前会话那一套**（undefined → 建话题时用
          // 当前作用域，主进程再按工作区种类兜底）。**不重置成工作区**：插件 /「对话」会话
          // 清空全部消息后仍然是这一侧的内容，掉回工作区记忆会让侧栏和下一轮都串味。
          pendingMemoryScopeRef.current = undefined
          if (deletedTopicId != null) {
            sessionsRef.current.delete(deletedTopicId)
            isLoadingMapRef.current.delete(deletedTopicId)
            syncLoadingTopics()
          }
        }
        return next
      })
    },
    [syncLoadingTopics]
  )

  /** 聊天输入框的 Enter 发送（气泡内编辑的 Enter 由 UserMessage 自己处理） */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend().then()
      }
    },
    [handleSend]
  )

  const handleStop = useCallback((): void => {
    harnessApi.harness.cancelStream()

    const topicId = currentTopicIdRef.current
    if (topicId != null) {
      isLoadingMapRef.current.delete(topicId)
      syncLoadingTopics()
      setIsLoading(false)

      // 清理流监听器
      chunkCleanupsRef.current.get(topicId)?.()
      chunkCleanupsRef.current.delete(topicId)
      doneCleanupsRef.current.get(topicId)?.()
      doneCleanupsRef.current.delete(topicId)
      errorCleanupsRef.current.get(topicId)?.()
      errorCleanupsRef.current.delete(topicId)
    }

    setMessages((prev) => prev.map((msg) => (msg.loading ? { ...msg, loading: false } : msg)))
  }, [syncLoadingTopics])

  const groupedProviderOptions = useMemo(() => {
    const grouped = new Map<
      string,
      {
        value: number
        displayName: string
        model: string
        effort: string | null
        levels: string[]
        controllable: boolean
      }[]
    >()
    for (const p of providers) {
      if (!grouped.has(p.provider)) {
        grouped.set(p.provider, [])
      }
      // 自定义端点按 extra_config.api_format 判定（Anthropic 兼容协议同样会下发档位）
      const anthropicFormat =
        String((p.extra_config as Record<string, unknown> | null)?.api_format ?? 'openai') ===
        'anthropic'
      grouped.get(p.provider)!.push({
        value: p.id,
        displayName: getProviderDisplayName(p),
        model: p.model,
        effort: p.reasoning_effort ?? null,
        // 档位真源是模型档案：未收录的模型不给档位（界面上只能选「默认」）
        levels: sortReasoningEfforts(getCapabilities(p.metadata).reasoning_effort_levels),
        controllable: supportsReasoningEffort(p.provider, anthropicFormat)
      })
    }
    return Array.from(grouped.entries()).map(([provider, opts]) => ({
      label: provider.charAt(0).toUpperCase() + provider.slice(1),
      options: opts.map((o) => ({
        value: o.value,
        label: o.displayName,
        providerType: provider,
        reasoningEffort: o.effort,
        effortLevels: o.levels,
        effortControllable: o.controllable
      }))
    }))
  }, [providers])

  return {
    // state
    messages,
    inputValue,
    setInputValue,
    /** 每次「外部请求聚焦输入框」自增（HarnessInput 用它把光标放进输入框，不改内容） */
    focusInputToken,
    availableTools,
    copiedId,
    currentTopicId,
    currentTopicArchived,
    topics,
    topicsWorkspaceId,
    sidebarOpen,
    setSidebarOpen,
    providers,
    selectedProviderId,
    setSelectedProviderId,
    attachments,
    setAttachments,
    isLoading,
    loadingTopicIds,
    awaitingTopicIds,
    completedTopicIds,
    // refs
    messagesEndRef,
    textareaRef,
    inputHistoryRef,
    currentSessionIdRef,
    currentTopicIdRef,
    // computed
    selectedProvider,
    modelSupportsTools,
    modelSupportsVision,
    groupedProviderOptions,
    // pagination
    topicsHasMore,
    topicsLoading,
    topicsRefreshing,
    messagesHasMore,
    messagesLoadingMore,
    // handlers
    handleSelectTopic,
    handleDeleteTopic,
    handleCopy,
    handleSend,
    handleStartGoal,
    handleNewHarness,
    handleDeleteMessagePair,
    handleStartEditMessage,
    handleSubmitEditMessage,
    handleCancelEditMessage,
    editingMessageId: editingOrphanId,
    handleBranchConversation,
    handleKeyDown,
    handleStop,
    handleLoadMoreTopics,
    handleLoadMoreMessages,
    refreshTopics,
    // 插话队列
    queuedMessages,
    steeredNotice,
    handleRemoveQueued,
    handleUpdateQueued,
    handleSteerQueued,
    agentSelection,
    setAgentSelection
  }
}
