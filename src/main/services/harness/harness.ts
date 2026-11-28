import type { StructuredToolInterface } from '../../ai/tools'
import { BaseChatModel } from '../../ai/chat-model'
import { BaseMessage } from '../../ai/messages'
import logger from 'electron-log'
import * as fs from 'fs'
import * as path from 'path'
import {
  HarnessOptions,
  StructuredMessage,
  SubAgentConfig,
  SubAgentMainModelDescriptor,
  HistoryCompaction
} from './types'
import { Runtime } from '../../runtime/harness/runtime'
import { planModeStore } from '../../runtime/harness/plan-mode'
import { teamModeStore } from '../../runtime/harness/team-mode'
import type { ModelUsageRecord } from '../../runtime/harness/usage'
import { lastCallContextTokens } from '../../runtime/harness/usage'
import { getMnemonComponent } from './mnemon-singleton'
import {
  memoryScopeDirName,
  memoryScopeRoot,
  serializeMemoryScope,
  workspaceScope,
  type MemoryScope
} from './memory-scope'
import { summarizeDialoguesWithRecovery } from '../../runtime/harness/compaction'
import { readVirtualTextFile } from '../../runtime/harness/fs-backend'
import { todoStore } from '../../runtime/harness/todo'
import { mainFormat } from '../../i18n'
import { getFsToolTexts } from '../../i18n/tool-results-fs'
import { getCompactionByTopic, upsertCompaction } from '../../database/mapper/harness/compaction'
import { getLastUsageByTopic } from '../../database/mapper/harness/harness'
import type { HistoryDialogue, LoadHistoryFn } from './history'
import { extractStructuredMessages, convertDialoguesToMessages } from './history'
import { buildHumanMessage } from './message-builder'
import type { UploadedFileRef } from './message-builder'
import { runStream } from './stream-handler'
import { DEFAULT_MAX_TOOL_ROUNDS } from '../../../shared/model-params'

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
   * Memory scope of this session (`workspace` / `plugin` / `chat`, see main/memory-scope.ts):
   * plugin sessions use **this plugin's own** directory (`<memoryPath>/plugin-<id>/`), and "chat"
   * mode sessions use `<memoryPath>/chat/`, with zero crossover with working memory.
   */
  private readonly memoryScope: MemoryScope
  /** Total tool-call limit (from the current model's "advanced config → tool call rounds") */
  private readonly maxToolRounds: number
  /** Main model descriptor at spawn time (provider row + model name): background subagent sessions persist it so cold recovery returns to the same model */
  private readonly modelDescriptor?: SubAgentMainModelDescriptor
  /** Goal auto-continuation rounds: skip plan-mode tools/prompts */
  private readonly suppressPlanMode: boolean
  /** Whether the model routed for this turn declares image input support (runtime gate for read_image) */
  private readonly supportsImageInput: boolean

  /**
   * @param model Created BaseChatModel instance (provided by the external ProviderService)
   * @param tools Tool list
   * @param subAgents Agent definition list
   * @param loadHistory Callback that loads historical dialogues from the database (injected by the main process to avoid circular dependencies)
   * @param skillsPath Skill storage directory (subdirectories containing SKILL.md are skills); empty = disabled
   * @param enabledSkills Enabled skill ID list; undefined = all enabled
   * @param workspacePath AI workspace directory, mounted as virtual /
   * @param memoryPath Memory storage root; empty = disabled (split by scope underneath, each scope has its own memory)
   * @param workspaceId Current workspace ID, used to isolate memory directories by workspace
   * @param maxToolRounds Total tool-call limit (model setting "tool call rounds"; defaults to the project default)
   * @param memoryScope Memory scope of this session; default = workspace scope by workspaceId
   * @param modelDescriptor Main model descriptor at spawn time (optional; for background subagent cold recovery)
   * @param suppressPlanMode Goal auto-continuation rounds: ignore plan mode
   * @param supportsImageInput Whether the current model profile declares image input support (false = read_image refuses to execute)
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
    memoryScope?: MemoryScope,
    modelDescriptor?: SubAgentMainModelDescriptor,
    suppressPlanMode = false,
    supportsImageInput = false
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
    this.memoryScope = memoryScope ?? workspaceScope(workspaceId)
    this.maxToolRounds = maxToolRounds
    this.modelDescriptor = modelDescriptor
    this.suppressPlanMode = suppressPlanMode
    this.supportsImageInput = supportsImageInput
    logger.info(
      `HarnessService initialized with the agent Runtime (skillsPath=${this.skillsPath ?? 'disabled'}, workspacePath=${this.workspacePath ?? 'disabled'}, memoryPath=${this.memoryPath ?? 'disabled'}, workspaceId=${this.workspaceId}, memoryScope=${this.memoryScopeDirName ?? 'disabled'}, subAgents=${this.subAgents.length}, maxToolRounds=${this.maxToolRounds}, model=${this.modelDescriptor ? `${this.modelDescriptor.providerId}/${this.modelDescriptor.model}` : 'default'})`
    )
  }

  /**
   * Create an agent runtime (a separate instance per request, for good isolation).
   * The Mnemon memory component is a process-level singleton (shared across requests, see mnemon-singleton.ts).
   *
   * @param onUsageRecord Callback invoked after each model call during generation (the IPC layer uses it to broadcast live usage for this turn)
   */
  private createRuntime(onUsageRecord?: (records: ModelUsageRecord[]) => void): Runtime {
    return new Runtime({
      model: this.model,
      tools: this.tools,
      subAgents: this.subAgents,
      skillsPath: this.skillsPath,
      enabledSkills: this.enabledSkills,
      workspacePath: this.workspacePath,
      // Memory is isolated by **scope**: the Runtime's /memories/ mount and the Mnemon storage
      // root both live under <memoryPath>/<scope dir>/ — work-mode sessions by workspace, plugin
      // sessions by plugin, "chat"-mode sessions under chat (see memory-scope.ts /
      // mnemon-singleton.ts)
      memoryPath: this.scopeMemoryPath,
      workspaceId: this.workspaceId,
      maxToolCalls: this.maxToolRounds,
      modelDescriptor: this.modelDescriptor,
      suppressPlanMode: this.suppressPlanMode,
      supportsImageInput: this.supportsImageInput,
      onUsageRecord,
      mnemon: getMnemonComponent(
        this.memoryPath,
        this.workspaceId,
        serializeMemoryScope(this.memoryScope)
      )
    })
  }

  /** Scope directory name (`workspace-<id>` / `plugin-<id>` / `chat`), for logs */
  private get memoryScopeDirName(): string | undefined {
    if (!this.memoryPath) return undefined
    return memoryScopeDirName(this.memoryScope)
  }

  /** Scope-level memory directory (memory root + scope directory name) */
  private get scopeMemoryPath(): string | undefined {
    return memoryScopeRoot(this.memoryPath, this.memoryScope)
  }

  /**
   * Copy user-uploaded files into the agent workspace /uploads/ directory,
   * returning virtual path references in the agent filesystem.
   *
   * Instead of embedding file content in the message, the agent reads it on demand with the
   * read_file tool; large read results are truncated at the tool layer (20K chars) to avoid
   * context bloat.
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
        // Sanitize the file name: the renderer-supplied fileName may contain path separators or
        // .., which would write outside the uploads directory if joined directly
        const safeName = path.basename(doc.fileName)
        if (!safeName) {
          logger.warn(`[Harness] Ignoring invalid upload file name: ${doc.fileName}`)
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
        // On copy failure, still tell the agent so it can try reading from the original path
        refs.push({
          fileName: doc.fileName,
          virtualPath: doc.filePath
        })
      }
    }

    return refs.length > 0 ? refs : undefined
  }

  /**
   * Context actually consumed by the previous model call (tokens), used for compaction pressure.
   *
   * The data source is harness_dialogue_usage (one row per turn; the last entry of the row's
   * detail array = the most recent call). Returns null when unavailable (the model/gateway does
   * not return usage_metadata, or a new session has no usage row yet), and the caller falls back
   * to the "chars ÷ budget" heuristic.
   */
  private async measureContextTokens(topicId: number): Promise<number | null> {
    try {
      const last = await getLastUsageByTopic(topicId)
      return lastCallContextTokens(last ? [last] : [])
    } catch (err) {
      logger.warn(
        '[Harness] Failed to read usage for compaction pressure, falling back to chars:',
        err
      )
      return null
    }
  }

  /**
   * Todo list text re-injected after compaction (empty string when there are no todos).
   *
   * The todo list is the "working memory" the model maintains itself; compaction only touches
   * historical messages and never this process-level list, but the summary may not remember every
   * item, so it is re-injected along with the file contents after compaction.
   */
  private buildRestoreNote(topicId: number): string {
    const todos = todoStore.get(topicId)
    if (todos.length === 0) return ''
    const header = mainFormat(getFsToolTexts().compaction.restoredTodos, {})
    return [header, ...todos.map((todo) => `- [${todo.status}] ${todo.content}`)].join('\n')
  }

  /**
   * Load historical message context from the database
   * @param topicId Topic ID
   * @param onCompactionStart Callback when summary compaction starts (fired before the LLM call; the frontend shows "compacting")
   * @param contextBudget Character budget for historical context (converted from the model context window; defaults to the default floor)
   * @param signal Cancellation signal (threaded into the summary compaction call: after stop, the compaction request is actually interrupted and no checkpoint is persisted)
   * @param contextWindow Current model context window (tokens); used when compaction pressure is judged by real tokens
   * @returns Converted BaseMessage array and the summary compaction info for this turn
   */
  private async loadContextMessages(
    topicId: number,
    onCompactionStart?: () => void,
    contextBudget?: number,
    signal?: AbortSignal,
    onCompactionRetry?: (attempt: number, retries: number) => void,
    turnSource?: string,
    contextWindow?: number
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
      const [dialogues, measuredContextTokens] = await Promise.all([
        this.loadHistory(topicId),
        this.measureContextTokens(topicId)
      ])
      logger.info(`[Harness] Fetched ${dialogues.length} dialogues for topic ${topicId}`)
      // Exclude the last entry (the current user message) and take only earlier dialogues
      const historyDialogues = dialogues.slice(0, -1)
      if (historyDialogues.length === 0) {
        logger.info(
          `[Harness] No prior dialogues for topic ${topicId} after excluding current message`
        )
        return { messages: [] }
      }

      const context = await convertDialoguesToMessages(historyDialogues, {
        // Summary compaction: when pressure is reached, compact the oldest dialogues into a
        // checkpoint (persisted and reused, incrementally merged); the compaction model request
        // recovers like the main stream: automatic retry (with progress) + continue with another
        // model; only when the user gives up or the model is unavailable does it fall back to
        // character truncation. The checkpoint is stored in the topic_compactions table.
        // Pressure prefers real tokens (previous turn's actual context ÷ window ≥ 79%) and falls
        // back to the character measure only when unavailable.
        maxChars: contextBudget,
        measuredContextTokens,
        contextWindowTokens: contextWindow,
        // Post-compaction re-injection: re-read recently read/modified files from the same
        // workspace snapshot (skip any that cannot be read)
        readFile: (virtualPath) =>
          readVirtualTextFile(
            {
              workspacePath: this.workspacePath,
              memoryPath: this.scopeMemoryPath,
              workspaceId: this.workspaceId
            },
            virtualPath
          ),
        // Bring the current todos back after compaction (the list lives in the process;
        // compaction itself does not touch it)
        restoreNote: () => this.buildRestoreNote(topicId),
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
        // The cancellation signal threads into the compaction chain: after abort, skip the
        // summary and checkpoint persistence (previously not passed, so the cancellation guards
        // in history.ts were all dead code and a checkpoint was still persisted inside the
        // cancellation window)
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
   * Send a message and return the structured message list
   * @param message User input
   * @param options Optional config (includes topicId for loading history)
   * @returns Structured message array, each element containing tool call info or text content
   */
  async sendMessage(message: string, options?: HarnessOptions): Promise<StructuredMessage[]> {
    try {
      // Backfill plan-mode / team-mode state (the non-streaming path also applies per topic)
      if (options?.topicId && options.topicId > 0) {
        await planModeStore.ensure(options.topicId)
        await teamModeStore.ensure(options.topicId)
      }
      const runtime = this.createRuntime()

      // Copy uploaded files into a workspace directory the agent can access
      const uploadedRefs = await this.copyUploadedFiles(options?.documents)
      const userMessage = buildHumanMessage(message, options?.images, uploadedRefs)
      const context = options?.topicId
        ? await this.loadContextMessages(
            options.topicId,
            undefined,
            options?.contextBudget,
            options?.signal,
            undefined,
            options?.turnMeta?.source,
            options?.contextWindow
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
      // The non-streaming path also carries this turn's hot-memory injection and summary
      // compaction info (the frontend shows cards from these)
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
   * Send a message and stream the content back
   * @param message User input
   * @param options Optional config (includes topicId for loading history)
   * @returns Async generator yielding StructuredMessage
   */
  async *sendMessageStream(
    message: string,
    options?: HarnessOptions,
    /** Real usage callback for this turn (the IPC layer writes it into harness_dialogue_usage after the assistant message is persisted) */
    onUsage?: (records: ModelUsageRecord[]) => void,
    /** Usage callback for each model call during generation (the IPC layer broadcasts it to the input footer to show this turn's progress live) */
    onUsageRecord?: (records: ModelUsageRecord[]) => void
  ): AsyncGenerator<StructuredMessage> {
    yield* runStream(
      {
        createRuntime: () => this.createRuntime(onUsageRecord),
        onUsage,
        loadContextMessages: (
          topicId: number,
          onCompactionStart?: () => void,
          contextBudget?: number,
          signal?: AbortSignal,
          onCompactionRetry?: (attempt: number, retries: number) => void,
          turnSource?: string,
          contextWindow?: number
        ) =>
          this.loadContextMessages(
            topicId,
            onCompactionStart,
            contextBudget,
            signal,
            onCompactionRetry,
            turnSource,
            contextWindow
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
