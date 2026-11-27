import { BaseChatModel } from '../../ai/chat-model'
import { BaseMessage } from '../../ai/messages'
import type { StructuredToolInterface } from '../../ai/tools'
import logger from 'electron-log'
import type { SubAgentConfig } from '../../services/harness/types'
import {
  buildAgentGraph,
  buildGraphInput,
  MAX_TOOL_CALLS,
  MIN_TOOL_CALLS,
  type QueueRef
} from './agent'
import type { ModelUsageRecord } from './usage'
import { buildFsTools } from './fs-backend'
import { buildTodoTools, todoStore } from './todo'
import { buildGoalTools, goalStore } from './goal'
import { buildExitPlanModeTool, planModePromptSection, planModeStore } from './plan-mode'
import { buildJobTools, jobsRegistry } from './jobs'
import { buildAskUserTool } from './ask'
import { buildSubagentControlTools, subagentSessions } from './subagent-sessions'
import { buildTeamTools, teamStore } from './team'
import { buildWorkflowTool } from './workflow'
import { buildSkillsPromptSection, loadSkills, type SkillInfo } from './skills-core'
import { buildSkillTool } from './skill-tool'
import { buildSessionSearchTools } from './session-search'
import { buildTerminalTools } from './terminal-tools'
import { buildRunCodeTool } from './run-code-tool'
import { buildModelRoutesTool } from './model-routes'
import { buildSubAgentTools as buildSubAgentToolsFromRegistry } from '../../tools/harness/builders'
import { createTaskTool } from './subagent'
import { createAgentAuthoringTool } from './subagent-authoring'
import { resolveSubAgentModelSpec } from './subagent-model'
import { teamModePromptSection, teamModeStore } from './team-mode'
import { listEnabledSubAgents } from '../../services/harness/subagents'
import { permissionGate } from './permission-gate'
import { guardTools } from './permission-guard'
import { sandboxPromptSection } from './permission'
import { RecordQueue, startGraphStream, invokeGraph, type GraphRunOptions } from './graph'
import { SpillStore } from './spill'
import type { MnemonComponent } from './mnemon'
import type { RuntimeStream } from './types'
import type {
  MemoryInjection,
  TurnMeta,
  AgentInjection,
  SubAgentMainModelDescriptor
} from '../../services/harness/types'

/**
 * AgentRuntime — 声明式组件组装入口（对应论文 §5.2 声明式配置 + 协调）
 *
 * 组件依赖声明（inject）：
 * - 文件工具集 ← workspacePath / memoryPath（无挂载则不激活）
 * - 记忆 ← memoryPath + workspaceId（未配置则不注入）
 * - 技能 ← skillsPath + enabledSkills（未配置则不注入）
 * - 子代理 ← subAgents + 模型解析器（task 工具始终挂载；无配置时描述引导 agent_create 构建）
 *
 * 每个请求一个 Runtime 实例（与旧 HarnessService 每次构建 agent 一致），隔离性好。
 */

/** Rita 基础人设（与旧版保持一致） */
const RITA_BASE_PROMPT = `Your name is Rita. You are a helpful assistant.

You are in a continuous conversation with the user. All messages in the harness history are genuine prior exchanges between you and this same user — treat them as real conversation context.
- When the user asks about "previous" or "last time", refer to the conversation history provided.
- Do NOT claim you cannot see or remember earlier messages. You have full access to the harness history.
- If you keep a todo list for multi-step work, keep it current: mark each item completed as you finish it, and before you end a turn send a final write_todos in which no item is left in_progress — the user sees the list live, and an item stuck on in_progress after the work is done reads as "still running". The only exception is when you really are handing back to the user mid-work, such as asking a question and waiting for the answer.
- For processes that never exit on their own (dev servers, watchers, long builds), call execute with run_in_background=true instead of blocking the turn: keep working or summarise, read output with job_output, and stop the job with job_kill when it is no longer needed.
- Reply in the same language the user writes in, and keep responses concise and natural.`

export interface AgentRuntimeOptions {
  /** 已创建的 BaseChatModel 实例（由 ProviderService 提供） */
  model: BaseChatModel
  /** 业务工具列表（8 个内置 AI 工具） */
  tools: StructuredToolInterface[]
  /** 智能体定义列表 */
  subAgents: SubAgentConfig[]
  /** 技能目录（含 SKILL.md 的子目录即技能），空表示不启用 */
  skillsPath?: string
  /** 启用的技能 ID 列表，undefined 表示全部启用 */
  enabledSkills?: string[]
  /** AI 工作区目录（挂载为虚拟 /） */
  workspacePath?: string
  /** 记忆存储根目录，空表示不启用 */
  memoryPath?: string
  /** 当前工作区 ID */
  workspaceId: number
  /** spawn 时主模型描述符（后台子代理会话持久化、冷恢复用；缺省 = 当前默认供应商） */
  modelDescriptor?: SubAgentMainModelDescriptor
  /** 目标自动续跑轮：忽略计划模式（计划只用于用户主动启动的首轮，避免每轮弹评审） */
  suppressPlanMode?: boolean
  /** Mnemon 记忆组件（进程级单例，由 HarnessService 注入） */
  mnemon?: MnemonComponent
  /** 工具调用总次数上限（模型级「工具调用轮数」；缺省用工程默认值） */
  maxToolCalls?: number
  /**
   * 本轮路由的模型是否声明支持图片输入（models-profile 的 supports_image_input）。
   * 传给文件工具集，作为 read_image 的执行期门禁（false = 拒绝）。
   */
  supportsImageInput?: boolean
  /**
   * 生成中每采到一次真实用量就回调（整轮累计的记录数组）。
   *
   * 与流结束时的 `onUsage`（落库用）不是一回事：这里每发生一次模型往返就调一次，
   * IPC 层据此把「本轮已跑 N 次调用 / X token」推给输入框底栏实时显示；
   * 不配置就只采集不推送（非流式路径、后台子代理等）。
   */
  onUsageRecord?: (records: ModelUsageRecord[]) => void
}

export class Runtime {
  private readonly opts: AgentRuntimeOptions
  private readonly fsTools: StructuredToolInterface[]
  private readonly queueRef: QueueRef = {}
  /** 溢出存储引用：stream/invoke 时按 topicId 创建（子代理图通过引用共享同一次请求的实例） */
  private readonly spillRef: { current?: SpillStore } = {}
  /** 本轮模型用量采集（每次模型调用 push 一条真实 usage_metadata） */
  private usageRecords: ModelUsageRecord[] = []
  private readonly taskTool?: StructuredToolInterface
  /** 主代理专属的作者化工具：委派构建可复用子代理配置（子代理图不挂） */
  private readonly authoringTool?: StructuredToolInterface
  private readonly workflowTool: StructuredToolInterface
  private readonly systemPrompt: string
  /** 本轮启用的技能（系统提示词只放索引，正文由 skill 工具按需加载） */
  private readonly skills: SkillInfo[]
  private readonly mnemon?: MnemonComponent
  /** 图递归上限：远宽于工具调用次数护栏（每轮约 2 个节点步 + 收尾余量），
   *  工具护栏先触发；即使触顶也有 graph.ts 的优雅收尾兜底（不报错）。 */
  private readonly recursionLimit: number
  /** 工具调用总次数上限（模型级「工具调用轮数」） */
  private readonly maxToolCalls: number
  /**
   * 本轮话题 id（每次 stream/invoke 重新赋值）。
   *
   * 为什么要在 Runtime 上留一份：工具包装（权限闸门）在组装期就需要一个话题兜底值——
   * 子代理子图不带 configurable，工具调用拿不到 topicId，只能回落到这里。
   */
  private currentTopicId = 0

  constructor(opts: AgentRuntimeOptions) {
    this.opts = opts
    this.maxToolCalls = Math.max(MIN_TOOL_CALLS, Math.floor(opts.maxToolCalls ?? MAX_TOOL_CALLS))
    this.recursionLimit = this.maxToolCalls * 2 + 20
    this.mnemon = opts.mnemon
    this.fsTools = buildFsTools({
      workspacePath: opts.workspacePath,
      memoryPath: opts.memoryPath,
      // 文件改动史按工作区归属（模型每次写文件都要留下可追溯 / 可回溯的记录）
      workspaceId: opts.workspaceId,
      // 视觉门禁：read_image 只在模型声明支持图片输入时执行
      supportsImageInput: opts.supportsImageInput
    })
    this.skills = loadSkills({
      skillsPath: opts.skillsPath,
      enabledSkills: opts.enabledSkills
    })
    this.systemPrompt = this.buildSystemPrompt()

    // task 工具始终挂载：没有已配置子代理时，描述会引导主智能体用 agent_create 构建；
    // reloadSubAgents 在**调用期**重新解析配置，保证同一轮内 agent_create 之后能立刻派发。
    this.taskTool = createTaskTool({
      subAgents: opts.subAgents,
      mainModel: opts.model,
      resolveModel: (spec) => this.resolveSubAgentModel(spec),
      buildTools: (sa) => this.buildSubAgentTools(sa),
      queue: this.queueRef,
      spillRef: this.spillRef,
      recursionLimit: this.recursionLimit,
      maxToolCalls: this.maxToolCalls,
      mainModelDescriptor: opts.modelDescriptor,
      // 子代理专属记忆根（<memoryPath>/workspace-<wsId>/ 下 sub-agents/<name>/memories/AGENTS.md）
      memoryPath: opts.memoryPath,
      // 技能目录：子代理按声明的 skills 过滤注入
      skillsPath: opts.skillsPath,
      reloadSubAgents: () => listEnabledSubAgents(opts.workspaceId)
    })

    // 作者化工具只给主代理：把「新建子代理配置」做成可委派的工具调用（设置页同一服务层）。
    // 没有工作区时 agent_config 无归属，不挂载。
    if (opts.workspaceId > 0) {
      this.authoringTool = createAgentAuthoringTool({
        workspaceId: opts.workspaceId,
        availableToolNames: opts.tools.map((tool) => tool.name)
      })
    }

    // 工作流工具：脚本编排多代理 fan-out（子代理 = 业务工具 + 文件工具，防递归嵌套）
    this.workflowTool = buildWorkflowTool({
      mainModel: opts.model,
      resolveModel: (spec) => this.resolveSubAgentModel(spec),
      // 工作流里的子代理同样受权限闸门约束（工具在真正被调用时才组装，话题取当时的 this.currentTopicId）
      buildAgentTools: () => this.guard([...this.opts.tools, ...this.fsTools]),
      recursionLimit: this.recursionLimit,
      maxToolCalls: this.maxToolCalls,
      spillRef: this.spillRef
    })

    logger.info(
      `[Runtime] initialized (recursionLimit=${this.recursionLimit}, maxToolCalls=${this.maxToolCalls}, fsTools=${this.fsTools.length}, subAgents=${opts.subAgents.length}, taskTool=${this.taskTool ? 'yes' : 'no'}, authoringTool=${this.authoringTool ? 'yes' : 'no'}, mnemon=${this.mnemon ? `yes(${this.mnemon.tools.length} tools)` : 'no'}, workspacePath=${opts.workspacePath ?? 'disabled'}, memoryPath=${opts.memoryPath ?? 'disabled'}, skillsPath=${opts.skillsPath ?? 'disabled'})`
    )
  }

  /**
   * 组装主代理工具集
   * （业务工具 + 文件工具 + 待办 + 目标 + 后台任务 + 提问 + 子代理续接控制 + 工作流 + Mnemon + task）
   *
   * 全部工具统一过权限闸门：任何一次调用（含 MCP / 插件贡献 / 后续新增的工具）都必须在
   * 组装处就被包住，否则「新加一个工具」就会悄悄绕过沙箱。
   */
  private buildAllTools(topicId: number): StructuredToolInterface[] {
    const tools: StructuredToolInterface[] = [
      ...this.opts.tools,
      ...this.fsTools,
      // 历史会话检索（跨话题搜索 + 按话题读取）：只在有工作区的会话里挂载
      ...(this.opts.workspaceId > 0 ? buildSessionSearchTools(this.opts.workspaceId) : []),
      // 持久终端：只在有工作区时挂载；open/send 由工具层限制在 danger-full-access 档
      ...buildTerminalTools({ workspacePath: this.opts.workspacePath }),
      ...buildTodoTools(todoStore, topicId),
      ...buildGoalTools(goalStore, topicId),
      // 计划模式：退出工具只在激活时披露（与规划指引同时出现）
      ...(!this.opts.suppressPlanMode && planModeStore.isActive(topicId)
        ? [buildExitPlanModeTool(topicId)]
        : []),
      ...buildJobTools(jobsRegistry, topicId),
      buildAskUserTool(topicId),
      ...buildSubagentControlTools(subagentSessions, topicId),
      // 共享任务板（opt-in）：仅在话题开启团队协作时注入
      ...(teamModeStore.isEnabled(topicId) ? buildTeamTools(teamStore, topicId) : []),
      this.workflowTool,
      ...(this.mnemon ? this.mnemon.tools : []),
      // 技能：系统提示词只放索引，正文由 skill 工具按需加载（没有技能时不挂）
      ...(this.skills.length > 0 ? [buildSkillTool(this.skills)] : []),
      ...(this.taskTool ? [this.taskTool] : []),
      ...(this.authoringTool ? [this.authoringTool] : []),
      // 模型路由清单：agent_create 的 `model` 字段只能填已启用的 provider:model，
      // 有工作区（能创建子代理）时才挂载
      ...(this.opts.workspaceId > 0 ? [buildModelRoutesTool()] : [])
    ]
    // PTC（run_code）要在**全部工具装配完成之后**再建：它把只读工具桥接给模型代码，
    // 必须能看到最终列表（且排除自身）。只在有工作区时挂载，与 terminal 一致。
    if (this.opts.workspacePath) {
      tools.push(buildRunCodeTool({ availableTools: tools }))
    }
    return this.guard(tools, topicId)
  }

  /** 子代理工具（按声明的工具名从系统工具注册表独立构建）——同样过闸门 */
  private buildSubAgentTools(subAgent: SubAgentConfig): StructuredToolInterface[] {
    // 子代理的技能同样按需加载：提示词里只有索引，因此必须带上 skill 工具，
    // 否则子代理能看到技能列表却读不到正文。
    const subAgentSkills =
      subAgent.skills && subAgent.skills.length > 0
        ? loadSkills({ skillsPath: this.opts.skillsPath, enabledSkills: subAgent.skills })
        : []
    // 子代理同样是团队一员（仅团队模式开启时）：带上共享任务板工具（身份由 configurable.teamAgent 提供）
    return this.guard([
      ...buildSubAgentToolsFromRegistry(subAgent),
      ...(subAgentSkills.length > 0 ? [buildSkillTool(subAgentSkills)] : []),
      ...(teamModeStore.isEnabled(this.currentTopicId)
        ? buildTeamTools(teamStore, this.currentTopicId)
        : [])
    ])
  }

  /**
   * 套上权限闸门（沙箱：仅可查看 / 工作区内修改 / 完全权限）。
   *
   * @param topicId 话题 id；缺省用本轮话题（子代理/工作流在调用期组装工具，取当时的 currentTopicId）
   */
  private guard(tools: StructuredToolInterface[], topicId?: number): StructuredToolInterface[] {
    return guardTools(tools, {
      topicId: topicId ?? this.currentTopicId,
      workspaceRoot: this.opts.workspacePath
    })
  }

  /** 解析 'provider:model' → 模型实例；失败返回 undefined（回退主模型） */
  private async resolveSubAgentModel(spec: string | undefined): Promise<BaseChatModel | undefined> {
    return resolveSubAgentModelSpec(spec)
  }

  /**
   * 构建系统提示词：Rita 人设 + 子智能体引导 + 技能段 + Mnemon sections（热记忆由 Mnemon 统一注入）。
   */
  private buildSystemPrompt(): string {
    let prompt = RITA_BASE_PROMPT
    // 工作区已配置时才有委派能力：task 工具始终挂载，没有子代理时引导 agent_create 构建
    if (this.opts.workspaceId > 0) {
      const list =
        this.opts.subAgents.length > 0
          ? this.opts.subAgents
              .map((sa) => {
                const display =
                  sa.rename && sa.rename !== sa.name ? `${sa.rename} (${sa.name})` : sa.name
                return `- ${display}: ${sa.description || '(no description)'}`
              })
              .join('\n')
          : '(none configured yet)'
      prompt += `\n\n## Subagents
You can use the task tool to delegate suitable work to a dedicated subagent (each subagent has its own system prompt, tools, and model). Prefer delegation when a task is beyond your current reach or falls in a subagent's area of expertise. Available subagents:
${list}
If no existing subagent fits, you can create a reusable one yourself with agent_create (name in lowercase kebab-case, a precise description, a complete system_prompt, and optionally tools/model). It persists for this workspace (visible and editable in Settings → Agents) and can be used immediately with task, including later in this same turn. Do not create a subagent that duplicates an existing one.
Once a delegation finishes, the subagent's full output is shown to the user directly; your final answer only needs a brief summary or a short wrap-up — do not restate the detail the subagent already produced.`
    }
    const skillsSection = buildSkillsPromptSection(this.skills)
    if (skillsSection) {
      prompt += skillsSection
    }
    if (this.mnemon) {
      for (const section of this.mnemon.promptSections) {
        prompt += section
      }
    }
    return prompt
  }

  /**
   * 本轮系统提示词 = 基础提示词 + 当前权限档位说明段。
   *
   * 为什么在请求期拼而不是构造期：档位是**按话题**的，同一份 Runtime 配置在
   * 不同话题下会用不同档位；档位说明必须与真正生效的拦截行为逐字对应。
   */
  private promptFor(topicId: number): string {
    return (
      this.systemPrompt +
      sandboxPromptSection(permissionGate.modeFor(topicId)) +
      // 计划模式：只在激活时追加规划指引（未激活不增加任何 token）
      planModePromptSection(!this.opts.suppressPlanMode && planModeStore.isActive(topicId)) +
      // 团队协作：opt-in（按话题持久化）；关闭时不追加任何团队提示词
      teamModePromptSection(teamModeStore.isEnabled(topicId))
    )
  }

  /** 图执行配置（递归上限触顶时由 graph 层优雅收尾，不再报错） */
  private graphOptions(signal?: AbortSignal, turnMeta?: TurnMeta, topicId = 0): GraphRunOptions {
    return {
      recursionLimit: this.recursionLimit,
      signal,
      // 本轮来源与话题归属：工具层经 config.configurable 读取
      //（目标工具 authority 校验、后台任务的 owner 隔离）
      configurable: {
        topicId,
        turnSource: turnMeta?.source ?? 'user',
        // 工作区根：present 等工具据此校验「交付物必须在工作区内」
        workspaceRoot: this.opts.workspacePath,
        // 团队身份：主图即 lead；子代理图会在自己的 stream 配置里覆盖成 member 身份
        teamAgent: { id: 'lead', name: 'lead', isLead: true },
        goalRound:
          turnMeta?.source === 'goal-round'
            ? {
                goalId: turnMeta.goalId,
                revision: turnMeta.goalRevision,
                round: turnMeta.goalRound
              }
            : undefined
      }
    }
  }

  /**
   * 本轮注入系统提示词的热记忆内容（USER / MEMORY 条目）。
   * Mnemon 未启用或热记忆为空时返回 null——前端据此决定是否显示「注入记忆」标识。
   */
  /** 本轮各次模型调用回传的真实用量（每次 stream/invoke 开始时清空，结束时读取） */
  get usage(): ModelUsageRecord[] {
    return this.usageRecords
  }

  /**
   * 记一条真实用量：先归入本轮账本，再在配置了监听时把**累计快照**交出去。
   *
   * 传副本而不是 `this.usageRecords` 本身：监听方（IPC 广播）可能在异步路径上读它，
   * 而本轮后续还会继续 push——不能让它读到半路变长的同一个数组。
   */
  private recordUsage(record: ModelUsageRecord): void {
    this.usageRecords.push(record)
    this.opts.onUsageRecord?.([...this.usageRecords])
  }

  get memoryInjection(): MemoryInjection | null {
    if (!this.mnemon) return null
    const snapshot = this.mnemon.runtimeMemory.snapshot()
    const user = snapshot.entries.filter((e) => e.target === 'user').map((e) => e.content)
    const memory = snapshot.entries.filter((e) => e.target === 'memory').map((e) => e.content)
    if (user.length === 0 && memory.length === 0) return null
    return {
      user,
      memory,
      usage: {
        user: `${snapshot.targets.user.used}/${snapshot.targets.user.limit}`,
        memory: `${snapshot.targets.memory.used}/${snapshot.targets.memory.limit}`
      }
    }
  }

  /**
   * 流式执行：注入记录队列 → 构建主代理图 → 启动后台消费 → 返回三路流。
   *
   * topicId 用于把对话计划（write_todos 清单）归属到当前话题并广播到前端。
   * 清单跨请求/跨轮次保留（进程级单例），模型可在后续轮次继续维护；
   * 取消/结束时仅关闭记录队列，不清空清单（中断的任务可继续追问）。
   */
  stream(
    messages: BaseMessage[],
    signal?: AbortSignal,
    topicId = 0,
    turnMeta?: TurnMeta,
    /** 回合内插话：工具节点执行前排空待注入插话（未配置则关闭注入） */
    drainInjections?: () => Promise<AgentInjection[] | null>
  ): RuntimeStream {
    const queue = new RecordQueue()
    this.queueRef.current = queue
    this.currentTopicId = topicId
    // 本轮用量采集容器（每次 stream/invoke 重新开始）
    this.usageRecords = []
    // 拒绝凭据按轮清零：上一轮用户拒绝过的调用，这一轮可以重新问（否则同签名会被永远静默拒绝）
    permissionGate.reset()
    // 按话题创建溢出存储（工作区 .spill 优先，其次记忆目录；均无则禁用溢出）
    this.spillRef.current = new SpillStore(this.opts.workspacePath, this.opts.memoryPath, topicId)
    const graph = buildAgentGraph({
      model: this.opts.model,
      tools: this.buildAllTools(topicId),
      systemPrompt: this.promptFor(topicId),
      queue: this.queueRef,
      spill: this.spillRef.current,
      usageSink: { push: (record) => this.recordUsage(record) },
      drainInjections
    })
    return startGraphStream(
      graph,
      buildGraphInput(messages),
      this.graphOptions(signal, turnMeta, topicId),
      queue
    )
  }

  /**
   * 非流式执行：返回最终消息列表。
   */
  async invoke(
    messages: BaseMessage[],
    signal?: AbortSignal,
    topicId = 0,
    turnMeta?: TurnMeta
  ): Promise<BaseMessage[]> {
    this.queueRef.current = undefined
    this.currentTopicId = topicId
    // 本轮用量采集容器（每次 stream/invoke 重新开始）
    this.usageRecords = []
    // 与流式路径同一处理：拒绝凭据按轮清零
    permissionGate.reset()
    this.spillRef.current = new SpillStore(this.opts.workspacePath, this.opts.memoryPath, topicId)
    const graph = buildAgentGraph({
      model: this.opts.model,
      tools: this.buildAllTools(topicId),
      systemPrompt: this.promptFor(topicId),
      queue: this.queueRef,
      spill: this.spillRef.current,
      usageSink: { push: (record) => this.recordUsage(record) }
    })
    return await invokeGraph(
      graph,
      buildGraphInput(messages),
      this.graphOptions(signal, turnMeta, topicId)
    )
  }
}
