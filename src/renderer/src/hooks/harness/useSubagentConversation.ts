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
 * Data source for the background subagent conversation view.
 *
 * The main process records each subagent turn's streaming chunks as an event stream
 * (turn_start / chunk* / turn_end):
 * - When a conversation is opened, the watch API returns **snapshot** data directly (all events + seq);
 * - After that, incremental events are pushed in 40ms batches; they are merged here by seq
 *   (duplicate events from before the snapshot are dropped);
 * - Event replay reuses the same `applyChunkToMessages` reducer as the main conversation, so text /
 *   thinking / tool card rendering shares exactly the same path as the main conversation.
 *
 * The conversation view is read-only (v1 offers no entry point for sending messages from the UI to a
 * subagent); the renderer neither mutates the main conversation state nor affects the main agent's
 * running stream.
 */

/** Metadata for the conversation view (from the snapshot / top bar list broadcast) */
export interface SubagentConversationMeta {
  topicId: number
  agentId: string
  name: string
  label: string
  prompt: string
  status: 'running' | 'idle' | 'inactive'
  lastStatus?: 'completed' | 'failed' | 'killed'
  /** Number of user messages queued while running (the view uses it to hint "queued") */
  queuedMessages: number
}

export interface SubagentConversationState {
  /** Whether the snapshot has arrived (when false the view shows a loading skeleton) */
  ready: boolean
  meta: SubagentConversationMeta | null
  /** Message list shaped like the main conversation (each turn = user message + assistant message) */
  messages: Message[]
  /** Whether this conversation currently has a turn streaming */
  streaming: boolean
  /** Whether there are older turns before the snapshot (loaded by scrolling at the top of the message area) */
  hasOlder: boolean
  /** Whether older turns are loading */
  loadingOlder: boolean
  /** Load one page of older history (called when the message area scrolls to the top) */
  loadMore: () => void
}

/** Internal state without callbacks: callbacks are assembled from refs at the end of the hook, so setState never stores a function */
type ConversationViewState = Omit<SubagentConversationState, 'loadMore'>

const EMPTY_STATE: ConversationViewState = {
  ready: false,
  meta: null,
  messages: [],
  streaming: false,
  hasOlder: false,
  loadingOlder: false
}

/** Upper bound on how many events the conversation view merges at once (avoids handling too many events in one frame) */
const FLUSH_INTERVAL_MS = 40

const userMessageId = (agentId: string, turnId: string): string => `sub-u-${agentId}-${turnId}`
const assistantMessageId = (agentId: string, turnId: string): string => `sub-a-${agentId}-${turnId}`

/** Build the user message for a turn (renderer-side display only: not persisted, not part of main session pagination) */
function createUserMessage(agentId: string, turnId: string, prompt: string, at: number): Message {
  return {
    id: userMessageId(agentId, turnId),
    role: 'user',
    content: prompt,
    blocks: [{ type: 'text', text: prompt }],
    timestamp: at
  }
}

/** Build the assistant placeholder message for a turn (later chunks are appended to this message's blocks) */
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

/** Replay a batch of events onto the message list (pure function: reads no React state, so snapshot replay and incremental updates can share it) */
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
 * Subscribe to and maintain the streaming conversation of one background subagent
 * (empty state when topicId/agentId are null).
 *
 * Switching conversations or returning to the main agent releases the watch automatically, and the
 * main process stops pushing events for it.
 */
export function useSubagentConversation(
  topicId: number | null,
  agentId: string | null
): SubagentConversationState {
  const [state, setState] = useState<ConversationViewState>(EMPTY_STATE)

  /** Current view (topic/agent): loadMore reads it from a ref outside the effect to avoid a stale closure */
  const viewRef = useRef<{ topicId: number; agentId: string } | null>(null)
  /** Raw events loaded so far (ascending; paging backwards replays them all so it stays identical to the incremental reducer) */
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
  /** In-flight lock and backoff timestamp for gap refetches: failures / repeated gaps never cause a refetch storm */
  const refetchingRef = useRef(false)
  const lastRefetchAtRef = useRef(0)

  useEffect(() => {
    if (topicId == null || agentId == null) {
      setState(EMPTY_STATE)
      return
    }
    // Narrow to non-null constants after the guard: snapshot/event callbacks are async closures, so keep the non-null types in them
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

    /** Merge a batch of incremental events (drop duplicates/stale ones by seq; refetch the snapshot if a gap appears) */
    function applyBatch(events: SubagentConversationEvent[]): void {
      if (!readyRef.current || events.length === 0) return
      const fresh = events.filter((event) => event.seq > seqRef.current)
      if (fresh.length === 0) return
      // Events are strictly consecutive in the normal case; on a gap (e.g. switching away and back) refetch the snapshot instead, so the conversation never misses a segment
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
      // The snapshot is the authoritative baseline: clear local state and replay the whole thing (re-opening the same agent comes through here too)
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
      // Incremental events that arrived before the snapshot returned (already carrying larger seq): merge them in the same frame
      const buffered = pendingRef.current
      pendingRef.current = []
      if (buffered.length > 0) applyBatch(buffered)
    }

    /** Gap fallback: refetch the snapshot once without registering a watch (the watch is still owned by this effect) */
    async function refetchSnapshot(): Promise<void> {
      if (refetchingRef.current) return
      // Retrying on every batch after repeated gaps/failures would saturate the main process: 800ms backoff window
      if (Date.now() - lastRefetchAtRef.current < 800) return
      refetchingRef.current = true
      lastRefetchAtRef.current = Date.now()
      try {
        const snapshot = await harnessApi.harness.agentConversation(viewTopicId, viewAgentId)
        if (!cancelled) applySnapshot(snapshot)
      } catch {
        /* A failed snapshot refetch is silent: keep the current state, and the next batch after the backoff triggers another try */
      } finally {
        refetchingRef.current = false
      }
    }

    // Subscribe to increments before fetching the snapshot: events arriving in the gap go into pending and are merged by applySnapshot
    const unsubscribeConversation = harnessApi.harness.onAgentConversationUpdated((data) => {
      if (data.topicId !== viewTopicId || data.agentId !== viewAgentId) return
      pendingRef.current.push(...data.events)
      if (pendingRef.current.length > 2000) {
        pendingRef.current.splice(0, pendingRef.current.length - 2000)
      }
      if (!readyRef.current) return
      scheduleFlush()
    })
    // Top bar list broadcast: sync the "running / completed / failed / stopped" badge
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

  /** Load one page of older turns backwards: replay everything (same reducer as increments); on failure keep the current state */
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
