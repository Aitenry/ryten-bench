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
  JobOutputView,
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
  PlanModeView,
  QueuedMessageView,
  StartMemoryAgentResult,
  SubagentConversationEvent,
  SubagentConversationSnapshot,
  SubagentConversationHistory,
  SubagentPromptResult,
  SubagentSessionRow,
  TeamBoardSnapshot,
  TeamModeView,
  TeamTaskEventView,
  TodoItem,
  TurnFinal,
  TurnUsageView,
  WorkspaceFsChange,
  WorkspaceRow
} from '../../../shared/harness/types'
import type { HarnessToolInfo } from '../types/harness/types'
import type {
  WorkshopActionResult,
  WorkshopBuildInfo,
  WorkshopDraftDetail,
  WorkshopDraftSummary,
  WorkshopPublishResult,
  WorkshopReport
} from '../../../shared/harness/workshop'

/** 档位状态视图（主进程为准：当前话题档位 + 新会话默认档位） */
export interface PermissionStateView {
  topicId: number
  mode: PermissionMode
  defaultMode: PermissionMode
}

/** 定时任务视图（设置 →「定时任务」页；字段与主进程 schedule-store 一致） */
export interface ScheduleView {
  id: string
  title: string
  prompt: string
  when:
    | { kind: 'once'; at: string }
    | { kind: 'every'; minutes: number }
    | { kind: 'daily'; time: string }
  enabled: boolean
  topicId: number
  createdAt: string
  updatedAt: string
  nextRunAt: string | null
  lastRunAt?: string
  lastStatus?: 'completed' | 'cancelled' | 'failed'
}

/** 规则（页面表单与 IPC 共用） */
export type ScheduleWhenView = ScheduleView['when']

/** 一条执行记录（永久保存） */
export interface ScheduleRunView {
  at: string
  status: 'completed' | 'cancelled' | 'failed'
  detail?: string | null
}

/** 新建/编辑结果：预期失败不抛错，`error` 是稳定代码（页面负责翻译） */
export type ScheduleMutationResult =
  | { ok: true; task: ScheduleView }
  | { ok: false; error: string }

/**
 * 目标动作的返回形状：界面入口（创建/编辑/暂停/恢复/完成/清除）统一走它。
 *
 * 与工坊动作同一套约定：预期失败不抛错，`error` 里放可直接展示的文案；
 * `goal-objective-required` / `goal-missing` 这类稳定代码由渲染层翻成本语言，
 * 其余（状态机拒绝）直接显示主进程返回的本地化文本。
 */
export interface GoalActionResult {
  ok: boolean
  goal?: GoalView
  error?: string
}

/**
 * 「对话」模式动作的返回形状：与工坊同一套约定（失败不抛错，渲染层把 `error` 原文显示出来）。
 * 直接复用 `WorkshopActionResult`，免得同一件事有两个类型。
 */
export type ChatActionResult<T = unknown> = WorkshopActionResult<T>

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
 * （`window.api.system.invoke/on`，通道名 `harness:*`）。
 *
 * 事件订阅同样走通用桥：通道必须由插件主进程 `ctx.registerEvent` 声明才进 preload
 * 白名单；插件停用时订阅调用**不再抛错**（preload 只告警），但没有发送方 ⇒ 事件不会来——
 * 调用方仍要按「可能永远收不到事件」写（历史教训：异常从 useEffect 逃逸会卸载整棵渲染树，白屏）。
 *
 * 契约见 src/main/plugins/context.ts；类型取自 shared/types.ts（跨进程 DTO，运行期零依赖）。
 */
const invoke = window.api.system.invoke

/** 主进程 → 渲染层事件通道的订阅（通用桥 + 白名单门控） */
const on = (channel: string, callback: (data: unknown) => void): (() => void) =>
  window.api.system.on(channel, callback)

/** 本轮流式结束载荷（harness-stream-done） */
export interface StreamDoneResult {
  topicId: number
  /** 本轮回合 id（渲染端据此丢弃不属于当前回合的过期收尾事件） */
  turnId?: number
  userDialogueId?: number
  assistantDialogueId?: number
  /** 助手段落表（无插话时只有一段）：messageId 对应一段助手气泡 */
  segments?: { messageId: string; dialogueId?: number }[]
  /** 本轮终局标记（最终答复边界 + 目标是否收口） */
  turnFinal?: TurnFinal
}

/** 话题的回合状态（主进程为真源：渲染端不再自己推断「是不是在生成」） */
export interface TurnStateResult {
  active: boolean
  turnId: number | null
}

/** 发起一轮的结果：started=false & queued=true 表示主进程判定上一轮还在跑，这条已收进队列 */
export interface StartTurnResult {
  started: boolean
  queued?: boolean
}

type AskAnswerItem = AskAnswer['answers'][number]

export const harnessApi = {
  /* ── 助手主体（话题对话 / 流式 / 队列 / 目标 / 后台任务 / 子代理 / 提问 / VFS） ── */
  harness: {
    sendMessage: (message: string, options?: { providerId?: number }) =>
      invoke('harness:harness-send-message', message, options),
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
      return invoke('harness:harness-start-stream', message, options) as Promise<
        StartTurnResult | undefined
      >
    },
    /** 话题当前有没有回合在跑（主进程真源；渲染端发送前先问一句，避免两个回合并发） */
    getTurnState: (topicId: number) =>
      invoke('harness:harness-turn-state', topicId) as Promise<TurnStateResult>,

    // ── 生成中的插话队列 ──────────────────────────────────────────────
    /** 生成中发消息：主进程裁决——有回合在跑则入队（queued=true），否则直接开新一轮 */
    enqueueMessage: (payload: {
      topicId: number
      text: string
      attachments?: {
        images?: string[]
        documents?: { fileName: string; filePath: string }[]
      }
    }) => invoke('harness:harness-queue-enqueue', payload) as Promise<{ queued: boolean }>,
    listQueuedMessages: (topicId: number) =>
      invoke('harness:harness-queue-list', topicId) as Promise<QueuedMessageView[]>,
    removeQueuedMessage: (topicId: number, itemId: string) =>
      invoke('harness:harness-queue-remove', { topicId, itemId }) as Promise<boolean>,
    updateQueuedMessage: (topicId: number, itemId: string, text: string) =>
      invoke('harness:harness-queue-update', { topicId, itemId, text }) as Promise<boolean>,
    /** 立即插话：把这条排队消息注入正在运行的回合（下一个工具节点边界生效） */
    steerQueuedMessage: (topicId: number, itemId: string) =>
      invoke('harness:harness-queue-steer', { topicId, itemId }) as Promise<{
        accepted: boolean
      }>,
    onQueueUpdated: (
      callback: (data: { topicId: number; queue: QueuedMessageView[] }) => void
    ): (() => void) =>
      on('harness:harness-queue-updated', (data) =>
        callback(data as { topicId: number; queue: QueuedMessageView[] })
      ),
    onQueueSteered: (
      callback: (data: { topicId: number; itemId: string; text: string }) => void
    ): (() => void) =>
      on('harness:harness-queue-steered', (data) =>
        callback(data as { topicId: number; itemId: string; text: string })
      ),

    getTools: () => invoke('harness:harness-get-tools') as Promise<HarnessToolInfo[]>,

    onStreamChunk: (callback: (chunk: Record<string, unknown>) => void): (() => void) =>
      on('harness:harness-stream-chunk', (chunk) => callback(chunk as Record<string, unknown>)),
    onStreamDone: (callback: (result: StreamDoneResult) => void): (() => void) =>
      on('harness:harness-stream-done', (result) => callback(result as StreamDoneResult)),
    onStreamError: (
      callback: (error: { error: string; topicId?: number; turnId?: number }) => void
    ): (() => void) =>
      on('harness:harness-stream-error', (error) =>
        callback(error as { error: string; topicId?: number; turnId?: number })
      ),

    /**
     * 文档被聊天工具修改/删除（notes 插件的编辑器据此同步或提示，防覆盖工具写入）。
     * 渲染层不再有人直接订阅它——harness 的 renderer install 把它桥接成宿主事件总线的
     * 语义事件 `doc:changed`（见 renderer/plugin.tsx），消费方是 notes 的文档编辑器。
     */
    onDocChanged: (
      callback: (data: { docId: number; action: 'updated' | 'deleted' }) => void
    ): (() => void) =>
      on('harness:harness-doc-changed', (data) =>
        callback(data as { docId: number; action: 'updated' | 'deleted' })
      ),

    getHarnessTodos: (topicId: number) =>
      invoke('harness:harness-todos-get', topicId) as Promise<TodoItem[]>,
    onHarnessTodosUpdated: (
      callback: (data: { topicId: number; todos: TodoItem[] }) => void
    ): (() => void) =>
      on('harness:harness-todos-updated', (data) =>
        callback(data as { topicId: number; todos: TodoItem[] })
      ),

    // 目标系统（goal）
    getGoal: (topicId: number) =>
      invoke('harness:harness-goal-get', topicId) as Promise<GoalView | null>,
    onGoalUpdated: (
      callback: (data: { topicId: number; goal: GoalView | null }) => void
    ): (() => void) =>
      on('harness:harness-goal-updated', (data) =>
        callback(data as { topicId: number; goal: GoalView | null })
      ),
    /** 创建目标（界面入口：人类直接请求，成功即武装自动续跑） */
    createGoal: (payload: { topicId: number; objective: string; maxGoalRounds?: number }) =>
      invoke('harness:harness-goal-create', payload) as Promise<GoalActionResult>,
    /** 更新目标：编辑目标文本 / 暂停 / 恢复 / 标记完成 */
    updateGoal: (payload: {
      topicId: number
      action: 'edit' | 'pause' | 'resume' | 'complete'
      objective?: string
      maxGoalRounds?: number
    }) => invoke('harness:harness-goal-update', payload) as Promise<GoalActionResult>,
    /** 清除目标（删除该话题的目标行；自动续跑随之解除） */
    clearGoal: (topicId: number) =>
      invoke('harness:harness-goal-clear', topicId) as Promise<GoalActionResult>,

    // 计划模式（plan mode）：按话题持久化的「先规划、批准后执行」开关
    getPlanMode: (topicId: number) =>
      invoke('harness:harness-plan-get', topicId) as Promise<PlanModeView>,
    setPlanMode: (payload: { topicId: number; active: boolean }) =>
      invoke('harness:harness-plan-set', payload) as Promise<PlanModeView>,
    onPlanModeUpdated: (callback: (data: PlanModeView) => void): (() => void) =>
      on('harness:harness-plan-updated', (data) => callback(data as PlanModeView)),

    // Agent Teams 模式（opt-in，按话题）：关闭时不注入 team_task_* 工具与团队提示词
    getTeamMode: (topicId: number) =>
      invoke('harness:harness-team-mode-get', topicId) as Promise<TeamModeView>,
    setTeamMode: (payload: { topicId: number; enabled: boolean }) =>
      invoke('harness:harness-team-mode-set', payload) as Promise<TeamModeView>,
    onTeamModeUpdated: (callback: (data: TeamModeView) => void): (() => void) =>
      on('harness:harness-team-mode-updated', (data) => callback(data as TeamModeView)),

    // 定时任务（设置 →「定时任务」页）：列表 + 暂停/恢复/删除
    listSchedules: () => invoke('harness:harness-schedule-list') as Promise<ScheduleView[]>,
    updateSchedule: (payload: { id: string; action: 'pause' | 'resume' | 'delete' }) =>
      invoke('harness:harness-schedule-update', payload) as Promise<{ ok: boolean }>,
    // 侧边栏「定时任务」页：新建 / 完整编辑 / 执行记录
    createSchedule: (payload: {
      topicId: number
      title: string
      prompt: string
      when: ScheduleWhenView
    }) => invoke('harness:harness-schedule-create', payload) as Promise<ScheduleMutationResult>,
    updateScheduleFull: (payload: {
      id: string
      title?: string
      prompt?: string
      when?: ScheduleWhenView
      enabled?: boolean
    }) => invoke('harness:harness-schedule-update-full', payload) as Promise<ScheduleMutationResult>,
    getScheduleRuns: (id: string, limit?: number, offset?: number) =>
      invoke('harness:harness-schedule-runs', { id, limit, offset }) as Promise<{
        runs: ScheduleRunView[]
        total: number
      }>,

    // 后台任务系统（jobs）
    onJobsUpdated: (
      callback: (data: { topicId: number; jobs: JobSnapshot[] }) => void
    ): (() => void) =>
      on('harness:harness-jobs-updated', (data) =>
        callback(data as { topicId: number; jobs: JobSnapshot[] })
      ),
    /** 当前话题的后台任务列表（顶部栏首次打开/切话题时拉一次） */
    listJobs: (topicId: number) =>
      invoke('harness:harness-jobs-list', topicId) as Promise<JobSnapshot[]>,
    /** 手动停止一个后台任务（取消请求；任务以 killed 终态收尾） */
    killJob: (topicId: number, jobId: string) =>
      invoke('harness:harness-job-kill', topicId, jobId) as Promise<{
        outcome: 'cancellation-requested' | 'already-finished' | 'not-found'
        job: JobSnapshot | null
      }>,
    /** 查看任务输出快照（尾部截断；不消费模型的 job_output 游标） */
    peekJobOutput: (topicId: number, jobId: string) =>
      invoke('harness:harness-job-output-peek', topicId, jobId) as Promise<JobOutputView>,

    // 后台子代理会话（顶部栏列表：进行中 > 已完成，点开查看结果）
    listAgents: (topicId: number) =>
      invoke('harness:harness-agents-list', topicId) as Promise<SubagentSessionRow[]>,
    /**
     * 存入记忆：起一个后台「记忆整理」子代理，由它自己总结后写入 Mnemon，立即返回。
     * 进度与结果走顶部栏后台代理入口（onAgentsUpdated），不等它跑完。
     */
    startMemoryAgent: (payload: {
      topicId: number
      answer: string
      dialogueId?: number
      providerId?: number
    }) => invoke('harness:harness-memory-agent-start', payload) as Promise<StartMemoryAgentResult>,
    onAgentsUpdated: (
      callback: (data: { topicId: number; rows: SubagentSessionRow[] }) => void
    ): (() => void) =>
      on('harness:harness-agents-updated', (data) =>
        callback(data as { topicId: number; rows: SubagentSessionRow[] })
      ),

    // 后台子代理会话视图：点开一个子代理 → 主对话区切到它的流式会话记录
    /** 会话快照（事件流 + seq；不登记关注，用于断点重拉） */
    agentConversation: (topicId: number, agentId: string) =>
      invoke(
        'harness:harness-agent-conversation',
        topicId,
        agentId
      ) as Promise<SubagentConversationSnapshot | null>,
    /** 向前翻页：取 beforeSeq 之前最近一页完整轮次（会话视图滚动到顶部时调用） */
    agentConversationOlder: (topicId: number, agentId: string, beforeSeq: number, maxTurns = 20) =>
      invoke(
        'harness:harness-agent-conversation-older',
        topicId,
        agentId,
        beforeSeq,
        maxTurns
      ) as Promise<SubagentConversationHistory | null>,
    /**
     * 打开/关闭会话视图。watch=true 时主进程登记关注并直接返回**当前快照**；
     * 此后增量事件走 onAgentConversationUpdated（按 seq 合并）。
     */
    watchAgentConversation: (topicId: number, agentId: string, watch: boolean) =>
      invoke(
        'harness:harness-agent-conversation-watch',
        topicId,
        agentId,
        watch
      ) as Promise<SubagentConversationSnapshot | null>,
    onAgentConversationUpdated: (
      callback: (data: {
        topicId: number
        agentId: string
        events: SubagentConversationEvent[]
      }) => void
    ): (() => void) =>
      on('harness:harness-agent-conversation-updated', (data) =>
        callback(data as { topicId: number; agentId: string; events: SubagentConversationEvent[] })
      ),
    /** 人工续聊：向子代理投递一条消息（空闲开新一轮，运行中排队；返回投递回执） */
    sendAgentPrompt: (topicId: number, agentId: string, message: string) =>
      invoke('harness:harness-agent-prompt', {
        topicId,
        agentId,
        message
      }) as Promise<SubagentPromptResult>,
    /** 停止子代理当前这一轮（已排队消息保留） */
    interruptAgent: (topicId: number, agentId: string) =>
      invoke('harness:harness-agent-interrupt', topicId, agentId) as Promise<{
        accepted: boolean
      }>,

    // Agent Teams / 超级智能体：共享任务板（主智能体 + 子代理协作的 team/task 投影）
    /** 当前话题的共享任务板快照（打开顶部栏任务入口时拉一次） */
    listTeamTasks: (topicId: number) =>
      invoke('harness:harness-team-tasks', topicId) as Promise<TeamBoardSnapshot>,
    /** 任务板整板变更推送（主进程每次变更推完整快照，带 revision 去旧） */
    onTeamUpdated: (callback: (snapshot: TeamBoardSnapshot) => void): (() => void) =>
      on('harness:harness-team-updated', (data) => callback(data as TeamBoardSnapshot)),
    listTeamEvents: (topicId: number, limit = 20) =>
      invoke('harness:harness-team-events', topicId, limit) as Promise<TeamTaskEventView[]>,

    // 向用户提问（ask_user_question）
    onQuestionAsked: (callback: (pending: PendingQuestionView) => void): (() => void) =>
      on('harness:harness-question-asked', (pending) => callback(pending as PendingQuestionView)),
    answerQuestion: (requestId: string, answers: AskAnswerItem[]) =>
      invoke('harness:harness-question-answer', requestId, answers) as Promise<boolean>,
    getQuestion: (topicId: number) =>
      invoke('harness:harness-question-get', topicId) as Promise<PendingQuestionView | null>,
    /**
     * 某条会话「还要不要用户确认」的翻转广播（提问 / 审批挂起时 pending=true，
     * 回答 / 允许 / 拒绝 / 中止时 false）。侧栏行首的黄色呼吸点据此切换，
     * 不按当前话题过滤：别的会话挂起时，那一条也要亮起来。
     */
    onTopicPending: (
      callback: (data: { topicId: number; pending: boolean }) => void
    ): (() => void) =>
      on('harness:harness-topic-pending', (data) =>
        callback(data as { topicId: number; pending: boolean })
      ),

    /* ── 沙箱权限（档位选择器 + 危险操作审批弹窗） ── */
    /** 当前档位与新会话默认值（切话题时拉一次） */
    getPermission: (topicId?: number | null) =>
      invoke(
        'harness:harness-permission-get',
        topicId ?? undefined
      ) as Promise<PermissionStateView>,
    /** 切档位：scope='default' 改新会话默认值，否则改该话题 */
    setPermission: (payload: {
      topicId?: number | null
      mode: PermissionMode
      scope?: 'topic' | 'default'
    }) =>
      invoke('harness:harness-permission-set', {
        topicId: payload.topicId ?? undefined,
        mode: payload.mode,
        scope: payload.scope
      }) as Promise<PermissionStateView>,
    onPermissionUpdated: (callback: (state: PermissionStateView) => void): (() => void) =>
      on('harness:harness-permission-updated', (state) => callback(state as PermissionStateView)),
    /** 沙箱后端状态：拿不到后端时命令会被拒绝执行（设置页要把这件事说出来） */
    sandboxStatus: () => invoke('harness:harness-sandbox-status') as Promise<SandboxStatusView>,
    /** 撤销工作区上的常驻 ACE（仅 Windows 后端有意义；卸载/清理入口） */
    cleanupSandbox: (workspacePath: string) =>
      invoke('harness:harness-sandbox-cleanup', workspacePath) as Promise<boolean>,
    /** 沙箱拦下一次危险 / 越界操作 → 弹窗等用户决定 */
    onApprovalAsked: (callback: (pending: ApprovalRequestView) => void): (() => void) =>
      on('harness:harness-approval-asked', (pending) => callback(pending as ApprovalRequestView)),
    /** 裁决：allow-once（只放行这一次）/ deny */
    decideApproval: (requestId: string, decision: ApprovalDecision) =>
      invoke('harness:harness-approval-decide', requestId, decision) as Promise<boolean>,
    getApproval: (topicId: number) =>
      invoke('harness:harness-approval-get', topicId) as Promise<ApprovalRequestView | null>,

    cancelStream: () => {
      void invoke('harness:harness-cancel-stream')
    },
    selectSkillsDirectory: () =>
      invoke('harness:harness-select-skills-directory') as Promise<string | null>,
    selectWorkspace: () => invoke('harness:harness-select-workspace') as Promise<string | null>,
    listSkills: () =>
      invoke('harness:harness-list-skills') as Promise<
        { id: string; name: string; description: string }[]
      >,
    /** 技能列表分页（主进程扫描 + 解析，渲染层只拿当前页） */
    listSkillsPaginated: (page: number, pageSize: number) =>
      invoke('harness:harness-list-skills-paginated', page, pageSize) as Promise<{
        items: { id: string; name: string; description: string }[]
        total: number
      }>,
    /** 技能启用/停用（完整目录判定在主进程） */
    setSkillEnabled: (skillId: string, enabled: boolean) =>
      invoke('harness:harness-set-skill-enabled', skillId, enabled) as Promise<
        string[] | undefined
      >,

    // 记忆管理（Mnemon 三层记忆）
    // 末尾的 memoryScope 决定读**哪一套**记忆：`plugin:<插件 id>` = 这份插件自己的；
    // 空 / 不传 = 当前工作区（见 renderer/memory-scope.ts）
    selectMemoryDirectory: () =>
      invoke('harness:harness-select-memory-directory') as Promise<string | null>,
    mnemonSnapshot: (memoryScope?: string | null) =>
      invoke('harness:mnemon-snapshot', memoryScope ?? null) as Promise<MnemonSnapshot>,
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
      invoke('harness:mnemon-runtime-mutate', request, memoryScope ?? null) as Promise<{
        success: boolean
        message: string
      }>,
    mnemonBodies: (memoryScope?: string | null) =>
      invoke('harness:mnemon-bodies', memoryScope ?? null) as Promise<MnemonBodiesView>,
    mnemonBodyCreate: (name: string, description: string, memoryScope?: string | null) =>
      invoke('harness:mnemon-body-create', { name, description }, memoryScope ?? null) as Promise<{
        success: boolean
        body?: MnemonBodyRef
        message?: string
      }>,
    mnemonBodyUpdate: (
      id: string,
      request: { name?: string; description?: string; active?: boolean },
      memoryScope?: string | null
    ) =>
      invoke('harness:mnemon-body-update', id, request, memoryScope ?? null) as Promise<{
        success: boolean
        body?: MnemonBodyRef
        message?: string
      }>,
    mnemonBodyList: (memoryBodyIds?: string[], memoryScope?: string | null) =>
      invoke('harness:mnemon-body-list', memoryBodyIds, memoryScope ?? null) as Promise<
        MnemonBodyInsight[]
      >,
    mnemonDocumentSnapshot: (memoryScope?: string | null) =>
      invoke('harness:mnemon-document-snapshot', memoryScope ?? null) as Promise<
        MnemonSnapshot['documents'] | null
      >,

    // 工作区管理
    getAllWorkspaces: () => invoke('harness:workspace-get-all') as Promise<WorkspaceRow[]>,
    createWorkspace: (name: string, path: string) =>
      invoke('harness:workspace-create', name, path) as Promise<number>,
    updateWorkspace: (id: number, updates: { name: string }) =>
      invoke('harness:workspace-update', id, updates) as Promise<boolean>,
    /**
     * 「在文件夹中显示」：在系统文件管理器里打开这个工作区的目录。
     * 只传 id（目录由主进程按行解析）；目录已被删除/移走时返回可读原因，不抛错。
     */
    openWorkspaceDir: (id: number) =>
      invoke('harness:workspace-open-dir', id) as Promise<WorkshopActionResult<string>>,
    deleteWorkspace: (id: number) => invoke('harness:workspace-delete', id) as Promise<boolean>,

    /**
     * 「对话」模式：它没有工作区概念，但模型需要一个可写的根目录（见 main/chat/workspace.ts）。
     * `ensureWorkspace` = 进入这个模式（或在该模式里新建会话）；`activateTopic` = 打开某条会话
     * （活动目录切到 `chat/<话题 id>/`）；`removeTopicDir` = 删话题后清理那条会话的目录。
     */
    ensureChatWorkspace: () =>
      invoke('harness:chat-ensure-workspace') as Promise<
        ChatActionResult<{ workspaceId: number; dir: string }>
      >,
    activateChatTopic: (topicId: number) =>
      invoke('harness:chat-activate-topic', topicId) as Promise<
        ChatActionResult<{ workspaceId: number; dir: string }>
      >,
    chatWorkspaces: () =>
      invoke('harness:chat-workspaces') as Promise<
        ChatActionResult<{ ids: number[]; rootWorkspaceId: number | null }>
      >,
    removeChatTopicDir: (topicId: number) =>
      invoke('harness:chat-remove-topic-dir', topicId) as Promise<ChatActionResult<boolean>>,

    // 话题管理
    getAllTopics: (workspaceId: number) =>
      invoke('harness:harness-topic-get-all', workspaceId) as Promise<HarnessTopicRow[]>,
    /** 所有工作区里已归档的会话（侧栏底部「已归档」分组用，按归档时间倒序） */
    getArchivedTopics: () =>
      invoke('harness:harness-topic-get-archived') as Promise<HarnessTopicRow[]>,
    getAllTopicsPaginated: (workspaceId: number, page: number, pageSize: number) =>
      invoke('harness:harness-topic-get-paginated', workspaceId, page, pageSize) as Promise<
        PaginatedResult<HarnessTopicRow>
      >,
    getTopicById: (id: number) =>
      invoke('harness:harness-topic-get-by-id', id) as Promise<HarnessTopicRow[]>,
    createTopic: (
      workspaceId: number,
      title: string,
      model?: string,
      selectedTools?: string,
      /** 记忆作用域：`plugin:<插件 id>` = 这份插件自己的记忆；空 = 跟工作区走 */
      memoryScope?: string | null
    ) =>
      invoke(
        'harness:harness-topic-create',
        workspaceId,
        title,
        model,
        selectedTools,
        memoryScope
      ) as Promise<number>,
    updateTopic: (
      id: number,
      updates: Partial<Pick<HarnessTopicRow, 'title' | 'model' | 'selected_tools'>>
    ) => invoke('harness:harness-topic-update', id, updates) as Promise<boolean>,
    /** 置顶 / 取消置顶（只改 pinned_at：不刷新活跃时间，取消后回到原来的位置） */
    setTopicPinned: (id: number, pinned: boolean) =>
      invoke('harness:harness-topic-set-pinned', id, pinned) as Promise<boolean>,
    /** 归档 / 取消归档（归档的会话从列表主区收进「已归档」分组，数据不删） */
    setTopicArchived: (id: number, archived: boolean) =>
      invoke('harness:harness-topic-set-archived', id, archived) as Promise<boolean>,
    /**
     * 分叉会话：把一条会话（话题 + 全部对话）复制成一条新的独立会话，返回新行。
     * 标题由调用方给（`原标题（分叉）`，跟着界面语言走）。
     */
    forkTopic: (id: number, title: string) =>
      invoke('harness:harness-topic-fork', id, title) as Promise<HarnessTopicRow | null>,
    deleteTopic: (id: number) => invoke('harness:harness-topic-delete', id) as Promise<boolean>,

    /** 「在应用中打开」的候选应用（文件资源管理器永远在内；其余按本机安装情况探测） */
    openInAppTargets: () =>
      invoke('harness:open-in-app-targets') as Promise<
        { id: string; label: string; icon?: string }[]
      >,
    /**
     * 用指定应用打开某个工作区的目录（会话 ⋯ → 在应用中打开）。
     * 只传工作区 id（目录由主进程解析）；目录被删/应用不在了都回可读原因，不抛错。
     */
    openWorkspaceInApp: (workspaceId: number, appId: string) =>
      invoke('harness:open-workspace-in-app', workspaceId, appId) as Promise<WorkshopActionResult>,

    // 消息管理
    getDialoguesByTopic: (topicId: number) =>
      invoke('harness:harness-dialogue-get-by-topic', topicId) as Promise<HarnessDialogueRow[]>,
    getDialoguesByTopicPaginated: (topicId: number, page: number, pageSize: number) =>
      invoke('harness:harness-dialogue-get-by-topic-paginated', topicId, page, pageSize) as Promise<
        PaginatedResult<HarnessDialogueRow>
      >,
    addDialogue: (dialogue: Omit<HarnessDialogueRow, 'id' | 'created_at'>) =>
      invoke('harness:harness-dialogue-add', dialogue) as Promise<number>,
    deleteDialoguesByTopic: (topicId: number) =>
      invoke('harness:harness-dialogue-delete-by-topic', topicId) as Promise<boolean>,
    deleteDialogue: (id: number) =>
      invoke('harness:harness-dialogue-delete', id) as Promise<boolean>,

    // 对话真实用量（一条助手回复一行）
    getUsageByTopic: (topicId: number) =>
      invoke('harness:harness-usage-get-by-topic', topicId) as Promise<HarnessDialogueUsageRow[]>,
    /** 生成中本轮累计用量：每次模型往返结束推一条（流结束后不再有事件，改读上面的落库数据） */
    onTurnUsage: (callback: (data: TurnUsageView) => void): (() => void) =>
      on('harness:harness-turn-usage', (data) => callback(data as TurnUsageView)),

    // 工具结果按需读取：内置工具（read_file/execute 等）的结果不再随流下发，
    // 聊天卡片点开时才取（ls/glob/grep/execute 的详情按 topicId+callId 取回）
    getToolOutput: (topicId: number, callId: string) =>
      invoke('harness:harness-tool-output-get', topicId, callId) as Promise<string | null>,

    // 按虚拟路径读取文本文件（卡片「打开文件」；工作区与记忆挂载都可读）
    // 记忆挂载按**当前会话的作用域**解析（插件会话读的是这份插件自己的记忆目录）
    readVirtualFile: (virtualPath: string, memoryScope?: string | null) =>
      invoke('harness:harness-vfs-read', virtualPath, memoryScope ?? null) as Promise<
        { content: string } | { error: string }
      >
  },

  /* ── 智能体配置（子智能体，挂在工作区下） ── */
  agents: {
    getAll: (workspaceId: number) =>
      invoke('harness:agent-get-all', workspaceId) as Promise<AgentConfigRow[]>,
    getPaginated: (workspaceId: number, page: number, pageSize: number) =>
      invoke('harness:agent-get-paginated', workspaceId, page, pageSize) as Promise<
        AgentPaginatedResult<AgentConfigRow>
      >,
    getById: (workspaceId: number, id: number) =>
      invoke('harness:agent-get-by-id', workspaceId, id) as Promise<AgentConfigRow | null>,
    create: (input: AgentConfigInput) => invoke('harness:agent-create', input) as Promise<number>,
    update: (
      workspaceId: number,
      id: number,
      updates: Partial<AgentConfigInput>,
      expectedRevision?: number
    ) =>
      invoke(
        'harness:agent-update',
        workspaceId,
        id,
        updates,
        expectedRevision
      ) as Promise<boolean>,
    delete: (workspaceId: number, id: number) =>
      invoke('harness:agent-delete', workspaceId, id) as Promise<boolean>
  },

  /* ── 主智能体配置（默认工具与技能） ── */
  mainAgent: {
    get: () =>
      invoke('harness:main-agent-get') as Promise<{
        tools: string[]
        skills: string[]
        mcpTools?: string[]
      }>,
    update: (config: { tools: string[]; skills: string[] }) =>
      invoke('harness:main-agent-update', config) as Promise<boolean>
  },

  /* ── MCP 服务器（设置 → MCP 页） ── */
  mcp: {
    /** 服务器清单 + 实时状态（打开设置页会重连一次，拿的是当前真实状态） */
    list: () => invoke('harness:mcp-servers-list') as Promise<McpServerView[]>,
    save: (input: McpServerInput) =>
      invoke('harness:mcp-server-save', input) as Promise<McpServerConfig>,
    remove: (id: string) => invoke('harness:mcp-server-remove', id) as Promise<boolean>,
    toggle: (id: string, enabled: boolean) =>
      invoke('harness:mcp-server-toggle', id, enabled) as Promise<boolean>,
    /** 手动重连全部服务器（外部进程被系统杀掉 / 网络恢复后点一下即可） */
    reconnect: () => invoke('harness:mcp-server-reconnect') as Promise<boolean>,
    /** 试连**尚未保存**的配置：连上返回工具清单，连不上返回原始错误（不抛错） */
    test: (input: McpServerInput) =>
      invoke('harness:mcp-server-test', input) as Promise<{
        ok: boolean
        tools?: McpToolInfo[]
        error?: string
      }>,
    /** 导入 mcp.json 形态的配置 */
    importServers: (raw: unknown) =>
      invoke('harness:mcp-servers-import', raw) as Promise<{
        imported: string[]
        failed: { name: string; reason: string }[]
      }>,
    /** 导入：弹出文件选择框读取 mcp.json（主进程读文件，渲染层不碰 fs） */
    pickImportFile: () =>
      invoke('harness:mcp-servers-import-file') as Promise<{
        imported: string[]
        failed: { name: string; reason: string }[]
      } | null>,
    /** 勾选/取消一台服务器带来的全部工具（写入 mainAgent.mcpTools） */
    setToolsEnabled: (toolNames: string[]) =>
      invoke('harness:mcp-tools-set', toolNames) as Promise<boolean>,
    /** 目录变化（连上/断开/增删工具）：MCP 页与智能体页的工具下拉都据此刷新 */
    onCatalogUpdated: (callback: () => void): (() => void) =>
      on('harness:harness-mcp-updated', () => callback())
  },

  /* ── 工作区文件与改动审查（AI 改动复核 + 文件浏览器） ── */
  workspace: {
    listDir: (dirPath: string) =>
      invoke('harness:workspace-list-dir', dirPath) as Promise<
        { name: string; isDirectory: boolean; path: string }[]
      >,
    readFile: (filePath: string) =>
      invoke('harness:workspace-read-file', filePath) as Promise<string>,
    saveFile: (filePath: string, content: string) =>
      invoke('harness:workspace-save-file', filePath, content) as Promise<boolean>,

    // --- 文件改动史（可追溯 / 可回溯） ---
    /** 当前工作区待审查的改动 */
    pendingChanges: () => invoke('harness:workspace-changes-pending') as Promise<FileChangeView[]>,
    /** 单个文件的改动历史（倒序） */
    fileChanges: (filePath: string) =>
      invoke('harness:workspace-changes-file', filePath) as Promise<FileChangeView[]>,
    /** 某次改动的前后正文 */
    changeContent: (id: number) =>
      invoke('harness:workspace-change-content', id) as Promise<FileChangeContent | null>,
    /** 审查：保留（清除待审查标记） */
    keepChanges: (ids: number[]) => invoke('harness:workspace-change-keep', ids) as Promise<number>,
    /** 审查：撤销到某次改动之前 */
    revertChange: (id: number) =>
      invoke('harness:workspace-change-revert', id) as Promise<
        { path: string; content: string | null } | { error: string }
      >,
    /** 审查：把差异视图里取舍后的内容落盘并标记已保留 */
    applyReview: (filePath: string, content: string) =>
      invoke('harness:workspace-apply-review', filePath, content) as Promise<
        { ok: true } | { error: string }
      >,
    /** 磁盘变化（模型写入 / 命令执行 / 外部编辑器）：刷新资源管理器与已打开页签 */
    onFsChanged: (callback: (data: { changes: WorkspaceFsChange[] }) => void): (() => void) =>
      on('harness:workspace-fs-changed', (data) =>
        callback(data as { changes: WorkspaceFsChange[] })
      ),
    /** 新增一条改动记录（模型改动了某个文件） */
    onChangeRecorded: (callback: (change: FileChangeView) => void): (() => void) =>
      on('harness:workspace-change-recorded', (change) => callback(change as FileChangeView)),
    /** 改动审查状态变化（保留 / 撤销） */
    onChangesUpdated: (
      callback: (data: { ids: number[]; status: string; path?: string; obsolete?: number }) => void
    ): (() => void) =>
      on('harness:workspace-changes-updated', (data) =>
        callback(data as { ids: number[]; status: string; path?: string; obsolete?: number })
      )
  },

  /* ── 插件工坊（对话式做插件 + 自动验收，设置 → 插件工坊） ── */
  workshop: {
    /** 工坊是否可用（AI 助手被停用时为 false）+ 根目录 + 草稿数 */
    state: () =>
      invoke('harness:workshop-state') as Promise<{
        ready: boolean
        /** 是否已配置插件存放路径（首次启动按安装目录预置；用户主动清空后为 false） */
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
    list: () => invoke('harness:workshop-list') as Promise<WorkshopDraftSummary[]>,
    detail: (id: string) => invoke('harness:workshop-detail', id) as Promise<WorkshopDraftDetail>,
    readFile: (id: string, relPath: string) =>
      invoke('harness:workshop-read-file', id, relPath) as Promise<string>,
    report: (id: string) => invoke('harness:workshop-report', id) as Promise<WorkshopReport | null>,
    create: (input: { id: string; title?: string; template?: string; description?: string }) =>
      invoke('harness:workshop-create', input) as Promise<
        WorkshopActionResult<{ id: string; files: string[]; dir: string }>
      >,
    build: (id: string, dev?: boolean) =>
      invoke('harness:workshop-build', id, dev) as Promise<WorkshopActionResult<WorkshopBuildInfo>>,
    verify: (id: string, probe?: boolean) =>
      invoke('harness:workshop-verify', id, probe) as Promise<WorkshopActionResult<WorkshopReport>>,
    publish: (id: string) =>
      invoke('harness:workshop-publish', id) as Promise<
        WorkshopActionResult<WorkshopPublishResult>
      >,
    disable: (id: string) =>
      invoke('harness:workshop-disable', id) as Promise<WorkshopActionResult<boolean>>,
    unpublish: (id: string) =>
      invoke('harness:workshop-unpublish', id) as Promise<WorkshopActionResult<boolean>>,
    remove: (id: string) =>
      invoke('harness:workshop-remove', id) as Promise<WorkshopActionResult<boolean>>,
    /** 重命名插件：改展示名（草稿 title + 清单 name），目录名/id 不动 */
    rename: (id: string, title: string) =>
      invoke('harness:workshop-rename', id, title) as Promise<
        WorkshopActionResult<WorkshopDraftSummary>
      >,
    /**
     * 取（必要时创建）某份插件的**插件工作区**：插件会话的工作目录就是它的源码目录
     * （`<插件存放路径>/<插件 id>/`）。侧栏「插件行 ＋」先调它，再像切普通工作区一样切过去。
     */
    ensureWorkspace: (id: string) =>
      invoke('harness:workshop-ensure-workspace', id) as Promise<
        WorkshopActionResult<{ id: number; name: string; path: string }>
      >,
    exportZip: (id: string) =>
      invoke('harness:workshop-export', id) as Promise<
        WorkshopActionResult<{ file: string; bytes: number; files: string[] }>
      >,
    openDir: (id: string) =>
      invoke('harness:workshop-open-dir', id) as Promise<WorkshopActionResult<string>>,
    /**
     * 弹系统选择框配置**插件存放路径**（所有插件的源码根目录）。
     * 首次启动已按安装目录预置；用户改地址时旧路径下的插件源码会迁到新路径。
     * 用户取消时返回 `{ canceled: true }`（取消不是失败）。
     */
    pickRoot: () =>
      invoke('harness:workshop-pick-root') as Promise<
        WorkshopActionResult<{ canceled: boolean; dir?: string; moved?: string[] }>
      >,
    /** 按显式路径配置插件存放路径（工装用；空串 = 清除配置） */
    setRoot: (dir: string) =>
      invoke('harness:workshop-set-root', dir) as Promise<
        WorkshopActionResult<{ dir: string; moved: string[] }>
      >,
    /** 草稿/产物/安装态变化（助手在对话里改了草稿时，开着的面板要跟着变） */
    onChanged: (callback: () => void): (() => void) =>
      on('harness:workshop-changed', () => callback()),
    /**
     * 渲染层实时探针请求（主进程发的；助手界面收到后 import 一遍插件产物并回话）。
     * 订阅本身由 Provider 常驻持有，用户在不在工坊页都能应答。
     */
    onProbe: (
      callback: (payload: { probeId: string; id: string; entry: string }) => void
    ): (() => void) =>
      on('harness:workshop-probe', (data) =>
        callback(data as { probeId: string; id: string; entry: string })
      ),
    /** 回话（主进程按 probeId 兑付；已超时的结果会被丢弃） */
    reportProbe: (payload: {
      probeId: string
      status: 'pass' | 'fail' | 'skip'
      detail?: string
      registrations?: string[]
      durationMs?: number
    }) => invoke('harness:workshop-probe-result', payload) as Promise<boolean>
  }
}

export default harnessApi
