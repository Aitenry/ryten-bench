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
import { mergeLoadedHistory } from '../../utils/harness/history-merge'
import {
  TURN_RECONCILE_POLL_MS,
  nextTurnReconcile,
  pickPersistedTurn
} from '../../utils/harness/turn-reconcile'
import {
  applySettledDialogue,
  ensureStreamTarget,
  isEmptyAssistantCard
} from '../../utils/harness/stream-target'
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
const MESSAGES_PAGE_SIZE = 20 // 10 message pairs

// ── Streaming chunk batching parameters (renderer OOM fix) ──────────────
// See startStreamListener below: high-frequency chunks are queued, then coalesced into one
// React commit per adaptive interval. The longer the message text, the more expensive each
// full markdown render, so the interval grows linearly with text length (capped at MAX below).
const CHUNK_FLUSH_BASE_INTERVAL_MS = 33 // regular flush interval (<= ~30 commits/s)
const CHUNK_FLUSH_MAX_INTERVAL_MS = 300 // adaptive cap for very long text
const CHUNK_FLUSH_INTERVAL_PER_CHAR_MS = 1 / 2000 // +1ms interval per 2k characters

const INPUT_HISTORY_STORAGE_KEY = 'rytenbench.harness.inputHistory'
const INPUT_HISTORY_MAX = 100
/**
 * Global input history cache (localStorage-backed module singleton, so storage is not
 * re-parsed on every render).
 */
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

/** Session cache state for each topic */
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
  /** Workspace id the topics belong to (null = not loaded yet) */
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
  /** Global input history (browse with Up/Down, recorded by handleSend, persisted in localStorage, max 100) */
  inputHistoryRef: { current: string[] }
  currentSessionIdRef: React.RefObject<string | null>
  currentTopicIdRef: React.RefObject<number | null>
  /** Whether the current session is archived (read-only: input hidden, sending rejected) */
  currentTopicArchived: boolean
  loadingTopicIds: Set<number>
  /**
   * Sessions currently blocked on a question / approval waiting for user confirmation (yellow
   * pulsing dot at the start of the sidebar row). It coexists with loadingTopicIds: when an
   * in-flight session suspends for confirmation, the yellow dot takes precedence.
   */
  awaitingTopicIds: Set<number>
  /**
   * Sessions that just finished naturally and have not been opened by the user yet (green
   * pulsing dot at the start of the sidebar row). The one displayed in the chat window when it
   * finishes is excluded (removed on completion); opening a session clears its dot, and the
   * state is never persisted.
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
      /** Reasoning effort of the current model (null = not set) */
      reasoningEffort: string | null
      /** Selectable effort levels declared by this model profile (empty array = not covered) */
      effortLevels: string[]
      /** Whether the current protocol actually sends the effort parameter (UI notes "record only" when unsupported) */
      effortControllable: boolean
    }[]
  }[]
  /** Topic pagination */
  topicsHasMore: boolean
  topicsLoading: boolean
  /** Full-table refresh in progress (not scroll pagination) */
  topicsRefreshing: boolean
  /** Message pagination (current topic) */
  messagesHasMore: boolean
  messagesLoadingMore: boolean
  handleSelectTopic: (
    topic: HarnessTopicRow,
    options?: { focusDialogueId?: number }
  ) => Promise<void>
  handleDeleteTopic: (topicId: number, e?: React.MouseEvent) => Promise<void>
  handleCopy: (text: string, id: string) => Promise<void>
  handleSend: () => Promise<void>
  /** Goal Enter: start an LLM turn from the goal text (reuses the normal send pipeline) */
  handleStartGoal: (objective: string) => Promise<void>
  handleNewHarness: () => void
  /** Incremented on every external "focus the input" request (see the harness-focus-input listener); the input uses it to place the caret */
  focusInputToken: number
  handleDeleteMessagePair: (msgIndex: number) => Promise<void>
  /** Enter **in-bubble** editing for an orphan question */
  handleStartEditMessage: (msgIndex: number) => void
  /** Submit in-bubble with Enter: replace the question in place and resend (no extra user bubble) */
  handleSubmitEditMessage: (msgIndex: number, content: string) => Promise<void>
  /** Cancel in-bubble editing (Esc) */
  handleCancelEditMessage: () => void
  /** Id of the question being edited in its bubble (used to render it in editable mode) */
  editingMessageId: string | null
  /** Branch: copy the messages up to upToIndex in the current topic into a new topic, then switch both the list and the view */
  handleBranchConversation: (upToIndex: number) => Promise<void>
  handleKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
  handleStop: () => void
  handleLoadMoreTopics: () => Promise<void>
  handleLoadMoreMessages: () => Promise<void>
  refreshTopics: () => Promise<void>
  /** Steering queue while generating (current topic) */
  queuedMessages: QueuedMessageView[]
  /** Steering text just merged into the current turn (transient feedback, disappears after 2.6s) */
  steeredNotice: string | null
  /** Delete one queued message */
  handleRemoveQueued: (itemId: string) => Promise<void>
  /** Rewrite the text of a queued message */
  handleUpdateQueued: (itemId: string, text: string) => Promise<void>
  /** Steer now: inject this queued message into the running turn */
  handleSteerQueued: (itemId: string) => Promise<void>
  /**
   * The current session's "run selection" for this turn (tools / skills / MCP, picked below the
   * input). Sent with startMessageStream on send and written back to the session by the main
   * process; null = use defaults.
   */
  agentSelection: AgentSelectionView | null
  setAgentSelection: React.Dispatch<React.SetStateAction<AgentSelectionView | null>>
  /**
   * **Draft value** for team collaboration in a blank session (no topic yet).
   *
   * Team collaboration is a topic-level switch (`harness_topic.team_mode`), while "new session"
   * starts blank and only calls `createTopic` on the first message (see `handleNewHarness` and
   * `startTurn`). So a toggle flipped in a blank session is recorded here first and persisted with
   * the INSERT when the topic is created; once a topic exists, the UI reads the topic's own value.
   */
  pendingTeamMode: boolean
  setPendingTeamMode: React.Dispatch<React.SetStateAction<boolean>>
  /**
   * Dialogue row id to jump to for a session-search hit (sidebar search → open the session and
   * scroll to that message with a highlight). HarnessMessageArea clears it via
   * `clearPendingJumpDialogueId` after consuming it, so switching topics again does not re-jump.
   */
  pendingJumpDialogueId: number | null
  setPendingJumpDialogueId: React.Dispatch<React.SetStateAction<number | null>>
  clearPendingJumpDialogueId: () => void
}

/**
 * Resolve a message's dialogue row id in the database.
 *
 * Messages during streaming use temporary ids (user messages `Date.now().toString()`, assistant
 * messages `timestamp_topic_random`); they are **not** harness_dialogue row ids, so deleting or
 * linking usage with them would hit nonexistent rows. Therefore: prefer the dialogueId returned
 * by the main process; otherwise accept only ids shaped like a small auto-increment integer
 * (timestamps are around 1.7e12 and are always treated as temporary ids).
 */
function resolveDialogueId(message: Message | undefined): number | null {
  if (!message) return null
  if (typeof message.dialogueId === 'number') return message.dialogueId
  const numeric = Number(message.id)
  return Number.isInteger(numeric) && numeric > 0 && numeric < 1e10 ? numeric : null
}

/**
 * User steering **does not alter the conversation flow**: it is a pure injection — the main
 * process merges it into the running turn without persisting it or splitting the assistant
 * message (there is an explicit requirement not to create new conversation content or DB rows).
 *
 * So on the renderer side steering chunks are only receipts and get filtered out: they carry
 * notice text rather than content / reasoning / tool data, and applying them one by one would
 * only trigger useless updates. (The "steered" transient feedback is handled by the queue bar.)
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
   * Counter for "put the focus in the input" requests (see the harness-focus-input listener
   * below). The input focuses based on it — content is untouched, so the user can type right
   * after clicking +.
   */
  const [focusInputToken, setFocusInputToken] = useState(0)
  // Session-level run selection (tools/skills/MCP): maintained by the selector row below the input and sent with each message
  const [agentSelection, setAgentSelection] = useState<AgentSelectionView | null>(null)
  /**
   * The same selection, mirrored into a ref so the **send path reads the value as of the click**.
   *
   * Why a ref: `startTurn` is a `useCallback`, so reading `agentSelection` directly freezes the
   * value at the last render in which one of its dependencies changed. In a **blank session** the
   * input does not persist the selection at all (there is no topic yet — see `persistSelection` in
   * HarnessInput), so the closure was the only carrier: after ticking tools and sending, the turn
   * still went out with `agentConfig: undefined` and the main process logged
   * `Tools for this turn: count=0 []`. The model then only had the always-mounted tools (goal /
   * memory) and, for a "summarize my spending every day" request, created a goal instead of a
   * scheduled task. A ref is assigned on every render, so it cannot go stale; the callback itself
   * keeps a stable identity (no extra re-renders, no dependency churn).
   */
  const agentSelectionRef = useRef<AgentSelectionView | null>(agentSelection)
  agentSelectionRef.current = agentSelection
  /**
   * Team collaboration draft value in a blank session (see `UseHarnessHandlersReturn.pendingTeamMode`).
   * Only meaningful while there is no topic: it is written into `team_mode` when the first
   * message creates the topic, then discarded.
   */
  const [pendingTeamMode, setPendingTeamMode] = useState(false)
  /**
   * Memory scope for the next **new topic** (`plugin:<id>` passed in from a plugin row's "+",
   * `chat` passed in from "chat" mode).
   *
   * Per the user's requirement on 2026-09-28, plugin memory must be independent: previously a
   * plugin conversation used the memory context selected in the workspace, which caused problems.
   * So when a plugin session creates a topic it writes `plugin:<id>` into
   * `harness_topic.memory_scope`, and afterwards (including after a restart) the main process
   * follows the scope stored on the topic (see main/memory-scope.ts); "chat" mode likewise writes
   * `chat` (that mode has no workspace, and its memory should not hang off a workspace).
   *
   * The three values mean different things — do not mix them up:
   * - `undefined` = **nobody is waiting**: use the scope stored on the current topic (the path for
   *   sending a second message into an existing session);
   * - `null` = explicitly want the **workspace** scope (written by a plain "new session" when
   *   clearing a previous pending value);
   * - string = this new topic wants `plugin:<id>` / `chat`.
   *
   * Only needed during the short window with no topic; it is cleared once the topic is created.
   */
  const pendingMemoryScopeRef = useRef<string | null | undefined>(undefined)
  const [availableTools, setAvailableTools] = useState<HarnessToolInfo[]>([])
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLDivElement>(null)
  /** Global input history (browse with Up/Down, recorded by handleSend, persisted in localStorage, max 100) */
  const inputHistoryRef = useRef<string[]>(loadInputHistory())
  const currentSessionIdRef = useRef<string | null>(null)

  /** Id of the currently active workspace */
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
   * After creating a topic in "chat" mode, make the UI follow the **new active working directory**.
   *
   * The main process already switched the active workspace to `<userData>/chat/<topic id>/` in
   * `harness-topic-create` (see ipc/harness-topic.ts), but that is the main process's setting; the
   * renderer's workspace path (explorer root, tool card → real path mapping) and the sidebar
   * active state re-read it from this event. Without it, files written by the first message would
   * open in the panel against the **previous** directory (reporting "file not found").
   */
  const notifyChatTopicActivated = useCallback((workspaceId: number): void => {
    if (!workspaceId) return
    window.dispatchEvent(new CustomEvent('workspace-changed', { detail: { workspaceId } }))
  }, [])

  /** Active agent causeId sets: routes agent events to the correct block */
  const activeSubAgentCauseIdsRef = useRef<Map<number, Set<string>>>(new Map())
  /** Get (or create) a topic's set of running subagent causeIds (used when merging task subagent blocks from chunks) */
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
   * Whether the current session is **archived** (read-only): the input is hidden and sending is
   * rejected once opened (user requirement, 2026-11-25: archived content is view-only). The state
   * feeds rendering; the ref feeds callbacks (avoiding stale closure values).
   */
  const [currentTopicArchived, setCurrentTopicArchived] = useState(false)
  const currentTopicArchivedRef = useRef(false)
  /** Write both state and ref together: they must always change in sync */
  const markTopicArchived = useCallback((archived: boolean): void => {
    currentTopicArchivedRef.current = archived
    setCurrentTopicArchived(archived)
  }, [])
  /**
   * The sidebar notifies this hook when the archive state changes (archive / unarchive): if the
   * change targets the current session, sync the read-only state. Otherwise the input would not
   * come back after unarchiving, or an archived session could still keep sending.
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
   * Whether the chat page (`/harness`) is currently shown in the main content area.
   *
   * The green dot must depend on "is this session on screen right now", not just
   * currentTopicId: when the user switches to the library / plugin store, the chat window is not
   * on screen, so a finished session should still notify. It is read when a completion event
   * arrives (see conversationVisibleRef below), hence the ref holds the latest value.
   */
  const location = useLocation()
  const conversationVisible =
    location.pathname === '/harness' || location.pathname.startsWith('/harness/')
  const conversationVisibleRef = useRef(conversationVisible)
  conversationVisibleRef.current = conversationVisible
  /** Which topic the messages React state actually belongs to — detects cross-topic pollution during handleSelectTopic's async gap */
  const messagesBelongToTopicRef = useRef<number | null>(null)
  // Hold the latest message snapshot in a ref (fix: handleDeleteMessagePair used to depend on
  // [messages]; during streaming each chunk rebuilt the callback, breaking React.memo for every
  // message component via onDelete → full re-render of the history on every chunk).
  // Declared early: mounting main-process-initiated turns (mountExternalTurn) also reads it as a
  // fallback for the session cache.
  const messagesSnapshotRef = useRef<Message[]>([])
  messagesSnapshotRef.current = messages
  const [topics, setTopics] = useState<HarnessTopicRow[]>([])
  /** Message to jump to after a session-search hit (dialogueId); MessageArea clears it once scrolled into place */
  const [pendingJumpDialogueId, setPendingJumpDialogueId] = useState<number | null>(null)
  const clearPendingJumpDialogueId = useCallback((): void => {
    setPendingJumpDialogueId(null)
  }, [])
  /** Which workspace the topics currently belong to (keeps an old list from being attached to a new workspace when switching) */
  const [topicsWorkspaceId, setTopicsWorkspaceId] = useState<number | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [providers, setProviders] = useState<LlmProviderConfig[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState<number | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [loadingTopicIds, setLoadingTopicIds] = useState<Set<number>>(new Set())
  /**
   * The other two ends of the sidebar row indicator: waiting for user confirmation (yellow) /
   * just completed (green). "In progress" is not here (see loadingTopicIds); the transition rules
   * for all three live in useTopicRunStatus.
   *
   * `isTopicActive` implements "do not light the green dot when the current chat window
   * finishes" (user requirement, 2026-11-23: remove it automatically if this is the current
   * session window). When a completion event arrives it reads "current topic + is the chat page
   * visible" from refs, so a result the user is already watching needs no green dot; if the user
   * is on another page such as the library / plugin store, the chat window is not in sight and
   * the green dot still shows.
   */
  const { awaitingTopicIds, completedTopicIds, beginTopicTurn, acknowledgeTopic, forgetTopic } =
    useTopicRunStatus({
      isTopicActive: (topicId) =>
        currentTopicIdRef.current === topicId && conversationVisibleRef.current
    })
  /** Id of the question being edited in its bubble (used to render the bubble in editable mode) */
  const [editingOrphanId, setEditingOrphanId] = useState<string | null>(null)

  // ── Steering queue while generating (main process is the single source of truth; only a mirror of the current topic is kept here) ──
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessageView[]>([])
  /** Steering text just merged into the current turn (2.6s transient feedback only; not persisted, not added to the conversation flow) */
  const [steeredNotice, setSteeredNotice] = useState<string | null>(null)
  const steeredNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** topicId → id of the assistant segment currently streaming for that topic (steering splits
   *  segments, and this locates the one to finalize). Bucketed by topic: several topics may
   *  stream at once, and a shared ref would finalize the wrong bubble. */
  const assistantIdByTopicRef = useRef<Map<number, string>>(new Map())

  // ── Pagination state ──
  const [topicsPage, setTopicsPage] = useState(0)
  const [topicsHasMore, setTopicsHasMore] = useState(true)
  const [topicsLoading, setTopicsLoading] = useState(false)
  /** "Full-table refresh" in progress (distinct from scroll pagination, so the bottom paging spinner does not flash when switching workspaces) */
  const [topicsRefreshing, setTopicsRefreshing] = useState(false)
  const [messagesPage, setMessagesPage] = useState(0)
  const [messagesHasMore, setMessagesHasMore] = useState(true)
  const [messagesLoadingMore, setMessagesLoadingMore] = useState(false)
  /**
   * Sequence number for session-list refreshes: only the **last initiated** request may write its
   * result back to `topics`.
   *
   * On startup restore / rapid workspace clicks, several "switch workspace" flows run almost
   * simultaneously (each refetches the list) and their IPC round-trip order is not guaranteed:
   * an earlier request can return last and write `topicsWorkspaceId` back to the **previous**
   * workspace. The sidebar then renders by "active workspace" and waits forever for that
   * workspace's list, stuck on the loading skeleton (the 5 grey rows under the plugin row in the
   * user's 2026-11-22 screenshot).
   */
  const topicsRefreshSeqRef = useRef(0)

  // ── Multi-session support ──
  const sessionsRef = useRef<Map<number, SessionState>>(new Map())
  /** Loading state per topicId */
  const isLoadingMapRef = useRef<Map<number, boolean>>(new Map())
  /** Stream chunk cleanup function per topicId */
  const chunkCleanupsRef = useRef<Map<number, () => void>>(new Map())
  /** Stream done cleanup function per topicId */
  const doneCleanupsRef = useRef<Map<number, () => void>>(new Map())
  /** Stream error cleanup function per topicId */
  const errorCleanupsRef = useRef<Map<number, () => void>>(new Map())

  // ── Steering queue sync ──
  // The main process is the single source of truth for the queue: subscribe to broadcasts here
  // and fetch once when switching topics. No optimistic local add/remove, which would duplicate
  // queue rows (added locally on enqueue, then added again when the broadcast arrives).
  const applyQueue = useCallback((topicId: number, queue: QueuedMessageView[]): void => {
    if (currentTopicIdRef.current !== topicId) return
    setQueuedMessages(queue)
  }, [])

  useEffect(() => {
    const api = harnessApi.harness
    const offUpdated = api.onQueueUpdated(({ topicId, queue }) => applyQueue(topicId, queue))
    const offSteered = api.onQueueSteered(({ topicId, itemId, text }) => {
      // Steering is a pure injection: no conversation-flow bubble is produced. Here we only drop
      // that row from the queue mirror and show a transient "steered" notice proving it was
      // merged into the current turn
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

  /** Fetch the topic's queue after switching (broadcasts cover changes, not switches) */
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

  /** Sync isLoadingMapRef into the loadingTopicIds state */
  const syncLoadingTopics = useCallback((): void => {
    setLoadingTopicIds(new Set(isLoadingMapRef.current.keys()))
  }, [])

  // Welcome typewriter: see components/WelcomeIntro.tsx (high-frequency / infinite animations are
  // not placed here, otherwise the whole chat view would re-render ~25 times per second)

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

        // Model: prefer the default provider
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
      // A newer refresh was started meanwhile: this result is stale and must not overwrite it
      // (otherwise `topicsWorkspaceId` would be written back to the old workspace and the sidebar
      // would never receive the active workspace's list)
      if (seq !== topicsRefreshSeqRef.current) return
      setTopics(result.items)
      // Tag which workspace these topics belong to: when switching workspaces, the old list must not be attached under the new workspace row
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
   * Workspace switch (including plugin rows / "modify in chat" / "chat" mode) → refetch the
   * session list.
   *
   * The subscription must live in the Provider (always mounted with the app), not in the chat
   * page: almost all workspace-switch entry points are in `/plugins` (plugin store / plugin
   * detail) or the persistent sidebar, where the user is not on `/harness`. This subscription
   * used to live in `pages/Harness.tsx`, so leaving the chat page meant nobody handled the event
   * ⇒ `topics` stayed stuck on the previous workspace, and the "expanded active workspace" in the
   * sidebar never received its own session list, remaining on the skeleton (this is what the user
   * reported on 2026-11-22: the 5 grey rows under the plugin row never moved).
   *
   * `refreshTopics` reads the active workspace from the **settings** itself, so it does not
   * depend on the event detail; concurrency / out-of-order responses are handled by
   * `topicsRefreshSeqRef`.
   */
  useEffect(() => {
    const onWorkspaceChanged = (): void => {
      refreshTopics().then()
    }
    window.addEventListener('workspace-changed', onWorkspaceChanged)
    return () => window.removeEventListener('workspace-changed', onWorkspaceChanged)
  }, [refreshTopics])

  // Clean up all stream listeners on unmount
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

  // ── Session cache management ──

  /** Save the current chat window state to the cache */
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

  /** Restore a session from the cache into the current chat window */
  const restoreSessionFromCache = useCallback((topicId: number): boolean => {
    const cached = sessionsRef.current.get(topicId)
    if (!cached) return false
    setMessages(cached.messages)
    setInputValue(cached.inputValue)
    setAttachments(cached.attachments)
    currentSessionIdRef.current = cached.sessionId
    return true
  }, [])

  // ── Start stream listeners (independent per topic) ──

  /**
   * @param expectedTurnId turn id for this listener (sent by the main process). When provided,
   *   only its events are handled; when omitted (locally initiated turns do not know the id at
   *   registration time), the listener locks onto the turn of the **first arriving chunk** and
   *   drops chunks / done / error from other turns — two overlapping turns on one topic would
   *   scramble the output.
   */
  const startStreamListener = useCallback(
    (topicId: number, aiMessageId: string, expectedTurnId?: number): void => {
      // Clean up old listeners
      chunkCleanupsRef.current.get(topicId)?.()
      doneCleanupsRef.current.get(topicId)?.()
      errorCleanupsRef.current.get(topicId)?.()

      /** Turn guard: drop chunks / done / error that do not belong to this turn (see utils/harness/turn-guard) */
      const matchesTurn = createTurnGuard(expectedTurnId)

      // Frontend temporary id for this turn's assistant message: the whole stream goes into this one bubble
      assistantIdByTopicRef.current.set(topicId, aiMessageId)

      // ── Streaming chunk batching (renderer OOM fix) ──────────────────
      // Previously every arriving chunk IPC triggered an immediate full re-render of the whole
      // message: ReactMarkdown parsing + syntax highlighting + KaTeX over the entire text, which
      // is O(L²) for a very long reply, saturating the main thread, starving GC and backing up
      // IPC events until the renderer was OOM-killed. Batching queues high-frequency chunks and
      // coalesces them into "one session update + one React commit" per interval — commits drop
      // from one per chunk to ~30/s or less, while content is still appended chunk by chunk in
      // arrival order (consistent with the existing incremental/dedup contract: nothing lost,
      // semantics unchanged).
      let pendingChunks: StreamChunk[] = []
      let flushTimer: ReturnType<typeof setTimeout> | null = null
      let flushIntervalMs = CHUNK_FLUSH_BASE_INTERVAL_MS

      /** Drain the backlog: apply chunks one by one in order, with a single session-cache write + one React commit */
      const applyPendingChunks = (): void => {
        flushTimer = null
        if (pendingChunks.length === 0) return
        /**
         * The cache can disappear **mid-turn** (topic switch, a queued-send rollback, another
         * turn's completion). This used to `return` and silently discard the entire remaining
         * stream: the bubble stayed at "generating…" forever while the main process kept
         * producing content (production 2026-11-28, topic 6 / dialogue 98: 155 blocks persisted,
         * nothing rendered). Rebuild the cache from the live list instead of dropping the batch.
         */
        let session = sessionsRef.current.get(topicId)
        if (!session) {
          const base = currentTopicIdRef.current === topicId ? messagesSnapshotRef.current : []
          console.warn(
            `[Stream] Session cache missing for topic ${topicId}; rebuilding from ${base.length} visible message(s)`
          )
          session = { messages: [...base], inputValue: '', attachments: [], sessionId: aiMessageId }
          sessionsRef.current.set(topicId, session)
        }
        // First coalesce same-kind "cumulative" deltas: applying per chunk copies the whole text
        // at every step (O(L²)); after coalescing each batch copies it once (O(F×L)). Deltas
        // already in incremental form are kept as-is, so semantics do not change.
        const coalesced = coalesceChunks(pendingChunks)
        pendingChunks = []
        const startedAt = performance.now()
        // Steering receipts (steered) are filtered out: they do not change the conversation flow
        // (see isSteerChunk), and the assistant message keeps accumulating in the same bubble —
        // a question/answer turn always has exactly one assistant message
        const dataChunks = coalesced.filter((chunk) => !isSteerChunk(chunk))
        const targetId = assistantIdByTopicRef.current.get(topicId) ?? aiMessageId
        // `applyChunkToMessages` only maps over existing messages: a missing target id is a silent
        // no-op, which is indistinguishable from "the model produced nothing". Guarantee the bubble
        // exists before applying, so a batch always lands somewhere visible.
        let updatedMessages = ensureStreamTarget(session.messages, targetId)
        if (updatedMessages !== session.messages) {
          console.warn(
            `[Stream] Streaming target ${targetId} missing from topic ${topicId}'s list; mounting it`
          )
        }
        for (const chunk of dataChunks) {
          updatedMessages = applyChunkToMessages(
            updatedMessages,
            targetId,
            chunk,
            activeCauseIdsFor(topicId)
          )
        }
        sessionsRef.current.set(topicId, { ...session, messages: updatedMessages })
        // Update React state directly from the session cache result
        // (avoids duplicate blocks when StrictMode double-invokes the setMessages(prev => ...)
        // updater)
        if (currentTopicIdRef.current === topicId) {
          setMessages(updatedMessages)
        }
        // Adaptive interval: the longer the text, the more expensive each full render, so the
        // interval grows linearly with length; the time taken by this batch (tool/agent-heavy
        // batches) also widens it, giving the main thread and GC room to breathe
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
        // Chunks that arrived while draining are already re-queued, so reschedule immediately
        scheduleFlush()
      }

      /** Schedule a drain timer if none is pending */
      const scheduleFlush = (): void => {
        if (flushTimer != null || pendingChunks.length === 0) return
        flushTimer = setTimeout(applyPendingChunks, flushIntervalMs)
      }

      const chunkCleanup = harnessApi.harness.onStreamChunk((chunk: StreamChunk) => {
        // topicId guard: only handle chunks for this topic (the Set-based dispatch delivers every chunk to every handler)
        if (chunk.__topicId !== topicId) return
        // Turn guard: drop chunks outside this turn (late events from the previous turn / concurrent other turns)
        if (!matchesTurn(chunk.__turnId)) return
        // No "session cache present?" check here: the cache is rebuilt from the live list inside
        // applyPendingChunks, so a cache that was dropped mid-turn cannot swallow the stream.
        pendingChunks.push(chunk)
        scheduleFlush()
      })
      // Drain the backlog before unregistering (done/error/topic deletion paths) so the last piece of content is not lost
      chunkCleanupsRef.current.set(topicId, () => {
        applyPendingChunks()
        chunkCleanup()
      })

      /**
       * Fill an empty settled card with the content the main process already persisted.
       *
       * The renderer has no stream replay: once a turn's events are missed there is no way to get
       * them back except the database. Reading the row back is what makes "the page says generating
       * forever, but the answer exists" self-correcting instead of requiring a topic switch.
       */
      const reloadSettledTurn = async (
        turnTopicId: number,
        targetId: string,
        dialogueId: number
      ): Promise<void> => {
        try {
          const page = await harnessApi.harness.getDialoguesByTopicPaginated(turnTopicId, 0, 40)
          const row = page.items.find((item) => item.id === dialogueId)
          if (!row) return
          console.warn(
            `[Stream] Recovered settled dialogue ${row.id} for topic ${turnTopicId} from the database (live stream was lost)`
          )
          setMessages((prev) => applySettledDialogue(prev, targetId, row))
        } catch (error) {
          console.warn('[Stream] Failed to recover the settled turn from the database:', error)
        }
      }

      const doneCleanup = harnessApi.harness.onStreamDone(
        ({
          topicId: doneTopicId,
          turnId: doneTurnId,
          assistantDialogueId,
          userDialogueId,
          segments,
          turnFinal
        }) => {
          // Guard: only handle completion events for this topic (Set dispatch may deliver other topics' events to old handlers)
          if (doneTopicId !== topicId) return
          // Turn guard: another turn's finish event must not close this turn (otherwise a running turn would be cut short)
          if (!matchesTurn(doneTurnId)) return

          // Drain the backlog first: the done event may arrive in the same tick as the last
          // chunk batch, and without draining, the trailing text would be lost (the session
          // cache is cleared right after)
          applyPendingChunks()

          /**
           * Self-heal: when this turn's bubble is still empty, the renderer lost the stream (see
           * the 2026-11-28 production incident: 155 blocks and 1107 characters were persisted as
           * dialogue 98 while the screen kept showing "generating…" and never even received the
           * done event). The content is never lost — it is already in the database — so the card is
           * filled from the persisted row instead of leaving an empty answer on screen.
           *
           * Captured **before** the cache is cleared below, and applied after the settle commit.
           */
          const liveTargetId = assistantIdByTopicRef.current.get(doneTopicId) ?? aiMessageId
          const liveTarget = sessionsRef.current
            .get(doneTopicId)
            ?.messages.find((msg) => msg.id === liveTargetId)
          // Only recover when the main process named **this turn's** row: using "the newest
          // assistant row" instead could fill the card with a previous turn's answer.
          const needsRecovery =
            assistantDialogueId != null && isEmptyAssistantCard(liveTarget)

          // Clear the loading state for this topic
          isLoadingMapRef.current.delete(doneTopicId)
          syncLoadingTopics()

          // Clear the cache on completion (switching back later reads the database directly)
          sessionsRef.current.delete(doneTopicId)

          // Clean up agent tracking
          activeSubAgentCauseIdsRef.current.delete(doneTopicId)
          // This turn's segment pointer is done: clear it so the next turn cannot reuse the stale temporary id
          assistantIdByTopicRef.current.delete(doneTopicId)

          // Clean up the stream listeners (doneCleanup itself is cleared by startStreamListener L575-576 when the same topic starts again)
          chunkCleanupsRef.current.get(doneTopicId)?.()
          chunkCleanupsRef.current.delete(doneTopicId)
          doneCleanupsRef.current.delete(doneTopicId)
          errorCleanupsRef.current.get(doneTopicId)?.()
          errorCleanupsRef.current.delete(doneTopicId)

          // Refresh the topic list
          refreshTopics().then()

          // If this is the currently displayed topic, update the UI
          if (currentTopicIdRef.current === doneTopicId) {
            setIsLoading(false)
            setMessages((prev) => {
              // This turn persists two messages: the last streaming assistant message and the
              // user message before it. Both need their DB row ids — deleting "this turn" works
              // by id, and attaching only the assistant id would leave the user row in the
              // database (looking like "only the assistant was deleted")
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
              // After steering splits segments, each assistant segment maps to one DB row: attach
              // it precisely by messageId; without a segment table (old path), fall back to
              // attaching assistantDialogueId to the last loading message
              const segmentIds = new Map(
                (segments ?? [])
                  .filter((seg) => seg.dialogueId != null)
                  .map((seg) => [seg.messageId, seg.dialogueId as number])
              )
              return prev.map((msg, i) => {
                if (msg.loading) {
                  // As a fallback on finish, remove the "retrying" transitional block (the success
                  // path already removed it on the first data chunk; this covers aborts / exhausted
                  // retries where no data arrived) — **filter before computing answer bounds**,
                  // otherwise renderer-only transitional blocks offset the "last N blocks" count
                  const settledBlocks = msg.blocks.filter((b) => b.type !== 'retrying')
                  return {
                    ...msg,
                    loading: false,
                    /**
                     * Final state of this turn: the main process gives the authoritative verdict in
                     * the done event (TurnFinal).
                     *
                     * `answerBlocks` is the number of blocks in the final answer (0 = no answer this
                     * turn). It is a **count** rather than an index because the two sides can have
                     * different block counts (the renderer merges adjacent reasoning and has
                     * transitional blocks); when the count does not match the local array,
                     * answerTailIndices returns undefined and we fall back to the old behaviour —
                     * never truncating incorrectly. Missing turnFinal (older main process) also
                     * changes nothing.
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

          if (needsRecovery && assistantDialogueId != null) {
            void reloadSettledTurn(doneTopicId, liveTargetId, assistantDialogueId)
          }
        }
      )
      doneCleanupsRef.current.set(topicId, doneCleanup)

      // Register the stream error listener: startup errors such as a missing or disabled model
      const errorCleanup = harnessApi.harness.onStreamError(
        ({ error: errMsg, topicId: errorTopicId, turnId: errorTurnId }) => {
          // Guard: only handle errors for this topic
          if (errorTopicId !== topicId) return
          // Turn guard: another turn's error must not overwrite this turn's content
          if (!matchesTurn(errorTurnId)) return

          // Drain the backlog first, then replace it with the error message, avoiding a race with the last batch of text
          applyPendingChunks()

          console.error(`[Stream] Error for topic ${topicId}: ${errMsg}`)

          // Replace the cached AI message with the error text (the active segment may be a continuation after a steering split)
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

          // If this topic is currently displayed, update React state in sync
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

  /**
   * Settle a turn the renderer believes is still running but the main process has already finished.
   *
   * This is the second half of the 2026-11-28 incident: the stream can lose **every** event,
   * including `done`, and `isLoading` is only ever cleared by a stream event — so the screen kept
   * showing "generating…" with the stop button lit long after the turn had ended (and its answer
   * had been persisted). Nothing else in the renderer can prove the turn is over; the main
   * process's turn state is the only witness that survives a lost stream, so it is the trigger here.
   *
   * What it does: clear the loading flags, drop the stale listeners/cache of that turn, then fill
   * the empty card from the persisted row — or remove the empty card when the turn persisted
   * nothing (a blank answer is not a state the user can act on).
   */
  const settleLostTurn = useCallback(
    (topicId: number): void => {
      const targetId = assistantIdByTopicRef.current.get(topicId) ?? null
      const session = sessionsRef.current.get(topicId)
      const target =
        targetId != null && session ? session.messages.find((msg) => msg.id === targetId) : undefined
      // When the turn started: used to decide whether a persisted row can be this turn's answer
      const startedAt = target?.timestamp ?? Date.now()

      console.warn(
        `[Stream] Turn for topic ${topicId} is no longer running but the UI still shows "generating"; settling it`
      )

      // Drop the lost turn's listeners first: their cleanup drains queued chunks (the tail of the
      // answer may still be worth showing) and unregisters them so a later turn is not fed by them.
      chunkCleanupsRef.current.get(topicId)?.()
      chunkCleanupsRef.current.delete(topicId)
      doneCleanupsRef.current.get(topicId)?.()
      doneCleanupsRef.current.delete(topicId)
      errorCleanupsRef.current.get(topicId)?.()
      errorCleanupsRef.current.delete(topicId)

      isLoadingMapRef.current.delete(topicId)
      syncLoadingTopics()
      if (currentTopicIdRef.current === topicId) setIsLoading(false)

      assistantIdByTopicRef.current.delete(topicId)
      activeSubAgentCauseIdsRef.current.delete(topicId)
      sessionsRef.current.delete(topicId)

      if (currentTopicIdRef.current === topicId) {
        setMessages((prev) => prev.map((msg) => (msg.loading ? { ...msg, loading: false } : msg)))
      }
      refreshTopics().then()

      if (targetId == null) return
      void (async () => {
        try {
          const page = await harnessApi.harness.getDialoguesByTopicPaginated(topicId, 0, 40)
          if (currentTopicIdRef.current !== topicId) return
          const row = pickPersistedTurn(page.items, startedAt)
          if (row) {
            console.warn(
              `[Stream] Recovered settled dialogue ${row.id} for topic ${topicId} from the database (turn ended without a done event)`
            )
            setMessages((prev) => applySettledDialogue(prev, targetId, row))
            return
          }
          // Nothing was persisted for this turn: an empty answer card would just spin forever
          setMessages((prev) => prev.filter((msg) => !(msg.id === targetId && isEmptyAssistantCard(msg))))
        } catch (error) {
          console.warn('[Stream] Failed to settle the lost turn from the database:', error)
        }
      })()
    },
    [refreshTopics, syncLoadingTopics]
  )

  /**
   * Reconciliation watchdog: while any topic claims to be generating, ask the main process (the
   * only surviving witness) whether a turn is really running there. A turn that ended without a
   * `done` reaching this window is settled — see {@link settleLostTurn}.
   *
   * A single interval covers every topic; it costs nothing while nothing is loading, and it is
   * deliberately conservative (several consecutive "not running" answers plus a minimum loading
   * age) so the few-millisecond gap between a goal round and its continuation cannot cut a turn.
   *
   * The callback goes through a ref and the effect has no dependencies: recreating the interval on
   * every render would reset the "how long has this been loading" bookkeeping and the watchdog
   * could then never accumulate enough age to act.
   */
  const settleLostTurnRef = useRef(settleLostTurn)
  settleLostTurnRef.current = settleLostTurn

  useEffect(() => {
    const strikes = new Map<number, number>()
    const loadingSince = new Map<number, number>()
    let busy = false

    const timer = setInterval(() => {
      // Forget bookkeeping for topics that stopped loading (done / error / user stop arrived)
      for (const id of [...loadingSince.keys()]) {
        if (!isLoadingMapRef.current.has(id)) {
          loadingSince.delete(id)
          strikes.delete(id)
        }
      }
      if (isLoadingMapRef.current.size === 0 || busy) return

      busy = true
      const topicIds = [...isLoadingMapRef.current.keys()]
      void (async () => {
        try {
          for (const topicId of topicIds) {
            if (!loadingSince.has(topicId)) loadingSince.set(topicId, Date.now())
            const state = await harnessApi.harness.getTurnState(topicId).catch(() => null)
            // No answer is not evidence of a dead turn: keep waiting
            if (!state) continue
            // Last proof of life for this turn: a live stream keeps bumping `lastChunkAt`, so data
            // still arriving always wins over a stale "not running" reading. The bubble is looked
            // up in the cache first and in the live list second — a lost stream may have dropped
            // the cache, and then only the on-screen list can still answer "when did we last hear
            // from this turn".
            const targetId = assistantIdByTopicRef.current.get(topicId)
            const list =
              sessionsRef.current.get(topicId)?.messages ??
              (currentTopicIdRef.current === topicId ? messagesSnapshotRef.current : [])
            const target =
              targetId != null ? list.find((msg) => msg.id === targetId) : undefined
            const lastActivity = target ? (target.lastChunkAt ?? target.timestamp) : null
            const decision = nextTurnReconcile({
              active: state.active,
              loadingForMs: Date.now() - (loadingSince.get(topicId) ?? Date.now()),
              inactiveStrikes: strikes.get(topicId) ?? 0,
              msSinceLastChunk: lastActivity == null ? undefined : Date.now() - lastActivity
            })
            strikes.set(topicId, decision.strikes)
            if (!decision.settle) continue
            strikes.delete(topicId)
            loadingSince.delete(topicId)
            settleLostTurnRef.current(topicId)
          }
        } finally {
          busy = false
        }
      })()
    }, TURN_RECONCILE_POLL_MS)

    return () => clearInterval(timer)
  }, [])

  // ── Listeners for turns initiated by the main process (always mounted; not cleared by a normal turn's done) ──
  //
  // Neither kind of turn involves the user clicking "send", so the renderer has no local placeholder:
  // - goalRound: automatic continuation round for a goal;
  // - queueTurn: a queued message automatically sent when the previous turn ends.
  // The main process sends a marker chunk at the start of the stream; on that basis we mount the
  // user message + assistant placeholder and register this turn's stream listener — without this
  // step the messages run while the UI shows nothing (the direct cause of the old "queued message
  // not sent" bug).
  useEffect(() => {
    /**
     * Mount a main-process-initiated turn: user message + assistant placeholder + loading state +
     * stream listener. Shared by both markers (they differ only in the user message's display
     * blocks and the temporary id prefix).
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

      // Mark the loading state (stop button enabled, sidebar spinner)
      // This turn has really started: clear any green / yellow dot left over from the previous turn
      beginTopicTurn(topicId)
      isLoadingMapRef.current.set(topicId, true)
      syncLoadingTopics()
      if (currentTopicIdRef.current === topicId) {
        setIsLoading(true)
        setMessages((prev) => [...prev, userMessage, initialAiMessage])
      }

      // Update the session cache and start this turn's listener (later chunks are handled by it)
      // The cache may have been cleared when the previous turn finished: when this topic is
      // currently displayed, fall back to the React list; otherwise the first chunk of this turn
      // would replace the whole visible message history
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
        // Queued turns have no dataURL (attachment contents live only in the main process queue):
        // listing file names here is enough — the bubble only explains what the message is, and
        // the real attachments are sent with the request
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

      // Scheduled-task turn: the text is the message delivered by the main process (same as what
      // is persisted), so the live bubble matches the history after refresh
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
    // A new session is never archived: clear the read-only flag so the input returns
    currentTopicArchivedRef.current = false
    setCurrentTopicArchived(false)
    messagesBelongToTopicRef.current = null
    setInputValue('')
    setAttachments([])
    setIsLoading(false)
    // A new session resets to "off by default": the draft only served the previous session and is not inherited
    setPendingTeamMode(false)
    // Abandon in-bubble editing when switching / creating a session (that question does not belong to the new session)
    setEditingOrphanId(null)
    // A new session has no steering queue; reset the current segment pointer as well
    setQueuedMessages([])
    assistantIdByTopicRef.current.clear()
    // A plain "new session" has no independent memory scope (a plugin row's "+" / "chat" mode
    // sets one afterwards, see harness-focus-input): write null explicitly to clear the previous
    // pending value so it does not leak into this new session
    pendingMemoryScopeRef.current = null
    // Reset the memory-scope store too: an empty session uses the workspace scope (a plugin row's
    // "+" is dispatched synchronously right after and overwrites it immediately)
    setMemoryScope(null)
  }, [saveSessionToCache])

  /**
   * External request to "open a new session (optionally with an independent memory scope) and put
   * the focus in the input" (`harness-focus-input`).
   *
   * Use case 1: clicking + on a sidebar row in "plugin" mode opens a new session for that plugin.
   * The new session is blank (the first topic is persisted on the first send) and **deliberately
   * pre-fills no text** (per the user's requirement on 2026-09-28, do not display something like
   * "for plugin 'personal ledger' (id: personal-ledger)"); it only sends the caret into the input
   * and remembers **which plugin's memory** the session should use.
   *
   * Use case 2: the + in "chat" mode fires the same event with `scope: 'chat'` — memory uses that
   * mode's own scope.
   */
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ pluginId?: string; scope?: string; focus?: boolean }>)
        .detail
      const pluginId = detail?.pluginId
      const scope = detail?.scope === 'chat' ? 'chat' : pluginId ? `plugin:${pluginId}` : null
      pendingMemoryScopeRef.current = scope
      // While there is no topic yet, the UI (sidebar memory block / Settings → Memory) must also show this scope
      setMemoryScope(scope)
      // The blank session entered automatically when switching modes only carries the scope and does not steal focus (the user is just browsing the plugin side)
      if (detail?.focus !== false) setFocusInputToken((n) => n + 1)
    }
    window.addEventListener('harness-focus-input', handler)
    return () => window.removeEventListener('harness-focus-input', handler)
  }, [])

  /**
   * Open a session.
   *
   * `options.focusDialogueId`: when session search hits "content", pass the target dialogue row
   * id. The target may fall outside the first 20 loaded rows, so keep paging backwards (up to 20
   * pages / 400 rows) until it is loaded into the list, then let the message area scroll to and
   * highlight it — otherwise a search hit cannot be located, breaking the flow at the last step.
   */
  const handleSelectTopic = useCallback(
    async (
      topic: HarnessTopicRow,
      options?: { focusDialogueId?: number }
    ): Promise<void> => {
      // Do not block switching while loading; free switching is allowed

      // The user opened this session = the just-completed green dot can go away (user requirement,
      // 2026-11-23: the green dot disappears when the user clicks the session; the yellow dot is
      // untouched, see acknowledgeTopic)
      acknowledgeTopic(topic.id)

      // Save the current topic state to the cache
      saveSessionToCache()

      // Abandon in-bubble editing when switching topics: that question belongs to the previous topic
      setEditingOrphanId(null)

      // The selected topic carries its own memory scope (stored on the topic row, honoured by the main process) → clear the pending value for "the next new topic"
      pendingMemoryScopeRef.current = undefined
      // Memory follows the current session: a plugin session shows that plugin's memory, a "chat"
      // mode session shows its own scope, otherwise fall back to the workspace
      // (this also holds after restarting the app — the scope is stored on the topic row and does
      // not rely on the renderer remembering it)
      setMemoryScope(topic.memory_scope ?? null)

      currentTopicIdRef.current = topic.id
      setCurrentTopicId(topic.id)
      // Archived sessions are read-only: opening only browses history (input hidden, sending rejected)
      markTopicArchived(Boolean(topic.archived_at))

      // First try restoring from the cache (for sessions still in progress).
      // But when "a search hit must be located", skip the cache early-return: the cache may not
      // contain the target message, so reload via pagination uniformly and let the paging logic
      // below ensure the target row enters the list.
      const restored =
        options?.focusDialogueId == null ? restoreSessionFromCache(topic.id) : false
      if (restored) {
        // Restored from the cache; sync the loading state
        setIsLoading(isLoadingMapRef.current.get(topic.id) ?? false)
        messagesBelongToTopicRef.current = topic.id
        // Reset pagination state (fix: the early return used to skip this, leaving the previous
        // topic's messagesPage/messagesHasMore; "load more" then fetched the current topic with the
        // old page number, causing missing pages / overlap)
        currentSessionIdRef.current = null
        setMessagesPage(0)
        setMessagesHasMore(true)
        return
      }

      // Cache miss: load the first page from the database
      currentSessionIdRef.current = null
      setIsLoading(false)
      setMessagesPage(0)
      setMessagesHasMore(true)

      const toMessage = (d: {
        id: number
        role: Message['role']
        content: string
        blocks: string | null
        created_at: string | null
      }): Message => ({
        id: String(d.id),
        role: d.role,
        content: d.content,
        blocks: d.blocks ? JSON.parse(d.blocks) : [],
        // The created_at column is nullable (DEFAULT NOW()); fall back to the current time when missing
        timestamp: d.created_at ? new Date(d.created_at).getTime() : Date.now(),
        loading: false
      })

      try {
        const result = await harnessApi.harness.getDialoguesByTopicPaginated(
          topic.id,
          0,
          MESSAGES_PAGE_SIZE
        )
        let loadedMessages = result.items.map(toMessage)
        let loadedPage = 0
        let hasMore = result.hasMore
        const focusId = options?.focusDialogueId
        if (focusId != null && !loadedMessages.some((m) => Number(m.id) === focusId)) {
          // Target not on the first screen: page backwards (page 0 is the newest page, page+1 is older) until found
          for (let guard = 0; guard < 20 && hasMore; guard += 1) {
            const older = await harnessApi.harness.getDialoguesByTopicPaginated(
              topic.id,
              loadedPage + 1,
              MESSAGES_PAGE_SIZE
            )
            loadedMessages = [...older.items.map(toMessage), ...loadedMessages]
            loadedPage += 1
            hasMore = older.hasMore
            if (loadedMessages.some((m) => Number(m.id) === focusId)) break
            if (older.items.length === 0) break
          }
        }
        /**
         * A send can start while this page load is still in flight (open a session and type
         * quickly). `startTurn` has then already appended the optimistic pair — the user's message
         * and its streaming bubble — to the live state **and** to the session cache, so replacing
         * the list here erased what the user just sent; the following chunk write then replaced it
         * back with the cache, and the history that was just loaded went missing (production
         * 2026-11-28: the screen showed a single user message and an empty assistant card).
         *
         * Merge instead: loaded history first, then the live tail this topic already holds, by id.
         * With no live session (the normal path) this reduces to the loaded page, unchanged.
         */
        const liveSession = sessionsRef.current.get(topic.id)
        const mergedMessages = mergeLoadedHistory(
          loadedMessages,
          liveSession
            ? liveSession.messages
            : messagesBelongToTopicRef.current === topic.id
              ? messagesSnapshotRef.current
              : []
        )
        if (liveSession) {
          // Keep the cache and the screen in sync: the next chunk batch writes the cache back to
          // the screen, and a cache without the loaded history would undo this merge.
          sessionsRef.current.set(topic.id, { ...liveSession, messages: mergedMessages })
        }
        setMessages(mergedMessages)
        setMessagesPage(loadedPage)
        setMessagesHasMore(hasMore)
      } catch (err) {
        console.error('Failed to load dialogues:', err)
        // A live turn survives a failed history read: show its tail instead of a blank screen
        const liveSession = sessionsRef.current.get(topic.id)
        setMessages(liveSession ? liveSession.messages : [])
      }

      messagesBelongToTopicRef.current = topic.id

      setInputValue('')
      setAttachments([])
    },
    [saveSessionToCache, restoreSessionFromCache, acknowledgeTopic, markTopicArchived]
  )

  /**
   * Branch: copy the messages up to upToIndex in the current topic into a new topic.
   *
   * Three things must happen together, otherwise it looks like "clicked and nothing happened":
   *  1) persist the new topic (createTopic) and copy each message (addDialogue);
   *  2) **refresh the topic list** — the sidebar reads the topics state, and a topic created
   *     without going through it never appears in the list;
   *  3) **switch to the new topic** — reuse handleSelectTopic so it goes through the normal
   *     loading / cache / pagination flow.
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
        // A branch continues the same collaborative work: carry the source topic's team
        // collaboration state over, otherwise a branch from a session with an open task board
        // would suddenly lose the team_task_* tools and team prompt.
        const sourceTopicId = currentTopicIdRef.current
        const branchTeamMode =
          sourceTopicId != null
            ? await harnessApi.harness
                .getTeamMode(sourceTopicId)
                .then((view) => view.enabled)
                .catch(() => false)
            : false
        const newTopicId = await harnessApi.harness.createTopic(
          workspaceId,
          title,
          undefined,
          undefined,
          // The branched session uses the **same memory** as the source (otherwise a branch from a plugin session would fall back to workspace memory)
          branchScope,
          branchTeamMode
        )
        // A "chat" mode branch is **another session**: it has its own directory, already switched
        // to by the main process when creating the topic. Sync the active path here, otherwise the
        // new branch would still read/write files in the parent session's directory.
        if (isChatScope(branchScope)) notifyChatTopicActivated(workspaceId)
        for (const item of slice) {
          await harnessApi.harness.addDialogue({
            topic_id: newTopicId,
            role: item.role,
            content: item.content,
            blocks: JSON.stringify(item.blocks ?? [])
          })
        }
        // Refresh the list first (the new topic has the newest updated_at and sits at the top of
        // page 0), then take its row from the refreshed result and switch to it
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
        // If the deleted topic is streaming, cancel the backend stream first
        if (isLoadingMapRef.current.has(topicId)) {
          harnessApi.harness.cancelStream()
        }

        await harnessApi.harness.deleteTopic(topicId)

        // Clean up all caches and listeners for this topic
        sessionsRef.current.delete(topicId)
        isLoadingMapRef.current.delete(topicId)
        syncLoadingTopics()
        // The row-start markers disappear with this session (the id may be reused by the database later)
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
          // Deleting the row that is **currently displayed**: move the pointer away before
          // clearing the view. `handleNewHarness()` starts with `saveSessionToCache()` (writes by
          // currentTopicIdRef); if the pointer still targets the deleted session, the deleted
          // history would be written back into `sessionsRef`, and any later "reselect this id"
          // (stale row, late event) would hit the cache and put the history back on screen — the
          // user reported this on 2026-10-26: after deleting the current session, its content was
          // still shown as the selected history.
          currentTopicIdRef.current = null
          handleNewHarness()
          // If an archived session was deleted, clear the read-only flag too (the new view is a blank session and the input must return)
          currentTopicArchivedRef.current = false
          setCurrentTopicArchived(false)
          // Belt and braces: if the cache was written again while clearing the view, delete it once more here
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
      // Insert older messages at the head of the list
      const olderMessages: Message[] = result.items.map((d) => ({
        id: String(d.id),
        role: d.role,
        content: d.content,
        blocks: d.blocks ? JSON.parse(d.blocks) : [],
        // The created_at column is nullable (DEFAULT NOW()); fall back to the current time when missing
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
   * Shared pipeline for one question/answer turn: optimistic render → ensure topic → loading
   * state → stream listener → session cache → start stream.
   *
   * @param userMessage   this turn's user message (newly created on a normal send; the one being
   *   **replaced in place** on an in-bubble edit)
   * @param attachments   this turn's attachments (image dataURLs / document paths), passed to the
   *   main process
   * @param replaceIndex  in-bubble edit: replace the message at this index in the list, **without
   *   adding another user bubble**
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
      // Selection as of this send (see agentSelectionRef): tools/skills/MCP ticked in the blank
      // session must reach the turn even though no topic existed when they were ticked.
      const agentSelectionNow = agentSelectionRef.current

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

      // Optimistic render: replace in place when editing (same id → same bubble, so no extra row), otherwise append
      setMessages((prev) => [
        ...(replaceIndex != null
          ? prev.map((m, i) => (i === replaceIndex ? userMessage : m))
          : [...prev, userMessage]),
        initialAiMessage
      ])

      // ── Clear the input area after sending ────────────────────────────
      // The input only clears the editor when inputValue becomes '' (see HarnessInput's sync
      // effect); this was not cleared before, so content stayed in the box (the bubble appeared,
      // making it look like it was not sent).
      // Done in startTurn rather than handleSend: all three entry points (first send / continuation
      // after enqueueing while generating / automatic queue continuation) need it; on an in-bubble
      // edit resend (replaceIndex != null) the input is empty, so leave it alone.
      if (replaceIndex == null) {
        // Race guard: sending is async; if the user typed new content meanwhile, do not clear it
        setInputValue((prev) => (prev.trim() === userMessage.content ? '' : prev))
        setAttachments([])
      }

      try {
        // If there is no topic yet, create one first (so the topic appears in the sidebar immediately)
        let topicId = currentTopicIdRef.current
        if (!topicId) {
          const title = userMessage.content.slice(0, 50)
          const workspaceId = await getActiveWorkspaceId()
          // Memory scope: a session opened from a plugin row's "+" carries `plugin:<id>` (that
          // plugin's own memory), a "chat" mode session carries `chat`, and a plain session
          // leaves it empty = follow the workspace (see main/memory-scope.ts).
          // For the three meanings of the value see pendingMemoryScopeRef; `undefined` means use
          // the scope stored on the **current topic** (sending into an existing session does not
          // create a topic, so this path is never reached), and the fallback is still the workspace.
          const memoryScope =
            pendingMemoryScopeRef.current !== undefined
              ? pendingMemoryScopeRef.current
              : getMemoryScope()
          topicId = await harnessApi.harness.createTopic(
            workspaceId,
            title,
            undefined,
            undefined,
            memoryScope,
            // Team collaboration draft flipped in the blank session: persisted together with the
            // topic, so switching the UI over shows no "off then on" flicker
            pendingTeamMode
          )
          // The scope is now stored on the topic row and read by the main process from there;
          // clear it after use so it does not affect the next new session (the UI-side scope store
          // stays untouched: the topic is this session's scope, rewritten when switching sessions)
          pendingMemoryScopeRef.current = undefined
          /**
           * **Write the input's current tool/skill/MCP selection into the new topic before
           * switching currentTopicId**.
           *
           * Why the order matters (user, 2026-11-27: selections were sometimes cancelled, so no
           * tools got registered): `setCurrentTopicId` makes the input re-read the session
           * selection for the topic, while the main process only writes `agentConfig` back to the
           * topic once the turn actually starts (inside startMessageStream). In that window the
           * input reads "this new topic has no selection yet" → falls back to the main agent
           * defaults (usually empty) → the just-checked tools are visually cleared and
           * `agentSelection` is overwritten with null; checking one more item afterwards then
           * overwrites the database with "only this one item" — the selection appears swallowed.
           *
           * The value must also be the one **as of this send** (`agentSelectionNow`), not the one
           * captured by the callback: the whole point of this write is to make the topic carry the
           * selection that the turn is about to use.
           */
          if (agentSelectionNow) {
            await harnessApi.harness
              .setTopicAgentSelection(topicId, agentSelectionNow)
              .catch(() => undefined)
          }
          currentTopicIdRef.current = topicId
          setCurrentTopicId(topicId)
          // The draft was already written into team_mode with the topic (the createTopic call
          // above); just reset it here so it does not leak into the next new session
          setPendingTeamMode(false)
          // "Chat" mode session directories are per topic id: the main process already switched
          // the active directory when creating the topic, so broadcast once here so the explorer /
          // file path mapping catch up (see notifyChatTopicActivated)
          if (isChatScope(memoryScope)) notifyChatTopicActivated(workspaceId)
          refreshTopics().then()
        }

        // Record this turn's input in the global input history (browsed with Up/Down, persisted in localStorage, max 100)
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
            // Storage failure does not affect the send flow
          }
        }

        currentSessionIdRef.current = aiMessageId

        // This turn has started: the previous turn's "just completed" green dot is void (the session goes from "waiting for you" back to "in progress")
        beginTopicTurn(topicId)

        // Mark the loading state
        isLoadingMapRef.current.set(topicId, true)
        syncLoadingTopics()
        setIsLoading(true)

        // Cache the current session — messagesBelongToTopicRef prevents cross-topic pollution: if
        // handleSelectTopic's async DB load has not finished, messages still belong to the old
        // topic, and the old messages must be dropped so the new conversation starts clean
        // (otherwise A's history would be mixed into B's session cache)
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

        // Sync React state
        setMessages(currentMessages)

        // Ask the main process whether this turn actually started before attaching the stream
        // listener:
        //  - started=true → attach normally (the listener locks onto the turn id from the first
        //    chunk);
        //  - queued=true  → the previous turn is still running (a very unlikely race), this message
        //    has been queued, so remove the optimistic bubble and avoid a ghost message that spins
        //    forever.
        // The listener is not attached before the await because that would overwrite the listener
        // of the turn that is actually running on the race path.
        const startResult = await harnessApi.harness.startMessageStream(userMessage.content, {
          images: currentImages.length > 0 ? currentImages : undefined,
          documents: currentDocuments.length > 0 ? currentDocuments : undefined,
          topicId,
          providerId: selectedProviderId ?? undefined,
          // Tools/skills/MCP selected below the input: the main process assembles this turn from it and writes it back to the session config
          agentConfig: agentSelectionNow ?? undefined,
          // Frontend temporary id of the first assistant segment: steering can split segments, and the main process returns the DB row id per segment
          messageId: aiMessageId,
          // Edit-and-resend: have the main process update this existing user message row instead
          // of inserting a new one (otherwise the database would get a duplicate question and the
          // history order would shift it to the end)
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

        // Start the stream listener (independent of the visible chat window; keeps updating the cache)
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

        // Clear the loading state
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
      // Team collaboration draft flipped in the blank session: passed to createTopic when creating the topic
      pendingTeamMode,
      t
    ]
  )

  /** Input send: start a turn directly when idle; while generating, hand it to the main process for the steering queue */
  const handleSend = useCallback(async (): Promise<void> => {
    // Archived sessions are read-only: the input is not rendered anyway, but this adds another guard so other entry points (shortcuts, etc.) cannot send either
    if (currentTopicArchivedRef.current) return
    if (!inputValue.trim()) return

    // A new turn begins: clear the in-progress task cards above the input (waiting for the model to re-plan)
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

    // While generating (this topic has a turn running): do not interrupt the current turn; the
    // message enters the steering queue and waits for the user to click "steer now" or for the
    // turn to finish and auto-continue. **Always ask the main process whether it is running** —
    // the local isLoading lags for main-process auto-continuations (queued messages / goal
    // rounds), and judging by it would start a second concurrent turn (the root cause of
    // scrambled output).
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
            // Queued (shown as a queue row above the input), so clear the input area.
            // Note: do not call setInputValue('') directly — enqueueing is async and the user may
            // have typed new content meanwhile; clear only when it still matches this message, so
            // a new draft is not deleted.
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

  /** Goal card Enter: after saving the goal, start a turn with "start executing the goal" (later rounds are auto-continued by the goal driver). */
  const handleStartGoal = useCallback(
    async (objective: string): Promise<void> => {
      const text = objective.trim()
      if (!text || currentTopicArchivedRef.current) return
      const userContent = t('harness.goalInline.startMessage', { text })
      window.dispatchEvent(new CustomEvent('harness-send-started'))
      const userMessage: Message = {
        id: Date.now().toString(),
        role: 'user',
        content: userContent,
        blocks: [{ type: 'text', text: userContent }],
        timestamp: Date.now()
      }
      await startTurn({ userMessage, attachments: [] })
    },
    [startTurn, t]
  )

  /**
   * Action card (propose_action) click: send the option text as a user message.
   *
   * Goes through the same path as a manual send: queue it while generating (without interrupting
   * the current turn), otherwise start a new turn. Cards hand the text here via the
   * `harness-propose-action` window event.
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

  /** Delete one queued message (the main process is the source of truth; the broadcast re-syncs) */
  const handleRemoveQueued = useCallback(async (itemId: string): Promise<void> => {
    const topicId = currentTopicIdRef.current
    if (topicId == null) return
    try {
      await harnessApi.harness.removeQueuedMessage(topicId, itemId)
    } catch (err) {
      console.error('Failed to remove queued message:', err)
    }
  }, [])

  /** Rewrite the text of a queued message */
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
   * Steer now: merge this queued message into the **running** turn (effective at the next tool
   * node boundary). The receipt and persistence are emitted by the main process at the injection
   * point (steered chunk); this only sends the request.
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

  /** Enter **in-bubble** editing (content stays in the bubble; the chat input is not involved) */
  const handleStartEditMessage = useCallback((msgIndex: number): void => {
    const current = messagesSnapshotRef.current[msgIndex]
    if (!current || current.role !== 'user') return
    setEditingOrphanId(current.id)
  }, [])

  /** Cancel in-bubble editing (Esc) */
  const handleCancelEditMessage = useCallback((): void => {
    setEditingOrphanId(null)
  }, [])

  /**
   * Submit in-bubble with Enter: **replace this question in place** (no extra user bubble), then
   * start a normal turn; the database updates the same row via UPDATE (reuseUserDialogueId), so
   * the row id and history order stay unchanged.
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
            // Messages during streaming use temporary ids (Date.now() timestamps); deleting by them hits nonexistent rows
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
          // The session is now empty = back to the blank state: hand the pending value back to
          // **the current session's scope** (undefined → use the current scope when creating the
          // topic, with the main process falling back by workspace kind). **Do not reset to the
          // workspace**: after clearing all messages, a plugin / "chat" session is still on that
          // side, and falling back to workspace memory would taint both the sidebar and the next
          // turn.
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

  /** Enter send from the chat input (Enter for in-bubble editing is handled by UserMessage itself) */
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

      // Clean up the stream listeners
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
      // Custom endpoints are determined by extra_config.api_format (Anthropic-compatible protocols also send the effort level)
      const anthropicFormat =
        String((p.extra_config as Record<string, unknown> | null)?.api_format ?? 'openai') ===
        'anthropic'
      grouped.get(p.provider)!.push({
        value: p.id,
        displayName: getProviderDisplayName(p),
        model: p.model,
        effort: p.reasoning_effort ?? null,
        // The model profile is the source of truth for effort levels: models not covered get none (the UI only offers "default")
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
    /** Incremented on every external "focus the input" request (HarnessInput uses it to place the caret without changing content) */
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
    // Steering queue
    queuedMessages,
    steeredNotice,
    handleRemoveQueued,
    handleUpdateQueued,
    handleSteerQueued,
    agentSelection,
    setAgentSelection,
    pendingTeamMode,
    setPendingTeamMode,
    // Session-search hit navigation
    pendingJumpDialogueId,
    setPendingJumpDialogueId,
    clearPendingJumpDialogueId
  }
}
