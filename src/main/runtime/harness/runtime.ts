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
import { buildProposeActionTool } from './propose-action'
import {
  buildSubAgentTools as buildSubAgentToolsFromRegistry,
  listAvailableTools
} from '../../tools/harness/builders'
import { buildListCapabilitiesTool } from '../../tools/harness/capabilities'
import { LIST_CAPABILITIES_TOOL_NAME } from '../../../shared/harness/mcp'
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
 * AgentRuntime — declarative component assembly entry point (declarative configuration plus
 * coordination)
 *
 * Component dependencies (inject):
 * - file toolset <- workspacePath / memoryPath (not active without a mount)
 * - memory <- memoryPath + workspaceId (not injected when unconfigured)
 * - skills <- skillsPath + enabledSkills (not injected when unconfigured)
 * - subagents <- subAgents + model resolver (the task tool is always mounted; without config its
 *   description guides the agent to build one with agent_create)
 *
 * One Runtime instance per request (good isolation).
 */

/** Rita base persona (unchanged from the previous version) */
const RITA_BASE_PROMPT = `Your name is Rita. You are a helpful assistant.

You are in a continuous conversation with the user. All messages in the harness history are genuine prior exchanges between you and this same user — treat them as real conversation context.
- When the user asks about "previous" or "last time", refer to the conversation history provided.
- Do NOT claim you cannot see or remember earlier messages. You have full access to the harness history.
- If you keep a todo list for multi-step work, keep it current: mark each item completed as you finish it, and before you end a turn send a final write_todos in which no item is left in_progress — the user sees the list live, and an item stuck on in_progress after the work is done reads as "still running". The only exception is when you really are handing back to the user mid-work, such as asking a question and waiting for the answer.
- For processes that never exit on their own (dev servers, watchers, long builds), call execute with run_in_background=true instead of blocking the turn: keep working or summarise, read output with job_output, and stop the job with job_kill when it is no longer needed.
- Reply in the same language the user writes in, and keep responses concise and natural.`

export interface AgentRuntimeOptions {
  /** An already created BaseChatModel instance (provided by ProviderService) */
  model: BaseChatModel
  /** Business tool list (the 8 built-in AI tools) */
  tools: StructuredToolInterface[]
  /** Agent definition list */
  subAgents: SubAgentConfig[]
  /** Skills directory (a subdirectory containing SKILL.md is a skill); empty disables skills */
  skillsPath?: string
  /** Enabled skill ids; undefined means all are enabled */
  enabledSkills?: string[]
  /** AI workspace directory (mounted as the virtual /) */
  workspacePath?: string
  /** Memory storage root; empty disables memory */
  memoryPath?: string
  /** Current workspace id */
  workspaceId: number
  /** Main model descriptor at spawn time (persisting background subagent sessions, cold resume; default = current default provider) */
  modelDescriptor?: SubAgentMainModelDescriptor
  /** Goal auto-continuation round: ignore plan mode (planning is only for the first user-started round, to avoid a review prompt every round) */
  suppressPlanMode?: boolean
  /**
   * Unattended turn (scheduled task): no human is present to answer or approve anything.
   *
   * Suppresses the interactive tools (`ask_user_question`, plan approval, action cards) and makes
   * the permission gate deny approval-required calls immediately instead of suspending the turn
   * forever. A scheduled run must always reach a reply on its own.
   */
  nonInteractive?: boolean
  /** Mnemon memory component (process-level singleton, injected by HarnessService) */
  mnemon?: MnemonComponent
  /** Total tool-call cap (the model-level "tool call rounds"; defaults to the built-in value) */
  maxToolCalls?: number
  /**
   * Whether the model routed for this turn declares image input support (models-profile's
   * supports_image_input).
   * Passed to the file toolset as the runtime gate for read_image (false = refuse).
   */
  supportsImageInput?: boolean
  /**
   * Called every time real usage is sampled during generation (the accumulated records of the
   * turn).
   *
   * Not the same as `onUsage` at stream end (used for persistence): this fires once per model
   * round-trip, and the IPC layer uses it to push "N calls / X tokens so far this turn" to the
   * input footer for live display; without it usage is collected but not pushed (non-streaming
   * paths, background subagents, etc.).
   */
  onUsageRecord?: (records: ModelUsageRecord[]) => void
}

export class Runtime {
  private readonly opts: AgentRuntimeOptions
  private readonly fsTools: StructuredToolInterface[]
  private readonly queueRef: QueueRef = {}
  /** Spill-store reference: created per topicId on stream/invoke (subagent graphs share the same request's instance through it) */
  private readonly spillRef: { current?: SpillStore } = {}
  /** This turn's model usage collection (one real usage_metadata pushed per model call) */
  private usageRecords: ModelUsageRecord[] = []
  private readonly taskTool?: StructuredToolInterface
  /** Authoring tool exclusive to the main agent: delegates building reusable subagent configs (not mounted in subagent graphs) */
  private readonly authoringTool?: StructuredToolInterface
  private readonly workflowTool: StructuredToolInterface
  private readonly systemPrompt: string
  /** Skills enabled this turn (the system prompt only indexes them; the skill tool loads bodies on demand) */
  private readonly skills: SkillInfo[]
  private readonly mnemon?: MnemonComponent
  /** Graph recursion cap: far wider than the tool-call guard (about 2 node steps per round plus
   *  wrap-up headroom), so the tool guard fires first; even if it is hit, graph.ts wraps up
   *  gracefully (no error). */
  private readonly recursionLimit: number
  /** Total tool-call cap (the model-level "tool call rounds") */
  private readonly maxToolCalls: number
  /**
   * Topic id for this turn (reassigned on every stream/invoke).
   *
   * Why keep a copy on Runtime: tool wrapping (the permission gate) needs a fallback topic at
   * assembly time — subagent subgraphs carry no configurable, so tool calls cannot see topicId and
   * must fall back to this.
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
      // File change history is owned by the workspace (every model write leaves a traceable,
      // revertible record)
      workspaceId: opts.workspaceId,
      // Vision gate: read_image only runs when the model declares image input support
      supportsImageInput: opts.supportsImageInput
    })
    this.skills = loadSkills({
      skillsPath: opts.skillsPath,
      enabledSkills: opts.enabledSkills
    })
    this.systemPrompt = this.buildSystemPrompt()

    // The task tool is always mounted: with no configured subagents its description guides the
    // main agent to build one with agent_create; reloadSubAgents re-resolves the config **at call
    // time**, so a just-created agent can be dispatched immediately within the same turn.
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
      // Per-subagent memory root:
      // <memoryPath>/workspace-<wsId>/sub-agents/<name>/memories/AGENTS.md
      memoryPath: opts.memoryPath,
      // Skills directory: subagents get skills filtered by their declared list
      skillsPath: opts.skillsPath,
      reloadSubAgents: () => listEnabledSubAgents(opts.workspaceId)
    })

    // The authoring tool is main-agent only: it turns "create a subagent config" into a delegable
    // tool call (same service layer as the settings page). Without a workspace, agent_config has
    // no owner, so it is not mounted.
    if (opts.workspaceId > 0) {
      this.authoringTool = createAgentAuthoringTool({
        workspaceId: opts.workspaceId,
        // Mounted names (groups already expanded): the service maps them back to selector values
        availableToolNames: opts.tools.map((tool) => tool.name),
        // Validation source for agent_create.skills: every skill on disk, not only the main agent's
        // enabled subset (a subagent's skill list is independent of the session selection)
        availableSkillIds: loadSkills({ skillsPath: opts.skillsPath }).map((skill) => skill.id)
      })
    }

    // Workflow tool: script-driven multi-agent fan-out (subagents get business + file tools, which
    // prevents recursive nesting)
    this.workflowTool = buildWorkflowTool({
      mainModel: opts.model,
      resolveModel: (spec) => this.resolveSubAgentModel(spec),
      // Workflow subagents are also gated by the permission gate (tools are assembled only when
      // actually invoked, using the current this.currentTopicId as the topic)
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
   * Assemble the main agent toolset
   * (business tools + file tools + todo + goal + background jobs + ask + subagent resume control
   * + workflow + Mnemon + task)
   *
   * All tools go through the permission gate: every call (including MCP / plugin-contributed /
   * future tools) must be wrapped at the assembly point, otherwise "adding one tool" would
   * silently bypass the sandbox.
   */
  private buildAllTools(topicId: number): StructuredToolInterface[] {
    const tools: StructuredToolInterface[] = [
      ...this.opts.tools,
      ...this.fsTools,
      // Session history search (cross-topic search + read by topic): mounted only with a workspace
      ...(this.opts.workspaceId > 0 ? buildSessionSearchTools(this.opts.workspaceId) : []),
      // Persistent terminal: mounted only with a workspace; open/send are restricted to the
      // danger-full-access mode by the tool layer
      ...buildTerminalTools({ workspacePath: this.opts.workspacePath }),
      ...buildTodoTools(todoStore, topicId),
      ...buildGoalTools(goalStore, topicId),
      // Plan mode: the exit tool is only exposed while active (it appears with the planning guidance).
      // Unattended turns never expose it: nobody can approve the plan.
      ...(!this.opts.suppressPlanMode &&
      !this.opts.nonInteractive &&
      planModeStore.isActive(topicId)
        ? [buildExitPlanModeTool(topicId)]
        : []),
      ...buildJobTools(jobsRegistry, topicId),
      // Nobody can answer an in-turn question during a scheduled run
      ...(!this.opts.nonInteractive ? [buildAskUserTool(topicId)] : []),
      ...buildSubagentControlTools(subagentSessions, topicId),
      // Shared task board (opt-in): injected only when team collaboration is enabled for the topic
      ...(teamModeStore.isEnabled(topicId) ? buildTeamTools(teamStore, topicId) : []),
      this.workflowTool,
      ...(this.mnemon ? this.mnemon.tools : []),
      // Skills: the system prompt only indexes them, the skill tool loads bodies on demand (not
      // mounted when there are none)
      ...(this.skills.length > 0 ? [buildSkillTool(this.skills)] : []),
      ...(this.taskTool ? [this.taskTool] : []),
      ...(this.authoringTool ? [this.authoringTool] : []),
      // Model route list: agent_create's `model` field only accepts enabled provider:model values,
      // so it is mounted only with a workspace (where subagents can be created)
      ...(this.opts.workspaceId > 0 ? [buildModelRoutesTool()] : []),
      // Capability catalog: a runtime built-in, always mounted in the main conversation. The
      // subagent-creation form (`agent_create`) and the schedule form (`schedule_create` /
      // `schedule_edit.agentConfig`) only accept exact tool / skill / MCP values, and this is where
      // the model reads them. Rebuilt per turn so plugin enable/disable and MCP changes apply;
      // skipped when a dirty old config already mounted it (avoid a duplicate tool name).
      ...(this.opts.tools.some((tool) => tool.name === LIST_CAPABILITIES_TOOL_NAME)
        ? []
        : [buildListCapabilitiesTool(listAvailableTools())]),
      // Action cards: renders clickable actions under the reply; clicking sends one message back
      // (no side effects, always mounted). Unattended turns have nobody to click them.
      ...(!this.opts.nonInteractive ? [buildProposeActionTool()] : [])
    ]
    // PTC (run_code) must be built **after all tools are assembled**: it bridges read-only tools
    // to model code and must see the final list (excluding itself). Mounted only with a workspace,
    // same as terminal.
    if (this.opts.workspacePath) {
      tools.push(buildRunCodeTool({ availableTools: tools }))
    }
    return this.guard(tools, topicId)
  }

  /** Subagent tools (built independently from the system tool registry by declared names) — gated too */
  private buildSubAgentTools(subAgent: SubAgentConfig): StructuredToolInterface[] {
    // Subagent skills are also loaded on demand: the prompt only has the index, so the skill tool
    // must be included, otherwise the subagent sees the list but cannot read the bodies.
    const subAgentSkills =
      subAgent.skills && subAgent.skills.length > 0
        ? loadSkills({ skillsPath: this.opts.skillsPath, enabledSkills: subAgent.skills })
        : []
    // Subagents are team members too (only when team mode is on): include the shared task board
    // tools (identity comes from configurable.teamAgent)
    return this.guard([
      ...buildSubAgentToolsFromRegistry(subAgent),
      ...(subAgentSkills.length > 0 ? [buildSkillTool(subAgentSkills)] : []),
      ...(teamModeStore.isEnabled(this.currentTopicId)
        ? buildTeamTools(teamStore, this.currentTopicId)
        : [])
    ])
  }

  /**
   * Wrap with the permission gate (sandbox: view only / workspace write / full access).
   *
   * @param topicId topic id; defaults to this turn's topic (subagents/workflow assemble tools at
   *   call time and use the current currentTopicId)
   */
  private guard(tools: StructuredToolInterface[], topicId?: number): StructuredToolInterface[] {
    return guardTools(tools, {
      topicId: topicId ?? this.currentTopicId,
      workspaceRoot: this.opts.workspacePath,
      nonInteractive: this.opts.nonInteractive
    })
  }

  /** Resolve 'provider:model' -> model instance; undefined on failure (falls back to the main model) */
  private async resolveSubAgentModel(spec: string | undefined): Promise<BaseChatModel | undefined> {
    return resolveSubAgentModelSpec(spec)
  }

  /**
   * Build the system prompt: Rita persona + subagent guidance + skills section + Mnemon sections
   * (hot memory is injected by Mnemon).
   */
  private buildSystemPrompt(): string {
    let prompt = RITA_BASE_PROMPT
    // Delegation needs a workspace: the task tool is always mounted and, with no subagents, guides
    // the model toward agent_create
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
task is non-blocking: it returns a session id immediately and keeps running in the top-bar subagent list. Call job_output(job_id, wait=true) when the next step depends on the subagent's result; otherwise continue working and poll later. The subagent's full output is shown to the user in its session view, so your final answer only needs a brief summary or a short wrap-up — do not restate the detail the subagent already produced.`
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
   * System prompt for this turn = base prompt + the section describing the current permission
   * mode.
   *
   * Why assemble it per request instead of per construction: the mode is **per topic**, so the
   * same Runtime config uses different modes in different topics; the mode description must match
   * the interception behavior that actually applies, word for word.
   */
  private promptFor(topicId: number): string {
    return (
      this.systemPrompt +
      sandboxPromptSection(permissionGate.modeFor(topicId)) +
      // Plan mode: append planning guidance only while active (no extra tokens when inactive);
      // unattended turns skip it entirely (there is no plan-approval tool mounted)
      planModePromptSection(
        !this.opts.suppressPlanMode && !this.opts.nonInteractive && planModeStore.isActive(topicId)
      ) +
      // Team collaboration: opt-in (persisted per topic); nothing is appended when off
      teamModePromptSection(teamModeStore.isEnabled(topicId))
    )
  }

  /** Graph execution options (when the recursion cap is hit, the graph layer wraps up gracefully) */
  private graphOptions(signal?: AbortSignal, turnMeta?: TurnMeta, topicId = 0): GraphRunOptions {
    return {
      recursionLimit: this.recursionLimit,
      signal,
      // Turn source and topic ownership: read by the tool layer from config.configurable
      // (goal-tool authority checks, background-job owner isolation)
      configurable: {
        topicId,
        turnSource: turnMeta?.source ?? 'user',
        // Workspace root: present and others use it to check that deliverables stay in the workspace
        workspaceRoot: this.opts.workspacePath,
        // Team identity: the main graph is lead; subagent graphs override it to member in their
        // own stream config
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
   * Hot memory (USER / MEMORY entries) injected into the system prompt this turn.
   * Returns null when Mnemon is disabled or hot memory is empty — the frontend uses that to decide
   * whether to show the "injected memory" badge.
   */
  /** Real usage reported by each model call this turn (cleared at the start of stream/invoke, read at the end) */
  get usage(): ModelUsageRecord[] {
    return this.usageRecords
  }

  /**
   * Record one real usage entry: add it to this turn's ledger, then hand out a **cumulative
   * snapshot** when a listener is configured.
   *
   * A copy is passed instead of `this.usageRecords` itself: the listener (IPC broadcast) may read
   * it on an async path while this turn keeps pushing — it must not see the same array grow
   * mid-read.
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
   * Streaming execution: inject the record queue -> build the main agent graph -> start the
   * background consumer -> return the three streams.
   *
   * topicId attributes the conversation plan (write_todos list) to the current topic and broadcasts
   * it to the frontend. The list survives across requests/turns (a process-level singleton) and the
   * model may keep maintaining it in later turns; cancel/end only closes the record queue and never
   * clears the list (an interrupted task can still be followed up).
   */
  stream(
    messages: BaseMessage[],
    signal?: AbortSignal,
    topicId = 0,
    turnMeta?: TurnMeta,
    /** In-turn interjections: drain pending interjections before the tool node runs (injection off when unset) */
    drainInjections?: () => Promise<AgentInjection[] | null>
  ): RuntimeStream {
    const queue = new RecordQueue()
    this.queueRef.current = queue
    this.currentTopicId = topicId
    // Usage collection container for this turn (restarted on every stream/invoke)
    this.usageRecords = []
    // Denial credentials reset per turn: a call the user refused last turn may ask again this turn
    // (otherwise the same signature would be silently refused forever)
    permissionGate.reset()
    // Create the spill store per topic (workspace .spill first, then the memory dir; neither =
    // spill disabled)
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
   * Non-streaming execution: returns the final message list.
   */
  async invoke(
    messages: BaseMessage[],
    signal?: AbortSignal,
    topicId = 0,
    turnMeta?: TurnMeta
  ): Promise<BaseMessage[]> {
    this.queueRef.current = undefined
    this.currentTopicId = topicId
    // Usage collection container for this turn (restarted on every stream/invoke)
    this.usageRecords = []
    // Same handling as the streaming path: denial credentials reset per turn
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
