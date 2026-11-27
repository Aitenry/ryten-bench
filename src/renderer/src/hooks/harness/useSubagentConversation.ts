import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  MessageBlock,
  StreamChunk,
  SubagentConversationEvent,
  SubagentConversationSnapshot,
  SubagentSessionRow
} from '../../../../shared/harness/types'
import type { Message } from '../../types/harness/types'
import { applyChunkToMessages } from '../../utils/harness/applyChunk'
import { harnessApi } from '../../api/harness'

/**
 * 后台子代理会话视图的数据源。
 *
 * 主进程把子代理每一轮的流式 chunk 记成事件流（turn_start / chunk* / turn_end）：
 * - 打开会话时 watch 接口直接返回**快照**（全量事件 + seq）；
 * - 此后增量事件按 40ms 合批推送，这里按 seq 合并（丢弃快照之前的重复事件）；
 * - 事件重放复用主对话同一套 `applyChunkToMessages` reducer，所以正文 / 思考 /
 *   工具卡的渲染与主对话完全同源。
 *
 * 会话视图是只读的（v1 不提供从 UI 向子代理投递消息的入口）；渲染层不修改主对话
 * 的状态，也不影响主代理正在跑的流。
 */

/** 会话视图的元信息（来自快照 / 顶部栏列表广播） */
export interface SubagentConversationMeta {
  topicId: number
  agentId: string
  name: string
  label: string
  prompt: string
  status: 'running' | 'idle' | 'inactive'
  lastStatus?: 'completed' | 'failed' | 'killed'
  /** 运行中排队的用户消息条数（会话视图据此提示「已排队」） */
  queuedMessages: number
}

export interface SubagentConversationState {
  /** 快照是否已到（false 时视图显示加载骨架） */
  ready: boolean
  meta: SubagentConversationMeta | null
  /** 与主对话同构的消息列表（每轮 = 用户消息 + 助手消息） */
  messages: Message[]
  /** 该会话当前是否有一轮正在流式输出 */
  streaming: boolean
  /** 快照之前是否还有更早轮次（消息区顶部滚动加载） */
  hasOlder: boolean
  /** 更早轮次是否正在加载 */
  loadingOlder: boolean
  /** 加载更早一页历史（消息区滚动到顶部时调用） */
  loadMore: () => void
}

/** 内部状态不含回调：回调在 hook 末尾按 ref 组装，避免每次 setState 存函数 */
type ConversationViewState = Omit<SubagentConversationState, 'loadMore'>

const EMPTY_STATE: ConversationViewState = {
  ready: false,
  meta: null,
  messages: [],
  streaming: false,
  hasOlder: false,
  loadingOlder: false
}

/** 会话视图一次最多合并的事件批大小（防单帧处理过多事件） */
const FLUSH_INTERVAL_MS = 40

const userMessageId = (agentId: string, turnId: string): string => `sub-u-${agentId}-${turnId}`
const assistantMessageId = (agentId: string, turnId: string): string => `sub-a-${agentId}-${turnId}`

/** 构造一轮的用户消息（渲染端只用于展示，不落库、不参与主会话分页） */
function createUserMessage(agentId: string, turnId: string, prompt: string, at: number): Message {
  return {
    id: userMessageId(agentId, turnId),
    role: 'user',
    content: prompt,
    blocks: [{ type: 'text', text: prompt }],
    timestamp: at
  }
}

/** 构造一轮的助手占位消息（后续 chunk 追加到这条消息的 blocks） */
function createAssistantMessage(agentId: string, turnId: string, at: number): Message {
  return {
    id: assistantMessageId(agentId, turnId),
    role: 'assistant',
    content: '',
    blocks: [],
    timestamp: at,
    loading: true,
    lastChunkAt: at
  }
}

/** 把一批事件重放到消息列表上（纯函数：不读 React 状态，便于快照回放与增量共用） */
function applyConversationEvents(
  messages: Message[],
  events: SubagentConversationEvent[],
  agentId: string,
  turnAssistants: Map<string, string>,
  activeCauseIds: Set<string>
): Message[] {
  let next = messages
  for (const event of events) {
    if (event.kind === 'turn_start') {
      const assistantId = assistantMessageId(agentId, event.turnId)
      turnAssistants.set(event.turnId, assistantId)
      next = [
        ...next,
        createUserMessage(agentId, event.turnId, event.prompt, event.startedAt),
        createAssistantMessage(agentId, event.turnId, event.startedAt)
      ]
    } else if (event.kind === 'chunk') {
      const assistantId = turnAssistants.get(event.turnId)
      if (!assistantId) continue
      next = applyChunkToMessages(next, assistantId, event.chunk as StreamChunk, activeCauseIds)
    } else {
      const assistantId = turnAssistants.get(event.turnId)
      if (!assistantId) continue
      const note = event.note
      next = next.map((message) => {
        if (message.id !== assistantId) return message
        const blocks: MessageBlock[] = note
          ? [...message.blocks, { type: 'text', text: note }]
          : message.blocks
        return { ...message, blocks, loading: false, lastChunkAt: Date.now() }
      })
    }
  }
  return next
}

const isStreaming = (messages: Message[]): boolean =>
  messages.length > 0 && messages[messages.length - 1].loading === true

/**
 * 订阅并维护一个后台子代理的流式会话（topicId/agentId 为 null 时为空状态）。
 *
 * 切换会话/返回主智能体时自动解除 watch，主进程不再为它推送事件。
 */
export function useSubagentConversation(
  topicId: number | null,
  agentId: string | null
): SubagentConversationState {
  const [state, setState] = useState<ConversationViewState>(EMPTY_STATE)

  /** 当前视图（topic/agent）：loadMore 在 effect 外按 ref 读取，避免闭包过期 */
  const viewRef = useRef<{ topicId: number; agentId: string } | null>(null)
  /** 已加载的原始事件（升序；向前翻页时整体重放，保证与增量 reducer 同源） */
  const eventsRef = useRef<SubagentConversationEvent[]>([])
  const hasOlderRef = useRef(false)
  const loadingOlderRef = useRef(false)

  const messagesRef = useRef<Message[]>([])
  const turnAssistantsRef = useRef<Map<string, string>>(new Map())
  const activeCauseIdsRef = useRef<Set<string>>(new Set())
  const seqRef = useRef(0)
  const readyRef = useRef(false)
  const pendingRef = useRef<SubagentConversationEvent[]>([])
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const metaRef = useRef<SubagentConversationMeta | null>(null)
  /** 断档重拉的在途锁与退避时间：失败/连续断档时不产生重拉风暴 */
  const refetchingRef = useRef(false)
  const lastRefetchAtRef = useRef(0)

  useEffect(() => {
    if (topicId == null || agentId == null) {
      setState(EMPTY_STATE)
      return
    }
    // 守卫后收窄成非空常量：快照/事件回调是异步闭包，闭包里保留非空类型
    const viewTopicId: number = topicId
    const viewAgentId: string = agentId

    let cancelled = false
    viewRef.current = { topicId: viewTopicId, agentId: viewAgentId }
    eventsRef.current = []
    hasOlderRef.current = false
    loadingOlderRef.current = false
    messagesRef.current = []
    turnAssistantsRef.current = new Map()
    activeCauseIdsRef.current = new Set()
    seqRef.current = 0
    refetchingRef.current = false
    lastRefetchAtRef.current = 0
    readyRef.current = false
    pendingRef.current = []
    metaRef.current = null
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    setState(EMPTY_STATE)

    const commitMessages = (messages: Message[], streaming: boolean): void => {
      messagesRef.current = messages
      setState((prev) => ({ ...prev, messages, streaming }))
    }

    /** 合并一批增量事件（按 seq 丢弃重复/过期；出现断档则重拉快照兜底） */
    function applyBatch(events: SubagentConversationEvent[]): void {
      if (!readyRef.current || events.length === 0) return
      const fresh = events.filter((event) => event.seq > seqRef.current)
      if (fresh.length === 0) return
      // 正常情况事件严格连续；出现断档（例如期间切走又切回）直接重拉快照，避免会话缺段
      if (fresh[0].seq !== seqRef.current + 1) {
        void refetchSnapshot()
        return
      }
      const nextMessages = applyConversationEvents(
        messagesRef.current,
        fresh,
        viewAgentId,
        turnAssistantsRef.current,
        activeCauseIdsRef.current
      )
      eventsRef.current.push(...fresh)
      seqRef.current = fresh[fresh.length - 1].seq
      if (nextMessages !== messagesRef.current) {
        commitMessages(nextMessages, isStreaming(nextMessages))
      }
    }

    function scheduleFlush(): void {
      if (flushTimerRef.current) return
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null
        if (cancelled) return
        const batch = pendingRef.current
        pendingRef.current = []
        applyBatch(batch)
      }, FLUSH_INTERVAL_MS)
    }
    function applySnapshot(snapshot: SubagentConversationSnapshot | null): void {
      if (cancelled) return
      if (!snapshot) {
        readyRef.current = true
        setState({ ...EMPTY_STATE, ready: true })
        return
      }
      // 快照是权威基准：清空本地状态后整段重放（同一 agent 的重复打开同样走这里）
      messagesRef.current = []
      turnAssistantsRef.current = new Map()
      eventsRef.current = [...(snapshot.events ?? [])]
      hasOlderRef.current = snapshot.hasOlder ?? false
      seqRef.current = 0
      metaRef.current = {
        topicId: snapshot.topicId,
        agentId: snapshot.agentId,
        name: snapshot.name,
        label: snapshot.label,
        prompt: snapshot.prompt,
        status: snapshot.status,
        lastStatus: snapshot.lastStatus,
        queuedMessages: snapshot.queuedMessages ?? 0
      }
      const messages = applyConversationEvents(
        [],
        snapshot.events,
        viewAgentId,
        turnAssistantsRef.current,
        activeCauseIdsRef.current
      )
      messagesRef.current = messages
      seqRef.current = snapshot.seq
      readyRef.current = true
      setState({
        ready: true,
        meta: metaRef.current,
        messages,
        streaming: isStreaming(messages),
        hasOlder: hasOlderRef.current,
        loadingOlder: false
      })
      // 快照返回前到达的增量事件（已带更大的 seq）：补在同一帧里合并
      const buffered = pendingRef.current
      pendingRef.current = []
      if (buffered.length > 0) applyBatch(buffered)
    }

    /** 断档兜底：不登记 watch 地重拉一次快照（watch 仍由本 effect 持有） */
    async function refetchSnapshot(): Promise<void> {
      if (refetchingRef.current) return
      // 连续断档/重拉失败时每批事件都重试会打满主进程：800ms 退避窗口
      if (Date.now() - lastRefetchAtRef.current < 800) return
      refetchingRef.current = true
      lastRefetchAtRef.current = Date.now()
      try {
        const snapshot = await harnessApi.harness.agentConversation(viewTopicId, viewAgentId)
        if (!cancelled) applySnapshot(snapshot)
      } catch {
        /* 快照重拉失败不打扰：保留现状，退避结束后下一批事件会再触发 */
      } finally {
        refetchingRef.current = false
      }
    }

    // 先订阅增量再拉快照：两者之间的空窗事件进入 pending，由 applySnapshot 合并
    const unsubscribeConversation = harnessApi.harness.onAgentConversationUpdated((data) => {
      if (data.topicId !== viewTopicId || data.agentId !== viewAgentId) return
      pendingRef.current.push(...data.events)
      if (pendingRef.current.length > 2000) {
        pendingRef.current.splice(0, pendingRef.current.length - 2000)
      }
      if (!readyRef.current) return
      scheduleFlush()
    })
    // 顶部栏列表广播：同步「进行中 / 已完成 / 失败 / 已停止」徽标
    const unsubscribeAgents = harnessApi.harness.onAgentsUpdated((data) => {
      if (data.topicId !== viewTopicId) return
      const row = (data.rows ?? []).find((item: SubagentSessionRow) => item.id === viewAgentId)
      if (!row || !metaRef.current) return
      metaRef.current = {
        ...metaRef.current,
        name: row.name,
        label: row.label,
        status: row.status,
        lastStatus: row.lastStatus,
        queuedMessages: row.queuedMessages
      }
      setState((prev) => ({ ...prev, meta: metaRef.current }))
    })

    void harnessApi.harness
      .watchAgentConversation(viewTopicId, viewAgentId, true)
      .then((snapshot) => applySnapshot(snapshot))
      .catch(() => {
        if (!cancelled) {
          readyRef.current = true
          setState({ ...EMPTY_STATE, ready: true })
        }
      })

    return () => {
      cancelled = true
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      unsubscribeConversation()
      unsubscribeAgents()
      if (viewRef.current?.topicId === viewTopicId && viewRef.current?.agentId === viewAgentId) {
        viewRef.current = null
      }
      void harnessApi.harness.watchAgentConversation(viewTopicId, viewAgentId, false)
    }
  }, [topicId, agentId])

  /** 向前加载一页更早轮次：整体重放（与增量同一 reducer），失败保持现状 */
  const loadMore = useCallback((): void => {
    const view = viewRef.current
    const oldestSeq = eventsRef.current[0]?.seq
    if (!view || oldestSeq === undefined || !hasOlderRef.current || loadingOlderRef.current) {
      return
    }
    loadingOlderRef.current = true
    setState((prev) => ({ ...prev, loadingOlder: true }))
    void harnessApi.harness
      .agentConversationOlder(view.topicId, view.agentId, oldestSeq)
      .then((page) => {
        const current = viewRef.current
        if (
          !page ||
          !current ||
          current.topicId !== view.topicId ||
          current.agentId !== view.agentId
        ) {
          return
        }
        const firstLoadedSeq = eventsRef.current[0]?.seq ?? Number.POSITIVE_INFINITY
        const older = page.events.filter((event) => event.seq < firstLoadedSeq)
        hasOlderRef.current = page.hasOlder
        if (older.length > 0) {
          eventsRef.current = [...older, ...eventsRef.current]
          const turnAssistants = new Map<string, string>()
          const activeCauseIds = new Set<string>()
          const messages = applyConversationEvents(
            [],
            eventsRef.current,
            view.agentId,
            turnAssistants,
            activeCauseIds
          )
          messagesRef.current = messages
          turnAssistantsRef.current = turnAssistants
          activeCauseIdsRef.current = activeCauseIds
          setState((prev) => ({
            ...prev,
            messages,
            streaming: isStreaming(messages),
            hasOlder: page.hasOlder,
            loadingOlder: false
          }))
        } else {
          setState((prev) => ({ ...prev, hasOlder: page.hasOlder, loadingOlder: false }))
        }
      })
      .catch(() => {
        setState((prev) => ({ ...prev, loadingOlder: false }))
      })
      .finally(() => {
        loadingOlderRef.current = false
      })
  }, [])

  return { ...state, loadMore }
}
