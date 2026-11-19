import logger from 'electron-log'

/**
 * 对话插话队列（按话题隔离）——生成中发消息时不打断当前回合，先把消息收进队列，
 * 由用户在队列条上点「立即插话」把它并入**正在运行**的回合（工具节点边界注入模型上下文），
 * 或等当前回合自然结束后由主进程作为新一轮自动接续发出。
 *
 * 两条通道职责分明：
 * - pending：**排队中**的消息（还没进模型），可编辑/删除/插话；
 * - injections：已被点「插话」、等待在下一个工具节点边界并入模型的缓冲（FIFO）。
 *
 * 队列是内存状态（与进行中的流同生命周期）：应用重启后未发出的插话不保留。
 */

/** 插话携带的附件（与 HarnessOptions 的字段一致，插话发起新一轮时原样透传） */
export interface QueueAttachments {
  images?: string[]
  documents?: { fileName: string; filePath: string }[]
}

/** 队列条目（主进程侧完整数据，含附件原始内容） */
export interface QueuedMessage {
  id: string
  topicId: number
  /** 发起这条插话的渲染进程 sender.id（投递回执与队列广播去重都用它） */
  senderId: number
  text: string
  images?: string[]
  documents?: { fileName: string; filePath: string }[]
  createdAt: number
  /** 点过插话但本轮没等到注入边界（见 releaseHolds） */
  held?: boolean
}

/** 下发给渲染进程的队列视图（不含 dataURL 正文，避免每次广播驮着几 MB 图片） */
export interface QueuedMessageView {
  id: string
  topicId: number
  text: string
  createdAt: number
  attachments: { fileName: string; isImage: boolean }[]
  /**
   * true = 这条点过「插话」但本轮没等到注入边界（模型已不再调用工具）。
   * 它不进对话流也不落库，留在队列里提示「随下一次发送带出」，避免内容悄悄丢失。
   */
  held?: boolean
}

/**
 * 一条插话被并入模型上下文。**纯注入**：既不落库、也不在对话流里新增气泡，
 * 更不会把助手输出切成两条消息——它只影响模型接下来的行为（用户明确要求）。
 */
export interface ConsumedSteer {
  item: QueuedMessage
}

/** 队列变更事件（enqueue / remove / update / 消费 / 回合结束回退） */
export interface QueueChangeEvent {
  topicId: number
  queue: QueuedMessageView[]
}

/** 插话注入事件（前端据此把该行从队列里抹掉并给一句瞬时反馈） */
export interface SteerConsumedEvent extends ConsumedSteer {
  topicId: number
}

/** electron-store 等外部依赖无关的纯状态容器；广播与落库由 IPC 层挂载 */
class HarnessQueueStore {
  /** topicId → 排队中的插话（FIFO） */
  private readonly pending = new Map<number, QueuedMessage[]>()
  /** topicId → 已点「插话」、等待工具节点边界并入模型的条目（FIFO） */
  private readonly injections = new Map<number, QueuedMessage[]>()
  /** topicId → 本轮点过插话但尚未注入的条目（回合结束仍未注入则放回排队区） */
  private readonly holds = new Map<number, QueuedMessage[]>()
  private seq = 0

  /** 队列变更回调（IPC 层广播 harness-queue-updated） */
  onChanged: ((event: QueueChangeEvent) => void) | null = null
  /** 插话消费回调（IPC 层广播 harness-queue-steered） */
  onConsumed: ((event: SteerConsumedEvent) => void) | null = null

  /**
   * 话题是否正有回合在跑（IPC 层维护）。生成中的消息走排队，不打断当前回合；
   * 没有回合在跑时直接发起新一轮，不排进队列。
   */
  private readonly active = new Set<number>()

  setTurnActive(topicId: number, active: boolean): void {
    if (active) this.active.add(topicId)
    else this.active.delete(topicId)
  }

  isTurnActive(topicId: number): boolean {
    return this.active.has(topicId)
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

  /** 入队（排在队尾）；返回新条目 */
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
      `[HarnessQueue] 入队话题 ${params.topicId}：${item.text.slice(0, 40)}（队列 ${this.listOf(params.topicId).length} 条）`
    )
    this.emitChanged(params.topicId)
    return item
  }

  /** 队列视图（FIFO，供广播与查询） */
  view(topicId: number): QueuedMessageView[] {
    return this.listOf(topicId).map(HarnessQueueStore.toView)
  }

  /** 话题是否有排队消息（回合结束后判断是否自动接续） */
  hasPending(topicId: number): boolean {
    return (this.pending.get(topicId)?.length ?? 0) > 0
  }

  /** 摘除队首一条（回合结束后自动接续用）；没有则返回 null */
  shift(topicId: number): QueuedMessage | null {
    const list = this.pending.get(topicId)
    if (!list || list.length === 0) return null
    const item = list.shift()!
    this.emitChanged(topicId)
    return item
  }

  /** 删除一条排队消息 */
  remove(topicId: number, itemId: string): boolean {
    const list = this.pending.get(topicId)
    if (!list) return false
    const idx = list.findIndex((item) => item.id === itemId)
    if (idx < 0) return false
    list.splice(idx, 1)
    this.emitChanged(topicId)
    return true
  }

  /** 改写一条排队消息的文本（空白内容视为无效改写，不改） */
  update(topicId: number, itemId: string, text: string): boolean {
    if (!text.trim()) return false
    const item = this.pending.get(topicId)?.find((it) => it.id === itemId)
    if (!item) return false
    item.text = text
    this.emitChanged(topicId)
    return true
  }

  /**
   * 标记「立即插话」：从排队区移入待注入缓冲，并记进本轮「未注入则回退」名单。
   * 返回被消费的条目（供 IPC 层下发 steered 事件），条目不存在返回 null。
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
    logger.info(`[HarnessQueue] 标记插话话题 ${topicId}：${item.text.slice(0, 40)}`)
    this.emitChanged(topicId)
    return item
  }

  /**
   * 取出待注入的插话（工具节点边界调用一次，全部取出，FIFO）。
   * 取空后清掉话题键，避免长会话在内存里留空数组。
   */
  takeInjections(topicId: number): QueuedMessage[] {
    const buffer = this.injections.get(topicId)
    if (!buffer || buffer.length === 0) return []
    const taken = buffer.splice(0, buffer.length)
    this.injections.delete(topicId)
    // 已注入的条目从「未注入则回退」名单里划掉
    const holds = this.holds.get(topicId)
    if (holds) {
      const takenIds = new Set(taken.map((item) => item.id))
      const left = holds.filter((item) => !takenIds.has(item.id))
      if (left.length > 0) this.holds.set(topicId, left)
      else this.holds.delete(topicId)
    }
    return taken
  }

  /** 待注入条数（日志与诊断用） */
  injectionCount(topicId: number): number {
    return this.injections.get(topicId)?.length ?? 0
  }

  /**
   * 回合收尾：把「点了插话但始终没等到注入边界」的条目放回排队区（标记 held）。
   *
   * 为什么需要：插话只在工具节点边界注入，模型若已进入收尾（不再调用工具）就没有边界可用。
   * 这些内容既没落库也没进对话流，直接丢掉等于用户白打字——放回队列并标 held，
   * 提示「随下一次发送带出」，由用户决定删掉还是留着。
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
        `[HarnessQueue] 话题 ${topicId} 有 ${holds.length} 条插话未等到注入边界，已放回队列`
      )
      this.emitChanged(topicId)
    }
    // 缓冲里可能还留着（理论上被 take 清空，防御性清一遍）
    this.injections.delete(topicId)
  }

  /** 插话注入完成：下发 steered 事件（前端把该行从队列里抹掉 + 瞬时反馈） */
  notifyConsumed(topicId: number, consumed: ConsumedSteer): void {
    this.onConsumed?.({ topicId, ...consumed })
    this.emitChanged(topicId)
  }

  /**
   * 话题被删除/新建对话时清空队列（含待注入缓冲与回退名单）。
   * 不广播：删话题路径前端已整片重置，新建对话也会走一次队列查询。
   */
  clear(topicId: number): void {
    this.injections.delete(topicId)
    this.holds.delete(topicId)
    if (this.pending.delete(topicId)) logger.info(`[HarnessQueue] 话题 ${topicId} 队列已清空`)
  }

  /**
   * 丢弃本轮的插话（用户点了停止：这些插话随本轮作废，排队中的消息保留）。
   * 连「未注入回退」名单一起清掉，否则随后的 releaseHolds 会把已经作废的插话又放回队列。
   */
  dropInjections(topicId: number): void {
    const dropped =
      (this.injections.get(topicId)?.length ?? 0) + (this.holds.get(topicId)?.length ?? 0)
    this.injections.delete(topicId)
    this.holds.delete(topicId)
    if (dropped > 0) {
      logger.info(`[HarnessQueue] 话题 ${topicId} 的 ${dropped} 条插话已随本轮取消作废`)
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

/** 进程级单例：队列与「进行中的流」同生命周期 */
export const harnessQueue = new HarnessQueueStore()
