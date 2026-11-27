import { BrowserWindow, app, dialog } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import logger from 'electron-log'
import { isSenderAlive, safeSend } from '../../safe-send'
import { mainMessages } from '../../i18n'
import { settingsStore, streamAbortControllers, activeHarnessStreams } from '../../context'
import { harnessQueue, setHarnessQueueLogger } from '../../services/harness/queue-store'
import { drainPendingTurns } from '../../services/harness/turn-drain'
import { registerIpcHandlers, type EffectScope, type IpcHandlerMap } from '../register'
import type { ToolInfo } from '../../services/harness/types'
import { effectiveMainAgentTools, type MainAgentConfig } from '../../../shared/harness/mcp'
import { HarnessService } from '../../services/harness/harness'
import { buildTools, listAvailableTools } from '../../tools/harness/builders'
import { hasLatticeSession } from '../../lattice/session'
import { readVirtualTextFile } from '../../runtime/harness/fs-backend'
import { getToolOutputStore } from '../../runtime/harness/tool-output-store'
import type {
  AgentInjection,
  ToolCallDetail,
  SubAgentEvent,
  MemoryInjection,
  TurnMeta,
  HistoryCompaction,
  SubAgentMainModelDescriptor
} from '../../services/harness/types'
import type { QueueAttachments } from '../../services/harness/queue-store'
import type { BaseChatModel } from '../../ai/chat-model'
import { getProviderService } from '../../provider/service'
import { listEnabledSubAgents } from '../../services/harness/subagents'
import { todoStore } from '../../runtime/harness/todo'
import { closeOutInProgress, decideCloseOutOnTurnEnd } from '../../runtime/harness/todo-closeout'
import { answerTrailingCount, type TurnFinal } from '../../services/harness/answer-boundary'
import { goalStore } from '../../runtime/harness/goal'
import { planModeStore } from '../../runtime/harness/plan-mode'
import { teamModeStore } from '../../runtime/harness/team-mode'
import { jobsRegistry } from '../../runtime/harness/jobs'
import { subagentSessions } from '../../runtime/harness/subagent-sessions'
import { teamStore } from '../../runtime/harness/team'
import type {
  SubagentConversationEvent,
  SubagentPromptResult
} from '../../runtime/harness/subagent-conversation'
import { startMemoryAgent, type StartMemoryAgentResult } from '../../runtime/harness/memory-agent'
import { questionService } from '../../runtime/harness/ask'
import {
  permissionGate,
  type ApprovalDecision,
  type ApprovalRequestView
} from '../../runtime/harness/permission-gate'
import {
  permissionStateFor,
  setDefaultPermissionMode,
  setTopicPermissionMode,
  wirePermissionGate
} from '../../runtime/harness/permission-store'
import { isPermissionMode, type PermissionMode } from '../../runtime/harness/permission'
import { ensureExecutable, resolveSandboxAsset, sandboxService } from '../../sandbox/service'
import { setSandboxLogger } from '../../sandbox/log'
import { goalRoundDriver } from '../../services/harness/goal-driver'
import { HarnessSettings } from '../../types/settings'
import {
  createTopic,
  addDialogue,
  updateDialogueContent,
  addDialogueUsage,
  getDialoguesByTopicId,
  getTopicById
} from '../../database/mapper/harness/harness'
import { listTeamTaskEvents } from '../../database/mapper/harness/team-task-event'
import {
  memoryScopeRoot,
  parseMemoryScope,
  serializeMemoryScope,
  type MemoryScope
} from '../../services/harness/memory-scope'
import { getActiveWorkspaceId } from '../../database/workspace-context'
import { sumUsage, type ModelUsageRecord } from '../../runtime/harness/usage'
import {
  startRendererMemorySampling,
  stopRendererMemorySampling
} from '../../services/harness/renderer-memory'
import { activateChatTopic } from '../../services/harness/chat/activation'

/**
 * 主进程 → 渲染层的事件通道（只有发送方、没有 ipcMain 处理器）。
 *
 * 通道名以 `harness:` 开头，渲染层经 preload 的系统桥直接订阅——不需要再登记白名单。
 */
export const HARNESS_EVENTS = {
  streamChunk: 'harness:harness-stream-chunk',
  streamDone: 'harness:harness-stream-done',
  streamError: 'harness:harness-stream-error',
  queueUpdated: 'harness:harness-queue-updated',
  queueSteered: 'harness:harness-queue-steered',
  goalUpdated: 'harness:harness-goal-updated',
  /** 计划模式开关变更（输入框的计划模式徽标实时刷新） */
  planUpdated: 'harness:harness-plan-updated',
  teamModeUpdated: 'harness:harness-team-mode-updated',
  jobsUpdated: 'harness:harness-jobs-updated',
  agentsUpdated: 'harness:harness-agents-updated',
  /** 子代理会话事件增量（打开会话视图时只推给正在查看该子代理的窗口） */
  agentConversationUpdated: 'harness:harness-agent-conversation-updated',
  /** 共享任务板变更（主智能体 / 子代理协作的 team/task 投影，整板快照） */
  teamUpdated: 'harness:harness-team-updated',
  questionAsked: 'harness:harness-question-asked',
  approvalAsked: 'harness:harness-approval-asked',
  /** 某条会话「是否正挂着等用户确认」（侧栏黄点）：提问 / 审批挂起时 true，结算时 false */
  topicPending: 'harness:harness-topic-pending',
  permissionUpdated: 'harness:harness-permission-updated',
  todosUpdated: 'harness:harness-todos-updated',
  /**
   * 生成中本轮累计用量（每次模型调用结束推一条）。
   *
   * 只用于输入框底栏的「本轮 N 次调用 · X tok」实时数字；权威账本仍是流结束后
   * 落库的 harness_dialogue_usage（渲染层在一轮结束时切回它）。
   */
  turnUsage: 'harness:harness-turn-usage'
} as const

/**
 * 轮次执行只需要 sender（存活校验、safeSend、渲染进程失效监听），因此按最小接口收窄类型：
 * 用户轮与队列接续轮共用同一条 `HarnessSenderEvent` 管线。
 *
 * 注：`registerIpc` 只把参数透传给处理器（不传 IpcMainInvokeEvent），所以 sender 由
 * `primarySender()` 解析——本应用只有一个真正运行界面的主窗口（加载窗口不跑 harness），
 * 取第一个存活窗口与原 `event.sender` 等价。
 */
interface HarnessSenderEvent {
  sender: Electron.WebContents
}

/** 目标渲染帧：第一个存活窗口（与 notes 图谱通道「广播给所有存活窗口」同一取舍） */
function primarySender(): Electron.WebContents | null {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  return win ? win.webContents : null
}

/** 单轮对话执行参数（用户轮 / 队列接续轮 / 目标自动轮共用 runHarnessTurn 管线） */
interface RunHarnessTurnParams {
  event: HarnessSenderEvent
  question: string
  /**
   * 本轮回合 id（`harnessQueue.beginTurn` 的值）。
   *
   * launchTurn 在为**已存在的话题**起轮时先登记并传进来；新话题（首条消息）由
   * runHarnessTurn 建完话题后再登记。这个 id 随每个 chunk / done / error 下发，
   * 渲染端据此丢弃过期回合的事件（同话题两轮串台是「输出错乱」的根因）。
   */
  turnId?: number
  options?: {
    topicId?: number
    providerId?: number
    images?: string[]
    documents?: { fileName: string; filePath: string }[]
    turnMeta?: TurnMeta
    /**
     * 「编辑并重发」：这一轮的提问已经存在库里（气泡内就地编辑），直接改写该行内容，
     * 不再插入新的用户消息行——否则库里会多出一条同内容提问、历史顺序也被挪到末尾。
     */
    reuseUserDialogueId?: number
    /**
     * 前端为这一轮登记的助手消息临时 id（首段）。回合内插话会切分助手输出，主进程为
     * 每个段落生成新的临时 id，随 steered chunk 下发，前端据此把段落接到对应气泡上。
     */
    messageId?: string
    /**
     * 记忆作用域（`plugin:<插件 id>`）。只在**主进程兜底建话题**时用得上——
     * 常规路径是渲染层先 `harness-topic-create`（把作用域写进话题行），主进程按话题读。
     */
    memoryScope?: string | null
  }
}

/** 落库后的助手消息（一轮一条；插话是纯注入，不切分） */
interface AssistantSegment {
  messageId: string
  dialogueId: number | null
  content: string
}

/** 流式段落累积器：插话边界处整体换新的一组状态 */
interface SegmentAccumulator {
  blocks: {
    type: string
    text?: string
    tool?: ToolCallDetail
    reasoning?: string
    subAgent?: SubAgentEvent
    memory?: MemoryInjection
    compaction?: HistoryCompaction
    children?: {
      type: string
      text?: string
      tool?: ToolCallDetail
      reasoning?: string
    }[]
  }[]
  content: string
  reasoning: string
  failed: boolean
  /** 本段是否已写入早期对话摘要压缩块（压缩卡片只保留在首段，避免插话后重复） */
  compactionSeen: boolean
}

/**
 * 写入本轮对话用量（harness_dialogue_usage）。
 *
 * - 只在模型**真的回传了 token 数字**时写：宁可没有行，也不写全 0 的假数据；
 * - token 是整轮累加（工具循环会有多次模型往返），每次调用的原始 usage_metadata
 *   以 JSON 数组存进 usage_metadata 列，保留 reasoning / cached 等各家明细；
 * - 供应商与模型存**快照**：供应商配置之后被删改也不影响这条账目。
 */
async function persistTurnUsage(params: {
  dialogueId: number
  topicId: number
  providerId?: number
  records: ModelUsageRecord[]
}): Promise<void> {
  const { dialogueId, topicId, providerId, records } = params
  if (records.length === 0) return
  const totals = sumUsage(records)
  if (!totals.hasTokens) {
    logger.info('[Harness] Model returned no usage_metadata, skipping usage persistence')
    return
  }
  try {
    let providerMark: string | null = null
    let configuredModel: string | null = null
    try {
      const config = await getProviderService().getConfig(providerId)
      providerMark = config?.provider ?? null
      configuredModel = config?.model ?? null
    } catch (err) {
      logger.warn(
        '[Harness] Failed to read provider config, usage row will only record tokens:',
        err
      )
    }
    await addDialogueUsage({
      workspace_id: getActiveWorkspaceId(),
      topic_id: topicId,
      dialogue_id: dialogueId,
      provider_id: providerId ?? null,
      provider: providerMark,
      // 响应里带的模型名优先（可能被用户临时切过模型），否则用当前配置
      model: records.find((r) => r.model)?.model ?? configuredModel,
      input_tokens: totals.inputTokens,
      output_tokens: totals.outputTokens,
      total_tokens: totals.totalTokens,
      calls: totals.calls,
      usage_metadata: JSON.stringify(
        records.map((r) => ({ model: r.model, subagent: r.subagent ?? false, usage: r.usage }))
      )
    })
    logger.info(
      `[Harness] Usage persisted dialogue=${dialogueId} in/out/total=${totals.inputTokens}/${totals.outputTokens}/${totals.totalTokens} calls=${totals.calls}`
    )
  } catch (err) {
    logger.error('[Harness] Failed to write dialogue usage:', err)
  }
}

/**
 * 执行一轮完整对话：建模型 → 建话题 → 存用户消息 → 流式 → 存 AI 回复 → 通知前端。
 * 返回 { topicId, cancelled, turnId }（cancelled=true 表示用户点了停止）。
 */
async function runHarnessTurn(
  params: RunHarnessTurnParams
): Promise<{ topicId: number; cancelled: boolean; turnId: number }> {
  const { event, question, options } = params

  // 渲染进程已失效（崩溃/窗口关闭）时跳过本轮：不再创建模型、不保存消息、不向死帧发送
  if (!isSenderAlive(event.sender)) {
    logger.warn(
      `[Harness] Renderer process is gone (senderId=${event.sender.id}), skipping this turn`
    )
    return { topicId: options?.topicId ?? 0, cancelled: true, turnId: 0 }
  }

  // 加载主智能体默认配置（electron-store）
  const mainAgentDefaults = settingsStore.get('mainAgent') as MainAgentConfig | undefined
  let harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined
  logger.info(`[Harness] Creating model with providerId: ${options?.providerId ?? 'default'}`)

  // 0. 本轮的记忆作用域与「插件模式」。**必须在建话题、建工具之前定下来**：
  //    插件模式决定工坊那 4 个工具是否自动挂载（见 shared/mcp.ts 的 PLUGIN_MODE_TOOL_NAMES），
  //    话题上的工具快照与真正挂载的工具集必须是同一个口径。
  //    作用域以话题上存的为准（重开这条会话 / 重启应用都仍然认），话题还没建时用调用方传来的兜底。
  const memoryScope = await resolveTurnMemoryScope(
    options?.topicId,
    options?.memoryScope,
    harnessSettings?.activeWorkspaceId ?? 0
  )
  const pluginMode = memoryScope.kind === 'plugin'

  // 本轮工具名与实例：用户勾选的（含 MCP 页勾选的 MCP 工具）+ 插件模式自动挂载的模式工具。
  // 「发布版本」要插件中心会话（未登录时连名字都不追加），所以登录态必须在这里现取：
  // 用户中途登录/退出后，下一轮的工具集随之变化，不需要重启。
  const selectedTools = effectiveMainAgentTools(mainAgentDefaults, {
    pluginMode,
    signedIn: hasLatticeSession()
  })
  const tools = buildTools(selectedTools)
  logger.info(
    `[Harness] Tools for this turn: pluginMode=${pluginMode} count=${selectedTools.length} [${selectedTools.join(',')}]`
  )

  // 1. 确保话题存在
  let topicId = options?.topicId
  if (!topicId) {
    const title = question.slice(0, 50)
    const workspaceId = harnessSettings?.activeWorkspaceId ?? 0
    try {
      // 话题上记一份「本轮启用的工具」快照（含 MCP 页勾选的 MCP 工具与模式工具，与真正挂载的口径一致）
      topicId = await createTopic(
        workspaceId,
        title,
        undefined,
        selectedTools.length ? JSON.stringify(selectedTools) : undefined,
        // 记忆作用域：插件 / 对话会话建话题时就落库（见 memory-scope.ts）
        serializeMemoryScope(memoryScope)
      )
      // 「对话」模式：这条会话的目录就是本轮的工作目录（渲染层通常已先建好话题并切过，
      // 这里是兜底路径，保证「没有话题 id 的首次发送」也不会把文件写进根目录）。
      if (memoryScope.kind === 'chat' && topicId) {
        try {
          await activateChatTopic(topicId)
          harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined
        } catch (err) {
          logger.warn(
            '[Chat] Failed to switch session directory for this turn (turn unaffected):',
            err
          )
        }
      }
    } catch (err) {
      logger.error('Failed to create topic:', err)
      topicId = 0
    }
  }

  // 1.5 本轮回合 id：已存在的话题由 launchTurn 先登记并传入（这样「另一个窗口/另一次点击
  //     抢在起轮前」就能被忙检查挡住）；新话题此时才建好，在这里补登记。
  const turnId = params.turnId || (topicId ? harnessQueue.beginTurn(topicId) : 0)

  /** 向渲染进程推一条 chunk：统一带上话题与回合 id（渲染端按回合 id 丢弃过期事件） */
  const sendChunk = (payload: Record<string, unknown>): boolean =>
    safeSend(event.sender, HARNESS_EVENTS.streamChunk, {
      ...payload,
      __topicId: topicId,
      __turnId: turnId
    })

  // 2. 保存用户消息（含图片、文档与目标自动续跑标记）。
  // 提前到模型创建之前（修复：模型创建失败时直接 return,用户消息不落库,重载后丢失）
  // 记下返回的行 id：流式结束后随 harness-stream-done 回传，前端删这轮时才找得到用户那一行
  let userDialogueId: number | null = null
  try {
    if (options?.reuseUserDialogueId) {
      // 编辑重发：改写原提问行（保 id、保位置），不再插入新行
      userDialogueId = options.reuseUserDialogueId
      await updateDialogueContent(userDialogueId, question)
    } else {
      const userBlocks: {
        type: string
        image_url?: string
        fileName?: string
        round?: number
        objective?: string
      }[] = []
      if (options?.images?.length) {
        for (const img of options.images) {
          userBlocks.push({ type: 'image', image_url: img })
        }
      }
      if (options?.documents?.length) {
        for (const doc of options.documents) {
          userBlocks.push({ type: 'document', fileName: doc.fileName })
        }
      }
      if (options?.turnMeta?.source === 'goal-round') {
        userBlocks.push({
          type: 'goalRound',
          round: options.turnMeta.goalRound,
          objective: options.turnMeta.objective ?? ''
        })
      }
      userDialogueId = await addDialogue({
        topic_id: topicId,
        role: 'user',
        content: question,
        blocks: JSON.stringify(userBlocks)
      })
    }
  } catch (err) {
    logger.error('Failed to save user message:', err)
  }

  // 对话轮次失败统一收尾：通知前端错误并复位加载态（保证任何阶段失败前端都能停止反应）
  const failTurn = (error: unknown): { topicId: number; cancelled: boolean; turnId: number } => {
    const errMsg = error instanceof Error ? error.message : String(error)
    logger.error('[Harness] Turn failed:', error)
    safeSend(event.sender, HARNESS_EVENTS.streamError, { error: errMsg, topicId, turnId })
    safeSend(event.sender, HARNESS_EVENTS.streamDone, { topicId, turnId })
    return { topicId, cancelled: false, turnId }
  }

  // 模型创建可能因供应商不存在、被禁用、模型名称为空等原因失败，需要捕获并通知前端
  let model: BaseChatModel
  try {
    model = await getProviderService().createModel(options?.providerId)
  } catch (modelErr) {
    return failTurn(modelErr)
  }

  // 按模型上下文窗口换算历史上下文字符预算（默认 20,000 token；1 token ≈ 1 字符的保守换算）
  // 同时取出该模型的「工具调用轮数」上限，注入本轮运行时护栏
  let modelDescriptor: SubAgentMainModelDescriptor | undefined
  let contextBudget: number | undefined
  let maxToolRounds: number | undefined
  /** 原始窗口（token）：压缩压力按真实 token 判定时用，与上面按 1:1 换算的字符预算分开存 */
  let contextWindowTokens: number | undefined
  /** 当前模型档案是否声明支持图片输入：false 时 read_image 在执行期拒绝 */
  let supportsImageInput = false
  try {
    const providerConfig = await getProviderService().getConfig(options?.providerId)
    modelDescriptor = { providerId: providerConfig.id, model: providerConfig.model }
    const windowTokens =
      typeof providerConfig.metadata?.context_window === 'number'
        ? providerConfig.metadata.context_window
        : 0
    contextBudget = Math.max(20_000, windowTokens)
    contextWindowTokens = windowTokens > 0 ? windowTokens : undefined
    maxToolRounds = providerConfig.max_tool_rounds
    supportsImageInput =
      (providerConfig.metadata as { capabilities?: { supports_image_input?: boolean } } | null)
        ?.capabilities?.supports_image_input === true
    logger.info(
      `[Harness] Model context window=${windowTokens} tokens → history budget=${contextBudget} chars, maxToolRounds=${maxToolRounds}`
    )
  } catch (err) {
    logger.warn(
      '[Harness] Failed to read model context window, using default history budget 20000:',
      err
    )
  }

  // 创建 AbortController 用于取消流式输出
  const abortController = new AbortController()
  streamAbortControllers.set(event.sender.id, abortController)

  // 渲染进程内存采样（OOM 可观测性）：本轮开始到收尾之间每 5s 采一次，
  // 崩溃时由 main-window 的 render-process-gone 处理落最后一份快照。
  // 必须在 try/finally 的每条退出路径上都 stop（含早退），否则采样表会一直挂着。
  let memSampling = true
  startRendererMemorySampling(`topic=${topicId}`)
  const stopMemSampling = (): void => {
    if (!memSampling) return
    memSampling = false
    stopRendererMemorySampling()
  }

  // 渲染进程失效跟踪：崩溃/窗口关闭时「渲染帧」先于「WebContents 对象」销毁，
  // 此时 send 不抛异常（Electron 内部静默打印 "Error sending from webFrameMain ..."），
  // isDestroyed() 也为 false——必须靠 render-process-gone / destroyed 事件主动中止流，
  // 否则流式循环会持续向死帧发送 chunk，错误刷屏且白烧 token。
  let senderDead = false
  const onSenderGone = (): void => {
    if (senderDead) return
    senderDead = true
    logger.warn(
      `[Harness] Renderer process is gone (senderId=${event.sender.id}), aborting streaming output`
    )
    abortController.abort()
  }
  event.sender.on('render-process-gone', onSenderGone)
  event.sender.once('destroyed', onSenderGone)

  // 2.5. 历史对话上下文由 HarnessService 内部从数据库加载（超长自动压缩）

  // 2.6. 主进程自行发起的轮次：流首下发标记 chunk，前端据此挂载用户消息 + 助手占位并
  // 启动本轮流监听（普通用户轮由前端在发送时自行挂载）。
  //  - goalRound：目标自动续跑轮；
  //  - queueTurn：排队消息在上轮结束后被自动接续发出的轮次（用户没有当场点发送，
  //    前端没有本地占位，缺了这条标记就会「消息消失了但什么都没发生」）。
  if (options?.turnMeta?.source === 'goal-round' && options.turnMeta.goalRound != null) {
    sendChunk({
      goalRound: {
        round: options.turnMeta.goalRound,
        objective: options.turnMeta.objective ?? ''
      }
    })
  }
  if (options?.turnMeta?.source === 'queue') {
    sendChunk({
      queueTurn: {
        itemId: options.turnMeta.queueItemId ?? null,
        text: question,
        attachments: (options.documents ?? [])
          .map((doc) => doc.fileName)
          .concat((options.images ?? []).map((_, index) => `image-${index + 1}`))
      }
    })
  }

  // 技能优先级：harnessSettings.enabledSkills > mainAgent.skills
  const effectiveSkills = harnessSettings?.enabledSkills ?? mainAgentDefaults?.skills

  let harnessService: HarnessService
  try {
    harnessService = new HarnessService(
      model,
      tools,
      await listEnabledSubAgents(harnessSettings?.activeWorkspaceId ?? 0),
      getDialoguesByTopicId,
      harnessSettings?.skillsPath || undefined,
      effectiveSkills,
      harnessSettings?.workspacePath || undefined,
      harnessSettings?.memoryPath || undefined,
      harnessSettings?.activeWorkspaceId ?? 0,
      maxToolRounds,
      memoryScope,
      modelDescriptor,
      options?.turnMeta?.source === 'goal-round',
      supportsImageInput
    )
  } catch (err) {
    // HarnessService 初始化（含子智能体定义加载）失败：清理本轮资源并通知前端，
    // 避免前端停留在「正在生成…」无任何反应
    logger.error('[Harness] Failed to initialize HarnessService:', err)
    streamAbortControllers.delete(event.sender.id)
    event.sender.removeListener('render-process-gone', onSenderGone)
    event.sender.removeListener('destroyed', onSenderGone)
    return failTurn(err)
  }
  // 本轮模型真实用量（usage_metadata）：流结束时由 HarnessService 回调进来，助手消息落库后写入用量表
  let usageRecords: ModelUsageRecord[] = []

  // ── 助手消息累积器（一轮 = 一条助手行）────────────────────────────────
  // 段落表按「可多段」的形态保留（落库、回传 messageId → dialogueId 都按段走），
  // 但当前**只会有 0/1 段**：回合内插话是纯注入（见下方 drainInjections），不切分助手输出，
  // 所以一轮问答始终落一条助手消息，与旧行为等价。留结构是为了以后真需要切段时不必改协议。
  const segments: AssistantSegment[] = []
  /** 本轮助手消息的前端临时 id（前端在 startMessageStream 时已建好占位并下发） */
  const segmentMessageId = options?.messageId ?? `seg_${Date.now()}`
  /** 累积器（保留结构以便后续扩展多段能力） */
  const newAccumulator = (): SegmentAccumulator => ({
    blocks: [],
    content: '',
    reasoning: '',
    failed: false,
    /** 是否已写入早期对话摘要压缩块（避免重复插入压缩卡片） */
    compactionSeen: false
  })
  const acc = newAccumulator()

  /**
   * 本轮「最终答复」边界（协议层真源；判定见 service/answer-boundary.ts）。
   *
   * 内容推进它、**撤回**也由它表达：`markAnswer` 每次都用累积块重算，
   * 结果从「有答复」变成「没答复」时下发一条显式 `answer: false` 的撤回 chunk
   * ——否则渲染端已经把那段内容摆到折叠外了，主进程悄悄改主意它无从得知。
   * 空内容 chunk 不表态（`undefined`），不会误清渲染端的标记。
   */
  let answerBlocks = 0
  let answerHas = false
  const markAnswer = (): void => {
    const next = answerTrailingCount(acc.blocks)
    // 从「有答复」变回「没答复」：显式撤回，否则渲染端已经把那段内容摆到折叠外了
    if (next === 0 && answerHas) {
      sendChunk({ answer: false })
    }
    answerBlocks = next
    answerHas = next > 0
  }

  /** 本轮终局标记（随 harness-stream-done 下发；渲染端据此知道「这就是最后一轮」） */
  let goalRoundWillContinue: boolean | null = null
  let goalRoundClosed: boolean | null = null

  /** 把本轮助手输出落库并登记 */
  const flushSegment = async (): Promise<void> => {
    let dialogueId: number | null = null
    if (!acc.failed) {
      try {
        dialogueId = await addDialogue({
          topic_id: topicId,
          role: 'assistant',
          content: acc.content,
          blocks: JSON.stringify(acc.blocks)
        })
      } catch (err) {
        logger.error('[Harness] Failed to save AI message:', err)
      }
    }
    segments.push({ messageId: segmentMessageId, dialogueId, content: acc.content })
  }

  const stream = harnessService.sendMessageStream(
    question,
    {
      ...options,
      topicId,
      signal: abortController.signal,
      contextBudget,
      // 原始窗口（token）：压缩压力优先按上一轮真实 token ÷ 窗口 ≥ 79% 判定，
      // 字符预算只做兜底（见 runtime/harness/context-pressure.ts）
      contextWindow: contextWindowTokens,
      // 摘要压缩开始：立即推送「压缩中」过渡 chunk（不落库，结果由流尾 historyCompacted 携带，
      // 渲染进程收到结果块后原地替换过渡块，形成「压缩中 → 压缩结果」的转变）
      onCompactionStart: () => {
        sendChunk({ historyCompacting: true })
      },
      // 摘要压缩模型请求自动重试：推送「正在重试（第 N/2 次）」过渡 chunk（不落库），
      // 压缩模型失败与正文模型同款恢复——重试耗尽后经 ModelRecoveryModal 换模型在原位置继续压缩
      onCompactionRetry: (attempt, retries) => {
        sendChunk({ retrying: { attempt, retries } })
      },
      // 回合内插话（steering）：**纯注入**——把文字并进模型上下文，不落库、不产生对话内容。
      // 调用点有两个（见 runtime/agent.ts）：模型节点调用前（主路径，长回答途中插话也能生效）、
      // 工具节点执行前。本轮结束时仍未取走的条目由 releaseHolds 放回队列，不静默丢内容。
      drainInjections: async (): Promise<AgentInjection[] | null> => {
        const items = harnessQueue.takeInjections(topicId)
        if (items.length === 0) return null
        logger.info(
          `[HarnessQueue] Draining ${items.length} queued message(s) for injection (topic=${topicId})`
        )
        return items.map((item) => {
          sendChunk({ steered: { text: item.text } })
          // 队列已摘除该条：广播给所有窗口（含发起窗口）抹掉队列行
          harnessQueue.notifyConsumed(topicId, { item })
          return { text: item.text }
        })
      }
    },
    (records) => {
      usageRecords = records
    },
    // 生成中的实时进度：只发「本轮累计」，不落库、不参与结算。拿不到 token 数字的调用
    // （模型没回传 usage_metadata）不发，免得底栏跳出一条 0 tok 的假消息。
    (records) => {
      const totals = sumUsage(records)
      if (!totals.hasTokens) return
      safeSend(event.sender, HARNESS_EVENTS.turnUsage, {
        topicId,
        turnId,
        calls: totals.calls,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        totalTokens: totals.totalTokens
      })
    }
  )

  try {
    for await (const chunk of stream) {
      // 渲染进程失效（崩溃/窗口关闭）时立即中止，不再向死帧发送 chunk
      if (!isSenderAlive(event.sender)) {
        senderDead = true
        abortController.abort()
        break
      }
      if (abortController.signal.aborted) {
        logger.info('[Harness] Stream cancelled by user')
        break
      }
      // 部分输出后流失败：转发错误事件给前端，并标记跳过落库
      if (chunk.streamError) {
        acc.failed = true
        logger.error(
          '[Harness] Stream failed (partial output already produced):',
          chunk.streamError.message
        )
        safeSend(event.sender, HARNESS_EVENTS.streamError, {
          error: chunk.streamError.message,
          topicId,
          turnId
        })
      }
      // 本轮热记忆注入：置于消息块最顶部（首个 chunk 到达，仅累积一次，随 blocks 持久化）
      if (chunk.memoryInjected) {
        const exists = acc.blocks.some((b) => b.type === 'memoryInjected')
        if (!exists) {
          acc.blocks.unshift({
            type: 'memoryInjected',
            memory: chunk.memoryInjected
          })
        }
      }
      // 本轮早期对话摘要压缩：紧随注入记忆块（正文流开始前到达，仅累积一次）。
      // 压缩卡片只落在首段：插话切段后新段落不再重复插入（重复的 historyCompacted 直接忽略）
      if (chunk.historyCompacted) {
        if (!acc.compactionSeen) {
          acc.compactionSeen = true
          acc.blocks.push({
            type: 'historyCompacted',
            compaction: chunk.historyCompacted
          })
        }
      }
      if (chunk.reasoning_content) {
        const rc = String(chunk.reasoning_content)
        // 兼容 provider 可能下发完整文本而非增量：新内容是已有内容的前缀时仅取新增后缀。
        // 不再做 endsWith 去重（修复）：主进程增量已按形态去重，此处收到的是真实增量，
        // 「增量恰好等于已累积尾部」往往是模型真实重复输出，误判会丢真实内容，
        // 且落库结果与渲染端显示不一致。
        if (acc.reasoning && rc.startsWith(acc.reasoning) && rc.length > acc.reasoning.length) {
          const delta = rc.slice(acc.reasoning.length)
          const lastBlock = acc.blocks[acc.blocks.length - 1]
          if (lastBlock && lastBlock.type === 'reasoning') {
            lastBlock.reasoning = (lastBlock.reasoning || '') + delta
          } else {
            acc.blocks.push({ type: 'reasoning', reasoning: delta })
          }
          acc.reasoning = rc
        } else {
          acc.reasoning += rc
          const lastBlock = acc.blocks[acc.blocks.length - 1]
          if (lastBlock && lastBlock.type === 'reasoning') {
            lastBlock.reasoning = (lastBlock.reasoning || '') + rc
          } else {
            acc.blocks.push({ type: 'reasoning', reasoning: rc })
          }
        }
        // 答复边界随内容推进（内容到达即重算，不再等「整轮结束」这个渲染端猜出来的时刻）；
        // answer=false 表示模型已经动手干活，渲染端据此把标记撤回
        if (chunk.answer !== false) markAnswer()
      }
      if (chunk.content) {
        const c = String(chunk.content)
        // 同 reasoning 分支：只做 startsWith 后缀切片（完整形态防御），不做 endsWith 去重；
        // 累积形态下新建文本块时同样只存增量，避免与渲染端（存后缀）出现双重计数
        if (acc.content && c.startsWith(acc.content) && c.length > acc.content.length) {
          const delta = c.slice(acc.content.length)
          acc.content = c
          const lastBlock = acc.blocks[acc.blocks.length - 1]
          if (lastBlock && lastBlock.type === 'text') {
            lastBlock.text = (lastBlock.text || '') + delta
          } else {
            acc.blocks.push({ type: 'text', text: delta })
          }
        } else {
          acc.content += c
          const lastBlock = acc.blocks[acc.blocks.length - 1]
          if (lastBlock && lastBlock.type === 'text') {
            lastBlock.text = (lastBlock.text || '') + c
          } else {
            acc.blocks.push({ type: 'text', text: c })
          }
        }
        if (chunk.answer !== false) markAnswer()
      }
      if (chunk.tool) {
        if (chunk.tool.name === 'task') {
          // task 工具已由 service.ts 转换为 subAgent 事件下发，此处跳过
        } else {
          // 优先按 callId 精确匹配同一次调用；preparing 阶段没有 id 时按名称回退；
          // ID 来自不同来源可能不一致，同名未完成时也按名称回退
          const matchesTool = (t: ToolCallDetail): boolean => {
            if (chunk.tool!.id) {
              if (t.id === chunk.tool!.id) return true
              if (!t.id && t.status === 'preparing' && t.name === chunk.tool!.name) return true
              if (t.id && t.status && t.status !== 'completed' && t.name === chunk.tool!.name)
                return true
              return false
            }
            return t.name === chunk.tool!.name || t.name === ''
          }
          if (chunk.tool.status === 'completed') {
            // 匹配同一次调用的未完成工具块并更新
            for (let i = acc.blocks.length - 1; i >= 0; i--) {
              const b = acc.blocks[i]
              if (
                b.type === 'tool' &&
                b.tool &&
                b.tool.status !== 'completed' &&
                matchesTool(b.tool)
              ) {
                b.tool.output = chunk.tool.output
                b.tool.status = chunk.tool.status
                b.tool.card = chunk.tool.card
                break
              }
            }
          } else if (chunk.tool.status === 'preparing') {
            // 模型开始构建工具参数；后续进度 chunk 仅用于保活，已存在则跳过。
            // 若同一次调用已处于 executing/completed（事件乱序），也跳过，避免重复块。
            const exists = acc.blocks.some(
              (b) => b.type === 'tool' && matchesTool(b.tool as ToolCallDetail)
            )
            if (!exists) {
              acc.blocks.push({
                type: 'tool',
                tool: {
                  name: chunk.tool.name,
                  input: {},
                  output: '',
                  status: 'preparing',
                  id: chunk.tool.id
                }
              })
            }
          } else {
            // executing：优先合并到同一次调用的 preparing 块
            let merged = false
            for (let i = acc.blocks.length - 1; i >= 0; i--) {
              const b = acc.blocks[i]
              if (b.type === 'tool' && b.tool?.status === 'preparing' && matchesTool(b.tool)) {
                b.tool.name = chunk.tool.name
                b.tool.input = chunk.tool.input
                b.tool.status = 'executing'
                b.tool.id = b.tool.id ?? chunk.tool.id
                merged = true
                break
              }
            }
            // 防御：部分 provider 首个工具块不携带工具名（以占位名 'tool' 登记）——
            // 未按名称匹配到 preparing 块时，并入最近的占位块并改名为真实工具名，
            // 避免「tool · 生成中…」幽灵块与真实工具块并存（与渲染端 applyChunkToMessages 一致）
            if (!merged) {
              for (let i = acc.blocks.length - 1; i >= 0; i--) {
                const b = acc.blocks[i]
                if (b.type === 'tool' && b.tool?.status === 'preparing' && b.tool.name === 'tool') {
                  b.tool.name = chunk.tool.name
                  b.tool.input = chunk.tool.input
                  b.tool.status = 'executing'
                  b.tool.id = b.tool.id ?? chunk.tool.id
                  merged = true
                  break
                }
              }
            }
            if (!merged) {
              acc.blocks.push({
                type: 'tool',
                tool: {
                  name: chunk.tool.name,
                  input: chunk.tool.input,
                  output: chunk.tool.output,
                  status: 'executing',
                  id: chunk.tool.id
                }
              })
            }
          }
        }
        // 工具卡落下即打断「答复尾巴」：边界退回最后一段非工具内容（通常是 null）
        markAnswer()
      }
      if (chunk.subAgent) {
        const sa = chunk.subAgent
        // 注意：不把子智能体输出拼入 acc.content（主消息 content）。
        // 子智能体详情已持久化在 blocks 的 subAgent 块（含 children），
        // 历史重载按 blocks 渲染即可；若再拼入 content，会导致：
        // ① 复制消息/上下文注入时子智能体全文重复出现在主智能体发言中；
        // ② 主模型下一轮看到重复文本，进一步放大复述行为。
        // 子智能体块匹配逻辑见下：

        // 匹配智能体累积块：优先 causeId，回退 name
        const matchesSa = (b: (typeof acc.blocks)[number]): boolean => {
          if (b.type !== 'subAgent' || !b.subAgent) return false
          if (sa.causeId && b.subAgent.causeId) return b.subAgent.causeId === sa.causeId
          return b.subAgent.name === sa.name
        }

        // 查找或创建同名智能体累积块
        let saBlock = acc.blocks.find(matchesSa)
        if (!saBlock) {
          saBlock = {
            type: 'subAgent',
            subAgent: {
              name: sa.name,
              causeId: sa.causeId,
              status: sa.status,
              taskDescription: sa.taskDescription
            },
            children: []
          }
          acc.blocks.push(saBlock)
        }

        if (sa.status === 'started') {
          saBlock.subAgent!.status = sa.status
          saBlock.subAgent!.taskDescription =
            saBlock.subAgent!.taskDescription || sa.taskDescription
        } else if (sa.status === 'dispatched') {
          // 后台派发轻量事件：块定格在「已派发」（名称+简述+会话 id），无子块/内容
          saBlock.subAgent!.status = 'dispatched'
          saBlock.subAgent!.taskDescription =
            saBlock.subAgent!.taskDescription || sa.taskDescription
          saBlock.subAgent!.subagentId = sa.subagentId ?? saBlock.subAgent!.subagentId
        } else if (sa.status === 'completed' || sa.status === 'error') {
          saBlock.subAgent!.status = sa.status
          saBlock.subAgent!.output = sa.output
          saBlock.subAgent!.error = sa.error
        } else if (sa.content || sa.reasoning_content || sa.tool) {
          if (saBlock.subAgent!.status !== 'completed' && saBlock.subAgent!.status !== 'error') {
            saBlock.subAgent!.status = 'running'
          }
          if (!saBlock.children) saBlock.children = []

          if (sa.reasoning_content) {
            const lastChild = saBlock.children[saBlock.children.length - 1]
            if (lastChild && lastChild.type === 'reasoning') {
              lastChild.reasoning = (lastChild.reasoning || '') + sa.reasoning_content
            } else {
              saBlock.children.push({ type: 'reasoning', reasoning: sa.reasoning_content })
            }
          }

          if (sa.content) {
            const lastChild = saBlock.children[saBlock.children.length - 1]
            if (lastChild && lastChild.type === 'text') {
              lastChild.text = (lastChild.text || '') + sa.content
            } else {
              saBlock.children.push({ type: 'text', text: sa.content })
            }
          }

          if (sa.tool) {
            // 优先按 callId 精确匹配同一次调用；preparing 阶段没有 id 时按名称回退；
            // ID 来自不同来源可能不一致，同名未完成时也按名称回退
            const matchesTool = (t: ToolCallDetail): boolean => {
              if (sa.tool!.id) {
                if (t.id === sa.tool!.id) return true
                if (!t.id && t.status === 'preparing' && t.name === sa.tool!.name) return true
                if (t.id && t.status && t.status !== 'completed' && t.name === sa.tool!.name)
                  return true
                return false
              }
              return t.name === sa.tool!.name || t.name === ''
            }
            if (sa.tool.status === 'completed') {
              for (let i = saBlock.children.length - 1; i >= 0; i--) {
                const c = saBlock.children[i]
                if (
                  c.type === 'tool' &&
                  c.tool &&
                  c.tool.status !== 'completed' &&
                  matchesTool(c.tool)
                ) {
                  c.tool.output = sa.tool.output
                  c.tool.status = 'completed'
                  c.tool.card = sa.tool.card
                  break
                }
              }
            } else if (sa.tool.status === 'preparing') {
              const exists = saBlock.children.some(
                (c) => c.type === 'tool' && c.tool?.status === 'preparing' && matchesTool(c.tool)
              )
              if (!exists) {
                saBlock.children.push({
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
              for (let i = saBlock.children.length - 1; i >= 0; i--) {
                const c = saBlock.children[i]
                if (c.type === 'tool' && c.tool?.status === 'preparing' && matchesTool(c.tool)) {
                  c.tool.name = sa.tool.name
                  c.tool.input = sa.tool.input
                  c.tool.status = 'executing'
                  c.tool.id = c.tool.id ?? sa.tool.id
                  merged = true
                  break
                }
              }
              // 防御：占位名 'tool' 兜底（同上方主代理累积块逻辑）
              if (!merged) {
                for (let i = saBlock.children.length - 1; i >= 0; i--) {
                  const c = saBlock.children[i]
                  if (
                    c.type === 'tool' &&
                    c.tool?.status === 'preparing' &&
                    c.tool.name === 'tool'
                  ) {
                    c.tool.name = sa.tool.name
                    c.tool.input = sa.tool.input
                    c.tool.status = 'executing'
                    c.tool.id = c.tool.id ?? sa.tool.id
                    merged = true
                    break
                  }
                }
              }
              if (!merged) {
                saBlock.children.push({
                  type: 'tool',
                  tool: {
                    name: sa.tool.name,
                    input: sa.tool.input,
                    output: sa.tool.output || '',
                    status: 'executing',
                    id: sa.tool.id
                  }
                })
              }
            }
          }
        }
        // 派遣子代理同样打断答复尾巴（子代理块不是答复内容）
        markAnswer()
      }
      // 发送失败（渲染帧已失效）时中止流，避免持续向死帧发送。
      // 统一走 safeSend（修复：裸 send 在帧失效窗口期不抛异常、try/catch 是死代码，
      // 且违反项目「主进程推送统一走 safeSend」约定）
      if (!sendChunk({ ...chunk })) {
        logger.warn('[Harness] Failed to send stream chunk (renderer disposed)')
        senderDead = true
        abortController.abort()
        break
      }
    }
  } catch (error) {
    if ((error as Error)?.name !== 'AbortError') {
      logger.error('Error in harness stream:', error)
      const errMsg = error instanceof Error ? error.message : String(error)
      safeSend(event.sender, HARNESS_EVENTS.streamError, { error: errMsg, topicId, turnId })
      // 流异常中断时不保存不完整的 AI 回复，直接跳到清理
      streamAbortControllers.delete(event.sender.id)
      stopMemSampling()
      safeSend(event.sender, HARNESS_EVENTS.streamDone, { topicId, turnId })
      return { topicId, cancelled: false, turnId }
    }
  } finally {
    // 流结束（正常/取消/异常/渲染进程失效）后移除失效跟踪监听
    event.sender.removeListener('render-process-gone', onSenderGone)
    event.sender.removeListener('destroyed', onSenderGone)
    stopMemSampling()
  }

  // 3.9 本轮答复边界的终值：流已经停止追加（含被停止/出错/渲染帧失效的路径），
  //     此刻重算一次即可给出定论。边界从「有」变回「无」时这里会补发一条撤回 chunk。
  markAnswer()

  // 4. 保存本轮各段 AI 回复（流执行失败时逐段跳过：截断的不完整回复不应落库为完整消息）。
  //    落库后把新对话行 id 回传前端：流式期间的消息用的是临时 id，只有拿到库里的行 id，
  //    前端才能把用量行（按 dialogue_id 关联）当场贴到这条消息上，不必重新加载会话。
  //    无插话时这里恰好只有一段，与旧行为完全一致。
  await flushSegment()
  const lastPersisted = [...segments].reverse().find((seg) => seg.dialogueId != null)
  const assistantDialogueId = lastPersisted?.dialogueId ?? null
  if (assistantDialogueId != null) {
    // 真实用量落库（模型没回传 usage_metadata 时直接跳过，不写全 0 的假数据）。
    // 一条用量行关联一段：多段时挂在最后一段上（整轮 token 是累加的，无法按段切分）
    await persistTurnUsage({
      dialogueId: assistantDialogueId,
      topicId,
      providerId: options?.providerId,
      records: usageRecords
    })
  }

  // 4.5 收尾任务清单：本轮结束后不会再有人接手这份清单时，把仍停在 in_progress 的项结为 completed。
  //
  // 为什么需要这条兜底：清单是模型自己写的，而它的收尾书写并不可靠——2026-09-18 实例：
  // 六项工作全部做完、回答也交付了，最后一次 write_todos 仍留一项 in_progress，卡片于是
  // 永远停在「5/6 已完成 · 1 进行中」。2026-09-23 用户再报同一现象（「明明任务已经完成了，
  // 页面还是显示有最后一个任务没有完成」），根因是这里此前**整轮跳过**目标自动续跑轮：
  // 目标在末轮 complete 后再也没有下一轮去收尾，那一项就永远转圈。
  //
  // 判定规则（见 runtime/todo-closeout.ts 的 decideCloseOutOnTurnEnd）只有一条：
  // 「本轮结束后还会不会有下一轮接手」——会（目标 active + 已武装且未达轮次上限）就不动，
  // 不会就收尾。因此用户停止、流失败、目标完成/阻塞/被 disarm/达轮次上限这几条路径同样收尾：
  // 那时什么都没在跑，留着「进行中」是假状态（应用重开后前端还会从 store 把它读回来）。
  // 「还会不会续跑」一律问 goalStore.willContinue（与驱动器派发门槛同一处真源，避免漂移）。
  try {
    const decision = await decideCloseOutOnTurnEnd({
      isGoalRound: options?.turnMeta?.source === 'goal-round',
      goalWillContinue: () => goalStore.willContinue(topicId),
      hasPendingQuestion: () => questionService.getPending(topicId) != null
    })
    // 终局标记的两个事实顺手记下（与收尾判定同一处真源，不额外查库）：
    // 渲染端据此知道「这是不是最后一轮、目标有没有收口」，不必再从别处推
    if (options?.turnMeta?.source === 'goal-round') {
      goalRoundWillContinue = await goalStore.willContinue(topicId)
      goalRoundClosed = (await goalStore.load(topicId))?.phase === 'complete'
    }
    if (decision.close) {
      const closed = closeOutInProgress(todoStore, topicId)
      if (closed) {
        logger.info(
          `[Harness] Closing out this turn: closed ${closed.closed} in-progress items -> ${closed.completed}/${closed.total} completed`
        )
      }
    } else {
      logger.info(`[Harness] Not closing out todo list this turn (${decision.reason})`)
    }
  } catch (err) {
    // 收尾只是兜底：判定或广播失败不能影响落库与前端收尾通知
    logger.warn('[Harness] Failed to close out todo list:', err)
  }

  /**
   * 本轮终局标记（协议层权威结论，见 service/answer-boundary.ts 的 TurnFinal）。
   *
   * 以前这些事实只写进日志：渲染端要判断「这一轮的答复在哪、是不是最后一轮」，
   * 只能拿自己的 loading 状态猜——而 loading 的翻转在目标续跑里被驱动器压掉了
   * （goal-driver 是 `while (await driveOnce())`，上一轮的 done 与下一轮的 goalRound
   * 几乎同 tick 落地）。现在结论随 done 事件一起下发。
   */
  const turnFinal: TurnFinal = {
    settled: !abortController.signal.aborted && !acc.failed,
    goalRound: options?.turnMeta?.source === 'goal-round',
    round: options?.turnMeta?.goalRound,
    goalClosed: goalRoundClosed ?? undefined,
    goalWillContinue: goalRoundWillContinue ?? undefined,
    answerFrom: answerBlocks > 0 ? acc.blocks.length - answerBlocks : null,
    answerBlocks
  }
  logger.info(
    `[Harness] Turn final: settled=${turnFinal.settled}, goalRound=${turnFinal.goalRound}` +
      `${turnFinal.round != null ? `(round=${turnFinal.round}, closed=${turnFinal.goalClosed}, willContinue=${turnFinal.goalWillContinue})` : ''}` +
      `, answer=${turnFinal.answerBlocks} blocks (from ${turnFinal.answerFrom}), blocks=${acc.blocks.length}`
  )

  // 5. 清理并通知渲染进程流式输出已完成
  streamAbortControllers.delete(event.sender.id)
  safeSend(event.sender, HARNESS_EVENTS.streamDone, {
    topicId,
    // 本轮回合 id：渲染端据此丢弃「不属于当前回合」的过期收尾事件
    turnId,
    // 本轮两条对话行的库内 id：前端据此把临时 id 换成真 id（删除这一轮、关联用量都要用）
    userDialogueId: userDialogueId ?? undefined,
    assistantDialogueId: assistantDialogueId ?? undefined,
    // 助手段落表：无插话时只有一段（等价于旧的单条 assistantDialogueId）；
    // 有插话时一段一条，前端按 messageId 把库内行 id 贴回对应的助手气泡
    segments: segments.map((seg) => ({
      messageId: seg.messageId,
      dialogueId: seg.dialogueId ?? undefined
    })),
    // 终局标记（含最终答复边界）：渲染端只读不猜
    turnFinal
  })
  return { topicId, cancelled: abortController.signal.aborted, turnId }
}

/** 广播插话队列当前状态（所有窗口；前端按 topicId 过滤） */
function broadcastQueue(topicId: number): void {
  const queue = harnessQueue.view(topicId)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed())
      safeSend(win.webContents, HARNESS_EVENTS.queueUpdated, { topicId, queue })
  }
}

/**
 * 这条会话此刻是不是挂着「等用户确认」的东西（提问 / 沙箱审批）。
 *
 * 两个服务各持一张挂起表（提问在 questionService，审批在 permissionGate），
 * 侧栏只关心「这条会话还要不要人管」，所以取并集；哪一端结算都重新算一次，
 * 另一端还挂着时仍算 true（同一轮里可能先问一句、再要一次授权）。
 */
function isTopicAwaitingUser(topicId: number): boolean {
  return questionService.getPending(topicId) != null || permissionGate.getPending(topicId) != null
}

/**
 * 广播「这条会话还要不要用户确认」——侧栏据此把行首的**进行中**换成**黄色呼吸点**
 * （用户口径 2026-11-23「当需要用户继续确认操作时，这个图标需要变成黄色的点在呼吸」）。
 *
 * 发送时机：提问 / 审批**挂起时**发一次、**结算时**（允许 / 拒绝 / 中止）再发一次，
 * 两端都按 `isTopicAwaitingUser` 现算，所以同一话题连续两次挂起、先结算一端另一端还挂着
 * 这类情形都不会报错状态；重复的同值事件由渲染层去重（Set 里有没有它本来就幂等）。
 */
function broadcastTopicPending(topicId: number): void {
  if (!Number.isFinite(topicId) || topicId <= 0) return
  const pending = isTopicAwaitingUser(topicId)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed())
      safeSend(win.webContents, HARNESS_EVENTS.topicPending, { topicId, pending })
  }
}

/** sender.id → 该渲染帧当前在跑的话题（「停止」时据此丢弃待注入缓冲） */
const senderTopic = new Map<number, number>()

/** 回合内插话的对外载荷（队列条目 + 落库行 id） */
interface StartStreamOptions {
  topicId?: number
  providerId?: number
  images?: string[]
  documents?: { fileName: string; filePath: string }[]
  turnMeta?: TurnMeta
  reuseUserDialogueId?: number
  messageId?: string
  /**
   * 记忆作用域（`plugin:<插件 id>`）。只在**主进程兜底建话题**时用得上——
   * 常规路径是渲染层先 `harness-topic-create`（把作用域写进话题行），主进程按话题读。
   */
  memoryScope?: string | null
}

/**
 * 本轮会话的记忆作用域：以**话题上存的**为准（`harness_topic.memory_scope`），
 * 话题还没建（本轮刚创建、或读不到）时用调用方传来的兜底；都没有 = 工作区记忆。
 *
 * 为什么以话题为准：插件行「＋」开出来的会话带 `plugin:<id>`，重开这个会话（甚至重启应用）后
 * 仍然要用那份插件自己的记忆，不能依赖渲染层记得住（用户口径 2026-09-28）。
 */
async function resolveTurnMemoryScope(
  topicId: number | undefined,
  fallback: string | null | undefined,
  workspaceId: number
): Promise<MemoryScope> {
  if (topicId) {
    try {
      const rows = await getTopicById(topicId)
      const raw = rows[0]?.memory_scope
      if (raw) return parseMemoryScope(raw, workspaceId)
    } catch (err) {
      logger.warn(
        '[Harness] Failed to read topic memory scope, falling back to workspace memory:',
        err
      )
    }
  }
  return parseMemoryScope(fallback, workspaceId)
}

/** 一轮对话的结局（turnId 用于把收尾事件对回它所属的回合） */
interface TurnOutcome {
  topicId: number
  cancelled: boolean
  turnId: number
}

/**
 * 启动一轮对话并跟踪其生命周期（退 Application 前会等待它落库）。
 *
 * 三个入口共用它：用户发送（harness-start-stream）、排队接续（drainPendingQueue）、
 * 目标自动续跑（goalRoundDriver）。回合登记（beginTurn / endTurn）也收在这一个地方，
 * 任何入口起的轮次都会让 `isTurnActive` 为真——这样「生成中再发一条」不会被当成空闲。
 */
function launchTurn(
  event: HarnessSenderEvent,
  question: string,
  options: StartStreamOptions | undefined,
  trackTurn: (p: Promise<TurnOutcome>) => Promise<TurnOutcome>
): Promise<TurnOutcome> {
  const requestedTopicId = options?.topicId
  // 已存在的话题：先登记本轮回合 id 再起轮（渲染进程的忙检查据此判断「有没有回合在跑」）
  const turnId = requestedTopicId != null ? harnessQueue.beginTurn(requestedTopicId) : 0
  if (requestedTopicId != null) senderTopic.set(event.sender.id, requestedTopicId)

  let outcome: TurnOutcome | null = null
  return trackTurn(runHarnessTurn({ event, question, options, turnId }))
    .then((result) => {
      outcome = result
      return result
    })
    .finally(() => {
      // 新话题（首条消息）的 id 由 runHarnessTurn 建出来后带回，收尾统一按它登记
      const settledTopicId = outcome?.topicId ?? requestedTopicId ?? 0
      if (settledTopicId > 0) {
        harnessQueue.endTurn(settledTopicId, outcome?.turnId ?? turnId)
        // 本轮点了插话却没等到注入边界的条目放回队列（见 releaseHolds 的说明）：
        // 它们既不落库也不进对话流，必须让用户还看得见，否则等于内容凭空消失
        harnessQueue.releaseHolds(settledTopicId)
      }
      // 只在本帧没有别的在跑话题时删掉映射（同帧切话题同时开两轮的情况很罕见，保守处理）
      if (requestedTopicId != null && senderTopic.get(event.sender.id) === requestedTopicId) {
        senderTopic.delete(event.sender.id)
      }
    })
}

/**
 * 回合结束后的队列处置：把排队中的消息**逐条**当作新一轮接续发出（FIFO），直到队列空。
 *
 * 以前的实现只接一条（接续轮自己的收尾不会再次触发这里），队列里第二条起永远发不出去。
 * 现在整段循环交给 turn-drain（纯函数、有单测），这里只负责把「起一轮 + 目标续跑」接上去。
 *
 * 终止条件：队列空 / 目标驱动器在跑（不抢跑）/ 用户中止了某一轮（剩下的留在队列里，
 * 由用户下一次发送再决定）/ 起轮失败（记日志，不再无限重试）。
 */
async function drainPendingQueue(
  event: HarnessSenderEvent,
  topicId: number,
  options: StartStreamOptions | undefined,
  trackTurn: (p: Promise<TurnOutcome>) => Promise<TurnOutcome>
): Promise<void> {
  const drained = await drainPendingTurns({
    isTurnActive: () => harnessQueue.isTurnActive(topicId),
    isGoalRunning: () => goalRoundDriver.isRunning(topicId),
    hasPending: () => harnessQueue.hasPending(topicId),
    shift: () => harnessQueue.shift(topicId),
    onContinue: (item) =>
      logger.info(
        `[HarnessQueue] Turn ended, continuing with queued message: ${item.text.slice(0, 40)}`
      ),
    runTurn: async (item) => {
      const outcome = await launchTurn(
        event,
        item.text,
        {
          ...options,
          topicId,
          // 接续轮不继承「编辑重发」目标行与旧消息 id
          reuseUserDialogueId: undefined,
          messageId: undefined,
          images: item.images,
          documents: item.documents,
          // 标记来源：runHarnessTurn 据此在流首下发 queueTurn 标记，
          // 渲染进程才知道「这一轮是排队消息接续出来的」并挂上用户气泡
          turnMeta: { source: 'queue', queueItemId: item.id }
        },
        trackTurn
      )
      if (!outcome.cancelled) {
        // 目标续跑：接续轮结束后同样交给驱动器，跑完再继续下一条排队消息
        await goalRoundDriver.maybeDrive(topicId, (p) =>
          launchTurn(
            event,
            p.question,
            { ...options, topicId: p.topicId, turnMeta: p.turnMeta },
            trackTurn
          )
        )
      }
      return outcome
    },
    onError: (error) =>
      logger.error('[HarnessQueue] Failed to continue with queued message:', error)
  })
  if (drained > 0) {
    logger.info(`[HarnessQueue] Drained ${drained} queued message(s) for topic ${topicId}`)
  }
}

/**
 * 对话发送 / 流式输出 / 目录选择 / 技能列表 IPC：收成 `harness:*` 处理器表，
 * 连同助手依赖的全局订阅（onChange / onAsk / 会话事件流）一起装配。
 *
 * - 通道名一律 `harness:<原扁平名>`，由 `registerIpcHandlers` 挂到 ipcMain；
 * - 原先的 `ipcMain.on`（start-stream / cancel-stream / agent-watch）改成普通 invoke 通道，
 *   preload 的 send 同步改 invoke（同资料库的 graph-build-start）；
 * - 全局订阅登记在 `EffectScope` 里，退出时按 LIFO 回滚。
 */
export function registerHarnessIpc(scope: EffectScope): () => void {
  const handlers: IpcHandlerMap = {}
  /** 收通道：`harness:` 前缀只在这里出现 */
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`harness:${channel}`] = handler
  }

  // 权限闸门接线：档位来源（electron-store）+ 工作区根目录 + 界面语言文案
  wirePermissionGate()
  // 队列是纯状态机（不依赖 electron，便于 tests/ 直接跑断言），日志出口在这里注入
  setHarnessQueueLogger(logger)
  // 沙箱层不 import electron（要能在任意 node 环境跑：工装 / 容器验证），日志由这里注入
  setSandboxLogger(logger)

  // 沙箱服务接线：把自带资产（Windows runner / Linux Landlock 启动器）的真实路径注入。
  // 两条候选：开发态在仓库 resources/sandbox 下；打包态由 electron-builder 的
  // extraResources 复制到 process.resourcesPath/sandbox（asar 里不能直接 spawn 脚本）。
  const sandboxRoots = { devRoot: app.getAppPath(), resourcesPath: process.resourcesPath }
  const archDir =
    process.arch === 'x64'
      ? 'linux-x64'
      : process.arch === 'arm64'
        ? 'linux-arm64'
        : `linux-${process.arch}`
  const landlockLauncher =
    process.platform === 'linux'
      ? resolveSandboxAsset(join(archDir, 'ryten-landlock-launcher'), sandboxRoots)
      : undefined
  if (landlockLauncher) ensureExecutable(landlockLauncher)
  sandboxService.configure({
    nodePath: process.execPath,
    appRoot: app.getAppPath(),
    windowsRunnerPath:
      process.platform === 'win32'
        ? resolveSandboxAsset('win32-sandbox-runner.cjs', sandboxRoots)
        : undefined,
    landlockLauncherPath: landlockLauncher
  })
  const sandboxStatus = sandboxService.status()
  logger.info(
    `[Sandbox] Wiring complete backend=${sandboxStatus.backend ?? 'unavailable'} enforcement=${sandboxStatus.enforcement ?? '-'} ${sandboxStatus.reason ?? ''}`
  )

  // 沙箱拦截到的危险 / 越界操作 → 广播到所有窗口，由审批弹窗问用户「允许一次 / 拒绝」
  scope.effect(() => {
    permissionGate.onApprovalAsked = (pending: ApprovalRequestView) => {
      // 只广播可序列化视图（无 resolve / signal，纯 JSON）
      const payload = {
        topicId: pending.topicId,
        requestId: pending.requestId,
        toolName: pending.toolName,
        detail: pending.detail,
        reason: pending.reason,
        reasonCode: pending.reasonCode,
        requestedMode: pending.requestedMode,
        justification: pending.justification
      }
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) safeSend(win.webContents, HARNESS_EVENTS.approvalAsked, payload)
      }
      // 挂起的同一刻告诉侧栏「这条会话在等人」：行首由进行中换成黄色呼吸点
      broadcastTopicPending(pending.topicId)
      logger.info(
        `[Permission] Pending approval requestId=${pending.requestId} tool=${pending.toolName} reason=${pending.reasonCode}`
      )
    }
    // 结算（允许 / 拒绝 / 中止）→ 撤回那个黄点，回到进行中
    permissionGate.onResolved = broadcastTopicPending
    return () => {
      // 退出装配即不再有人应答：挂起审批全部按拒绝结算（故障关闭）
      permissionGate.onApprovalAsked = undefined
      permissionGate.onResolved = undefined
      permissionGate.abortAll()
    }
  })

  // 队列变更 → 广播到所有窗口（输入框上方的插话队列实时刷新）
  scope.effect(() => {
    harnessQueue.onChanged = ({ topicId }) => broadcastQueue(topicId)
    return () => {
      harnessQueue.onChanged = null
    }
  })
  // 插话已并入当前回合（纯注入）→ 广播给所有窗口：前端抹掉队列行 + 给一句瞬时反馈
  scope.effect(() => {
    harnessQueue.onConsumed = (eventPayload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          safeSend(win.webContents, HARNESS_EVENTS.queueSteered, {
            topicId: eventPayload.topicId,
            itemId: eventPayload.item.id,
            text: eventPayload.item.text
          })
        }
      }
    }
    return () => {
      harnessQueue.onConsumed = null
    }
  })
  handle(
    'harness-send-message',
    async (
      question: string,
      options?: {
        topicId?: number
        providerId?: number
        images?: string[]
        documents?: { fileName: string; filePath: string }[]
      }
    ) => {
      // 加载主智能体默认配置（electron-store）
      const mainAgentDefaults = settingsStore.get('mainAgent') as MainAgentConfig | undefined
      const harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined
      logger.info(`[Harness] Creating model with providerId: ${options?.providerId ?? 'default'}`)

      // 这条同步路径也要认话题的记忆作用域（插件会话 → 那份插件自己的记忆），
      // 并据此决定插件模式的模式工具是否自动挂载（见 shared/mcp.ts 的 PLUGIN_MODE_TOOL_NAMES）
      const syncMemoryScope = await resolveTurnMemoryScope(
        options?.topicId,
        undefined,
        harnessSettings?.activeWorkspaceId ?? 0
      )
      const pluginMode = syncMemoryScope.kind === 'plugin'
      const selectedTools = effectiveMainAgentTools(mainAgentDefaults, {
        pluginMode,
        signedIn: hasLatticeSession()
      })
      const tools = buildTools(selectedTools)
      logger.info(
        `[Harness] Tools for this turn: pluginMode=${pluginMode} count=${selectedTools.length} [${selectedTools.join(',')}]`
      )

      const model = await getProviderService().createModel(options?.providerId)

      // 技能优先级：harnessSettings.enabledSkills > mainAgent.skills
      const effectiveSkills = harnessSettings?.enabledSkills ?? mainAgentDefaults?.skills

      // 该模型的「工具调用轮数」上限（取不到则用工程默认值，由 HarnessService 兜底）；
      // 同时记录 provider/model 描述符，供后台子代理持久化与冷恢复回到同一模型
      let maxToolRounds: number | undefined
      let syncModelDescriptor: SubAgentMainModelDescriptor | undefined
      let syncSupportsImageInput = false
      try {
        const providerConfig = await getProviderService().getConfig(options?.providerId)
        maxToolRounds = providerConfig.max_tool_rounds
        syncModelDescriptor = { providerId: providerConfig.id, model: providerConfig.model }
        syncSupportsImageInput =
          (providerConfig.metadata as { capabilities?: { supports_image_input?: boolean } } | null)
            ?.capabilities?.supports_image_input === true
      } catch (err) {
        logger.warn('[Harness] Failed to read model max tool call rounds, using default:', err)
      }

      const harnessService = new HarnessService(
        model,
        tools,
        await listEnabledSubAgents(harnessSettings?.activeWorkspaceId ?? 0),
        getDialoguesByTopicId,
        harnessSettings?.skillsPath || undefined,
        effectiveSkills,
        harnessSettings?.workspacePath || undefined,
        harnessSettings?.memoryPath || undefined,
        harnessSettings?.activeWorkspaceId ?? 0,
        maxToolRounds,
        syncMemoryScope,
        syncModelDescriptor,
        false,
        syncSupportsImageInput
      )
      return await harnessService.sendMessage(question, options)
    }
  )

  handle(
    'harness-start-stream',
    (question: string, options?: StartStreamOptions): { started: boolean; queued?: boolean } => {
      // 原 ipcMain.on('harness-start-stream') 的 event.sender：新契约不透传事件对象
      const sender = primarySender()
      if (!sender) return { started: false }
      const event: HarnessSenderEvent = { sender }
      // 同一话题已有回合在跑：绝不并发起第二轮。
      //
      // 并发会让两轮的 chunk 都带着同一个 __topicId 进同一个助手气泡（「输出错乱」），
      // 所以这里把这次发送收进队列，由当前回合结束后的 drainPendingQueue 接续。
      // 返回 queued=true，渲染进程据此撤掉自己刚挂的乐观气泡（那条消息不会丢，在队列里）。
      const requestedTopicId = options?.topicId
      if (requestedTopicId != null && harnessQueue.isTurnActive(requestedTopicId)) {
        logger.info(
          `[HarnessQueue] Topic ${requestedTopicId} already running, queueing the new message instead of starting a second turn`
        )
        harnessQueue.enqueue({
          topicId: requestedTopicId,
          senderId: sender.id,
          text: question,
          attachments: { images: options?.images, documents: options?.documents }
        })
        return { started: false, queued: true }
      }
      // 跟踪进行中的流：应用退出时统一中止并等待数据保存完成。
      // 用户轮次完成后触发目标轮次驱动器（自动续跑轮由驱动器内部递归调度）
      // 每个轮次（含目标驱动器派发的自动轮）都登记进 activeHarnessStreams，
      // 退出时 lifecycle 才能拦截并等待落库（修复：此前只跟踪首轮，自动轮运行中退出会丢回复）
      const trackTurn = (p: Promise<TurnOutcome>): Promise<TurnOutcome> => {
        activeHarnessStreams.add(p)
        p.finally(() => activeHarnessStreams.delete(p))
        return p
      }
      const streamPromise = launchTurn(event, question, options, trackTurn)
        .then(async ({ topicId, cancelled }) => {
          if (options?.turnMeta?.source === 'goal-round') return
          if (cancelled) {
            // 用户停止本轮：disarm 目标并跳过自动续跑调度（修复：此前 cancelled 被丢弃，
            // 停止后立即白烧一轮自动轮；目标保持 active，用户要求「继续」时经 resume 重新武装）
            logger.info(
              '[Harness] Turn cancelled by user, goal disarmed, skipping automatic continuation'
            )
            goalStore.disarm(topicId)
            return
          }
          await goalRoundDriver.maybeDrive(topicId, (p) =>
            launchTurn(
              event,
              p.question,
              { ...options, topicId: p.topicId, turnMeta: p.turnMeta },
              trackTurn
            )
          )
          // 目标续跑全部结束后再处置队列：排队中的消息逐条作为新一轮发出
          await drainPendingQueue(event, topicId, options, trackTurn)
        })
        .catch((err) => logger.error('[Harness] Error executing turn:', err))
      activeHarnessStreams.add(streamPromise)
      streamPromise.finally(() => activeHarnessStreams.delete(streamPromise))
      return { started: true }
    }
  )

  /**
   * 生成中发消息：当前话题有回合在跑 → 收进插话队列；没有在跑 → 交给渲染进程走正常发送。
   *
   * 这里**故意不再自己起轮**（旧实现会起一轮，而渲染进程拿到 queued=false 后也会起一轮，
   * 同一句话于是跑成两个回合、库里出现两条用户行）。主进程只裁决「排队还是没排队」。
   */
  handle(
    'harness-queue-enqueue',
    async (payload: {
      topicId: number
      text: string
      attachments?: QueueAttachments
    }): Promise<{ queued: boolean }> => {
      const { topicId, text } = payload
      const attachments = payload.attachments ?? {}
      if (!Number.isInteger(topicId) || topicId <= 0 || !text.trim()) {
        return { queued: false }
      }
      // 原 event.sender.id（队列按发送帧记账）：新契约用主窗口的 webContents
      const sender = primarySender()
      if (!sender) return { queued: false }
      if (!harnessQueue.isTurnActive(topicId)) return { queued: false }
      harnessQueue.enqueue({ topicId, senderId: sender.id, text, attachments })
      return { queued: true }
    }
  )

  /** 队列查询（窗口/话题重新挂载时拉取当前队列） */
  handle('harness-queue-list', (topicId: number) => harnessQueue.view(topicId))

  /**
   * 话题当前回合状态（渲染端发送前问一句）。
   *
   * 主进程是「有没有回合在跑」的唯一真源：渲染端自己的 loading 状态在「主进程自行接续
   * 排队消息」「目标自动续跑」这类轮次上会滞后，据此判断就会并发起第二个回合。
   */
  handle('harness-turn-state', (topicId: number) => ({
    active: Number.isInteger(topicId) && harnessQueue.isTurnActive(topicId),
    turnId: Number.isInteger(topicId) ? harnessQueue.currentTurnId(topicId) : null
  }))

  /** 删除一条排队消息 */
  handle('harness-queue-remove', (payload: { topicId: number; itemId: string }) => {
    return harnessQueue.remove(payload.topicId, payload.itemId)
  })

  /** 改写一条排队消息的文本 */
  handle('harness-queue-update', (payload: { topicId: number; itemId: string; text: string }) => {
    if (!payload.text.trim()) return false
    return harnessQueue.update(payload.topicId, payload.itemId, payload.text)
  })

  /**
   * 「立即插话」：把这条排队消息并入**正在运行**的回合。
   * 这里只把它移入待注入缓冲并落库、下发回执；真正的注入发生在下一个工具节点边界
   *（见 runtime/agent.ts createInterjectionHandler）。
   */
  handle(
    'harness-queue-steer',
    async (payload: { topicId: number; itemId: string }): Promise<{ accepted: boolean }> => {
      const { topicId, itemId } = payload
      const item = harnessQueue.steer(topicId, itemId)
      if (!item) return { accepted: false }
      // 纯注入：条目进入待注入缓冲，下一个工具节点边界会被并进模型上下文，
      // 不落库、不产生对话内容；本轮没等到边界的条目由 releaseHolds 放回队列。
      logger.info(
        `[HarnessQueue] Queued message accepted for topic ${topicId} (waiting for injection at the next tool node boundary): ${item.text.slice(0, 40)}`
      )
      return { accepted: true }
    }
  )

  // 目标查询（渲染进程加载目标状态）
  handle('harness-goal-get', async (topicId: number) => {
    return await goalStore.load(topicId)
  })

  /**
   * 目标写入（输入框 / 目标弹窗的人工入口）。
   *
   * 创建、编辑、暂停、恢复、完成、清除全部走同一份 GoalStore（与目标工具共用状态机、
   * 单目标语义与 CAS），只是 authority 不走工具层——界面上的操作本身就是「人类直接请求」。
   * 失败不抛错，返回 `{ ok:false, error }` 由渲染层按本语言展示（与工坊动作同一套约定）。
   */
  handle(
    'harness-goal-create',
    async (payload: { topicId: number; objective: string; maxGoalRounds?: number }) => {
      try {
        const objective = payload.objective?.trim() ?? ''
        if (!objective) return { ok: false, error: 'goal-objective-required' }
        const goal = await goalStore.create(payload.topicId, objective, payload.maxGoalRounds)
        return { ok: true, goal }
      } catch (err) {
        logger.warn('[Goal] Failed to create goal from the UI:', err)
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  handle(
    'harness-goal-update',
    async (payload: {
      topicId: number
      action: 'edit' | 'pause' | 'resume' | 'complete'
      objective?: string
      maxGoalRounds?: number
    }) => {
      try {
        const current = await goalStore.load(payload.topicId)
        if (!current) return { ok: false, error: 'goal-missing' }
        const goal = await goalStore.update(
          payload.topicId,
          current.id,
          current.revision,
          payload.action,
          { objective: payload.objective, maxGoalRounds: payload.maxGoalRounds }
        )
        return { ok: true, goal }
      } catch (err) {
        logger.warn('[Goal] Failed to update goal from the UI:', err)
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  handle('harness-goal-clear', async (topicId: number) => {
    try {
      await goalStore.delete(topicId)
      // GoalStore.delete 只清缓存与数据库行（话题删除时也走它）：界面上的目标条
      // 靠广播收回，所以这里补一条 null 目标，避免清理后横幅还挂在输入框上方。
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed())
          safeSend(win.webContents, HARNESS_EVENTS.goalUpdated, { topicId, goal: null })
      }
      return { ok: true }
    } catch (err) {
      logger.warn('[Goal] Failed to clear goal from the UI:', err)
      return { ok: false, error: (err as Error).message }
    }
  })

  // 计划模式：读取（顺带回填内存缓存）/ 切换（持久化 + 广播）
  handle('harness-plan-get', async (topicId: number) => {
    const active = await planModeStore.ensure(topicId)
    return { topicId, active }
  })

  handle('harness-plan-set', async (payload: { topicId: number; active: boolean }) => {
    const active = await planModeStore.setActive(payload.topicId, payload.active)
    return { topicId: payload.topicId, active }
  })

  // 计划模式变更 → 广播到所有窗口（输入框徽标实时刷新）
  scope.effect(() => {
    planModeStore.onChange = (topicId, active) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed())
          safeSend(win.webContents, HARNESS_EVENTS.planUpdated, { topicId, active })
      }
    }
    return () => {
      planModeStore.onChange = undefined
    }
  })

  // Agent Teams 模式（opt-in，按话题）：读取（顺带回填内存缓存）/ 切换（持久化 + 广播）
  handle('harness-team-mode-get', async (topicId: number) => {
    const enabled = await teamModeStore.ensure(topicId)
    return { topicId, enabled }
  })

  handle('harness-team-mode-set', async (payload: { topicId: number; enabled: boolean }) =>
    teamModeStore.setEnabled(payload.topicId, payload.enabled)
  )

  // 团队模式变更 → 广播到所有窗口（侧栏菜单勾选/顶部栏提示实时刷新）
  scope.effect(() => {
    teamModeStore.onChange = (view) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) safeSend(win.webContents, HARNESS_EVENTS.teamModeUpdated, view)
      }
    }
    return () => {
      teamModeStore.onChange = undefined
    }
  })

  // 目标变更 → 广播到所有窗口（GoalBar 实时刷新）
  scope.effect(() => {
    goalStore.onChange = (topicId, goal) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed())
          safeSend(win.webContents, HARNESS_EVENTS.goalUpdated, { topicId, goal })
      }
    }
    return () => {
      goalStore.onChange = undefined
    }
  })

  // 后台任务变更 → 广播到所有窗口（任务状态实时刷新）
  scope.effect(() => {
    jobsRegistry.onChange = (topicId, jobs) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed())
          safeSend(win.webContents, HARNESS_EVENTS.jobsUpdated, { topicId, jobs })
      }
    }
    return () => {
      jobsRegistry.onChange = undefined
    }
  })

  // 顶部栏「后台任务」入口：列表 / 手动停止 / 输出快照（peek 不消费模型的游标）
  handle('harness-jobs-list', (topicId: number) => jobsRegistry.list(topicId))
  handle('harness-job-kill', (topicId: number, jobId: string) => {
    const result = jobsRegistry.kill(jobId, topicId)
    // undefined 经 IPC 结构化克隆后语义不明确，统一成 null（渲染层按 null 判空）
    return { outcome: result.outcome, job: result.job ?? null }
  })
  handle('harness-job-output-peek', (topicId: number, jobId: string) =>
    jobsRegistry.peek(jobId, topicId)
  )

  // 后台子代理会话变更 → 广播（顶部栏代理列表实时刷新）
  scope.effect(() => {
    subagentSessions.onChange = (topicId, rows) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed())
          safeSend(win.webContents, HARNESS_EVENTS.agentsUpdated, { topicId, rows })
      }
    }
    return () => {
      subagentSessions.onChange = undefined
    }
  })
  handle('harness-agents-list', (topicId: number) => subagentSessions.list(topicId))

  // 共享任务板（Agent Teams / 超级智能体）：整板快照推送 + 按话题拉取。
  // 板子很小（单话题上限 200 条），整板替换比增量协议简单可靠，渲染层按 revision 去旧。
  scope.effect(() => {
    teamStore.onChange = (snapshot) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue
        safeSend(win.webContents, HARNESS_EVENTS.teamUpdated, snapshot)
      }
    }
    return () => {
      teamStore.onChange = undefined
    }
  })
  // 任务板读取：先懒加载持久化快照（重启后第一次打开协作面板/调用工具时恢复）
  handle('harness-team-tasks', async (topicId: number) => {
    await teamStore.ensureLoaded(topicId)
    return teamStore.snapshot(topicId)
  })

  // Agent Teams 最近活动（任务事件日志；追加写，面板 footer 展示最近一条）
  handle('harness-team-events', async (topicId: number, limit = 20) => {
    const rows = await listTeamTaskEvents(topicId, limit)
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      action: row.action,
      actorId: row.actor_id,
      actorName: row.actor_name,
      subject: row.subject,
      taskRevision: row.task_revision,
      createdAt: row.created_at
    }))
  })

  // 子代理会话视图（2026-11-26）：watch 即返回快照；此后把事件增量按 40ms 合批推送，
  // 轮次结束（turn_end）立即 flush，保证「进行中 → 已完成/失败」状态翻转及时可见。
  const AGENT_CONVERSATION_FLUSH_MS = 40
  const conversationWatchSet = new Set<string>()
  const conversationBuffers = new Map<string, SubagentConversationEvent[]>()
  const conversationTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const conversationKey = (topicId: number, agentId: string): string => `${topicId}:${agentId}`
  const flushAgentConversation = (topicId: number, agentId: string): void => {
    const key = conversationKey(topicId, agentId)
    const timer = conversationTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      conversationTimers.delete(key)
    }
    const events = conversationBuffers.get(key)
    conversationBuffers.delete(key)
    if (!events || events.length === 0) return
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      safeSend(win.webContents, HARNESS_EVENTS.agentConversationUpdated, {
        topicId,
        agentId,
        events
      })
    }
  }
  scope.effect(() => {
    subagentSessions.onConversationEvent = (topicId, agentId, event) => {
      const key = conversationKey(topicId, agentId)
      if (!conversationWatchSet.has(key)) return
      let buffer = conversationBuffers.get(key)
      if (!buffer) {
        buffer = []
        conversationBuffers.set(key, buffer)
      }
      buffer.push(event)
      // 轮次结束是状态翻转，必须尽快送达；其余 token 级事件按 40ms 合批
      if (event.kind === 'turn_end') {
        flushAgentConversation(topicId, agentId)
        return
      }
      if (!conversationTimers.has(key)) {
        conversationTimers.set(
          key,
          setTimeout(() => flushAgentConversation(topicId, agentId), AGENT_CONVERSATION_FLUSH_MS)
        )
      }
    }
    return () => {
      subagentSessions.onConversationEvent = undefined
      for (const timer of conversationTimers.values()) clearTimeout(timer)
      conversationTimers.clear()
      conversationBuffers.clear()
      conversationWatchSet.clear()
    }
  })
  handle(
    'harness-agent-conversation',
    (topicId: number, agentId: string) =>
      subagentSessions.readConversation(agentId, topicId) ?? null
  )
  /** 会话视图向前翻页：取 beforeSeq 之前最近一页完整轮次（滚动到顶部时调用） */
  handle(
    'harness-agent-conversation-older',
    (topicId: number, agentId: string, beforeSeq: number, maxTurns?: number) =>
      subagentSessions.readOlderConversation(agentId, topicId, beforeSeq, maxTurns) ?? null
  )
  /**
   * 打开/关闭子代理会话视图：
   * - watch=true：登记关注并**直接返回快照**（渲染层先订阅事件再 invoke，快照之前的
   *   增量事件会按 seq 丢弃，不存在丢失窗口）；
   * - watch=false：取消关注并丢弃未发送的缓冲（离开会话视图后不再产生 IPC）。
   */
  handle('harness-agent-conversation-watch', (topicId: number, agentId: string, watch: boolean) => {
    const key = conversationKey(topicId, agentId)
    if (watch) {
      conversationWatchSet.add(key)
      return subagentSessions.readConversation(agentId, topicId) ?? null
    }
    conversationWatchSet.delete(key)
    const timer = conversationTimers.get(key)
    if (timer) clearTimeout(timer)
    conversationTimers.delete(key)
    conversationBuffers.delete(key)
    return null
  })

  // 清理联动：话题删除 / 切换账号时，主进程不能给已不存在的会话继续保留 watch 状态
  // 与合批定时器（此前只在渲染层主动 unwatch 时清理，刷新/删话题会留下悬挂项）。
  scope.effect(() => {
    const clearTopicWatches = (topicId: number): void => {
      const prefix = `${topicId}:`
      for (const key of [...conversationWatchSet]) {
        if (!key.startsWith(prefix)) continue
        conversationWatchSet.delete(key)
        const timer = conversationTimers.get(key)
        if (timer) clearTimeout(timer)
        conversationTimers.delete(key)
        conversationBuffers.delete(key)
      }
    }
    const clearAllWatches = (): void => {
      conversationWatchSet.clear()
      for (const timer of conversationTimers.values()) clearTimeout(timer)
      conversationTimers.clear()
      conversationBuffers.clear()
    }
    subagentSessions.onTopicCleared = clearTopicWatches
    subagentSessions.onAllCleared = clearAllWatches
    return () => {
      subagentSessions.onTopicCleared = undefined
      subagentSessions.onAllCleared = undefined
      clearAllWatches()
    }
  })

  /**
   * 从会话视图向子代理投递一条消息（人工续聊）。
   *
   * 复用主代理 `send_message` 同一个 registry.send：空闲立即开新一轮、运行中进 FIFO
   * 收件箱；投递本身返回回执，不等待子代理回复（新轮的事件走 conversation 通道）。
   */
  handle(
    'harness-agent-prompt',
    async (payload: {
      topicId: number
      agentId: string
      message: string
    }): Promise<SubagentPromptResult> => {
      const topicId = typeof payload?.topicId === 'number' ? payload.topicId : -1
      const agentId = typeof payload?.agentId === 'string' ? payload.agentId : ''
      const text = typeof payload?.message === 'string' ? payload.message.trim() : ''
      if (!text) return { ok: false, error: 'empty message' }
      try {
        // inactive 会话会在这里冷恢复（重建 runtime）后继续；失败返回可读错误
        const { messageId } = await subagentSessions.send(agentId, topicId, text)
        return { ok: true, messageId }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  /** 停止该子代理当前这一轮（keepInbox：已排队但未开始的消息保留，可继续续聊） */
  handle('harness-agent-interrupt', (topicId: number, agentId: string) =>
    subagentSessions.interrupt(agentId, topicId)
  )

  /**
   * 「存入记忆」：不再由渲染层把正文截断后直接塞进热记忆，改为起一个后台记忆整理
   * 子代理——它读这一轮问答，自己判断哪些是可复用事实、该落到哪一层（热记忆 /
   * 项目文档 / 长期记忆空间），再用 mnemon_* 工具写入。
   *
   * 进度与结果复用顶部栏后台代理入口（subagentSessions 变更会广播 harness-agents-updated），
   * 这里只负责补齐上下文（该轮提问 + 模型护栏）并把任务交出去，不等它跑完。
   */
  handle(
    'harness-memory-agent-start',
    async (payload: {
      topicId: number
      answer: string
      dialogueId?: number
      providerId?: number
    }): Promise<StartMemoryAgentResult> => {
      const harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined

      // 该轮提问：按对话行 id 往前找最近一条用户消息，给整理代理补全上下文
      // （拿不到就只整理回答，不影响主流程）
      let question: string | undefined
      try {
        const rows = await getDialoguesByTopicId(payload.topicId)
        const at =
          payload.dialogueId != null ? rows.findIndex((row) => row.id === payload.dialogueId) : -1
        const before = at >= 0 ? rows.slice(0, at) : rows
        for (let i = before.length - 1; i >= 0; i -= 1) {
          if (before[i].role === 'user') {
            question = before[i].content
            break
          }
        }
      } catch (err) {
        logger.warn(
          '[Harness] Failed to read the question for this turn, memory consolidation will only include the answer:',
          err
        )
      }

      // 与主轮次同源的工具调用轮数护栏（取不到则由 startMemoryAgent 用默认值兜底）
      let maxToolRounds: number | undefined
      try {
        maxToolRounds = (await getProviderService().getConfig(undefined)).max_tool_rounds
      } catch (err) {
        logger.warn(
          '[Harness] Failed to read model max tool call rounds, memory consolidation will use the default:',
          err
        )
      }

      // 「存入记忆」也要落进**这条会话自己的**记忆作用域（插件会话 → 那份插件的记忆）
      const memoryAgentScope = await resolveTurnMemoryScope(
        payload.topicId,
        undefined,
        harnessSettings?.activeWorkspaceId ?? 0
      )

      const result = await startMemoryAgent({
        topicId: payload.topicId,
        answer: payload.answer ?? '',
        question,
        workspaceId: harnessSettings?.activeWorkspaceId ?? 0,
        memoryPath: harnessSettings?.memoryPath || undefined,
        memoryScope: serializeMemoryScope(memoryAgentScope),
        // 优先用那条回复自己的供应商（前端从用量行带过来），拿不到再走默认供应商
        providerId: payload.providerId,
        maxToolRounds
      })
      logger.info(
        `[Harness] Memory consolidation subagent: ${result.ok ? `${result.agentId} (${result.label})` : result.reason}`
      )
      return result
    }
  )

  // 后台子代理会话的实时内容走「会话事件流」通道（subagent-conversation），
  // 旧的纯文本输出 watch/节流链路已删除（无消费者，且与会话事件流重复）。

  // 提问系统：新提问 → 广播到所有窗口（前端弹窗）；回答/查询走 handle
  scope.effect(() => {
    questionService.onAsk = (pending) => {
      // 只发送可序列化视图（topicId/requestId/questions 均为纯 JSON），
      // 严禁把含 resolve/reject/signal 的记录直接送过 IPC（Electron 会抛序列化错误）
      const payload = {
        topicId: pending.topicId,
        requestId: pending.requestId,
        questions: pending.questions
      }
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) safeSend(win.webContents, HARNESS_EVENTS.questionAsked, payload)
      }
      // 挂起的同一刻告诉侧栏「这条会话在等人」：行首由进行中换成黄色呼吸点
      broadcastTopicPending(pending.topicId)
    }
    // 结算（用户回答 / 本轮中止）→ 撤回那个黄点，回到进行中
    questionService.onResolved = broadcastTopicPending
    return () => {
      questionService.onAsk = undefined
      questionService.onResolved = undefined
    }
  })
  handle('harness-question-answer', (requestId: string, answers: unknown) => {
    return questionService.answer(
      requestId,
      (answers ?? []) as Array<{ id: string; selected: string[]; custom?: string }>
    )
  })
  handle('harness-question-get', (topicId: number) => {
    return questionService.getPending(topicId)
  })

  // ── 沙箱审批（危险 / 越界操作被拦下后等用户决定）─────────────────────────
  // 与提问不同：审批只影响「这一次调用」，没有「总是允许」——持久策略由档位负责。
  handle('harness-approval-decide', (requestId: string, decision: string) => {
    const allowed = permissionGate.decide(
      requestId,
      decision === 'allow-once' ? 'allow-once' : ('deny' as ApprovalDecision)
    )
    logger.info(
      `[Permission] Approval decision requestId=${requestId} decision=${decision} matched=${allowed}`
    )
    return allowed
  })
  // 切话题 / 重新加载时拉一次当前挂起的审批（弹窗可能是在别的界面挂起的）
  handle('harness-approval-get', (topicId: number) => permissionGate.getPending(topicId))

  // ── 权限档位（输入框左下角选择器 + 设置页「新会话默认」）───────────────────
  handle('harness-permission-get', (topicId?: number) => permissionStateFor(topicId ?? null))
  // 沙箱后端状态（设置页与诊断用）：拿不到后端时命令会被拒绝执行，界面必须能说出来
  handle('harness-sandbox-status', () => {
    const status = sandboxService.status()
    return { ...status, ...sandboxService.describe() }
  })
  // 撤销工作区上的常驻 ACE（卸载/清理入口；仅 Windows 后端有意义）
  handle('harness-sandbox-cleanup', (workspacePath: string) => {
    if (!workspacePath) return false
    return sandboxService.cleanupWorkspace({
      mode: 'workspace-write',
      workspaceRoot: workspacePath
    })
  })
  handle(
    'harness-permission-set',
    (payload: { topicId?: number; mode?: unknown; scope?: 'topic' | 'default' }) => {
      const mode = payload?.mode
      if (!isPermissionMode(mode)) {
        logger.warn(`[Permission] Rejected invalid permission mode: ${String(mode)}`)
        return permissionStateFor(payload?.topicId ?? null)
      }
      // scope='default' 改「之后新建话题的默认值」；否则改当前话题（DSH 的两层语义）
      if (payload?.scope === 'default') {
        setDefaultPermissionMode(mode)
      } else if (typeof payload.topicId === 'number' && payload.topicId > 0) {
        setTopicPermissionMode(payload.topicId, mode as PermissionMode)
      } else {
        setDefaultPermissionMode(mode)
      }
      const state = permissionStateFor(payload?.topicId ?? null)
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          safeSend(win.webContents, HARNESS_EVENTS.permissionUpdated, state)
        }
      }
      logger.info(`[Permission] Mode switched topic=${state.topicId} mode=${state.mode}`)
      return state
    }
  )

  // 取消流式输出（同时中止挂起的提问）
  handle('harness-cancel-stream', () => {
    const sender = primarySender()
    if (!sender) return
    const controller = streamAbortControllers.get(sender.id)
    if (controller) {
      controller.abort()
      streamAbortControllers.delete(sender.id)
    }
    // 用户点了停止：只中止当前回合的注入缓冲；**排队中的插话保留**——
    // 那些是用户明确写下、还没被处理的消息（停止后由回合收尾路径作为新一轮接续发出）。
    const topicId = senderTopic.get(sender.id)
    if (topicId != null) {
      harnessQueue.dropInjections(topicId)
      broadcastQueue(topicId)
    }
    // 挂起的提问 / 审批：**只撤回这条会话自己的**。
    // 此前无差别 abortAll()：在 B 会话点「停止生成」会把 A 会话挂着的提问/审批一起按拒绝结算
    // （用户口径 2026-09-28「会被其他的会话占用……应该是按会话进行隔离」）。
    // 认不出话题（理论上不该发生）时才退回全撤，宁可多撤也别让调用永远挂着。
    if (topicId != null) {
      questionService.abortTopic(topicId)
      permissionGate.abortTopic(topicId)
    } else {
      questionService.abortAll()
      permissionGate.abortAll()
    }
  })

  // 对话计划清单（write_todos）变更 → 广播到渲染进程（输入框上方的进行中任务卡片）
  scope.effect(() => {
    todoStore.onChange = (topicId, todos) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed())
          safeSend(win.webContents, HARNESS_EVENTS.todosUpdated, { topicId, todos })
      }
    }
    return () => {
      todoStore.onChange = undefined
    }
  })

  // 读取当前话题的计划清单：卡片每次重新挂载（切页 / 切话题）都要主动拉一次，
  // 只靠写入选 broadcast 的话，切走再回来卡片会一直是空的直到模型下次写清单
  handle('harness-todos-get', async (topicId: number) => todoStore.get(topicId))

  // 选择记忆（Memory）存储目录
  handle('harness-select-memory-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: mainMessages().dialog.selectMemoryDir
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // 选择技能（Skills）存储目录
  handle('harness-select-skills-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: mainMessages().dialog.selectSkillsDir
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // 选择 AI 工作区目录（FilesystemBackend 挂载根目录）
  handle('harness-select-workspace', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: mainMessages().dialog.selectWorkspaceDir
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // ── 工具清单（设置 →「智能体」页的工具下拉）───────────────────────────────
  // 清单每次请求现取（本地工具 + 各插件当前贡献），因此插件启停立刻反映到设置页；
  // label/description 是**界面元数据**，按当前界面语言覆盖后下发。
  handle('harness-get-tools', async () => {
    const dict: Record<string, { label: string; description: string }> = mainMessages().tools
    return listAvailableTools().map((tool: ToolInfo) => {
      const text = dict[tool.name]
      return text ? { ...tool, label: text.label, description: text.description } : tool
    })
  })

  // ── 工具结果按需读取（内置工具的结果不再随流下发/落库）─────────────────────
  // 聊天里的工具卡片只带元信息；用户点开时才按 (topicId, callId) 取完整结果。
  // 未命中（详情未保存 / 已被清理）返回 null，前端显示「详情不可用」而不是空白。
  handle('harness-tool-output-get', (topicId: number, callId: string) => {
    try {
      return getToolOutputStore()?.read(topicId, callId) ?? null
    } catch (err) {
      logger.error('Error in harness-tool-output-get:', err)
      return null
    }
  })

  // 按虚拟路径读取文本文件（工具卡片「打开文件」用）：
  // 与 workspace-read-file 的区别是这里按挂载解析（工作区 + 记忆目录），
  // 边界仍是「必须落在某个已挂载根目录内」。
  //
  // 第二个参数是**当前会话的记忆作用域**（`plugin:<id>`，渲染层从作用域 store 带过来）：
  // 记忆挂载根是作用域目录（`<memoryPath>/plugin-<id>/`），跟 Runtime 的 /memories/ 同一口径——
  // 不按作用域解析的话，插件会话里点开 `/memories/...` 会去找工作区那份（找不到）。
  handle('harness-vfs-read', (virtualPath: string, scope?: string | null) => {
    try {
      const harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined
      return readVirtualTextFile(
        {
          workspacePath: harnessSettings?.workspacePath || undefined,
          memoryPath:
            memoryScopeRoot(
              harnessSettings?.memoryPath || undefined,
              parseMemoryScope(scope, harnessSettings?.activeWorkspaceId ?? 0)
            ) ??
            (harnessSettings?.memoryPath || undefined)
        },
        virtualPath
      )
    } catch (err) {
      logger.error('Error in harness-vfs-read:', err)
      return { error: (err as Error).message }
    }
  })

  /**
   * 技能目录扫描（主进程）：只 stat 确认 SKILL.md 可读，不读文件内容。
   * 分页时只解析当前页的 SKILL.md，扫描成本不随「页内要展示多少」增长。
   */
  const listSkillDirNames = (skillsPath: string): string[] => {
    try {
      return fs
        .readdirSync(skillsPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => {
          try {
            fs.accessSync(join(skillsPath, entry.name, 'SKILL.md'), fs.constants.R_OK)
            return true
          } catch {
            return false
          }
        })
        .map((entry) => entry.name)
    } catch (error) {
      logger.error('Error scanning skills dir:', error)
      return []
    }
  }

  /** 读单个技能的元信息（front matter 的 name / description） */
  const readSkillMeta = (
    skillsPath: string,
    dirName: string
  ): { id: string; name: string; description: string } => {
    let name = dirName
    let description = ''
    try {
      const content = fs.readFileSync(join(skillsPath, dirName, 'SKILL.md'), 'utf-8')
      const fm = content.match(/^---\s*\n([\s\S]*?)\n---/)
      if (fm) {
        const n = fm[1].match(/^name:\s*(.+)$/m)
        const d = fm[1].match(/^description:\s*(.+)$/m)
        if (n) name = n[1].trim()
        if (d) description = d[1].trim()
      }
    } catch {
      // 读不到就当默认名
    }
    return { id: dirName, name, description }
  }

  // 列出技能目录中的所有技能（工具页 / 技能选择器用；小数据量）
  handle('harness-list-skills', async () => {
    const skillsPath = (settingsStore.get('harness') as HarnessSettings | undefined)?.skillsPath
    if (!skillsPath) return []
    return listSkillDirNames(skillsPath).map((dirName) => readSkillMeta(skillsPath, dirName))
  })

  /**
   * 技能列表分页（主进程）：只返回当前页的元信息 + total。
   * 渲染层不再「全量拉取 + 前端切片」。
   */
  handle('harness-list-skills-paginated', async (page = 0, pageSize = 5) => {
    const skillsPath = (settingsStore.get('harness') as HarnessSettings | undefined)?.skillsPath
    if (!skillsPath) return { items: [], total: 0 }
    const dirs = listSkillDirNames(skillsPath)
    const safeSize = Math.max(1, Math.min(100, Math.floor(pageSize)))
    const safePage = Math.max(0, Math.floor(page))
    const start = safePage * safeSize
    return {
      items: dirs
        .slice(start, start + safeSize)
        .map((dirName) => readSkillMeta(skillsPath, dirName)),
      total: dirs.length
    }
  })

  /**
   * 技能启用/停用：判定在主进程完成。
   *
   * 「全部启用」在配置里用 `enabledSkills: undefined` 表示；停用某个技能时必须展开成完整清单，
   * 而完整技能目录只有主进程知道——放在渲染层会依赖「前端刚好拉到了全部技能」，
   * 分页后会漏掉其他页的技能。
   */
  handle('harness-set-skill-enabled', async (skillId: string, enabled: boolean) => {
    const harness = (settingsStore.get('harness') as HarnessSettings | undefined) ?? {}
    const skillsPath = harness.skillsPath
    const current = harness.enabledSkills
    let next: string[] | undefined
    if (enabled) {
      // 没有清单 = 全部启用，无需写
      next = current ? (current.includes(skillId) ? current : [...current, skillId]) : undefined
    } else {
      const base = current ?? (skillsPath ? listSkillDirNames(skillsPath) : [])
      next = base.filter((id) => id !== skillId)
    }
    settingsStore.set('harness', { ...harness, enabledSkills: next })
    return next
  })

  return registerIpcHandlers(handlers)
}
