import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'

import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import {
  isSameToolCall,
  computeTextDelta,
  pushBlock,
  findPlaceholderPreparingTool,
  coalesceChunks,
  answerTailIndices
} from '../utils/harnessHelpers'
import {
  getCapabilities,
  getProviderDisplayName,
  isEmbeddingProvider,
  sortReasoningEfforts,
  supportsCapability,
  supportsReasoningEffort
} from '@renderer/utils/providerMeta'
import type {
  HarnessTopicRow,
  MessageBlock,
  QueuedMessageView,
  StreamChunk,
  ToolCall
} from '../../shared/types'
import type { Attachment, HarnessToolInfo, Message } from '../types'
import type { LlmProviderConfig } from '../../../../main/database/mapper/provider'
import { harnessApi } from '../api'
import { getMemoryScope, setMemoryScope } from '../memory-scope'

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
  loadingTopicIds: Set<number>
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
  /**
   * 下一条**新话题**要用的插件记忆作用域（插件行「＋ 新建会话」带过来的插件 id）。
   *
   * 用户口径 2026-09-28：「插件里面的记忆应该是独立的，现在是直接使用工作里面之前选中的记忆上下文，
   * 会导致有问题」——所以插件会话开话题时把 `plugin:<id>` 写进 `harness_topic.memory_scope`，
   * 之后（含重启后再打开这个会话）主进程都按话题上存的作用域走（见 main/memory-scope.ts）。
   * 只有在「还没有话题」的这一小段时间里需要它，话题一建就清掉。
   */
  const pendingPluginIdRef = useRef<string | null>(null)
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

  /** 当前活跃的智能体 causeId 集合：用于把智能体事件路由到正确块 */
  const activeSubAgentCauseIdsRef = useRef<Map<number, Set<string>>>(new Map())
  const [currentTopicId, setCurrentTopicId] = useState<number | null>(null)
  const currentTopicIdRef = useRef<number | null>(null)
  /** messages React 状态实际属于哪个话题——用于检测 handleSelectTopic 异步间隙中的跨话题污染 */
  const messagesBelongToTopicRef = useRef<number | null>(null)
  const [topics, setTopics] = useState<HarnessTopicRow[]>([])
  /** topics 当前属于哪个工作区（切换工作区时用于避免把旧列表挂到新工作区下） */
  const [topicsWorkspaceId, setTopicsWorkspaceId] = useState<number | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [providers, setProviders] = useState<LlmProviderConfig[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState<number | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [loadingTopicIds, setLoadingTopicIds] = useState<Set<number>>(new Set())
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

  // ── 处理流式 chunk 的核心逻辑（主代理 + 智能体） ──

  /** 将 stream chunk 应用到消息上，返回更新后的 messages 浅拷贝 */
  const applyChunkToMessages = useCallback(
    (msgs: Message[], aiMessageId: string, chunk: StreamChunk, topicId: number): Message[] => {
      let activeCauseIds = activeSubAgentCauseIdsRef.current.get(topicId)
      if (!activeCauseIds) {
        activeCauseIds = new Set()
        activeSubAgentCauseIdsRef.current.set(topicId, activeCauseIds)
      }
      return msgs.map((msg) => {
        if (msg.id !== aiMessageId) return msg

        const updatedReasoning = chunk.reasoning_content
          ? msg.reasoning_content &&
            String(chunk.reasoning_content).startsWith(msg.reasoning_content)
            ? String(chunk.reasoning_content)
            : msg.reasoning_content &&
                msg.reasoning_content.endsWith(String(chunk.reasoning_content))
              ? msg.reasoning_content
              : (msg.reasoning_content || '') + chunk.reasoning_content
          : msg.reasoning_content

        const updatedContent = chunk.content
          ? msg.content && chunk.content.startsWith(msg.content)
            ? chunk.content
            : msg.content + chunk.content
          : msg.content

        let updatedToolCalls = msg.toolCalls || []
        if (chunk.tool) {
          const existingIndex = updatedToolCalls.findIndex((tc) =>
            isSameToolCall(tc, chunk.tool as ToolCall)
          )
          if (existingIndex >= 0) {
            updatedToolCalls = [
              ...updatedToolCalls.slice(0, existingIndex),
              chunk.tool as ToolCall,
              ...updatedToolCalls.slice(existingIndex + 1)
            ]
          } else {
            updatedToolCalls = [...updatedToolCalls, chunk.tool as ToolCall]
          }
        }
        let updatedBlocks = [...msg.blocks]

        // 「正在重试」过渡块仅在请求未恢复时展示：一旦真实内容/工具/智能体/压缩结果到达，
        // 说明重试已成功、模型开始正常输出，立即移除该过渡块
        const retryFinished =
          Boolean(chunk.content) ||
          Boolean(chunk.reasoning_content) ||
          Boolean(chunk.tool) ||
          Boolean(chunk.subAgent) ||
          Boolean(chunk.historyCompacted)
        if (retryFinished) {
          updatedBlocks = updatedBlocks.filter((b) => b.type !== 'retrying')
        }
        // 摘要压缩失败/放弃（全程没有 historyCompacted 结果）时，正文一旦开始就收起
        // 残留的「正在压缩早期对话…」过渡卡（避免压缩卡与正文并行误导）
        if (retryFinished && !updatedBlocks.some((b) => b.type === 'historyCompacted')) {
          updatedBlocks = updatedBlocks.filter((b) => b.type !== 'historyCompacting')
        }

        // 模型单次请求失败后在原调用处自动重试（不整轮重跑）：插入「正在重试」过渡行，
        // 只保留最新一次进度；已输出的历史内容与工具块原样保留（重试不会作废它们）
        if (chunk.retrying) {
          updatedBlocks = updatedBlocks.filter((b) => b.type !== 'retrying')
          updatedBlocks.push({
            type: 'retrying',
            retrying: { attempt: chunk.retrying.attempt, retries: chunk.retrying.retries }
          })
        }

        // 本轮热记忆注入：置于消息块最顶部（首个 chunk 到达，仅插入一次）
        if (chunk.memoryInjected) {
          const exists = updatedBlocks.some((b) => b.type === 'memoryInjected')
          if (!exists) {
            updatedBlocks.unshift({
              type: 'memoryInjected',
              memory: {
                user: chunk.memoryInjected.user,
                memory: chunk.memoryInjected.memory,
                usage: chunk.memoryInjected.usage
              }
            })
          }
        }

        // 摘要压缩开始：插入「压缩中」过渡块（仅当前轮展示，不落库；
        // 结果块到达后在原位置替换，压缩失败时随消息结束隐藏）
        if (chunk.historyCompacting) {
          const exists = updatedBlocks.some(
            (b) => b.type === 'historyCompacting' || b.type === 'historyCompacted'
          )
          if (!exists) {
            updatedBlocks.push({ type: 'historyCompacting' })
          }
        }

        // 本轮早期对话摘要压缩：紧随记忆注入块（正文流开始前到达，仅插入一次）
        if (chunk.historyCompacted) {
          const compacted = {
            type: 'historyCompacted' as const,
            compaction: {
              compressedCount: chunk.historyCompacted.compressedCount,
              retainedCount: chunk.historyCompacted.retainedCount,
              boundaryId: chunk.historyCompacted.boundaryId
            }
          }
          // 原地替换「压缩中」过渡块（保持卡片位置稳定）
          const compactingIdx = updatedBlocks.findIndex((b) => b.type === 'historyCompacting')
          if (compactingIdx >= 0) {
            updatedBlocks[compactingIdx] = compacted
          } else if (!updatedBlocks.some((b) => b.type === 'historyCompacted')) {
            updatedBlocks.push(compacted)
          }
        }

        if (chunk.reasoning_content) {
          const reasoningDelta = computeTextDelta(
            String(chunk.reasoning_content),
            msg.reasoning_content || ''
          )
          if (reasoningDelta) {
            const lastBlock = updatedBlocks[updatedBlocks.length - 1]
            if (lastBlock?.type === 'reasoning') {
              updatedBlocks[updatedBlocks.length - 1] = {
                type: 'reasoning',
                reasoning: (lastBlock.reasoning || '') + reasoningDelta
              }
            } else {
              pushBlock(updatedBlocks, { type: 'reasoning', reasoning: reasoningDelta })
            }
          }
        }

        if (chunk.content) {
          const contentDelta = computeTextDelta(String(chunk.content), msg.content || '')
          if (contentDelta) {
            const lastBlock = updatedBlocks[updatedBlocks.length - 1]
            if (lastBlock?.type === 'text') {
              updatedBlocks[updatedBlocks.length - 1] = {
                type: 'text',
                text: (lastBlock.text || '') + contentDelta
              }
            } else {
              pushBlock(updatedBlocks, { type: 'text', text: contentDelta })
            }
          }
        }

        if (chunk.tool) {
          if (chunk.tool.name !== 'task') {
            if (chunk.tool.status === 'completed') {
              for (let i = updatedBlocks.length - 1; i >= 0; i--) {
                const b = updatedBlocks[i]
                if (
                  b.type === 'tool' &&
                  b.tool &&
                  b.tool.status !== 'completed' &&
                  isSameToolCall(b.tool, chunk.tool)
                ) {
                  updatedBlocks[i] = {
                    type: 'tool',
                    tool: {
                      ...b.tool,
                      output: chunk.tool.output,
                      status: chunk.tool.status,
                      card: chunk.tool.card
                    }
                  }
                  break
                }
              }
            } else if (chunk.tool.status === 'preparing') {
              const exists = updatedBlocks.some(
                (b) =>
                  b.type === 'tool' && isSameToolCall(b.tool as ToolCall, chunk.tool as ToolCall)
              )
              if (!exists) {
                const blockTool = {
                  name: chunk.tool.name,
                  input: {},
                  output: '',
                  status: 'preparing' as const,
                  id: chunk.tool.id
                }
                pushBlock(updatedBlocks, { type: 'tool', tool: blockTool })
              }
            } else {
              let merged = false
              for (let i = updatedBlocks.length - 1; i >= 0; i--) {
                const b = updatedBlocks[i]
                if (
                  b.type === 'tool' &&
                  b.tool?.status === 'preparing' &&
                  isSameToolCall(b.tool, chunk.tool)
                ) {
                  updatedBlocks[i] = {
                    type: 'tool',
                    tool: {
                      name: chunk.tool.name,
                      input: chunk.tool.input,
                      output: '',
                      status: 'executing',
                      id: b.tool.id ?? chunk.tool.id
                    }
                  }
                  merged = true
                  break
                }
              }
              // 防御：部分 provider 首个工具块不携带工具名（以占位名 'tool' 登记）——
              // 未按名称匹配到 preparing 块时，并入最近的占位块并改名为真实工具名，
              // 避免「tool · 参数构建中…」幽灵块与真实工具块并存
              if (!merged) {
                const placeholderIdx = findPlaceholderPreparingTool(updatedBlocks)
                if (placeholderIdx >= 0) {
                  const b = updatedBlocks[placeholderIdx]
                  if (b.type === 'tool' && b.tool) {
                    updatedBlocks[placeholderIdx] = {
                      type: 'tool',
                      tool: {
                        name: chunk.tool.name,
                        input: chunk.tool.input,
                        output: '',
                        status: 'executing',
                        id: b.tool.id ?? chunk.tool.id
                      }
                    }
                    merged = true
                  }
                }
              }
              if (!merged) {
                const blockTool = {
                  name: chunk.tool.name,
                  input: chunk.tool.input,
                  output: chunk.tool.output,
                  status: (chunk.tool.status || 'executing') as ToolCall['status'],
                  id: chunk.tool.id
                }
                pushBlock(updatedBlocks, { type: 'tool', tool: blockTool })
              }
            }
          }
        }

        if (chunk.subAgent) {
          const sa = chunk.subAgent

          const findSaBlock = (): number => {
            for (let i = updatedBlocks.length - 1; i >= 0; i--) {
              const block = updatedBlocks[i]
              if (block.type !== 'subAgent' || !block.subAgent) continue
              if (sa.causeId && block.subAgent.causeId && block.subAgent.causeId === sa.causeId) {
                return i
              }
              if (block.subAgent.name === sa.name && (!sa.causeId || !block.subAgent.causeId)) {
                return i
              }
            }
            return -1
          }

          if (sa.status === 'started') {
            const idx = findSaBlock()
            if (idx < 0) {
              pushBlock(updatedBlocks, {
                type: 'subAgent',
                subAgent: {
                  name: sa.name,
                  causeId: sa.causeId,
                  status: 'started',
                  taskDescription: sa.taskDescription
                },
                children: []
              })
            } else {
              // 复制后更新：不改写与旧状态共享的 subAgent 对象（渲染/更新期就地改共享对象
              // 是文本自复制的隐患，统一走不可变替换）
              const existing = updatedBlocks[idx]
              const prevSa = existing.subAgent!
              updatedBlocks[idx] = {
                ...existing,
                subAgent: {
                  ...prevSa,
                  status: 'started',
                  taskDescription: prevSa.taskDescription || sa.taskDescription
                }
              }
            }
            if (sa.causeId) {
              activeCauseIds.add(sa.causeId)
            }
          } else if (sa.status === 'dispatched') {
            // 后台派发轻量卡：定格「已派发」，仅名称+简述+会话 id（结果在顶部栏查看）
            const idx = findSaBlock()
            if (idx < 0) {
              pushBlock(updatedBlocks, {
                type: 'subAgent',
                subAgent: {
                  name: sa.name,
                  causeId: sa.causeId,
                  status: 'dispatched',
                  taskDescription: sa.taskDescription,
                  subagentId: sa.subagentId
                },
                children: []
              })
            } else {
              const existing = updatedBlocks[idx]
              const prevSa = existing.subAgent!
              updatedBlocks[idx] = {
                ...existing,
                subAgent: {
                  ...prevSa,
                  status: 'dispatched',
                  taskDescription: prevSa.taskDescription || sa.taskDescription,
                  subagentId: sa.subagentId ?? prevSa.subagentId
                }
              }
            }
          } else if (sa.status === 'completed' || sa.status === 'error') {
            const idx = findSaBlock()
            if (idx >= 0) {
              const existing = updatedBlocks[idx]
              const prevSa = existing.subAgent!
              updatedBlocks[idx] = {
                ...existing,
                subAgent: {
                  ...prevSa,
                  status: sa.status,
                  output: sa.output ?? prevSa.output,
                  error: sa.error ?? prevSa.error,
                  taskDescription: prevSa.taskDescription || sa.taskDescription
                }
              }
            }
            if (sa.causeId) {
              activeCauseIds.delete(sa.causeId)
            }
          } else if (sa.content || sa.reasoning_content || sa.tool) {
            const idx = findSaBlock()
            let block: MessageBlock
            if (idx >= 0) {
              // 复制成新块后再就地更新：新块独占 subAgent 对象与 children 数组，
              // 后续对 block.subAgent/block.children 的写入不会污染与旧状态共享的对象
              const existing = updatedBlocks[idx]
              block = {
                ...existing,
                subAgent: { ...existing.subAgent! },
                children: existing.children ? [...existing.children] : []
              }
              updatedBlocks[idx] = block
            } else {
              block = {
                type: 'subAgent',
                subAgent: {
                  name: sa.name,
                  causeId: sa.causeId,
                  status: 'running',
                  taskDescription: sa.taskDescription
                },
                children: []
              }
              pushBlock(updatedBlocks, block)
            }
            if (block.subAgent!.status !== 'completed' && block.subAgent!.status !== 'error') {
              block.subAgent!.status = 'running'
            }
            block.subAgent!.taskDescription = block.subAgent!.taskDescription || sa.taskDescription
            if (!block.children) block.children = []

            if (sa.reasoning_content) {
              const totalPrevReasoning = block.children
                .filter((c) => c.type === 'reasoning')
                .map((c) => c.reasoning || '')
                .join('')
              const reasoningDelta = computeTextDelta(
                String(sa.reasoning_content),
                totalPrevReasoning
              )
              if (reasoningDelta) {
                const lastChild = block.children[block.children.length - 1]
                if (lastChild?.type === 'reasoning') {
                  block.children[block.children.length - 1] = {
                    type: 'reasoning',
                    reasoning: (lastChild.reasoning || '') + reasoningDelta
                  }
                } else {
                  pushBlock(block.children, { type: 'reasoning', reasoning: reasoningDelta })
                }
              }
            }

            if (sa.content) {
              const totalPrevText = block.children
                .filter((c) => c.type === 'text')
                .map((c) => c.text || '')
                .join('')
              const contentDelta = computeTextDelta(String(sa.content), totalPrevText)
              if (contentDelta) {
                const lastChild = block.children[block.children.length - 1]
                if (lastChild?.type === 'text') {
                  block.children[block.children.length - 1] = {
                    type: 'text',
                    text: (lastChild.text || '') + contentDelta
                  }
                } else {
                  pushBlock(block.children, { type: 'text', text: contentDelta })
                }
              }
            }

            if (sa.tool) {
              if (sa.tool.name !== 'task') {
                if (sa.tool.status === 'completed') {
                  for (let i = block.children.length - 1; i >= 0; i--) {
                    const c = block.children[i]
                    if (
                      c.type === 'tool' &&
                      c.tool &&
                      c.tool.status !== 'completed' &&
                      isSameToolCall(c.tool, sa.tool)
                    ) {
                      block.children[i] = {
                        type: 'tool',
                        tool: {
                          ...c.tool,
                          output: sa.tool.output,
                          status: sa.tool.status,
                          card: sa.tool.card
                        }
                      }
                      break
                    }
                  }
                } else if (sa.tool.status === 'preparing') {
                  const exists = block.children.some(
                    (c) =>
                      c.type === 'tool' && isSameToolCall(c.tool as ToolCall, sa.tool as ToolCall)
                  )
                  if (!exists) {
                    pushBlock(block.children, {
                      type: 'tool',
                      tool: {
                        name: sa.tool.name,
                        input: {},
                        output: '',
                        status: 'preparing',
                        id: sa.tool.id
                      }
                    })
                  }
                } else {
                  let merged = false
                  for (let i = block.children.length - 1; i >= 0; i--) {
                    const c = block.children[i]
                    if (
                      c.type === 'tool' &&
                      c.tool?.status === 'preparing' &&
                      isSameToolCall(c.tool, sa.tool)
                    ) {
                      block.children[i] = {
                        type: 'tool',
                        tool: {
                          name: sa.tool.name,
                          input: sa.tool.input,
                          output: '',
                          status: 'executing',
                          id: c.tool.id ?? sa.tool.id
                        }
                      }
                      merged = true
                      break
                    }
                  }
                  // 防御：部分 provider 首个工具块不携带工具名（以占位名 'tool' 登记）——
                  // 未按名称匹配到 preparing 块时，并入最近的占位块并改名为真实工具名
                  if (!merged) {
                    const placeholderIdx = findPlaceholderPreparingTool(block.children)
                    if (placeholderIdx >= 0) {
                      const c = block.children[placeholderIdx]
                      if (c.type === 'tool' && c.tool) {
                        block.children[placeholderIdx] = {
                          type: 'tool',
                          tool: {
                            name: sa.tool.name,
                            input: sa.tool.input,
                            output: '',
                            status: 'executing',
                            id: c.tool.id ?? sa.tool.id
                          }
                        }
                        merged = true
                      }
                    }
                  }
                  if (!merged) {
                    pushBlock(block.children, {
                      type: 'tool',
                      tool: {
                        name: sa.tool.name,
                        input: sa.tool.input,
                        output: sa.tool.output,
                        status: (sa.tool.status || 'executing') as ToolCall['status'],
                        id: sa.tool.id
                      }
                    })
                  }
                }
              }
            }
          }
        }

        /**
         * **流式期间不动折叠布局**（用户 2026-09-24：「还是出现内容从折叠里面移到外面，
         * 一会又被移进去」）：主进程随 chunk 下发的 `answer` 实时标记不再驱动布局——
         * 那时边界还没有定论（模型随时可能接着调工具，刚写的那句话就不是答复），
         * 一摘就会出现「先露到折叠外、再被收回折叠里」的来回搬。
         *
         * 布局只在 done 事件（下面的 done 分支）一次性按主进程的权威结论定格：
         * 折叠外只留**最终结果正文 + 紧挨着它的思考**，其余内容全部留在任务段折叠里
         * （第一个 write_todos 之前那段 2026-09-25 起不折叠、始终铺开）。
         */
        return {
          ...msg,
          content: updatedContent,
          blocks: updatedBlocks,
          toolCalls: updatedToolCalls.length > 0 ? updatedToolCalls : undefined,
          reasoning_content: updatedReasoning,
          // 瞬时字段：记录最后 chunk 时间戳，供静默指示（正在生成…）判定
          lastChunkAt: Date.now()
        }
      })
    },
    []
  )

  // ── 开始流式监听（每个 topic 独立） ──

  const startStreamListener = useCallback(
    (topicId: number, aiMessageId: string): void => {
      // 清理旧的监听器
      chunkCleanupsRef.current.get(topicId)?.()
      doneCleanupsRef.current.get(topicId)?.()
      errorCleanupsRef.current.get(topicId)?.()

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
          updatedMessages = applyChunkToMessages(updatedMessages, targetId, chunk, topicId)
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
        ({ topicId: doneTopicId, assistantDialogueId, userDialogueId, segments, turnFinal }) => {
          // 守卫：只处理本 topic 的完成事件（Set 分发可能导致旧 handler 收到其他 topic 的事件）
          if (doneTopicId !== topicId) return

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
        ({ error: errMsg, topicId: errorTopicId }) => {
          // 守卫：只处理本 topic 的错误
          if (errorTopicId !== topicId) return

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
    [applyChunkToMessages, syncLoadingTopics]
  )

  // ── 目标自动续跑轮监听（常驻，不随普通轮的 done 清理）──
  // 目标轮次驱动器在主进程发起新轮时先下发 goalRound 标记 chunk：
  // 挂载「自动续跑」用户消息 + 助手占位，并为本轮注册流监听（普通用户轮由 handleSend 挂载）。
  useEffect(() => {
    const cleanup = harnessApi.harness.onStreamChunk((chunk: StreamChunk) => {
      if (!chunk.goalRound) return
      const topicId = chunk.__topicId ?? 0
      if (!topicId) return
      const { round, objective } = chunk.goalRound

      const userMessage: Message = {
        id: `goal-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'user',
        content: objective,
        blocks: [{ type: 'goalRound', round }],
        timestamp: Date.now()
      }
      const aiMessageId = `goal-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const initialAiMessage: Message = {
        id: aiMessageId,
        role: 'assistant',
        content: '',
        blocks: [],
        timestamp: Date.now(),
        toolCalls: [],
        loading: true
      }

      // 标记加载状态（停止按钮可用、侧边栏转圈）
      isLoadingMapRef.current.set(topicId, true)
      syncLoadingTopics()
      if (currentTopicIdRef.current === topicId) {
        setIsLoading(true)
        setMessages((prev) => [...prev, userMessage, initialAiMessage])
      }

      // 更新会话缓存并启动本轮监听（后续 chunk 由本轮监听器处理）
      const session = sessionsRef.current.get(topicId)
      const base = session?.messages ?? []
      sessionsRef.current.set(topicId, {
        messages: [...base, userMessage, initialAiMessage],
        inputValue: session?.inputValue ?? '',
        attachments: session?.attachments ?? [],
        sessionId: aiMessageId
      })
      currentSessionIdRef.current = aiMessageId
      assistantIdByTopicRef.current.set(topicId, aiMessageId)
      startStreamListener(topicId, aiMessageId)
    })
    return cleanup
  }, [startStreamListener, syncLoadingTopics])

  // ── Handlers ──

  const handleNewHarness = useCallback((): void => {
    saveSessionToCache()
    setMessages([])
    setCurrentTopicId(null)
    currentTopicIdRef.current = null
    messagesBelongToTopicRef.current = null
    setInputValue('')
    setAttachments([])
    setIsLoading(false)
    // 切换/新建会话时放弃气泡内编辑状态（那条提问不属于新会话）
    setEditingOrphanId(null)
    // 新会话没有插话队列；当前段落指针也一并复位
    setQueuedMessages([])
    assistantIdByTopicRef.current.clear()
    // 普通「新建会话」不带插件记忆作用域（插件行 ＋ 会在之后把 id 放进来，见 harness-focus-input）
    pendingPluginIdRef.current = null
    // 记忆作用域同步归零：空会话 = 工作区那套（插件行 ＋ 是同步紧跟着派发的，会立刻改写回来）
    setMemoryScope(null)
  }, [saveSessionToCache])

  /**
   * 外部请求「开一个（可选带插件记忆作用域的）新会话，并把焦点放进输入框」（`harness-focus-input`）。
   *
   * 用途：侧栏「插件」模式的行上点 ＋ = 针对这份插件开新会话——新会话是空白的
   * （首个话题在首次发送时才落库），**刻意不预填任何文字**（用户口径 2026-09-28
   * 「我需要的是不要显示：给插件「个人记账台账」（id: personal-ledger）这个玩意」），
   * 只把光标送进输入框 + 记住这条会话该用**哪份插件的记忆**。
   */
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ pluginId?: string; focus?: boolean }>).detail
      const pluginId = detail?.pluginId
      pendingPluginIdRef.current = typeof pluginId === 'string' && pluginId ? pluginId : null
      // 还没有话题的这段时间里，界面（侧栏记忆块 / 设置 → 记忆）也要显示这份插件的记忆
      setMemoryScope(pendingPluginIdRef.current ? `plugin:${pendingPluginIdRef.current}` : null)
      // 切模式自动进入的那条空白会话只带作用域、不抢光标（用户只是在看插件这一侧的内容）
      if (detail?.focus !== false) setFocusInputToken((n) => n + 1)
    }
    window.addEventListener('harness-focus-input', handler)
    return () => window.removeEventListener('harness-focus-input', handler)
  }, [])

  const handleSelectTopic = useCallback(
    async (topic: HarnessTopicRow): Promise<void> => {
      // 不在加载时禁止切换，允许自由切换

      // 保存当前话题状态到缓存
      saveSessionToCache()

      // 切话题时放弃气泡内编辑状态：那条提问属于上一个话题
      setEditingOrphanId(null)

      // 选中的话题自带记忆作用域（存在话题行上，主进程按它走）→ 清掉「下一条新话题」的挂起值
      pendingPluginIdRef.current = null
      // 记忆跟着当前会话走：这条会话是插件会话就显示这份插件的记忆，否则回工作区
      // （重开应用后点开会话也认——作用域是话题行上存着的，不靠渲染层记得住）
      setMemoryScope(topic.memory_scope ?? null)

      currentTopicIdRef.current = topic.id
      setCurrentTopicId(topic.id)

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
    [saveSessionToCache, restoreSessionFromCache]
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
        const newTopicId = await harnessApi.harness.createTopic(
          workspaceId,
          title,
          undefined,
          undefined,
          // 分支出来的会话跟原会话用**同一套记忆**（否则从插件会话分出来的支会掉回工作记忆）
          getMemoryScope()
        )
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
    [messages, getActiveWorkspaceId, handleSelectTopic, refreshTopics, viewMessage, t]
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
        chunkCleanupsRef.current.get(topicId)?.()
        chunkCleanupsRef.current.delete(topicId)
        doneCleanupsRef.current.get(topicId)?.()
        doneCleanupsRef.current.delete(topicId)
        errorCleanupsRef.current.get(topicId)?.()
        errorCleanupsRef.current.delete(topicId)
        activeSubAgentCauseIdsRef.current.delete(topicId)
        assistantIdByTopicRef.current.delete(topicId)

        if (currentTopicIdRef.current === topicId) {
          handleNewHarness()
        }
        await refreshTopics()
      } catch (err) {
        console.error('Failed to delete topic:', err)
      }
    },
    [handleNewHarness, syncLoadingTopics]
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

  // 用 ref 持有最新消息快照（修复：handleDeleteMessagePair 此前依赖 [messages],流式期间
  // 每个 chunk 重建回调,作为 onDelete 传给全部消息组件击穿 React.memo → 每 chunk 全量重渲染历史消息）
  const messagesSnapshotRef = useRef<Message[]>([])
  messagesSnapshotRef.current = messages

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
          // 普通会话留空 = 跟工作区走（见 main/memory-scope.ts）
          const pluginId = pendingPluginIdRef.current
          const memoryScope = pluginId ? `plugin:${pluginId}` : null
          topicId = await harnessApi.harness.createTopic(
            workspaceId,
            title,
            undefined,
            undefined,
            memoryScope
          )
          // 作用域已经落进话题行，之后由主进程按话题读；用完就清，避免影响下一条新会话
          // （界面这一侧的作用域 store 保持不动：话题就是这条会话的作用域，等切会话时再改写）
          pendingPluginIdRef.current = null
          currentTopicIdRef.current = topicId
          setCurrentTopicId(topicId)
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

        // 标记加载状态
        isLoadingMapRef.current.set(topicId, true)
        syncLoadingTopics()
        setIsLoading(true)

        // 启动流监听（独立于当前对话窗口，持续更新缓存）
        startStreamListener(topicId, aiMessageId)

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

        harnessApi.harness.startMessageStream(userMessage.content, {
          images: currentImages.length > 0 ? currentImages : undefined,
          documents: currentDocuments.length > 0 ? currentDocuments : undefined,
          topicId,
          providerId: selectedProviderId ?? undefined,
          // 首段助手消息的前端临时 id：插话会切段，主进程按段回传库内行 id
          messageId: aiMessageId,
          // 编辑重发：让主进程改写这条已存在的用户消息行，而不是插入新行
          // （否则库里会多出一条同内容提问，历史顺序也被挪到末尾）
          reuseUserDialogueId:
            replaceIndex != null ? (resolveDialogueId(userMessage) ?? undefined) : undefined
        })
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
      refreshTopics,
      t
    ]
  )

  /** 输入框发送：空闲时直接开一轮；生成中则交给主进程收进插话队列 */
  const handleSend = useCallback(async (): Promise<void> => {
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
    // 或等本轮跑完自动接续。是否在跑由主进程裁决（多窗口/多话题下前端判断会失准）。
    // 新话题（还没有 topicId）必然没有回合在跑，走本地起轮路径。
    const topicId = currentTopicIdRef.current
    if (topicId != null && isLoadingMapRef.current.get(topicId)) {
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

    await startTurn({ userMessage, attachments: currentAttachments })
  }, [inputValue, attachments, startTurn])

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
            console.warn(`[Harness] 跳过删除：消息尚无库内 id（index=${idx}）`)
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
          // 会话空了 = 回到了空白态：记忆也回到工作区那套（下一条会话默认按工作区建）
          pendingPluginIdRef.current = null
          setMemoryScope(null)
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
    handleSteerQueued
  }
}
