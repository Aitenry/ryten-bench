/**
 * Conversation steering queue (isolated per topic) — when a message is sent during generation the
 * current turn is not interrupted; the message is queued first, and the user can click "steer now"
 * on the queue item to merge it into the **running** turn (injected into the model context at a
 * tool node boundary), or wait for the current turn to end naturally and let the main process
 * continue it automatically as a new turn.
 *
 * Two channels with distinct roles:
 * - pending: messages **waiting in the queue** (not yet in the model); editable / removable /
 *   steerable;
 * - injections: buffer of messages already marked "steer", waiting to be merged into the model at
 *   the next tool node boundary (FIFO).
 *
 * The queue is in-memory state (same lifetime as the in-flight stream): steering messages that were
 * never sent are not retained across an app restart.
 */

/** Attachments carried by a steering message (same fields as HarnessOptions; passed through as-is when steering starts a new turn) */
export interface QueueAttachments {
  images?: string[]
  documents?: { fileName: string; filePath: string }[]
}

/** Queue entry (full data on the main-process side, including raw attachment contents) */
export interface QueuedMessage {
  id: string
  topicId: number
  /** sender.id of the renderer that initiated this steering message (used for delivery receipts and queue broadcast dedupe) */
  senderId: number
  text: string
  images?: string[]
  documents?: { fileName: string; filePath: string }[]
  createdAt: number
  /** Steer was clicked but this turn never reached an injection boundary (see releaseHolds) */
  held?: boolean
}

/** Queue view sent to the renderer (no dataURL bodies, so each broadcast doesn't carry MBs of images) */
export interface QueuedMessageView {
  id: string
  topicId: number
  text: string
  createdAt: number
  attachments: { fileName: string; isImage: boolean }[]
  /**
   * true = "steer" was clicked for this message but this turn never reached an injection boundary
   * (the model stopped calling tools). It neither enters the conversation flow nor the database;
   * it stays in the queue as a hint that it will go out with the next send, so the content isn't
   * silently lost.
   */
  held?: boolean
}

/**
 * A steering message has been merged into the model context. **Injection only**: it is neither
 * persisted nor shown as a new bubble in the conversation flow, and it will never split the
 * assistant output into two messages — it only affects the model's subsequent behavior (an
 * explicit user request).
 */
export interface ConsumedSteer {
  item: QueuedMessage
}

/**
 * Queue logger outlet: silent by default.
 *
 * The queue itself is a pure state machine (no electron dependency); the IPC layer injects
 * electron-log at assembly time — this way Node regression scripts under `tests/` can import this
 * module directly and run state assertions.
 */
export interface QueueLogger {
  info: (message: string) => void
  warn: (message: string) => void
}

let logger: QueueLogger = { info: () => {}, warn: () => {} }

/** Inject the log outlet (called when the IPC layer registers; silent in tests if never called) */
export function setHarnessQueueLogger(next: QueueLogger): void {
  logger = next
}

/** Queue change event (enqueue / remove / update / consume / turn-end rollback) */
export interface QueueChangeEvent {
  topicId: number
  queue: QueuedMessageView[]
}

/** Steering injection event (the frontend removes that row from the queue and shows a brief toast) */
export interface SteerConsumedEvent extends ConsumedSteer {
  topicId: number
}

/** Pure state container with no external dependency such as electron-store; broadcasting and persistence are mounted by the IPC layer */
class HarnessQueueStore {
  /** topicId → steering messages waiting in the queue (FIFO) */
  private readonly pending = new Map<number, QueuedMessage[]>()
  /** topicId → entries marked "steer" that await a tool node boundary to be merged into the model (FIFO) */
  private readonly injections = new Map<number, QueuedMessage[]>()
  /** topicId → entries marked for steering this turn but not yet injected (put back in the queue if the turn ends without injection) */
  private readonly holds = new Map<number, QueuedMessage[]>()
  private seq = 0

  /** Queue change callback (IPC layer broadcasts harness-queue-updated) */
  onChanged: ((event: QueueChangeEvent) => void) | null = null
  /** Steering consumption callback (IPC layer broadcasts harness-queue-steered) */
  onConsumed: ((event: SteerConsumedEvent) => void) | null = null

  /**
   * Whether the topic currently has a running turn (maintained by the IPC layer). Messages sent
   * during generation are queued instead of interrupting the current turn; when no turn is running
   * they start a new turn directly without entering the queue.
   *
   * Stores the **turn id** rather than a boolean: when two turns on the same topic interleave
   * (e.g. a user expedited send + queue continuation), the renderer must be able to drop stale
   * events by id (see StreamChunk.__turnId).
   */
  private readonly turnByTopic = new Map<number, number>()
  /** Turn id counter (monotonic within the process; only used to distinguish turns, not persisted) */
  private turnSeq = 0

  /** Begin a turn: register the topic's current turn id and return it */
  beginTurn(topicId: number): number {
    this.turnSeq += 1
    this.turnByTopic.set(topicId, this.turnSeq)
    return this.turnSeq
  }

  /** End a turn: clear only if the currently registered turn is still this one, so an old turn's cleanup never wipes a new turn */
  endTurn(topicId: number, turnId: number): void {
    if (this.turnByTopic.get(topicId) === turnId) this.turnByTopic.delete(topicId)
  }

  /** Current turn id for the topic; null when no turn is running */
  currentTurnId(topicId: number): number | null {
    return this.turnByTopic.get(topicId) ?? null
  }

  isTurnActive(topicId: number): boolean {
    return this.turnByTopic.has(topicId)
  }

  /**
   * Clear all queues and turn state (used when switching account data spaces).
   *
   * topicId is an **auto-increment id local to each account database**: after switching databases
   * the same id may belong to another topic; without clearing, queued steering messages / steering
   * buffers from the previous account would be attached to topics of the new account.
   */
  reset(): void {
    this.pending.clear()
    this.injections.clear()
    this.holds.clear()
    this.turnByTopic.clear()
  }

  private nextId(): string {
    this.seq += 1
    return `q_${Date.now().toString(36)}_${this.seq}`
  }

  private listOf(topicId: number): QueuedMessage[] {
    let list = this.pending.get(topicId)
    if (!list) {
      list = []
      this.pending.set(topicId, list)
    }
    return list
  }

  /** Enqueue (at the tail); returns the new entry */
  enqueue(params: {
    topicId: number
    senderId: number
    text: string
    attachments?: QueueAttachments
  }): QueuedMessage {
    const item: QueuedMessage = {
      id: this.nextId(),
      topicId: params.topicId,
      senderId: params.senderId,
      text: params.text,
      images: params.attachments?.images,
      documents: params.attachments?.documents,
      createdAt: Date.now()
    }
    this.listOf(params.topicId).push(item)
    logger.info(
      `[HarnessQueue] Enqueued for topic ${params.topicId}: ${item.text.slice(0, 40)} (queue length ${this.listOf(params.topicId).length})`
    )
    this.emitChanged(params.topicId)
    return item
  }

  /** Queue view (FIFO, for broadcast and queries) */
  view(topicId: number): QueuedMessageView[] {
    return this.listOf(topicId).map(HarnessQueueStore.toView)
  }

  /** Whether the topic has queued messages (used after a turn ends to decide automatic continuation) */
  hasPending(topicId: number): boolean {
    return (this.pending.get(topicId)?.length ?? 0) > 0
  }

  /** Remove one entry from the head (for automatic continuation after a turn ends); returns null if none */
  shift(topicId: number): QueuedMessage | null {
    const list = this.pending.get(topicId)
    if (!list || list.length === 0) return null
    const item = list.shift()!
    this.emitChanged(topicId)
    return item
  }

  /** Delete one queued message */
  remove(topicId: number, itemId: string): boolean {
    const list = this.pending.get(topicId)
    if (!list) return false
    const idx = list.findIndex((item) => item.id === itemId)
    if (idx < 0) return false
    list.splice(idx, 1)
    this.emitChanged(topicId)
    return true
  }

  /** Rewrite the text of a queued message (blank content is treated as an invalid edit and ignored) */
  update(topicId: number, itemId: string, text: string): boolean {
    if (!text.trim()) return false
    const item = this.pending.get(topicId)?.find((it) => it.id === itemId)
    if (!item) return false
    item.text = text
    this.emitChanged(topicId)
    return true
  }

  /**
   * Mark "steer now": move from the queue into the pending-injection buffer and record it in this
   * turn's "rollback if not injected" list. Returns the consumed entry (for the IPC layer to emit a
   * steered event), or null if the entry does not exist.
   */
  steer(topicId: number, itemId: string): QueuedMessage | null {
    const list = this.pending.get(topicId)
    if (!list) return null
    const idx = list.findIndex((item) => item.id === itemId)
    if (idx < 0) return null
    const [item] = list.splice(idx, 1)
    let buffer = this.injections.get(topicId)
    if (!buffer) {
      buffer = []
      this.injections.set(topicId, buffer)
    }
    buffer.push(item)
    let holds = this.holds.get(topicId)
    if (!holds) {
      holds = []
      this.holds.set(topicId, holds)
    }
    holds.push(item)
    logger.info(`[HarnessQueue] Steer marked for topic ${topicId}: ${item.text.slice(0, 40)}`)
    this.emitChanged(topicId)
    return item
  }

  /**
   * Take the pending steering messages (called once at each tool node boundary; all are taken,
   * FIFO). The topic key is deleted once empty so long sessions don't leave empty arrays in memory.
   */
  takeInjections(topicId: number): QueuedMessage[] {
    const buffer = this.injections.get(topicId)
    if (!buffer || buffer.length === 0) return []
    const taken = buffer.splice(0, buffer.length)
    this.injections.delete(topicId)
    // Remove injected entries from the "rollback if not injected" list
    const holds = this.holds.get(topicId)
    if (holds) {
      const takenIds = new Set(taken.map((item) => item.id))
      const left = holds.filter((item) => !takenIds.has(item.id))
      if (left.length > 0) this.holds.set(topicId, left)
      else this.holds.delete(topicId)
    }
    return taken
  }

  /** Number of pending injections (for logs and diagnostics) */
  injectionCount(topicId: number): number {
    return this.injections.get(topicId)?.length ?? 0
  }

  /**
   * Turn wrap-up: put entries marked "steer" that never reached an injection boundary back into the
   * queue (flagged held).
   *
   * Why this is needed: steering is only injected at tool node boundaries; once the model has begun
   * wrapping up (no more tool calls) there is no boundary available. Such content was neither
   * persisted nor added to the conversation flow, so dropping it would waste the user's typing —
   * put it back in the queue and mark it held, hinting that it goes out with the next send while
   * leaving it to the user to delete or keep.
   */
  releaseHolds(topicId: number): void {
    const holds = this.holds.get(topicId)
    this.holds.delete(topicId)
    if (holds && holds.length > 0) {
      const list = this.listOf(topicId)
      for (const item of holds) {
        if (!list.some((it) => it.id === item.id)) {
          item.held = true
          list.push(item)
        }
      }
      logger.info(
        `[HarnessQueue] Topic ${topicId} has ${holds.length} queued messages that never reached an injection boundary, put back in queue`
      )
      this.emitChanged(topicId)
    }
    // The buffer may still hold entries (theoretically emptied by take; clear defensively)
    this.injections.delete(topicId)
  }

  /** Injection complete: emit the steered event (the frontend removes that row from the queue + brief toast) */
  notifyConsumed(topicId: number, consumed: ConsumedSteer): void {
    this.onConsumed?.({ topicId, ...consumed })
    this.emitChanged(topicId)
  }

  /**
   * Clear the queue when a topic is deleted / a new conversation is started (including the
   * pending-injection buffer and the rollback list).
   * No broadcast: the delete-topic path resets the whole frontend, and a new conversation performs
   * a queue query anyway.
   */
  clear(topicId: number): void {
    this.injections.delete(topicId)
    this.holds.delete(topicId)
    if (this.pending.delete(topicId)) logger.info(`[HarnessQueue] Topic ${topicId} queue cleared`)
  }

  /**
   * Discard this turn's steering messages (the user clicked stop: they become void with this turn;
   * queued messages are kept). Also clears the "rollback if not injected" list, otherwise a later
   * releaseHolds would put the already-void steering messages back into the queue.
   */
  dropInjections(topicId: number): void {
    const dropped =
      (this.injections.get(topicId)?.length ?? 0) + (this.holds.get(topicId)?.length ?? 0)
    this.injections.delete(topicId)
    this.holds.delete(topicId)
    if (dropped > 0) {
      logger.info(`[HarnessQueue] Topic ${topicId}: ${dropped} queued messages discarded with this round's cancellation`)
    }
  }

  private emitChanged(topicId: number): void {
    this.onChanged?.({ topicId, queue: this.view(topicId) })
  }

  private static toView(item: QueuedMessage): QueuedMessageView {
    const attachments = [
      ...(item.documents ?? []).map((doc) => ({ fileName: doc.fileName, isImage: false })),
      ...(item.images ?? []).map((_, i) => ({ fileName: `image-${i + 1}`, isImage: true }))
    ]
    return {
      id: item.id,
      topicId: item.topicId,
      text: item.text,
      createdAt: item.createdAt,
      attachments,
      held: item.held
    }
  }
}

/** Process-level singleton: the queue shares the lifetime of the in-flight stream */
export const harnessQueue = new HarnessQueueStore()
