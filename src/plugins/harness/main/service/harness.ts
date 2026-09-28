import type { StructuredToolInterface } from '@langchain/core/tools'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { BaseMessage } from '@langchain/core/messages'
import logger from 'electron-log'
import * as fs from 'fs'
import * as path from 'path'
import { HarnessOptions, StructuredMessage, SubAgentConfig, HistoryCompaction } from '../types'
import { Runtime } from '../runtime/runtime'
import type { ModelUsageRecord } from '../runtime/usage'
import { getMnemonComponent } from '../mnemon-singleton'
import {
  memoryScopeDirName,
  memoryScopeRoot,
  pluginScope,
  workspaceScope,
  type MemoryScope
} from '../memory-scope'
import { summarizeDialoguesWithRecovery } from '../runtime/compaction'
import { getCompactionByTopic, upsertCompaction } from '../db/mapper/compaction'
import type { HistoryDialogue, LoadHistoryFn } from './history'
import { extractStructuredMessages, convertDialoguesToMessages } from './history'
import { buildHumanMessage } from './message-builder'
import type { UploadedFileRef } from './message-builder'
import { runStream } from './stream-handler'
import { DEFAULT_MAX_TOOL_ROUNDS } from '../../../../shared/model-params'

class HarnessService {
  private readonly model: BaseChatModel
  private readonly tools: StructuredToolInterface[]
  private readonly subAgents: SubAgentConfig[]
  private readonly loadHistory?: LoadHistoryFn
  private readonly skillsPath?: string
  private readonly enabledSkills?: string[]
  private readonly workspacePath?: string
  private readonly memoryPath?: string
  private readonly workspaceId: number
  /**
   * 插件 id：非空表示这个会话是插件行「＋」开出来的，记忆走**这份插件自己的作用域**
   * （`<memoryPath>/plugin-<id>/`，见 main/memory-scope.ts），与工作记忆零交叉。
   */
  private readonly pluginId?: string
  /** 工具调用总次数上限（来自当前模型的「高级配置 → 工具调用轮数」） */
  private readonly maxToolRounds: number

  /**
   * @param model 已创建的 BaseChatModel 实例（由外部 ProviderService 提供）
   * @param tools 工具列表
   * @param subAgents 智能体定义列表
   * @param loadHistory 从数据库加载历史对话的回调（由主进程注入，避免循环依赖）
   * @param skillsPath 技能存储目录（含 SKILL.md 的子目录即技能），空表示不启用
   * @param enabledSkills 启用的技能 ID 列表，undefined 表示全部启用
   * @param workspacePath AI 工作区目录，挂载为虚拟 /
   * @param memoryPath 记忆存储根目录，空表示不启用（其下按作用域分隔，每个作用域一套独立记忆）
   * @param workspaceId 当前工作区 ID，用于按工作区隔离记忆目录
   * @param maxToolRounds 工具调用总次数上限（模型设置「工具调用轮数」；缺省用工程默认值）
   * @param pluginId 非空 = 这份插件的会话，记忆落在 `<memoryPath>/plugin-<id>/`
   */
  constructor(
    model: BaseChatModel,
    tools: StructuredToolInterface[] = [],
    subAgents: SubAgentConfig[] = [],
    loadHistory?: LoadHistoryFn,
    skillsPath?: string,
    enabledSkills?: string[],
    workspacePath?: string,
    memoryPath?: string,
    workspaceId = 0,
    maxToolRounds: number = DEFAULT_MAX_TOOL_ROUNDS,
    pluginId?: string
  ) {
    this.model = model
    this.tools = tools
    this.subAgents = subAgents
    this.loadHistory = loadHistory
    this.skillsPath = skillsPath
    this.enabledSkills = enabledSkills
    this.workspacePath = workspacePath
    this.memoryPath = memoryPath
    this.workspaceId = workspaceId
    this.pluginId = pluginId
    this.maxToolRounds = maxToolRounds
    logger.info(
      `HarnessService initialized with LangChain Runtime (skillsPath=${this.skillsPath ?? 'disabled'}, workspacePath=${this.workspacePath ?? 'disabled'}, memoryPath=${this.memoryPath ?? 'disabled'}, workspaceId=${this.workspaceId}, memoryScope=${this.memoryScopeDirName ?? 'disabled'}, subAgents=${this.subAgents.length}, maxToolRounds=${this.maxToolRounds})`
    )
  }

  /**
   * 创建 LangChain/LangGraph 运行时（每次请求独立实例，隔离性好）。
   * Mnemon 记忆组件为进程级单例（跨请求共享，见 mnemon-singleton.ts）。
   */
  private createRuntime(): Runtime {
    return new Runtime({
      model: this.model,
      tools: this.tools,
      subAgents: this.subAgents,
      skillsPath: this.skillsPath,
      enabledSkills: this.enabledSkills,
      workspacePath: this.workspacePath,
      // 记忆按**作用域**隔离：Runtime 的 /memories/ 挂载与 Mnemon 存储根都在
      // <memoryPath>/<作用域目录>/ 下——工作模式的会话按工作区，插件会话按插件
      // （见 memory-scope.ts / mnemon-singleton.ts）
      memoryPath: this.scopeMemoryPath,
      workspaceId: this.workspaceId,
      maxToolCalls: this.maxToolRounds,
      mnemon: getMnemonComponent(this.memoryPath, this.workspaceId, this.pluginId)
    })
  }

  /** 作用域目录名（`workspace-<id>` / `plugin-<id>`），日志用 */
  private get memoryScopeDirName(): string | undefined {
    if (!this.memoryPath) return undefined
    return memoryScopeDirName(this.memoryScope)
  }

  /** 当前会话的记忆作用域 */
  private get memoryScope(): MemoryScope {
    return this.pluginId ? pluginScope(this.pluginId) : workspaceScope(this.workspaceId)
  }

  /** 作用域级记忆目录（记忆根 + 作用域目录名定位） */
  private get scopeMemoryPath(): string | undefined {
    return memoryScopeRoot(this.memoryPath, this.memoryScope)
  }

  /**
   * 将用户上传的文件复制到 agent 工作区 /uploads/ 目录，
   * 返回 agent 文件系统中的虚拟路径引用。
   *
   * 不直接将文件内容嵌入消息，而是让 agent 通过 read_file 工具按需读取，
   * 大文件读取结果在工具层截断（20K 字符），避免上下文膨胀。
   */
  private async copyUploadedFiles(
    docs?: { fileName: string; filePath: string }[]
  ): Promise<UploadedFileRef[] | undefined> {
    if (!docs || docs.length === 0 || !this.workspacePath) return undefined

    const uploadsDir = path.join(this.workspacePath, 'uploads')
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true })
    }

    const refs: UploadedFileRef[] = []
    for (const doc of docs) {
      try {
        // 文件名净化：renderer 传入的 fileName 可能含路径分隔符/..，直接拼接会写出 uploads 目录
        const safeName = path.basename(doc.fileName)
        if (!safeName) {
          logger.warn(`[Harness] 忽略非法上传文件名: ${doc.fileName}`)
          continue
        }
        const destPath = path.join(uploadsDir, safeName)
        fs.copyFileSync(doc.filePath, destPath)
        refs.push({
          fileName: safeName,
          virtualPath: `/uploads/${safeName}`
        })
      } catch (err) {
        logger.warn(`Failed to copy uploaded file ${doc.fileName}:`, err)
        // 复制失败时仍告知 agent，让其尝试直接从原始路径读取
        refs.push({
          fileName: doc.fileName,
          virtualPath: doc.filePath
        })
      }
    }

    return refs.length > 0 ? refs : undefined
  }

  /**
   * 从数据库加载历史消息上下文
   * @param topicId 话题 ID
   * @param onCompactionStart 摘要压缩开始时回调（LLM 调用前触发，前端展示「压缩中」）
   * @param contextBudget 历史上下文字符预算（由模型上下文窗口换算，缺省用默认下限）
   * @param signal 取消信号（贯通到摘要压缩调用：停止后压缩请求真正中断，且不落库 checkpoint）
   * @returns 转换后的 LangChain BaseMessage 数组及本轮发生的摘要压缩信息
   */
  private async loadContextMessages(
    topicId: number,
    onCompactionStart?: () => void,
    contextBudget?: number,
    signal?: AbortSignal,
    onCompactionRetry?: (attempt: number, retries: number) => void,
    turnSource?: string
  ): Promise<{ messages: BaseMessage[]; compaction?: HistoryCompaction }> {
    if (!this.loadHistory) {
      logger.warn('[Harness] loadHistory callback not provided, skipping history')
      return { messages: [] }
    }
    if (topicId <= 0) {
      logger.warn(`[Harness] Invalid topicId=${topicId}, skipping history`)
      return { messages: [] }
    }

    try {
      const dialogues = await this.loadHistory(topicId)
      logger.info(`[Harness] Fetched ${dialogues.length} dialogues for topic ${topicId}`)
      // 排除最后一条（当前用户消息），只取之前的对话
      const historyDialogues = dialogues.slice(0, -1)
      if (historyDialogues.length === 0) {
        logger.info(
          `[Harness] No prior dialogues for topic ${topicId} after excluding current message`
        )
        return { messages: [] }
      }

      const context = await convertDialoguesToMessages(historyDialogues, {
        // 摘要压缩：压力达标时把最老对话压缩为 checkpoint（持久化复用，增量合并），
        // 压缩模型请求与正文同款恢复：自动重试（带进度）+ 换模型继续；
        // 用户放弃/询问不可用才回退字符截断。checkpoint 存于 topic_compactions 表。
        maxChars: contextBudget,
        summarizer: (transcript, priorSummary) =>
          summarizeDialoguesWithRecovery(this.model, transcript, priorSummary, {
            topicId,
            turnSource,
            signal,
            onRetry: onCompactionRetry
          }),
        topicId,
        getCheckpoint: async (tid) => {
          const row = await getCompactionByTopic(tid)
          return row ? { boundaryId: row.boundary_id, summary: row.summary } : undefined
        },
        saveCheckpoint: async (tid, cp) => {
          await upsertCompaction({ topic_id: tid, boundary_id: cp.boundaryId, summary: cp.summary })
        },
        onCompactionStart,
        // 取消信号贯通到压缩链路：中止后跳过摘要与 checkpoint 落库（此前漏传，
        // history.ts 里的取消守卫全是死代码，取消窗口内仍会落库 checkpoint）
        signal
      })
      logger.info(
        `[Harness] Loaded ${context.messages.length} history messages for topic ${topicId}`
      )
      return { messages: context.messages, compaction: context.compaction }
    } catch (err) {
      logger.error('Failed to load harness history:', err)
      return { messages: [] }
    }
  }

  /**
   * 发送消息并返回结构化的消息列表
   * @param message 用户输入
   * @param options 可选配置（含 topicId 用于加载历史）
   * @returns 结构化消息数组，每个元素包含工具调用信息或文本内容
   */
  async sendMessage(message: string, options?: HarnessOptions): Promise<StructuredMessage[]> {
    try {
      const runtime = this.createRuntime()

      // 将上传文件复制到 agent 可访问的工作区目录
      const uploadedRefs = await this.copyUploadedFiles(options?.documents)
      const userMessage = buildHumanMessage(message, options?.images, uploadedRefs)
      const context = options?.topicId
        ? await this.loadContextMessages(
            options.topicId,
            undefined,
            options?.contextBudget,
            options?.signal,
            undefined,
            options?.turnMeta?.source
          )
        : { messages: [] as BaseMessage[] }
      logger.info(
        `[Harness] Passing ${context.messages.length} context messages + 1 user message to runtime (topicId=${options?.topicId})`
      )
      const resultMessages = await runtime.invoke(
        [...context.messages, userMessage],
        options?.signal,
        options?.topicId,
        options?.turnMeta
      )

      const structured = extractStructuredMessages(resultMessages)
      // 非流式路径同样携带本轮热记忆注入与摘要压缩信息（前端据此显示卡片）
      const meta: StructuredMessage[] = []
      if (context.compaction) meta.push({ historyCompacted: context.compaction })
      const injection = runtime.memoryInjection
      if (injection) meta.push({ memoryInjected: injection })
      return meta.length > 0 ? [...meta, ...structured] : structured
    } catch (error) {
      logger.error('Error in sendMessage:', error)
      return [
        {
          content: `Failed to get response: ${error}`
        }
      ]
    }
  }

  /**
   * 发送消息并以流式方式返回内容
   * @param message 用户输入
   * @param options 可选配置（含 topicId 用于加载历史）
   * @returns 异步生成器，返回 StructuredMessage
   */
  async *sendMessageStream(
    message: string,
    options?: HarnessOptions,
    /** 本轮真实用量回调（由 IPC 层在助手消息落库后写入 harness_dialogue_usage） */
    onUsage?: (records: ModelUsageRecord[]) => void
  ): AsyncGenerator<StructuredMessage> {
    yield* runStream(
      {
        createRuntime: () => this.createRuntime(),
        onUsage,
        loadContextMessages: (
          topicId: number,
          onCompactionStart?: () => void,
          contextBudget?: number,
          signal?: AbortSignal,
          onCompactionRetry?: (attempt: number, retries: number) => void,
          turnSource?: string
        ) =>
          this.loadContextMessages(
            topicId,
            onCompactionStart,
            contextBudget,
            signal,
            onCompactionRetry,
            turnSource
          ),
        copyUploadedFiles: (docs) => this.copyUploadedFiles(docs)
      },
      message,
      options
    )
  }
}

export { HarnessService }
export type { HistoryDialogue, LoadHistoryFn }
