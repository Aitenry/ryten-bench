import { BrowserWindow, app, dialog } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import logger from 'electron-log'
import { isSenderAlive, safeSend } from '../../../../main/safe-send'
import { mainMessages } from '../../../../main/i18n'
import {
  settingsStore,
  streamAbortControllers,
  activeHarnessStreams
} from '../../../../main/context'
import { harnessQueue } from '../queue-store'
import type { MainIpcHandlers, MainPluginContext } from '../../../../main/plugins/context'
import type { ToolInfo } from '../types'
import { effectiveMainAgentTools, type MainAgentConfig } from '../../shared/mcp'
import { HarnessService } from '../service/harness'
import { buildTools, listAvailableTools } from '../tools/builders'
import { readVirtualTextFile } from '../runtime/fs-backend'
import { getToolOutputStore } from '../runtime/tool-output-store'
import type {
  AgentInjection,
  ToolCallDetail,
  SubAgentEvent,
  MemoryInjection,
  TurnMeta,
  HistoryCompaction
} from '../types'
import type { QueueAttachments } from '../queue-store'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { getProviderService } from '../../../../main/provider/service'
import { getSubAgentDefs } from '../preload-cache'
import { todoStore } from '../runtime/todo'
import { closeOutInProgress, decideCloseOutOnTurnEnd } from '../runtime/todo-closeout'
import { answerTrailingCount, type TurnFinal } from '../service/answer-boundary'
import { goalStore } from '../runtime/goal'
import { jobsRegistry } from '../runtime/jobs'
import { subagentSessions } from '../runtime/subagent-sessions'
import { startMemoryAgent, type StartMemoryAgentResult } from '../runtime/memory-agent'
import { questionService } from '../runtime/ask'
import {
  permissionGate,
  type ApprovalDecision,
  type ApprovalRequestView
} from '../runtime/permission-gate'
import {
  permissionStateFor,
  setDefaultPermissionMode,
  setTopicPermissionMode,
  wirePermissionGate
} from '../runtime/permission-store'
import { isPermissionMode, type PermissionMode } from '../runtime/permission'
import { ensureExecutable, resolveSandboxAsset, sandboxService } from '../sandbox/service'
import { setSandboxLogger } from '../sandbox/log'
import { goalRoundDriver } from '../goal-driver'
import { HarnessSettings } from '../../../../main/types/settings'
import {
  createTopic,
  addDialogue,
  updateDialogueContent,
  addDialogueUsage,
  getDialoguesByTopicId,
  getTopicById
} from '../db/mapper/harness'
import { memoryScopeRoot, parseMemoryScope, type MemoryScope } from '../memory-scope'
import { getActiveWorkspaceId } from '../../../../main/database/workspace-context'
import { sumUsage, type ModelUsageRecord } from '../runtime/usage'
import { startRendererMemorySampling, stopRendererMemorySampling } from '../renderer-memory'

/**
 * 主进程 → 渲染层的事件通道（只有发送方、没有 ipcMain 处理器）。
 *
 * 它们必须在 plugin 的 `install` 里经 `ctx.registerEvent` 声明才会进 preload 的
 * 插件通道白名单（notes 那轮踩过：不声明则渲染层订阅被拒）。
 */
export const HARNESS_EVENTS = {
  streamChunk: 'plugin:harness:harness-stream-chunk',
  streamDone: 'plugin:harness:harness-stream-done',
  streamError: 'plugin:harness:harness-stream-error',
  queueUpdated: 'plugin:harness:harness-queue-updated',
  queueSteered: 'plugin:harness:harness-queue-steered',
  goalUpdated: 'plugin:harness:harness-goal-updated',
  jobsUpdated: 'plugin:harness:harness-jobs-updated',
  agentsUpdated: 'plugin:harness:harness-agents-updated',
  agentOutputUpdated: 'plugin:harness:harness-agent-output-updated',
  questionAsked: 'plugin:harness:harness-question-asked',
  approvalAsked: 'plugin:harness:harness-approval-asked',
  permissionUpdated: 'plugin:harness:harness-permission-updated',
  todosUpdated: 'plugin:harness:harness-todos-updated'
} as const

/** 本插件声明的事件通道清单（install 里交给 ctx.registerEvent） */
export const HARNESS_EVENT_CHANNELS: string[] = Object.values(HARNESS_EVENTS)

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

/** 单轮对话执行参数（用户轮与目标自动轮共用 runHarnessTurn 管线） */
interface RunHarnessTurnParams {
  event: HarnessSenderEvent
  question: string
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
    logger.info('[Harness] 模型未回传 usage_metadata，跳过用量落库')
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
      logger.warn('[Harness] 读取供应商配置失败，用量行只记 token:', err)
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
      `[Harness] 用量已落库 dialogue=${dialogueId} in/out/total=${totals.inputTokens}/${totals.outputTokens}/${totals.totalTokens} calls=${totals.calls}`
    )
  } catch (err) {
    logger.error('[Harness] 写入对话用量失败:', err)
  }
}

/**
 * 执行一轮完整对话：建模型 → 建话题 → 存用户消息 → 流式 → 存 AI 回复 → 通知前端。
 * 返回 { topicId, cancelled }（cancelled=true 表示用户点了停止）。
 */
async function runHarnessTurn(
  params: RunHarnessTurnParams
): Promise<{ topicId: number; cancelled: boolean }> {
  const { event, question, options } = params

  // 渲染进程已失效（崩溃/窗口关闭）时跳过本轮：不再创建模型、不保存消息、不向死帧发送
  if (!isSenderAlive(event.sender)) {
    logger.warn(`[Harness] 渲染进程已失效（senderId=${event.sender.id}），跳过本轮对话`)
    return { topicId: options?.topicId ?? 0, cancelled: true }
  }

  // 加载主智能体默认配置（electron-store）
  const mainAgentDefaults = settingsStore.get('mainAgent') as MainAgentConfig | undefined
  const tools = buildTools(effectiveMainAgentTools(mainAgentDefaults))
  const harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined
  logger.info(`[Harness] Creating model with providerId: ${options?.providerId ?? 'default'}`)

  // 1. 确保话题存在
  let topicId = options?.topicId
  if (!topicId) {
    const title = question.slice(0, 50)
    const workspaceId = harnessSettings?.activeWorkspaceId ?? 0
    try {
      // 话题上记一份「本轮启用的工具」快照（含 MCP 页勾选的 MCP 工具，与真正挂载的口径一致）
      const selected = effectiveMainAgentTools(mainAgentDefaults)
      topicId = await createTopic(
        workspaceId,
        title,
        undefined,
        selected.length ? JSON.stringify(selected) : undefined,
        // 记忆作用域：插件会话建话题时就落库（见 memory-scope.ts）
        options?.memoryScope ?? null
      )
    } catch (err) {
      logger.error('Failed to create topic:', err)
      topicId = 0
    }
  }

  // 1b. 本轮的记忆作用域（插件会话 → 那份插件自己的记忆，与工作记忆零交叉）
  const memoryScope = await resolveTurnMemoryScope(
    topicId,
    options?.memoryScope,
    harnessSettings?.activeWorkspaceId ?? 0
  )
  const memoryPluginId = memoryScope.kind === 'plugin' ? memoryScope.pluginId : undefined

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
      const userBlocks: { type: string; image_url?: string; fileName?: string; round?: number }[] =
        []
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
        userBlocks.push({ type: 'goalRound', round: options.turnMeta.goalRound })
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
  const failTurn = (error: unknown): { topicId: number; cancelled: boolean } => {
    const errMsg = error instanceof Error ? error.message : String(error)
    logger.error('[Harness] 对话轮次失败:', error)
    safeSend(event.sender, HARNESS_EVENTS.streamError, { error: errMsg, topicId })
    safeSend(event.sender, HARNESS_EVENTS.streamDone, { topicId })
    return { topicId, cancelled: false }
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
  let contextBudget: number | undefined
  let maxToolRounds: number | undefined
  try {
    const providerConfig = await getProviderService().getConfig(options?.providerId)
    const windowTokens =
      typeof providerConfig.metadata?.context_window === 'number'
        ? providerConfig.metadata.context_window
        : 0
    contextBudget = Math.max(20_000, windowTokens)
    maxToolRounds = providerConfig.max_tool_rounds
    logger.info(
      `[Harness] Model context window=${windowTokens} tokens → history budget=${contextBudget} chars, maxToolRounds=${maxToolRounds}`
    )
  } catch (err) {
    logger.warn('[Harness] 读取模型上下文窗口失败，使用默认历史预算 20000:', err)
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
    logger.warn(`[Harness] 渲染进程已失效（senderId=${event.sender.id}），中止流式输出`)
    abortController.abort()
  }
  event.sender.on('render-process-gone', onSenderGone)
  event.sender.once('destroyed', onSenderGone)

  // 2.5. 历史对话上下文由 HarnessService 内部从数据库加载（超长自动压缩）

  // 2.6. 目标自动续跑轮：流首先下发标记 chunk，前端据此挂载「自动续跑」用户消息 +
  // 助手占位并启动本轮流监听（普通用户轮由前端在发送时自行挂载）
  if (options?.turnMeta?.source === 'goal-round' && options.turnMeta.goalRound != null) {
    safeSend(event.sender, HARNESS_EVENTS.streamChunk, {
      __topicId: topicId,
      goalRound: {
        round: options.turnMeta.goalRound,
        objective: options.turnMeta.objective ?? ''
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
      await getSubAgentDefs(harnessSettings?.activeWorkspaceId ?? 0),
      getDialoguesByTopicId,
      harnessSettings?.skillsPath || undefined,
      effectiveSkills,
      harnessSettings?.workspacePath || undefined,
      harnessSettings?.memoryPath || undefined,
      harnessSettings?.activeWorkspaceId ?? 0,
      maxToolRounds,
      memoryPluginId
    )
  } catch (err) {
    // HarnessService 初始化（含子智能体定义加载）失败：清理本轮资源并通知前端，
    // 避免前端停留在「正在生成…」无任何反应
    logger.error('[Harness] HarnessService 初始化失败:', err)
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
      safeSend(event.sender, HARNESS_EVENTS.streamChunk, { answer: false, __topicId: topicId })
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
        logger.error('[Harness] 保存 AI 消息失败:', err)
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
      // 摘要压缩开始：立即推送「压缩中」过渡 chunk（不落库，结果由流尾 historyCompacted 携带，
      // 渲染进程收到结果块后原地替换过渡块，形成「压缩中 → 压缩结果」的转变）
      onCompactionStart: () => {
        safeSend(event.sender, HARNESS_EVENTS.streamChunk, {
          historyCompacting: true,
          __topicId: topicId
        })
      },
      // 摘要压缩模型请求自动重试：推送「正在重试（第 N/2 次）」过渡 chunk（不落库），
      // 压缩模型失败与正文模型同款恢复——重试耗尽后经 ModelRecoveryModal 换模型在原位置继续压缩
      onCompactionRetry: (attempt, retries) => {
        safeSend(event.sender, HARNESS_EVENTS.streamChunk, {
          retrying: { attempt, retries },
          __topicId: topicId
        })
      },
      // 回合内插话（steering）：**纯注入**——把文字并进模型上下文，不落库、不产生对话内容。
      // 调用点有两个（见 runtime/agent.ts）：模型节点调用前（主路径，长回答途中插话也能生效）、
      // 工具节点执行前。本轮结束时仍未取走的条目由 releaseHolds 放回队列，不静默丢内容。
      drainInjections: async (): Promise<AgentInjection[] | null> => {
        const items = harnessQueue.takeInjections(topicId)
        if (items.length === 0) return null
        logger.info(`[HarnessQueue] 取出 ${items.length} 条待注入插话（topic=${topicId}）`)
        return items.map((item) => {
          safeSend(event.sender, HARNESS_EVENTS.streamChunk, {
            steered: { text: item.text },
            __topicId: topicId
          })
          // 队列已摘除该条：广播给所有窗口（含发起窗口）抹掉队列行
          harnessQueue.notifyConsumed(topicId, { item })
          return { text: item.text }
        })
      }
    },
    (records) => {
      usageRecords = records
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
        logger.error('[Harness] 流式执行失败（已有部分输出）:', chunk.streamError.message)
        safeSend(event.sender, HARNESS_EVENTS.streamError, {
          error: chunk.streamError.message,
          topicId
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
      if (!safeSend(event.sender, HARNESS_EVENTS.streamChunk, { ...chunk, __topicId: topicId })) {
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
      safeSend(event.sender, HARNESS_EVENTS.streamError, { error: errMsg, topicId })
      // 流异常中断时不保存不完整的 AI 回复，直接跳到清理
      streamAbortControllers.delete(event.sender.id)
      stopMemSampling()
      safeSend(event.sender, HARNESS_EVENTS.streamDone, { topicId })
      return { topicId, cancelled: false }
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
          `[Harness] 本轮收尾：结掉 ${closed.closed} 项进行中 → ${closed.completed}/${closed.total} 已完成`
        )
      }
    } else {
      logger.info(`[Harness] 本轮不收尾任务清单（${decision.reason}）`)
    }
  } catch (err) {
    // 收尾只是兜底：判定或广播失败不能影响落库与前端收尾通知
    logger.warn('[Harness] 收尾任务清单失败:', err)
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
    `[Harness] 本轮终局：settled=${turnFinal.settled}, goalRound=${turnFinal.goalRound}` +
      `${turnFinal.round != null ? `(round=${turnFinal.round}, closed=${turnFinal.goalClosed}, willContinue=${turnFinal.goalWillContinue})` : ''}` +
      `, answer=${turnFinal.answerBlocks}块(from ${turnFinal.answerFrom}), blocks=${acc.blocks.length}`
  )

  // 5. 清理并通知渲染进程流式输出已完成
  streamAbortControllers.delete(event.sender.id)
  safeSend(event.sender, HARNESS_EVENTS.streamDone, {
    topicId,
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
  return { topicId, cancelled: abortController.signal.aborted }
}

/** 广播插话队列当前状态（所有窗口；前端按 topicId 过滤） */
function broadcastQueue(topicId: number): void {
  const queue = harnessQueue.view(topicId)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed())
      safeSend(win.webContents, HARNESS_EVENTS.queueUpdated, { topicId, queue })
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
      logger.warn('[Harness] 读取话题记忆作用域失败，按工作区记忆处理:', err)
    }
  }
  return parseMemoryScope(fallback, workspaceId)
}

/** 启动一轮用户对话并跟踪其生命周期（退 Application 前会等待它落库） */
function launchTurn(
  event: HarnessSenderEvent,
  question: string,
  options: StartStreamOptions | undefined,
  trackTurn: (p: Promise<{ topicId: number; cancelled: boolean }>) => Promise<{
    topicId: number
    cancelled: boolean
  }>
): Promise<{ topicId: number; cancelled: boolean }> {
  const topicId = options?.topicId
  if (topicId != null) {
    // 标记话题进行中：生成中新发来的消息据此走排队而不是插一轮
    harnessQueue.setTurnActive(topicId, true)
    senderTopic.set(event.sender.id, topicId)
  }
  return trackTurn(runHarnessTurn({ event, question, options })).finally(() => {
    if (topicId != null) {
      harnessQueue.setTurnActive(topicId, false)
      // 本轮点了插话却没等到注入边界的条目放回队列（见 releaseHolds 的说明）：
      // 它们既不落库也不进对话流，必须让用户还看得见，否则等于内容凭空消失
      harnessQueue.releaseHolds(topicId)
      // 只在本帧没有别的在跑话题时删掉映射（同帧切话题同时开两轮的情况很罕见，保守处理）
      if (senderTopic.get(event.sender.id) === topicId) senderTopic.delete(event.sender.id)
    }
  })
}

/**
 * 回合结束后的队列处置。
 *
 * 排队中的消息（用户明确要发的下一轮提问）在这里作为**新一轮**接续发出，FIFO。
 * 注意与插话分开：点了「立即插话」的条目走纯注入，不产生对话内容；只有排队区里
 * 还没点插话的消息才会被接续成轮次。目标自动续跑仍在跑时不抢跑，交给最后一轮收尾后接续。
 */
function drainPendingQueue(
  event: HarnessSenderEvent,
  topicId: number,
  options: StartStreamOptions | undefined,
  trackTurn: (p: Promise<{ topicId: number; cancelled: boolean }>) => Promise<{
    topicId: number
    cancelled: boolean
  }>
): void {
  if (harnessQueue.isTurnActive(topicId)) return
  if (goalRoundDriver.isRunning(topicId)) return
  const item = harnessQueue.shift(topicId)
  if (!item) return
  logger.info(`[HarnessQueue] 回合结束，接续队列消息：${item.text.slice(0, 40)}`)
  launchTurn(
    event,
    item.text,
    {
      ...options,
      topicId,
      // 接续轮不继承「编辑重发」目标行与旧消息 id
      reuseUserDialogueId: undefined,
      messageId: undefined,
      images: item.images,
      documents: item.documents
    },
    trackTurn
  ).catch((err) => logger.error('[HarnessQueue] 接续队列消息失败:', err))
}

/**
 * 对话发送 / 流式输出 / 目录选择 / 技能列表 IPC：收成 plugin:harness:* 处理器表，
 * 连同本插件依赖的全局订阅（onChange / onAsk / onLiveOutput）一起装配。
 *
 * 契约见 src/plugins/README.md 与 src/main/plugins/context.ts：
 * - 通道名一律 `plugin:harness:<原扁平名>`（命名空间 = manifest.id），交给 ctx.registerIpc，
 *   停用时随 ctx.dispose() 一次性摘除；
 * - 原先的 `ipcMain.on`（start-stream / cancel-stream / agent-watch）在「只有 handle」的
 *   新契约下改成普通 invoke 通道，preload 的 send 同步改 invoke（同 notes 的 graph-build-start）；
 * - 订阅用 ctx.effect 挂/摘：停用插件后不再向渲染层广播任何 harness 事件。
 */
export function installHarnessIpc(ctx: MainPluginContext): void {
  const handlers: MainIpcHandlers = {}
  /** 收通道：本插件的命名空间前缀只在这里出现 */
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`plugin:harness:${channel}`] = handler
  }

  // 权限闸门接线：档位来源（electron-store）+ 工作区根目录 + 界面语言文案
  wirePermissionGate()
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
    `[Sandbox] 接线完成 backend=${sandboxStatus.backend ?? 'unavailable'} enforcement=${sandboxStatus.enforcement ?? '-'} ${sandboxStatus.reason ?? ''}`
  )

  // 沙箱拦截到的危险 / 越界操作 → 广播到所有窗口，由审批弹窗问用户「允许一次 / 拒绝」
  ctx.effect(() => {
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
      logger.info(
        `[Permission] 挂起审批 requestId=${pending.requestId} tool=${pending.toolName} reason=${pending.reasonCode}`
      )
    }
    return () => {
      // 停用插件即不再有人应答：挂起审批全部按拒绝结算（故障关闭）
      permissionGate.onApprovalAsked = undefined
      permissionGate.abortAll()
    }
  })

  // 队列变更 → 广播到所有窗口（输入框上方的插话队列实时刷新）
  ctx.effect(() => {
    harnessQueue.onChanged = ({ topicId }) => broadcastQueue(topicId)
    return () => {
      harnessQueue.onChanged = null
    }
  })
  // 插话已并入当前回合（纯注入）→ 广播给所有窗口：前端抹掉队列行 + 给一句瞬时反馈
  ctx.effect(() => {
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
      const tools = buildTools(effectiveMainAgentTools(mainAgentDefaults))
      logger.info(`[Harness] Creating model with providerId: ${options?.providerId ?? 'default'}`)
      const model = await getProviderService().createModel(options?.providerId)
      const harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined

      // 技能优先级：harnessSettings.enabledSkills > mainAgent.skills
      const effectiveSkills = harnessSettings?.enabledSkills ?? mainAgentDefaults?.skills

      // 该模型的「工具调用轮数」上限（取不到则用工程默认值，由 HarnessService 兜底）
      let maxToolRounds: number | undefined
      try {
        maxToolRounds = (await getProviderService().getConfig(options?.providerId)).max_tool_rounds
      } catch (err) {
        logger.warn('[Harness] 读取模型工具调用轮数失败，使用默认值:', err)
      }

      // 这条同步路径也要认话题的记忆作用域（插件会话 → 那份插件自己的记忆）
      const syncMemoryScope = await resolveTurnMemoryScope(
        options?.topicId,
        undefined,
        harnessSettings?.activeWorkspaceId ?? 0
      )

      const harnessService = new HarnessService(
        model,
        tools,
        await getSubAgentDefs(harnessSettings?.activeWorkspaceId ?? 0),
        getDialoguesByTopicId,
        harnessSettings?.skillsPath || undefined,
        effectiveSkills,
        harnessSettings?.workspacePath || undefined,
        harnessSettings?.memoryPath || undefined,
        harnessSettings?.activeWorkspaceId ?? 0,
        maxToolRounds,
        syncMemoryScope.kind === 'plugin' ? syncMemoryScope.pluginId : undefined
      )
      return await harnessService.sendMessage(question, options)
    }
  )

  handle('harness-start-stream', (question: string, options?: StartStreamOptions) => {
    // 原 ipcMain.on('harness-start-stream') 的 event.sender：新契约不透传事件对象
    const sender = primarySender()
    if (!sender) return
    const event: HarnessSenderEvent = { sender }
    // 跟踪进行中的流：应用退出时统一中止并等待数据保存完成。
    // 用户轮次完成后触发目标轮次驱动器（自动续跑轮由驱动器内部递归调度）
    // 每个轮次（含目标驱动器派发的自动轮）都登记进 activeHarnessStreams，
    // 退出时 lifecycle 才能拦截并等待落库（修复：此前只跟踪首轮，自动轮运行中退出会丢回复）
    const trackTurn = (
      p: Promise<{ topicId: number; cancelled: boolean }>
    ): Promise<{ topicId: number; cancelled: boolean }> => {
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
          logger.info('[Harness] 本轮被用户取消，目标 disarm，跳过自动续跑调度')
          goalStore.disarm(topicId)
          return
        }
        await goalRoundDriver.maybeDrive(topicId, (p) =>
          trackTurn(
            runHarnessTurn({
              event,
              question: p.question,
              options: { ...options, topicId: p.topicId, turnMeta: p.turnMeta }
            })
          )
        )
        // 目标续跑全部结束后再处置队列：排队中的插话作为新一轮发出
        drainPendingQueue(event, topicId, options, trackTurn)
      })
      .catch((err) => logger.error('[Harness] 轮次执行异常:', err))
    activeHarnessStreams.add(streamPromise)
    streamPromise.finally(() => activeHarnessStreams.delete(streamPromise))
  })

  /**
   * 生成中发消息：当前话题有回合在跑 → 收进插话队列；没有在跑 → 直接发起新一轮。
   * 渲染进程不再自己判断（多窗口/多话题下判断会失准），一律由主进程裁决。
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
      const event: HarnessSenderEvent = { sender }
      if (harnessQueue.isTurnActive(topicId)) {
        harnessQueue.enqueue({ topicId, senderId: event.sender.id, text, attachments })
        return { queued: true }
      }
      // 没有在跑的回合：直接开一轮（与普通发送同一条管线）
      const trackTurn = (
        p: Promise<{ topicId: number; cancelled: boolean }>
      ): Promise<{ topicId: number; cancelled: boolean }> => {
        activeHarnessStreams.add(p)
        p.finally(() => activeHarnessStreams.delete(p))
        return p
      }
      void trackTurn(
        runHarnessTurn({
          event,
          question: text,
          options: {
            topicId,
            // 队列接续轮沿用默认模型与主智能体默认工具集
            images: attachments.images,
            documents: attachments.documents,
            turnMeta: { source: 'user' }
          }
        })
      )
        .then(() => {
          drainPendingQueue(event, topicId, { topicId }, trackTurn)
        })
        .catch((err) => logger.error('[HarnessQueue] 直接发起轮次异常:', err))
      return { queued: false }
    }
  )

  /** 队列查询（窗口/话题重新挂载时拉取当前队列） */
  handle('harness-queue-list', (topicId: number) => harnessQueue.view(topicId))

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
        `[HarnessQueue] 插话已受理话题 ${topicId}（等待下一个工具节点边界注入）：${item.text.slice(0, 40)}`
      )
      return { accepted: true }
    }
  )

  // 目标查询（渲染进程加载目标状态）
  handle('harness-goal-get', async (topicId: number) => {
    return await goalStore.load(topicId)
  })

  // 目标变更 → 广播到所有窗口（GoalBar 实时刷新）
  ctx.effect(() => {
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
  ctx.effect(() => {
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

  // 后台子代理会话变更 → 广播（顶部栏代理列表实时刷新）
  ctx.effect(() => {
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
  handle('harness-agent-output', (topicId: number, agentId: string) =>
    subagentSessions.readOutput(agentId, topicId)
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
        logger.warn('[Harness] 读取该轮提问失败，记忆整理只带回答:', err)
      }

      // 与主轮次同源的工具调用轮数护栏（取不到则由 startMemoryAgent 用默认值兜底）
      let maxToolRounds: number | undefined
      try {
        maxToolRounds = (await getProviderService().getConfig(undefined)).max_tool_rounds
      } catch (err) {
        logger.warn('[Harness] 读取模型工具调用轮数失败，记忆整理使用默认值:', err)
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
        pluginId: memoryAgentScope.kind === 'plugin' ? memoryAgentScope.pluginId : undefined,
        // 优先用那条回复自己的供应商（前端从用量行带过来），拿不到再走默认供应商
        providerId: payload.providerId,
        maxToolRounds
      })
      logger.info(
        `[Harness] 记忆整理子代理：${result.ok ? `${result.agentId} (${result.label})` : result.reason}`
      )
      return result
    }
  )

  // 后台子代理输出推送（弹窗监听后端，替代手动刷新/轮询）：
  // 仅在渲染端 watch 该 agent 时消费 onLiveOutput，并按 500ms 节流（防 token 级 IPC 风暴）
  const agentWatchSet = new Set<string>() // `${topicId}:${agentId}`
  const agentPushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const agentLastPush = new Map<string, number>()
  const AGENT_OUTPUT_PUSH_MS = 500
  const pushAgentOutput = (topicId: number, agentId: string): void => {
    const output = subagentSessions.readOutput(agentId, topicId)
    if (!output) return
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        safeSend(win.webContents, HARNESS_EVENTS.agentOutputUpdated, { topicId, agentId, output })
      }
    }
  }
  ctx.effect(() => {
    subagentSessions.onLiveOutput = (topicId, agentId) => {
      const key = `${topicId}:${agentId}`
      if (!agentWatchSet.has(key)) return
      const now = Date.now()
      const last = agentLastPush.get(key) ?? 0
      if (now - last >= AGENT_OUTPUT_PUSH_MS) {
        agentLastPush.set(key, now)
        pushAgentOutput(topicId, agentId)
      } else if (!agentPushTimers.has(key)) {
        agentPushTimers.set(
          key,
          setTimeout(() => {
            agentPushTimers.delete(key)
            agentLastPush.set(key, Date.now())
            pushAgentOutput(topicId, agentId)
          }, AGENT_OUTPUT_PUSH_MS)
        )
      }
    }
    return () => {
      subagentSessions.onLiveOutput = undefined
    }
  })
  handle('harness-agent-watch', (topicId: number, agentId: string, watch: boolean) => {
    const key = `${topicId}:${agentId}`
    if (watch) {
      agentWatchSet.add(key)
      pushAgentOutput(topicId, agentId) // 打开弹窗即推一次当前快照
    } else {
      agentWatchSet.delete(key)
      const timer = agentPushTimers.get(key)
      if (timer) clearTimeout(timer)
      agentPushTimers.delete(key)
    }
  })

  // 提问系统：新提问 → 广播到所有窗口（前端弹窗）；回答/查询走 handle
  ctx.effect(() => {
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
    }
    return () => {
      questionService.onAsk = undefined
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
    logger.info(`[Permission] 审批裁决 requestId=${requestId} decision=${decision} 命中=${allowed}`)
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
        logger.warn(`[Permission] 拒绝非法档位: ${String(mode)}`)
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
      logger.info(`[Permission] 档位已切换 topic=${state.topicId} mode=${state.mode}`)
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
    questionService.abortAll()
    // 沙箱审批同样撤回：用户点了停止，就不该再有「等待审批」的调用挂在那里
    permissionGate.abortAll()
  })

  // 对话计划清单（write_todos）变更 → 广播到渲染进程（输入框上方的进行中任务卡片）
  ctx.effect(() => {
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

  // 列出技能目录中的所有技能
  handle('harness-list-skills', async () => {
    try {
      const settings = settingsStore.store
      const skillsPath = (settings.harness as HarnessSettings)?.skillsPath
      if (!skillsPath) return []

      const entries = fs.readdirSync(skillsPath, { withFileTypes: true })
      const skills: { id: string; name: string; description: string }[] = []

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillMdPath = join(skillsPath, entry.name, 'SKILL.md')
        try {
          fs.accessSync(skillMdPath, fs.constants.R_OK)
          const content = fs.readFileSync(skillMdPath, 'utf-8')
          const fm = content.match(/^---\s*\n([\s\S]*?)\n---/)
          let name = entry.name
          let description = ''
          if (fm) {
            const n = fm[1].match(/^name:\s*(.+)$/m)
            const d = fm[1].match(/^description:\s*(.+)$/m)
            if (n) name = n[1].trim()
            if (d) description = d[1].trim()
          }
          skills.push({ id: entry.name, name, description })
        } catch {
          // 目录中没有 SKILL.md，跳过
        }
      }
      return skills
    } catch (error) {
      logger.error('Error listing skills:', error)
      return []
    }
  })

  // 整张表交给宿主：停用时随 ctx.dispose() 一次性摘除
  ctx.registerIpc(handlers)
}
