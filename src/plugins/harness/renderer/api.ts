import type {
  AgentConfigInput,
  AgentConfigRow,
  AgentPaginatedResult,
  ApprovalDecision,
  ApprovalRequestView,
  AskAnswer,
  FileChangeContent,
  FileChangeView,
  GoalView,
  HarnessDialogueRow,
  HarnessDialogueUsageRow,
  HarnessTopicRow,
  JobSnapshot,
  MnemonBodiesView,
  MnemonBodyInsight,
  MnemonBodyRef,
  MnemonSnapshot,
  McpServerConfig,
  McpServerInput,
  McpServerView,
  McpToolInfo,
  PaginatedResult,
  PendingQuestionView,
  PermissionMode,
  QueuedMessageView,
  StartMemoryAgentResult,
  SubagentSessionRow,
  TodoItem,
  TurnFinal,
  WorkspaceFsChange,
  WorkspaceRow
} from '../shared/types'
import type { HarnessToolInfo } from './types'
import type {
  WorkshopActionResult,
  WorkshopBuildInfo,
  WorkshopDraftDetail,
  WorkshopDraftSummary,
  WorkshopPublishResult,
  WorkshopReport
} from '../shared/workshop'

/** 档位状态视图（主进程为准：当前话题档位 + 新会话默认档位） */
export interface PermissionStateView {
  topicId: number
  mode: PermissionMode
  defaultMode: PermissionMode
}

/** 沙箱后端状态（设置页展示「有没有真正的内核级隔离」） */
export interface SandboxStatusView {
  platform: string
  backend: string | null
  enforcement: 'full' | 'partial' | null
  usable: boolean
  reason?: string
  tempRoot?: string
  windowsRunnerPath?: string
  landlockLauncherPath?: string
}

/**
 * harness 插件主进程通道的薄封装。
 *
 * 原先散在 `src/preload/index.ts` 的四个命名空间（`harness` / `agents` / `mainAgent` /
 * `workspace`，其中 Mnemon 记忆的一组方法嵌在 `harness` 里）已整体删除；这里的方法分组与
 * **名称、参数、返回类型**逐一对应（分组结构保留，避免 `getAll` / `update` / `delete`
 * 在不同域之间重名），实现改为走 preload 唯一暴露的通用桥
 * （`window.api.plugin.invoke/on`，通道名 `plugin:harness:*`）。
 *
 * 事件订阅同样走通用桥：通道必须由插件主进程 `ctx.registerEvent` 声明才进 preload
 * 白名单；插件停用时订阅调用**不再抛错**（preload 只告警），但没有发送方 ⇒ 事件不会来——
 * 调用方仍要按「可能永远收不到事件」写（历史教训：异常从 useEffect 逃逸会卸载整棵渲染树，白屏）。
 *
 * 契约见 src/plugins/README.md；类型取自 shared/types.ts（跨进程 DTO，运行期零依赖）。
 */
const invoke = window.api.plugin.invoke

/** 主进程 → 渲染层事件通道的订阅（通用桥 + 白名单门控） */
const on = (channel: string, callback: (data: unknown) => void): (() => void) =>
  window.api.plugin.on(channel, callback)

/** 后台子代理会话输出视图（点开查看结果） */
export interface SubagentSessionOutputView {
  text: string
  status: 'running' | 'idle'
  lastStatus?: 'completed' | 'failed' | 'killed'
  /** 启动时的原始任务指令（弹窗顶部展示） */
  prompt: string
}

/** 本轮流式结束载荷（harness-stream-done） */
export interface StreamDoneResult {
  topicId: number
  userDialogueId?: number
  assistantDialogueId?: number
  /** 助手段落表（无插话时只有一段）：messageId 对应一段助手气泡 */
  segments?: { messageId: string; dialogueId?: number }[]
  /** 本轮终局标记（最终答复边界 + 目标是否收口） */
  turnFinal?: TurnFinal
}

type AskAnswerItem = AskAnswer['answers'][number]

export const harnessApi = {
  /* ── 助手主体（话题对话 / 流式 / 队列 / 目标 / 后台任务 / 子代理 / 提问 / VFS） ── */
  harness: {
    sendMessage: (message: string, options?: { providerId?: number }) =>
      invoke('plugin:harness:harness-send-message', message, options),
    startMessageStream: (
      message: string,
      options?: {
        topicId?: number
        providerId?: number
        images?: string[]
        documents?: { fileName: string; filePath: string }[]
        /** 编辑并重发：改写这条已存在的用户消息行，而不是插入新行 */
        reuseUserDialogueId?: number
        /** 本轮首段助手消息的前端临时 id（插话会切段，主进程按段回传 dialogueId） */
        messageId?: string
      }
    ) => {
      // harness-start-stream 已从 ipcMain.on 改成 invoke 通道（见插件 main/index.ts）
      void invoke('plugin:harness:harness-start-stream', message, options)
    },

    // ── 生成中的插话队列 ──────────────────────────────────────────────
    /** 生成中发消息：主进程裁决——有回合在跑则入队（queued=true），否则直接开新一轮 */
    enqueueMessage: (payload: {
      topicId: number
      text: string
      attachments?: {
        images?: string[]
        documents?: { fileName: string; filePath: string }[]
      }
    }) => invoke('plugin:harness:harness-queue-enqueue', payload) as Promise<{ queued: boolean }>,
    listQueuedMessages: (topicId: number) =>
      invoke('plugin:harness:harness-queue-list', topicId) as Promise<QueuedMessageView[]>,
    removeQueuedMessage: (topicId: number, itemId: string) =>
      invoke('plugin:harness:harness-queue-remove', { topicId, itemId }) as Promise<boolean>,
    updateQueuedMessage: (topicId: number, itemId: string, text: string) =>
      invoke('plugin:harness:harness-queue-update', { topicId, itemId, text }) as Promise<boolean>,
    /** 立即插话：把这条排队消息注入正在运行的回合（下一个工具节点边界生效） */
    steerQueuedMessage: (topicId: number, itemId: string) =>
      invoke('plugin:harness:harness-queue-steer', { topicId, itemId }) as Promise<{
        accepted: boolean
      }>,
    onQueueUpdated: (
      callback: (data: { topicId: number; queue: QueuedMessageView[] }) => void
    ): (() => void) =>
      on('plugin:harness:harness-queue-updated', (data) =>
        callback(data as { topicId: number; queue: QueuedMessageView[] })
      ),
    onQueueSteered: (
      callback: (data: { topicId: number; itemId: string; text: string }) => void
    ): (() => void) =>
      on('plugin:harness:harness-queue-steered', (data) =>
        callback(data as { topicId: number; itemId: string; text: string })
      ),

    getTools: () => invoke('plugin:harness:harness-get-tools') as Promise<HarnessToolInfo[]>,

    onStreamChunk: (callback: (chunk: Record<string, unknown>) => void): (() => void) =>
      on('plugin:harness:harness-stream-chunk', (chunk) =>
        callback(chunk as Record<string, unknown>)
      ),
    onStreamDone: (callback: (result: StreamDoneResult) => void): (() => void) =>
      on('plugin:harness:harness-stream-done', (result) => callback(result as StreamDoneResult)),
    onStreamError: (callback: (error: { error: string; topicId?: number }) => void): (() => void) =>
      on('plugin:harness:harness-stream-error', (error) =>
        callback(error as { error: string; topicId?: number })
      ),

    /**
     * 文档被聊天工具修改/删除（notes 插件的编辑器据此同步或提示，防覆盖工具写入）。
     * 渲染层不再有人直接订阅它——harness 的 renderer install 把它桥接成宿主事件总线的
     * 语义事件 `doc:changed`（见 renderer/plugin.tsx），消费方是 notes 的文档编辑器。
     */
    onDocChanged: (
      callback: (data: { docId: number; action: 'updated' | 'deleted' }) => void
    ): (() => void) =>
      on('plugin:harness:harness-doc-changed', (data) =>
        callback(data as { docId: number; action: 'updated' | 'deleted' })
      ),

    getHarnessTodos: (topicId: number) =>
      invoke('plugin:harness:harness-todos-get', topicId) as Promise<TodoItem[]>,
    onHarnessTodosUpdated: (
      callback: (data: { topicId: number; todos: TodoItem[] }) => void
    ): (() => void) =>
      on('plugin:harness:harness-todos-updated', (data) =>
        callback(data as { topicId: number; todos: TodoItem[] })
      ),

    // 目标系统（goal）
    getGoal: (topicId: number) =>
      invoke('plugin:harness:harness-goal-get', topicId) as Promise<GoalView | null>,
    onGoalUpdated: (
      callback: (data: { topicId: number; goal: GoalView | null }) => void
    ): (() => void) =>
      on('plugin:harness:harness-goal-updated', (data) =>
        callback(data as { topicId: number; goal: GoalView | null })
      ),

    // 后台任务系统（jobs）
    onJobsUpdated: (
      callback: (data: { topicId: number; jobs: JobSnapshot[] }) => void
    ): (() => void) =>
      on('plugin:harness:harness-jobs-updated', (data) =>
        callback(data as { topicId: number; jobs: JobSnapshot[] })
      ),

    // 后台子代理会话（顶部栏列表：进行中 > 已完成，点开查看结果）
    listAgents: (topicId: number) =>
      invoke('plugin:harness:harness-agents-list', topicId) as Promise<SubagentSessionRow[]>,
    agentOutput: (topicId: number, agentId: string) =>
      invoke('plugin:harness:harness-agent-output', topicId, agentId) as Promise<
        SubagentSessionOutputView | undefined
      >,
    /**
     * 存入记忆：起一个后台「记忆整理」子代理，由它自己总结后写入 Mnemon，立即返回。
     * 进度与结果走顶部栏后台代理入口（onAgentsUpdated / agentOutput），不等它跑完。
     */
    startMemoryAgent: (payload: {
      topicId: number
      answer: string
      dialogueId?: number
      providerId?: number
    }) =>
      invoke(
        'plugin:harness:harness-memory-agent-start',
        payload
      ) as Promise<StartMemoryAgentResult>,
    onAgentsUpdated: (
      callback: (data: { topicId: number; rows: SubagentSessionRow[] }) => void
    ): (() => void) =>
      on('plugin:harness:harness-agents-updated', (data) =>
        callback(data as { topicId: number; rows: SubagentSessionRow[] })
      ),
    watchAgentOutput: (topicId: number, agentId: string, watch: boolean) => {
      void invoke('plugin:harness:harness-agent-watch', topicId, agentId, watch)
    },
    onAgentOutputUpdated: (
      callback: (data: {
        topicId: number
        agentId: string
        output: SubagentSessionOutputView
      }) => void
    ): (() => void) =>
      on('plugin:harness:harness-agent-output-updated', (data) =>
        callback(data as { topicId: number; agentId: string; output: SubagentSessionOutputView })
      ),

    // 向用户提问（ask_user_question）
    onQuestionAsked: (callback: (pending: PendingQuestionView) => void): (() => void) =>
      on('plugin:harness:harness-question-asked', (pending) =>
        callback(pending as PendingQuestionView)
      ),
    answerQuestion: (requestId: string, answers: AskAnswerItem[]) =>
      invoke('plugin:harness:harness-question-answer', requestId, answers) as Promise<boolean>,
    getQuestion: (topicId: number) =>
      invoke('plugin:harness:harness-question-get', topicId) as Promise<PendingQuestionView | null>,

    /* ── 沙箱权限（档位选择器 + 危险操作审批弹窗） ── */
    /** 当前档位与新会话默认值（切话题时拉一次） */
    getPermission: (topicId?: number | null) =>
      invoke(
        'plugin:harness:harness-permission-get',
        topicId ?? undefined
      ) as Promise<PermissionStateView>,
    /** 切档位：scope='default' 改新会话默认值，否则改该话题 */
    setPermission: (payload: {
      topicId?: number | null
      mode: PermissionMode
      scope?: 'topic' | 'default'
    }) =>
      invoke('plugin:harness:harness-permission-set', {
        topicId: payload.topicId ?? undefined,
        mode: payload.mode,
        scope: payload.scope
      }) as Promise<PermissionStateView>,
    onPermissionUpdated: (callback: (state: PermissionStateView) => void): (() => void) =>
      on('plugin:harness:harness-permission-updated', (state) =>
        callback(state as PermissionStateView)
      ),
    /** 沙箱后端状态：拿不到后端时命令会被拒绝执行（设置页要把这件事说出来） */
    sandboxStatus: () =>
      invoke('plugin:harness:harness-sandbox-status') as Promise<SandboxStatusView>,
    /** 撤销工作区上的常驻 ACE（仅 Windows 后端有意义；卸载/清理入口） */
    cleanupSandbox: (workspacePath: string) =>
      invoke('plugin:harness:harness-sandbox-cleanup', workspacePath) as Promise<boolean>,
    /** 沙箱拦下一次危险 / 越界操作 → 弹窗等用户决定 */
    onApprovalAsked: (callback: (pending: ApprovalRequestView) => void): (() => void) =>
      on('plugin:harness:harness-approval-asked', (pending) =>
        callback(pending as ApprovalRequestView)
      ),
    /** 裁决：allow-once（只放行这一次）/ deny */
    decideApproval: (requestId: string, decision: ApprovalDecision) =>
      invoke('plugin:harness:harness-approval-decide', requestId, decision) as Promise<boolean>,
    getApproval: (topicId: number) =>
      invoke('plugin:harness:harness-approval-get', topicId) as Promise<ApprovalRequestView | null>,

    cancelStream: () => {
      void invoke('plugin:harness:harness-cancel-stream')
    },
    selectSkillsDirectory: () =>
      invoke('plugin:harness:harness-select-skills-directory') as Promise<string | null>,
    selectWorkspace: () =>
      invoke('plugin:harness:harness-select-workspace') as Promise<string | null>,
    listSkills: () =>
      invoke('plugin:harness:harness-list-skills') as Promise<
        { id: string; name: string; description: string }[]
      >,

    // 记忆管理（Mnemon 三层记忆）
    // 末尾的 memoryScope 决定读**哪一套**记忆：`plugin:<插件 id>` = 这份插件自己的；
    // 空 / 不传 = 当前工作区（见 renderer/memory-scope.ts）
    selectMemoryDirectory: () =>
      invoke('plugin:harness:harness-select-memory-directory') as Promise<string | null>,
    mnemonSnapshot: (memoryScope?: string | null) =>
      invoke('plugin:harness:mnemon-snapshot', memoryScope ?? null) as Promise<MnemonSnapshot>,
    mnemonRuntimeMutate: (
      request: {
        action: string
        target: string
        content?: string
        old_text?: string
        importance?: string
      },
      memoryScope?: string | null
    ) =>
      invoke('plugin:harness:mnemon-runtime-mutate', request, memoryScope ?? null) as Promise<{
        success: boolean
        message: string
      }>,
    mnemonBodies: (memoryScope?: string | null) =>
      invoke('plugin:harness:mnemon-bodies', memoryScope ?? null) as Promise<MnemonBodiesView>,
    mnemonBodyCreate: (name: string, description: string, memoryScope?: string | null) =>
      invoke(
        'plugin:harness:mnemon-body-create',
        { name, description },
        memoryScope ?? null
      ) as Promise<{
        success: boolean
        body?: MnemonBodyRef
        message?: string
      }>,
    mnemonBodyUpdate: (
      id: string,
      request: { name?: string; description?: string; active?: boolean },
      memoryScope?: string | null
    ) =>
      invoke('plugin:harness:mnemon-body-update', id, request, memoryScope ?? null) as Promise<{
        success: boolean
        body?: MnemonBodyRef
        message?: string
      }>,
    mnemonBodyList: (memoryBodyIds?: string[], memoryScope?: string | null) =>
      invoke('plugin:harness:mnemon-body-list', memoryBodyIds, memoryScope ?? null) as Promise<
        MnemonBodyInsight[]
      >,
    mnemonDocumentSnapshot: (memoryScope?: string | null) =>
      invoke('plugin:harness:mnemon-document-snapshot', memoryScope ?? null) as Promise<
        MnemonSnapshot['documents'] | null
      >,

    // 工作区管理
    getAllWorkspaces: () => invoke('plugin:harness:workspace-get-all') as Promise<WorkspaceRow[]>,
    createWorkspace: (name: string, path: string) =>
      invoke('plugin:harness:workspace-create', name, path) as Promise<number>,
    updateWorkspace: (id: number, updates: { name: string }) =>
      invoke('plugin:harness:workspace-update', id, updates) as Promise<boolean>,
    deleteWorkspace: (id: number) =>
      invoke('plugin:harness:workspace-delete', id) as Promise<boolean>,

    // 话题管理
    getAllTopics: (workspaceId: number) =>
      invoke('plugin:harness:harness-topic-get-all', workspaceId) as Promise<HarnessTopicRow[]>,
    getAllTopicsPaginated: (workspaceId: number, page: number, pageSize: number) =>
      invoke('plugin:harness:harness-topic-get-paginated', workspaceId, page, pageSize) as Promise<
        PaginatedResult<HarnessTopicRow>
      >,
    getTopicById: (id: number) =>
      invoke('plugin:harness:harness-topic-get-by-id', id) as Promise<HarnessTopicRow[]>,
    createTopic: (
      workspaceId: number,
      title: string,
      model?: string,
      selectedTools?: string,
      /** 记忆作用域：`plugin:<插件 id>` = 这份插件自己的记忆；空 = 跟工作区走 */
      memoryScope?: string | null
    ) =>
      invoke(
        'plugin:harness:harness-topic-create',
        workspaceId,
        title,
        model,
        selectedTools,
        memoryScope
      ) as Promise<number>,
    updateTopic: (
      id: number,
      updates: Partial<Pick<HarnessTopicRow, 'title' | 'model' | 'selected_tools'>>
    ) => invoke('plugin:harness:harness-topic-update', id, updates) as Promise<boolean>,
    deleteTopic: (id: number) =>
      invoke('plugin:harness:harness-topic-delete', id) as Promise<boolean>,

    // 消息管理
    getDialoguesByTopic: (topicId: number) =>
      invoke('plugin:harness:harness-dialogue-get-by-topic', topicId) as Promise<
        HarnessDialogueRow[]
      >,
    getDialoguesByTopicPaginated: (topicId: number, page: number, pageSize: number) =>
      invoke(
        'plugin:harness:harness-dialogue-get-by-topic-paginated',
        topicId,
        page,
        pageSize
      ) as Promise<PaginatedResult<HarnessDialogueRow>>,
    addDialogue: (dialogue: Omit<HarnessDialogueRow, 'id' | 'created_at'>) =>
      invoke('plugin:harness:harness-dialogue-add', dialogue) as Promise<number>,
    deleteDialoguesByTopic: (topicId: number) =>
      invoke('plugin:harness:harness-dialogue-delete-by-topic', topicId) as Promise<boolean>,
    deleteDialogue: (id: number) =>
      invoke('plugin:harness:harness-dialogue-delete', id) as Promise<boolean>,

    // 对话真实用量（一条助手回复一行）
    getUsageByTopic: (topicId: number) =>
      invoke('plugin:harness:harness-usage-get-by-topic', topicId) as Promise<
        HarnessDialogueUsageRow[]
      >,

    // 工具结果按需读取：内置工具（read_file/execute 等）的结果不再随流下发，
    // 聊天卡片点开时才取（ls/glob/grep/execute 的详情按 topicId+callId 取回）
    getToolOutput: (topicId: number, callId: string) =>
      invoke('plugin:harness:harness-tool-output-get', topicId, callId) as Promise<string | null>,

    // 按虚拟路径读取文本文件（卡片「打开文件」；工作区与记忆挂载都可读）
    // 记忆挂载按**当前会话的作用域**解析（插件会话读的是这份插件自己的记忆目录）
    readVirtualFile: (virtualPath: string, memoryScope?: string | null) =>
      invoke('plugin:harness:harness-vfs-read', virtualPath, memoryScope ?? null) as Promise<
        { content: string } | { error: string }
      >
  },

  /* ── 智能体配置（子智能体，挂在工作区下） ── */
  agents: {
    getAll: (workspaceId: number) =>
      invoke('plugin:harness:agent-get-all', workspaceId) as Promise<AgentConfigRow[]>,
    getPaginated: (workspaceId: number, page: number, pageSize: number) =>
      invoke('plugin:harness:agent-get-paginated', workspaceId, page, pageSize) as Promise<
        AgentPaginatedResult<AgentConfigRow>
      >,
    getById: (workspaceId: number, id: number) =>
      invoke('plugin:harness:agent-get-by-id', workspaceId, id) as Promise<AgentConfigRow | null>,
    create: (input: AgentConfigInput) =>
      invoke('plugin:harness:agent-create', input) as Promise<number>,
    update: (workspaceId: number, id: number, updates: Partial<AgentConfigInput>) =>
      invoke('plugin:harness:agent-update', workspaceId, id, updates) as Promise<boolean>,
    delete: (workspaceId: number, id: number) =>
      invoke('plugin:harness:agent-delete', workspaceId, id) as Promise<boolean>
  },

  /* ── 主智能体配置（默认工具与技能） ── */
  mainAgent: {
    get: () =>
      invoke('plugin:harness:main-agent-get') as Promise<{
        tools: string[]
        skills: string[]
        mcpTools?: string[]
      }>,
    update: (config: { tools: string[]; skills: string[] }) =>
      invoke('plugin:harness:main-agent-update', config) as Promise<boolean>
  },

  /* ── MCP 服务器（设置 → MCP 页） ── */
  mcp: {
    /** 服务器清单 + 实时状态（打开设置页会重连一次，拿的是当前真实状态） */
    list: () => invoke('plugin:harness:mcp-servers-list') as Promise<McpServerView[]>,
    save: (input: McpServerInput) =>
      invoke('plugin:harness:mcp-server-save', input) as Promise<McpServerConfig>,
    remove: (id: string) => invoke('plugin:harness:mcp-server-remove', id) as Promise<boolean>,
    toggle: (id: string, enabled: boolean) =>
      invoke('plugin:harness:mcp-server-toggle', id, enabled) as Promise<boolean>,
    /** 手动重连全部服务器（外部进程被系统杀掉 / 网络恢复后点一下即可） */
    reconnect: () => invoke('plugin:harness:mcp-server-reconnect') as Promise<boolean>,
    /** 试连**尚未保存**的配置：连上返回工具清单，连不上返回原始错误（不抛错） */
    test: (input: McpServerInput) =>
      invoke('plugin:harness:mcp-server-test', input) as Promise<{
        ok: boolean
        tools?: McpToolInfo[]
        error?: string
      }>,
    /** 导入 mcp.json 形态的配置 */
    importServers: (raw: unknown) =>
      invoke('plugin:harness:mcp-servers-import', raw) as Promise<{
        imported: string[]
        failed: { name: string; reason: string }[]
      }>,
    /** 导入：弹出文件选择框读取 mcp.json（主进程读文件，渲染层不碰 fs） */
    pickImportFile: () =>
      invoke('plugin:harness:mcp-servers-import-file') as Promise<{
        imported: string[]
        failed: { name: string; reason: string }[]
      } | null>,
    /** 勾选/取消一台服务器带来的全部工具（写入 mainAgent.mcpTools） */
    setToolsEnabled: (toolNames: string[]) =>
      invoke('plugin:harness:mcp-tools-set', toolNames) as Promise<boolean>,
    /** 目录变化（连上/断开/增删工具）：MCP 页与智能体页的工具下拉都据此刷新 */
    onCatalogUpdated: (callback: () => void): (() => void) =>
      on('plugin:harness:harness-mcp-updated', () => callback())
  },

  /* ── 工作区文件与改动审查（AI 改动复核 + 文件浏览器） ── */
  workspace: {
    listDir: (dirPath: string) =>
      invoke('plugin:harness:workspace-list-dir', dirPath) as Promise<
        { name: string; isDirectory: boolean; path: string }[]
      >,
    readFile: (filePath: string) =>
      invoke('plugin:harness:workspace-read-file', filePath) as Promise<string>,
    saveFile: (filePath: string, content: string) =>
      invoke('plugin:harness:workspace-save-file', filePath, content) as Promise<boolean>,

    // --- 文件改动史（可追溯 / 可回溯） ---
    /** 当前工作区待审查的改动 */
    pendingChanges: () =>
      invoke('plugin:harness:workspace-changes-pending') as Promise<FileChangeView[]>,
    /** 单个文件的改动历史（倒序） */
    fileChanges: (filePath: string) =>
      invoke('plugin:harness:workspace-changes-file', filePath) as Promise<FileChangeView[]>,
    /** 某次改动的前后正文 */
    changeContent: (id: number) =>
      invoke('plugin:harness:workspace-change-content', id) as Promise<FileChangeContent | null>,
    /** 审查：保留（清除待审查标记） */
    keepChanges: (ids: number[]) =>
      invoke('plugin:harness:workspace-change-keep', ids) as Promise<number>,
    /** 审查：撤销到某次改动之前 */
    revertChange: (id: number) =>
      invoke('plugin:harness:workspace-change-revert', id) as Promise<
        { path: string; content: string | null } | { error: string }
      >,
    /** 审查：把差异视图里取舍后的内容落盘并标记已保留 */
    applyReview: (filePath: string, content: string) =>
      invoke('plugin:harness:workspace-apply-review', filePath, content) as Promise<
        { ok: true } | { error: string }
      >,
    /** 磁盘变化（模型写入 / 命令执行 / 外部编辑器）：刷新资源管理器与已打开页签 */
    onFsChanged: (callback: (data: { changes: WorkspaceFsChange[] }) => void): (() => void) =>
      on('plugin:harness:workspace-fs-changed', (data) =>
        callback(data as { changes: WorkspaceFsChange[] })
      ),
    /** 新增一条改动记录（模型改动了某个文件） */
    onChangeRecorded: (callback: (change: FileChangeView) => void): (() => void) =>
      on('plugin:harness:workspace-change-recorded', (change) =>
        callback(change as FileChangeView)
      ),
    /** 改动审查状态变化（保留 / 撤销） */
    onChangesUpdated: (
      callback: (data: { ids: number[]; status: string; path?: string; obsolete?: number }) => void
    ): (() => void) =>
      on('plugin:harness:workspace-changes-updated', (data) =>
        callback(data as { ids: number[]; status: string; path?: string; obsolete?: number })
      )
  },

  /* ── 插件工坊（对话式做插件 + 自动验收，设置 → 插件工坊） ── */
  workshop: {
    /** 工坊是否可用（AI 助手被停用时为 false）+ 根目录 + 草稿数 */
    state: () =>
      invoke('plugin:harness:workshop-state') as Promise<{
        ready: boolean
        /** 是否已配置插件存放路径（用户设置，没有默认值） */
        configured: boolean
        /** 用户配置的插件存放路径（未配置时为空串） */
        pluginsPath: string
        drafts: number
        /**
         * 插件工作区清单（插件 id → 它的工作区行）：插件会话的工作目录 = 插件源码目录，
         * 侧栏靠它把插件行和它自己的会话对上，并把插件工作区从「工作」列表里滤掉。
         */
        pluginWorkspaces: { draftId: string; workspaceId: number; path: string }[]
      }>,
    list: () => invoke('plugin:harness:workshop-list') as Promise<WorkshopDraftSummary[]>,
    detail: (id: string) =>
      invoke('plugin:harness:workshop-detail', id) as Promise<WorkshopDraftDetail>,
    readFile: (id: string, relPath: string) =>
      invoke('plugin:harness:workshop-read-file', id, relPath) as Promise<string>,
    report: (id: string) =>
      invoke('plugin:harness:workshop-report', id) as Promise<WorkshopReport | null>,
    create: (input: { id: string; title?: string; template?: string; description?: string }) =>
      invoke('plugin:harness:workshop-create', input) as Promise<
        WorkshopActionResult<{ id: string; files: string[]; dir: string }>
      >,
    build: (id: string, dev?: boolean) =>
      invoke('plugin:harness:workshop-build', id, dev) as Promise<
        WorkshopActionResult<WorkshopBuildInfo>
      >,
    verify: (id: string, probe?: boolean) =>
      invoke('plugin:harness:workshop-verify', id, probe) as Promise<
        WorkshopActionResult<WorkshopReport>
      >,
    publish: (id: string) =>
      invoke('plugin:harness:workshop-publish', id) as Promise<
        WorkshopActionResult<WorkshopPublishResult>
      >,
    disable: (id: string) =>
      invoke('plugin:harness:workshop-disable', id) as Promise<WorkshopActionResult<boolean>>,
    unpublish: (id: string) =>
      invoke('plugin:harness:workshop-unpublish', id) as Promise<WorkshopActionResult<boolean>>,
    remove: (id: string) =>
      invoke('plugin:harness:workshop-remove', id) as Promise<WorkshopActionResult<boolean>>,
    /** 重命名插件：改展示名（草稿 title + 清单 name），目录名/id 不动 */
    rename: (id: string, title: string) =>
      invoke('plugin:harness:workshop-rename', id, title) as Promise<
        WorkshopActionResult<WorkshopDraftSummary>
      >,
    /**
     * 取（必要时创建）某份插件的**插件工作区**：插件会话的工作目录就是它的源码目录
     * （`<插件存放路径>/<插件 id>/`）。侧栏「插件行 ＋」先调它，再像切普通工作区一样切过去。
     */
    ensureWorkspace: (id: string) =>
      invoke('plugin:harness:workshop-ensure-workspace', id) as Promise<
        WorkshopActionResult<{ id: number; name: string; path: string }>
      >,
    exportZip: (id: string) =>
      invoke('plugin:harness:workshop-export', id) as Promise<
        WorkshopActionResult<{ file: string; bytes: number; files: string[] }>
      >,
    openDir: (id: string) =>
      invoke('plugin:harness:workshop-open-dir', id) as Promise<WorkshopActionResult<string>>,
    /**
     * 弹系统选择框配置**插件存放路径**（所有插件的源码根目录，没有默认值）。
     * 用户取消时返回 `{ canceled: true }`（取消不是失败）。
     */
    pickRoot: () =>
      invoke('plugin:harness:workshop-pick-root') as Promise<
        WorkshopActionResult<{ canceled: boolean; dir?: string; moved?: string[] }>
      >,
    /** 按显式路径配置插件存放路径（工装用；空串 = 清除配置） */
    setRoot: (dir: string) =>
      invoke('plugin:harness:workshop-set-root', dir) as Promise<
        WorkshopActionResult<{ dir: string; moved: string[] }>
      >,
    /** 草稿/产物/安装态变化（助手在对话里改了草稿时，开着的面板要跟着变） */
    onChanged: (callback: () => void): (() => void) =>
      on('plugin:harness:workshop-changed', () => callback()),
    /**
     * 渲染层实时探针请求（主进程发的；助手界面收到后 import 一遍插件产物并回话）。
     * 订阅本身由 Provider 常驻持有，用户在不在工坊页都能应答。
     */
    onProbe: (
      callback: (payload: { probeId: string; id: string; entry: string }) => void
    ): (() => void) =>
      on('plugin:harness:workshop-probe', (data) =>
        callback(data as { probeId: string; id: string; entry: string })
      ),
    /** 回话（主进程按 probeId 兑付；已超时的结果会被丢弃） */
    reportProbe: (payload: {
      probeId: string
      status: 'pass' | 'fail' | 'skip'
      detail?: string
      registrations?: string[]
      durationMs?: number
    }) => invoke('plugin:harness:workshop-probe-result', payload) as Promise<boolean>
  }
}

export default harnessApi
