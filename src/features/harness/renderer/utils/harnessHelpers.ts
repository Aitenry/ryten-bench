import type { TFunction } from 'i18next'
import type { MessageBlock, StreamChunk, ToolCall } from '../../shared/types'

/** 判断工具块与工具事件是否为同一次调用。
 *  优先按 callId 精确匹配；content-block-start 的 id 与 run.toolCalls 的 callId 来源不同
 *  可能不一致，此时按名称+状态回退：同名且未完成的块视为同一次调用 */
export const isSameToolCall = (
  blockTool: ToolCall,
  incoming: { id?: string; name: string }
): boolean => {
  if (incoming.id) {
    if (blockTool.id === incoming.id) return true
    // preparing 阶段还没有 id，按名称匹配
    if (!blockTool.id && blockTool.status === 'preparing' && blockTool.name === incoming.name)
      return true
    // ID 不同但名称相同且块未完成：content-block-start 与 call.callId 来源不同，回退按名称
    return !!(
      blockTool.id &&
      blockTool.status &&
      blockTool.status !== 'completed' &&
      blockTool.name === incoming.name
    )
  }
  return blockTool.name === incoming.name || blockTool.name === ''
}

/**
 * 计算文本增量：兼容 provider 下发完整文本而非增量的场景。
 * - 若 incoming 是 previous 的扩展，仅返回新增后缀；
 * - 否则按增量处理，返回 incoming 本身。
 *
 * 注意：不再做「previous.endsWith(incoming) → ''」的后缀去重——主进程已按形态去重，
 * 增量形态下后缀相同往往是模型真实输出的重复内容（如表格相邻相同行、"好的，好的，…"），
 * 误判为重复发送会导致真实内容被丢弃，且后续增量全部错位。
 */
export const computeTextDelta = (incoming: string, previous: string): string => {
  if (incoming.startsWith(previous) && incoming.length > previous.length) {
    return incoming.slice(previous.length)
  }
  return incoming
}

/**
 * 将新块追加到数组末尾；只做追加，不根据智能体状态做重排。
 * 合并/去重由调用方负责，确保最终顺序严格等于事件流顺序。
 */
export const pushBlock = (blocks: MessageBlock[], block: MessageBlock): void => {
  blocks.push(block)
}

/**
 * 工具进行中/完成态标签（与 AssistantMessage 渲染共用，测试断言同源）：
 * - preparing：模型已吐出工具名、正在生成参数（阶段二「参数构建中」）
 * - executing：系统正在执行参数
 * - 其余：静态工具名
 * 非组件函数：译文由调用方传入 t（hook 只能在组件/自定义 Hook 内调用）
 */
export const getToolStatusLabel = (
  t: TFunction,
  toolName: string,
  phase: 'preparing' | 'executing' | undefined
): string => {
  if (phase === 'preparing') return t('harness.helpers.toolPreparing', { name: toolName })
  if (phase === 'executing') return t('harness.helpers.toolExecuting', { name: toolName })
  return toolName
}

/**
 * 占位名兜底：部分 provider 首个工具块不携带工具名（以占位名 'tool' 登记）。
 * executing 未按名称匹配到 preparing 块时，并入最近的占位块并改名为真实工具名，
 * 避免「tool · 参数构建中…」幽灵块与真实工具块并存。返回下标，未找到返回 -1。
 */
export const findPlaceholderPreparingTool = (blocks: MessageBlock[]): number => {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.type === 'tool' && b.tool?.status === 'preparing' && b.tool.name === 'tool') return i
  }
  return -1
}

/**
 * 流式静默窗口阈值：已有可见输出、loading 中、超过该时长无任何新 chunk 时，
 * 视为「模型仍在生成但流内无事件」（推理型模型生成大参数期间 SSE 静默的典型表现），
 * 由 UI 显示「正在生成…」光泽指示行（诚实不冒充工具名）。
 */
export const STREAM_SILENCE_MS = 2500

/** 流式静默指示判定（纯逻辑，测试脚本与渲染同源） */
export const shouldShowSilenceIndicator = (args: {
  loading: boolean
  /** 已有任何可见输出（正文/推理/工具块/子代理块等） */
  hasStartedContent: boolean
  now: number
  /** 最后收到 chunk 的时间戳（缺省用消息创建时间） */
  lastChunkAt: number
}): boolean => {
  if (!args.loading || !args.hasStartedContent) return false
  return args.now - args.lastChunkAt >= STREAM_SILENCE_MS
}

/**
 * chunk 是否「只带正文」/「只带思考」：任何其它载荷（工具、子代理、记忆注入、压缩、重试、
 * 错误、目标轮标记、插话段落边界）都算边界，不能并进同一段文本增量里。
 */
const isPureTextChunk = (chunk: StreamChunk): boolean =>
  Boolean(chunk.content) &&
  !chunk.tool &&
  !chunk.reasoning_content &&
  !chunk.subAgent &&
  !chunk.memoryInjected &&
  !chunk.historyCompacted &&
  !chunk.historyCompacting &&
  !chunk.retrying &&
  !chunk.streamError &&
  !chunk.goalRound &&
  !chunk.steered

const isPureReasoningChunk = (chunk: StreamChunk): boolean =>
  Boolean(chunk.reasoning_content) &&
  !chunk.content &&
  !chunk.tool &&
  !chunk.subAgent &&
  !chunk.memoryInjected &&
  !chunk.historyCompacted &&
  !chunk.historyCompacting &&
  !chunk.retrying &&
  !chunk.streamError &&
  !chunk.goalRound &&
  !chunk.steered

/**
 * 单条助手消息内的「任务分段」——供消息内容按任务折叠使用。
 *
 * 背景：一条长回复里工具卡/思考段可以累积到几百块，而渲染开销与**同时挂载的块数**成正比
 * （仿真台实测：375 块 253~305KB/次刷入，80 块 77KB/次）。按任务折叠后，折起的任务整组
 * 不渲染，开销随可见块数下降。
 *
 * 归属规则（块与任务在存储层没有关联，只能从流里推导）：
 * - `write_todos` 的工具块是**分段边界**：它带着当时的完整清单快照；
 * - 快照里标为 `in_progress` 的那一项，就是**紧随其后**那批块所属的任务（模型先开任务再干活）；
 * - 快照里没有 in_progress（例如最后那次「全部完成」的收尾写入）时**不开新段**，
 *   后续块并入当前段，避免出现一个没有意义的空任务头；
 * - 首个 write_todos 之前的块（记忆注入卡、收尾前的正文等）归属 `task: null` 段，不显示任务头。
 */
export interface TaskSegment {
  /** 稳定 key：任务名 + 该任务第几次出现（同名任务被重新开始时不会串） */
  key: string
  /** 任务名；null = 不属于任何任务（头部内容 / 未规划的块） */
  task: string | null
  /** 该任务在快照里的状态；null 段为 null */
  status: 'completed' | 'in_progress' | 'pending' | null
  /** 段内块在合并后块数组里的下标（保持原顺序） */
  blockIndices: number[]
  /** 段内 write_todos 块的下标：正文里不再渲染（改由折叠头的「清单」按需展开） */
  writeIndices: number[]
  /** 段内**最后一次** write_todos 快照：点开「清单」时显示的内容 */
  snapshot: { content: string; status: string }[]
}

/** 取 write_todos 快照里的清单项（非 write_todos 块返回 null） */
const todoSnapshotOf = (block: MessageBlock): { content: string; status: string }[] | null => {
  if (block.type !== 'tool' || block.tool?.name !== 'write_todos') return null
  const todos = (
    block.tool.input as { todos?: { content?: string; status?: string }[] } | undefined
  )?.todos
  if (!Array.isArray(todos)) return null
  return todos.map((t) => ({ content: String(t?.content ?? ''), status: String(t?.status ?? '') }))
}

/** 取出 write_todos 快照里「正在进行的任务」 */
const inProgressTaskOf = (block: MessageBlock): string | null => {
  const todos = todoSnapshotOf(block)
  if (!todos) return null
  return todos.find((t) => t.status === 'in_progress')?.content ?? null
}

/** 把块序列切成任务段（纯函数：输入块数组，输出段划分，不改动入参）
 *
 *  `streaming`：该条消息是否仍在流式。只影响**末段**的状态判定——见下方状态推导。
 */
export function buildTaskSegments(
  blocks: MessageBlock[],
  options: { streaming?: boolean } = {}
): TaskSegment[] {
  const segments: TaskSegment[] = []
  const seen = new Map<string, number>()
  const fresh = (extra: Partial<TaskSegment>): TaskSegment => ({
    key: 'segment-head',
    task: null,
    status: null,
    blockIndices: [],
    writeIndices: [],
    snapshot: [],
    ...extra
  })
  let current = fresh({})

  for (let i = 0; i < blocks.length; i += 1) {
    const snapshot = todoSnapshotOf(blocks[i])
    const started = inProgressTaskOf(blocks[i])
    if (started) {
      // 已有内容的段先收口（空段不产出，避免连续 write_todos 造出空任务头）
      if (current.blockIndices.length > 0) {
        // 这一条 write_todos 同时是上一段的**收尾快照**（它通常把上一段的任务标成 completed）。
        // 记进上一段：否则上一段清单里那个任务永远停在 in_progress，而段头状态点已经是绿的，
        // 两处颜色互相打架（用户反馈「什么颜色都有」）。它不属于上一段的正文，故不进 writeIndices。
        if (snapshot) current.snapshot = snapshot
        segments.push(current)
      }
      const nth = (seen.get(started) ?? 0) + 1
      seen.set(started, nth)
      current = fresh({ key: `segment-${nth}-${started}`, task: started, status: 'in_progress' })
    }
    current.blockIndices.push(i)
    if (snapshot) {
      current.writeIndices.push(i)
      current.snapshot = snapshot
    }
  }
  if (current.blockIndices.length > 0) segments.push(current)

  /**
   * 任务状态推导（用户 2026-09-19：「任务都已经完成了，并没有显示绿色，什么颜色都有」）。
   *
   * 旧实现的错：段的 status 在**开段那一刻**写成 'in_progress' 就再没更新过——于是
   * ① 后面明明又开过新任务（＝这个任务早结束了），它还是蓝的；
   * ② 一轮跑完、清单里最后那次「全部完成」写入也落在末段里，末段的点仍然是蓝的。
   * 现在按「段内最后一次快照 = 唯一真源」推导，规则：
   *  - 非末段：后面还有别的任务段 ⇒ 这个任务已经结束 → completed（绿）；
   *  - 末段：看**本段最后一次快照**里这个任务的状态；快照里没有它（改过名等）时按
   *    「仍在流式 → in_progress，否则 completed」兜底——一轮已经结束就不该再显示「进行中」；
   *  - pending 保持 pending（灰），不把没开始的任务说成完成。
   */
  return segments.map((segment, index) => {
    if (!segment.task) return segment
    const isLast = index === segments.length - 1
    if (!isLast) return { ...segment, status: 'completed' as const }
    const own = segment.snapshot.find((item) => item.content === segment.task)?.status
    if (own === 'pending') return { ...segment, status: 'pending' as const }
    if (own === 'completed') return { ...segment, status: 'completed' as const }
    return {
      ...segment,
      status: options.streaming ? ('in_progress' as const) : ('completed' as const)
    }
  })
}

/**
 * 「连续相同的工具调用折到一起」（用户 2026-09-25：「连续相同的工具调用需要折叠到一起」）。
 *
 * 动因：前期探索段不再折叠之后（同日另一条要求），模型一轮里连着读 10 个文件、连着 grep 5 次
 * 就直接摊成十来个卡片，铺开的正文又变成一堵墙。归并只做一件事：把**相邻的同名工具块**
 * 收进一个折叠组，组头写清「哪个工具、几次」，卡片本身一点就展开、内容一点没少。
 *
 * 规则（纯函数，便于离线断言）：
 *  - 只认**相邻**同名（`read_file → read_file`）。中间夹了别的工具、正文或思考就断开——
 *    那已经是两个步骤，合起来会掩盖执行顺序；
 *  - 长度 ≥ `TOOL_RUN_MIN` 才成组，单次调用保持原样（不为一次调用多摆一层折叠）；
 *  - 待办记账工具（write_todos / read_todos）**既不参与也不打断**：它们在正文里不渲染
 *    （见 AssistantMessage 的说明），视觉上本来就是透明的，让它们把一串读文件切成两半不对；
 *  - 非工具块原样按顺序返回，调用方照旧走块级缓存渲染。
 */
const HIDDEN_INLINE_TOOLS = new Set(['write_todos', 'read_todos'])

/** 成组的最小长度：2 = 相邻两次同名就并成一组 */
export const TOOL_RUN_MIN = 2

export type ToolRunEntry =
  { kind: 'block'; index: number } | { kind: 'run'; name: string; indices: number[] }

/** 把一段块下标序列归并成「单块 / 同名工具组」的渲染序列（保持原顺序） */
export function buildToolRuns(items: MessageBlock[], indices: number[]): ToolRunEntry[] {
  const out: ToolRunEntry[] = []
  let runName = ''
  let runIndices: number[] = []
  const flush = (): void => {
    if (runIndices.length >= TOOL_RUN_MIN) {
      out.push({ kind: 'run', name: runName, indices: runIndices })
    } else {
      for (const index of runIndices) out.push({ kind: 'block', index })
    }
    runName = ''
    runIndices = []
  }

  for (const index of indices) {
    const block = items[index]
    const name = block?.type === 'tool' ? block.tool?.name : undefined
    if (name && HIDDEN_INLINE_TOOLS.has(name)) continue
    if (name && name === runName) {
      runIndices.push(index)
      continue
    }
    flush()
    if (name) {
      runName = name
      runIndices = [index]
    } else {
      out.push({ kind: 'block', index })
    }
  }
  flush()
  return out
}

/**
 * 合批内合并「累积形态」的同类增量（正文 / 思考各自成段）。
 *
 * 背景（2026-09-18 渲染进程内存实测）：合批只减少了 React commit 次数，逐 chunk 应用时
 * 每一步仍要做 `(已累积文本) + 增量`——累积形态的 provider 下这是 O(L) 的整块复制，
 * 一条几十万字符的回复配两万条增量 = O(L²) 的瞬时分配（实测 workingSet 从 534MB 涨到
 * 5991MB，长时间目标轮次下必然 OOM）。累积形态里「一批的最后一条」本身即这批的全量结果，
 * 用它代表整段：下游 computeTextDelta 仍按原规则算出本批增量，分配量降到每批一次。
 *
 * 只合并能确认是累积形态的段（末条以首条开头且更长）。增量形态（每条只带新增片段）合并
 * 会与 computeTextDelta 的累积判定语义冲突，一律原样保留。
 */
export function coalesceChunks(batch: StreamChunk[]): StreamChunk[] {
  const out: StreamChunk[] = []
  let i = 0
  while (i < batch.length) {
    const head = batch[i]
    const kind: 'content' | 'reasoning_content' | null = isPureTextChunk(head)
      ? 'content'
      : isPureReasoningChunk(head)
        ? 'reasoning_content'
        : null

    if (!kind) {
      out.push(head)
      i += 1
      continue
    }

    let j = i + 1
    while (
      j < batch.length &&
      (kind === 'content' ? isPureTextChunk(batch[j]) : isPureReasoningChunk(batch[j]))
    ) {
      j += 1
    }

    const run = batch.slice(i, j)
    if (run.length > 1) {
      const first = String(run[0][kind] ?? '')
      const last = String(run[run.length - 1][kind] ?? '')
      if (last.length > first.length && last.startsWith(first)) {
        // 累积形态：末条即全量，整段收敛成一条
        out.push({ ...run[run.length - 1] })
        i = j
        continue
      }
    }

    // 单条 / 增量形态：保持逐条，语义与合批前完全一致
    out.push(...run)
    i = j
  }
  return out
}

/**
 * 「收尾阶段」判定（用户 2026-09-25 选定的口径）：
 * 消息里**最后一个非内容块**是不是一次「收口」的 `write_todos`——清单里至少有一项
 * `completed`、且没有任何 `in_progress`。是则返回它在块数组里的下标，否则返回 -1。
 *
 * 为什么用这个信号：真实会话（topic 237/292、236/282）的块序列是
 * `write_todos(任务一) → 一句话 → write_todos(任务一完成/任务二) → 一句话 → … → 最终回答`，
 * 每项任务结束时那句话与最终回答在流式时长得一模一样。只有「清单收口」这一次写入是模型
 * **自己宣告「活干完了，接下来是交付给用户的回答」**的数据层事实——据此才能让最终回答
 * 从一开始就流式渲染在折叠外，而不必把每项任务那句话也搬到外面，更不会来回搬。
 *
 * 判据是「最后一个非内容块」，所以模型收口后又接着调工具（自相矛盾的情形）自然不成立：
 * 那时实时摘出的内容会被收回折叠里（这是唯一会跳的情形，且只在模型反悔时发生）。
 *
 * @param blocks 渲染端合并块数组（或主进程累积块，两边都按到达顺序 append）
 */
export function answerPhaseFrom(blocks: MessageBlock[]): number {
  let lastNonContent = -1
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const type = blocks[i]?.type
    if (type === 'reasoning' || type === 'text') continue
    lastNonContent = i
    break
  }
  if (lastNonContent < 0) return -1
  const block = blocks[lastNonContent]
  if (block.type !== 'tool' || block.tool?.name !== 'write_todos') return -1
  const todos = (block.tool.input as { todos?: { status?: string }[] } | undefined)?.todos
  if (!Array.isArray(todos) || todos.length === 0) return -1
  const statusOf = (item: { status?: string }): string => String(item?.status ?? '')
  if (todos.some((item) => statusOf(item) === 'in_progress')) return -1
  return todos.some((item) => statusOf(item) === 'completed') ? lastNonContent : -1
}

/**
 * 段内末尾那段「思考 + 正文」（末尾连续 reasoning/text，且至少含一段正文）在块数组里的下标。
 *
 * 与主进程 `answerTrailingCount` / `answerTailIndices` 同口径（反向扫到第一个非内容块为止），
 * 渲染端的两处调用共用它：整轮结束后的兜底扫描、以及收尾阶段（`answerPhaseFrom`）的实时摘出。
 * 整段以思考结尾（没有正文可摘）时返回空数组——没有交付给用户的回答，交给折叠统一收着。
 */
export function tailContentIndices(blocks: MessageBlock[], indices: readonly number[]): number[] {
  let cut = indices.length
  let sawText = false
  while (cut > 0) {
    const type = blocks[indices[cut - 1]]?.type
    if (type === 'text') {
      sawText = true
      cut -= 1
      continue
    }
    if (type === 'reasoning') {
      cut -= 1
      continue
    }
    break
  }
  return sawText ? indices.slice(cut) : []
}

/**
 * 答复边界（协议层真源）→ 渲染端的块下标集合。
 *
 * 主进程随内容 chunk 打 `answer` 标记、随 done 事件给 `answerBlocks` 数量
 * （见 plugins/harness/main/service/answer-boundary.ts）。渲染端**只读不猜**：
 * 这里把「末尾第 N 块是答复」翻译成本端合并块数组的下标集合，并且带两道守卫——
 *   ① 数量必须落在数组范围内（协议演进/版本不一致时宁可不标，也不能错切）；
 *   ② 被标的块必须是 reasoning/text。
 *
 * 返回 null = 明确没有答复（本轮中止、只有工具/思考、或主进程已撤回标记）；
 * 返回 undefined = 主进程没给结论（老版本/异常路径）——此时渲染端保留旧行为。
 *
 * @param blocks 渲染端合并块数组（**必须先滤掉只在渲染端存在的过渡块**，例如 retrying）
 */
export function answerTailIndices(
  blocks: MessageBlock[],
  count: number | null | undefined
): Set<number> | null | undefined {
  if (count === undefined) return undefined
  if (count === null || count <= 0) return null
  if (count > blocks.length) return undefined
  const start = blocks.length - count
  const out = new Set<number>()
  for (let i = start; i < blocks.length; i += 1) {
    const type = blocks[i]?.type
    if (type !== 'reasoning' && type !== 'text') return undefined
    out.add(i)
  }
  return out
}

/**
 * 从**已累积的标记**推出本端当前的答复下标集合（流式过程中每来一块重算）。
 *
 * 口径与主进程 `answerTrailingCount` **必须逐字一致**：末尾连续的 reasoning/text，
 * 且**至少含一个 text 块**才算答复——只有思考的尾巴不算（本轮被中止、或思考刚流出、
 * 正文还没到）。这条曾经漏过：渲染端只要末尾是 reasoning 就返回集合，于是末轮思考一
 * 开始流动就被摘到折叠外，而主进程同时刻的边界是 0，两侧对同一形态给出相反结论。
 *
 * 用本端自己的块数组算，因此不受两侧块数差异影响（渲染端会合并相邻 reasoning、
 * 还会有只在渲染端存在的过渡块）。返回 null = 当前没有答复（调用方据此把答复收回折叠里）。
 */
export function answerMarkedIndices(blocks: MessageBlock[]): Set<number> | null {
  let start = blocks.length
  let sawText = false
  while (start > 0) {
    const type = blocks[start - 1]?.type
    if (type === 'text') {
      sawText = true
      start -= 1
      continue
    }
    if (type === 'reasoning') {
      start -= 1
      continue
    }
    break
  }
  if (!sawText) return null
  const out = new Set<number>()
  for (let i = start; i < blocks.length; i += 1) out.add(i)
  return out
}
