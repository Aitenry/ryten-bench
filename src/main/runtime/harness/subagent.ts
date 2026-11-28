import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'
import { BaseChatModel } from '../../ai/chat-model'
import { HumanMessage, SystemMessage } from '../../ai/messages'
import { GraphRecursionError } from '../../ai/graph'
import logger from 'electron-log'
import * as fs from 'fs'
import * as path from 'path'
import type { SubAgentRecord } from './types'
import { buildAgentGraph, pushMessageRecords, type QueueRef, type StreamMessageLike } from './agent'
import { buildSkillsPromptSection, loadSkills } from './skills-core'
import type { SpillStore } from './spill'
import { subagentSessions } from './subagent-sessions'
import { subagentTeamPromptSection, teamModeStore } from './team-mode'
import type { SubAgentConfig, SubAgentMainModelDescriptor } from '../../services/harness/types'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'

/**
 * Subagent (task tool): delegates work to dedicated subagents.
 *
 * Mechanics:
 * - the task tool schema keeps the subagent_type / description / prompt fields;
 * - every call dynamically compiles a subagent subgraph (independent model/tools/system
 *   prompt + dedicated memory + skills);
 * - causeId is injected through config.configurable.toolCallId (written by the tool node);
 * - subgraph token-level events are forwarded as sub_* records, driving the frontend
 *   subagent activity block;
 * - the model is resolved from 'provider:model', falling back to the main model (a missing
 *   dependency degrades instead of failing);
 * - the subagent list (name/description) is injected dynamically into the task tool
 *   description and schema, so the main model can decide whether to delegate and which
 *   subagent to pick.
 */

/** Subagent runtime context */
export interface SubAgentRuntimeContext {
  /** Subagent definition list */
  /** Subagent definitions (construction-time snapshot: used for the task tool description / initial schema) */
  subAgents: SubAgentConfig[]
  /**
   * Re-resolve the subagent list at call time (when the main agent just created one with
   * agent_create or the settings page just changed the config, a task call in the same
   * turn must see the latest config rather than the snapshot taken when the Runtime was
   * constructed).
   * Default = use the construction-time snapshot (paths without authoring capability,
   * such as background sessions / workflows).
   */
  reloadSubAgents?: () => Promise<SubAgentConfig[]>
  /** Main agent model (fallback target) */
  mainModel: BaseChatModel
  /** Callback that creates a model from 'provider:model' (injected by the Runtime) */
  resolveModel: (spec: string | undefined) => Promise<BaseChatModel | undefined>
  /** Main model descriptor at spawn time: persisted with background sessions so cold resume returns to the same model */
  mainModelDescriptor?: SubAgentMainModelDescriptor
  /** Business tool construction (by the tool names declared by the subagent) */
  buildTools: (subAgent: SubAgentConfig) => StructuredToolInterface[]
  /** Record queue reference (injected while streaming) */
  queue: QueueRef
  /** Spill store reference (shared with the main graph for the same request; subagent tool output follows the same spill policy) */
  spillRef?: { current?: SpillStore }
  /** Subagent graph recursion limit (derived from main runtime constants) */
  recursionLimit: number
  /** Total tool call limit (the model-level "tool call rounds"; shares the same model setting as the main graph) */
  maxToolCalls: number
  /** Subagent memory root (<memoryPath>/workspace-<wsId>/, under which sub-agents/<name>/memories/AGENTS.md) */
  memoryPath?: string
  /** Skills directory (any subdirectory containing SKILL.md is a skill); subagents filter by their declared skills */
  skillsPath?: string
}

/** Subagent-specific memory file (AGENTS.md), consistent with the existing directory convention */
function loadSubAgentMemory(memoryPath: string | undefined, name: string): string {
  if (!memoryPath) return ''
  const memoryFile = path.join(memoryPath, 'sub-agents', name, 'memories', 'AGENTS.md')
  try {
    if (fs.existsSync(memoryFile)) {
      const content = fs.readFileSync(memoryFile, 'utf-8').trim()
      return content || ''
    }
  } catch (err) {
    logger.warn(`[SubAgent] Failed to read memory file ${memoryFile}:`, err)
  }
  return ''
}

/** Mount paths needed to build the subagent session prompt (shared by foreground spawn / background sessions / cold resume) */
export interface SubAgentPromptPaths {
  memoryPath?: string
  skillsPath?: string
}

/**
 * Build the subagent system prompt: base systemPrompt + dedicated memory + skills section +
 * team collaboration section.
 *
 * Extracted into a standalone export because cold resume (`subagent-resume.ts`) has no
 * `SubAgentRuntimeContext` (no main model / tool builder and other runtime dependencies)
 * yet must use exactly the same prompt rules as foreground/background sessions; otherwise
 * the resumed subagent's behavior would drift.
 */
export function buildSubAgentSessionPrompt(
  sa: SubAgentConfig,
  paths: SubAgentPromptPaths,
  teamMode: boolean
): string {
  let prompt = sa.systemPrompt

  const memory = loadSubAgentMemory(paths.memoryPath, sa.name)
  if (memory) {
    prompt += `\n\n## Long-term memory\n${memory}`
  }

  if (sa.skills && sa.skills.length > 0) {
    const skillsSection = buildSkillsPromptSection(
      loadSkills({ skillsPath: paths.skillsPath, enabledSkills: sa.skills })
    )
    if (skillsSection) {
      prompt += skillsSection
    }
  }

  prompt += subagentTeamPromptSection(teamMode)

  return prompt
}

/** Build the subagent system prompt (runtime-context version; delegates to the shared implementation) */
function buildSubAgentSystemPrompt(
  ctx: SubAgentRuntimeContext,
  sa: SubAgentConfig,
  teamMode: boolean
): string {
  return buildSubAgentSessionPrompt(
    sa,
    { memoryPath: ctx.memoryPath, skillsPath: ctx.skillsPath },
    teamMode
  )
}

/** Build the task tool description: static guidance + subagent list (name + description) */
function buildTaskDescription(subAgents: SubAgentConfig[]): string {
  if (subAgents.length === 0) {
    return 'Delegate complex work to a dedicated subagent. A subagent has its own system prompt and toolset, which suits subtasks that need focused handling. No subagent definitions are configured in this workspace yet: create one with agent_create (name/description/system_prompt/tools), then delegate to it with task.'
  }
  const list = subAgents
    .map((sa) => {
      const display = sa.rename && sa.rename !== sa.name ? `${sa.rename} (${sa.name})` : sa.name
      return `- ${display}: ${sa.description || '(no description)'}`
    })
    .join('\n')
  return `Delegate complex work to a dedicated subagent. A subagent has its own system prompt and toolset, which suits subtasks that need focused handling.

Available subagents:
${list}

Usage rules:
- Pick the subagent that best fits the task; pass its name field as subagent_type.
- A subagent's full output is shown to the user directly. Once the task finishes, just give a brief summary or wrap up; do not restate the detail the subagent already produced.`
}

/** Build the subagent graph input (systemPrompt + task message) */
function buildSubAgentMessages(
  systemPrompt: string,
  prompt: string
): (SystemMessage | HumanMessage)[] {
  return [new SystemMessage(systemPrompt), new HumanMessage(prompt)]
}

/** Subagent executor: compile the subgraph → stream → forward records → return the final text */
export function createTaskTool(ctx: SubAgentRuntimeContext): StructuredToolInterface {
  const availableNames =
    ctx.subAgents.length > 0
      ? `Available names: ${ctx.subAgents.map((s) => s.name).join(', ')}`
      : '(no subagents available)'
  const taskSchema = z.object({
    subagent_type: z
      .string()
      .describe(`Name of the subagent type to delegate to. ${availableNames}`),
    description: z.string().optional().describe('Short description of the task (for display)'),
    prompt: z.string().describe('Complete task instructions to hand to the subagent'),
    background: z
      .boolean()
      .optional()
      .describe(
        'When true, run in the background: returns a job_id immediately. Use job_output(job_id, wait=true) to poll for the result, job_list to inspect jobs, and job_kill to terminate. Suited to long-running tasks.'
      )
  })

  return tool(
    async ({ subagent_type, description, prompt, background }, config) => {
      const m = getAgentToolTexts()
      // Re-resolve at call time: agent_create / the settings page may have changed the config after the Runtime was constructed
      const subAgents = ctx.reloadSubAgents ? await ctx.reloadSubAgents() : ctx.subAgents
      const sa = subAgents.find((s) => s.name === subagent_type)
      if (!sa) {
        return mainFormat(m.subagent.notFound, {
          type: subagent_type,
          names: subAgents.map((s) => s.name).join(', ') || m.subagent.noneAvailable
        })
      }

      // Background mode: start a continuable subagent session (continued via send_message/list_agents/interrupt_agent),
      // and register the session run as a background job with the same name (monitored via job_output/job_kill)
      if (background) {
        const configurable = (config?.configurable ?? {}) as Record<string, unknown>
        const topicId = typeof configurable.topicId === 'number' ? configurable.topicId : 0
        const row = subagentSessions.start(topicId, sa, prompt, {
          mainModel: ctx.mainModel,
          resolveModel: ctx.resolveModel,
          buildTools: ctx.buildTools,
          recursionLimit: ctx.recursionLimit,
          maxToolCalls: ctx.maxToolCalls,
          spillRef: ctx.spillRef,
          extendSystemPrompt: (s) =>
            buildSubAgentSystemPrompt(ctx, s, teamModeStore.isEnabled(topicId)),
          mainModelDescriptor: ctx.mainModelDescriptor
        })
        return mainFormat(m.subagent.backgroundStarted, { id: row.id, label: row.label })
      }

      const causeId =
        ((config?.configurable as Record<string, unknown> | undefined)?.toolCallId as
          string | undefined) ?? 'unknown'
      // topicId from the parent graph's configurable: foreground subagents must also read/write this topic's shared task board
      const parentConfigurable = (config?.configurable ?? {}) as Record<string, unknown>
      const parentTopicId =
        typeof parentConfigurable.topicId === 'number' ? parentConfigurable.topicId : 0
      const queue = ctx.queue
      const push = (record: SubAgentRecord): void => queue.current?.push(record)

      // sub_start: frontend subagent activity block (started is emitted by the toolCalls stream's task record; this marks the content stream)
      push({ kind: 'sub_start', name: sa.name, causeId, description } satisfies SubAgentRecord)

      try {
        // Resolve the model (provider:model → model; fall back to the main model on failure)
        const model = (await ctx.resolveModel(sa.model)) ?? ctx.mainModel

        // Tools: business tools declared by the subagent
        const tools = ctx.buildTools(sa)
        // System prompt: base prompt + dedicated memory + skills section
        const systemPrompt = buildSubAgentSystemPrompt(
          ctx,
          sa,
          teamModeStore.isEnabled(parentTopicId)
        )

        // Compile the subagent subgraph (records are wrapped as sub_* records via subagentCtx)
        const graph = buildAgentGraph({
          model,
          tools,
          systemPrompt,
          queue,
          spill: ctx.spillRef?.current,
          subagentCtx: { name: sa.name, causeId },
          maxToolCalls: ctx.maxToolCalls
        })

        // Stream execution: forward tokens / reasoning / tool blocks as sub_* records and accumulate the final text.
        // Note: messages mode also emits ToolMessages from tool nodes; they must be filtered before
        // accumulating, otherwise tool result text would leak into the subagent's final output.
        const seenIndexes = new Set<number>()
        let fullText = ''
        try {
          const stream = await graph.stream(
            { messages: buildSubAgentMessages(systemPrompt, prompt) },
            {
              streamMode: ['messages'] as const,
              recursionLimit: ctx.recursionLimit,
              signal: config?.signal,
              // Team identity: foreground subagents also join the shared task board as members (id = dispatch call id)
              configurable: {
                topicId: parentTopicId,
                teamAgent: { id: `task-${causeId}`, name: sa.name, isLead: false }
              }
            }
          )
          for await (const item of stream) {
            if (config?.signal?.aborted) break
            // Each iterated element is a [mode, [message, metadata]] tuple
            const [, payload] = item as readonly [string, [StreamMessageLike, unknown]]
            const chunk = payload[0]
            const chunkType = chunk._getType?.()
            if (chunkType && chunkType !== 'ai') continue
            if (typeof chunk.content === 'string') fullText += chunk.content
            pushMessageRecords(chunk, { push: (r) => push(r as SubAgentRecord) }, seenIndexes, {
              name: sa.name,
              causeId
            })
          }

          const output = fullText.trim() || m.subagent.noTextOutput
          push({ kind: 'sub_end', name: sa.name, causeId, output } satisfies SubAgentRecord)
          // Append a suppression hint to the content returned to the main model: the subagent's full output
          // is already shown to the user directly, so the main model need not restate it (otherwise the subagent block and main content would duplicate).
          return `${output}\n\n(The above is the complete output of subagent ${sa.name} and has already been shown to the user directly. Do not restate it in your final answer; just wrap up briefly.)`
        } catch (err) {
          // Tool call rounds exhausted: return the partial content generated so far + a closing hint (instead of "execution failed")
          const isRecursion =
            err instanceof GraphRecursionError || (err as Error)?.name === 'GraphRecursionError'
          if (isRecursion) {
            logger.warn(
              `[SubAgent] ${sa.name} reached the tool call round limit, stopping automatically`
            )
            const output = fullText.trim()
              ? `${fullText.trim()}${m.subagent.roundLimitNote}`
              : m.subagent.roundLimitIncomplete
            push({ kind: 'sub_end', name: sa.name, causeId, output } satisfies SubAgentRecord)
            return output
          }
          const message = err instanceof Error ? err.message : String(err)
          logger.warn(`[SubAgent] ${sa.name} failed to run:`, err)
          const output = mainFormat(m.subagent.failed, { message })
          push({ kind: 'sub_end', name: sa.name, causeId, output } satisfies SubAgentRecord)
          return output
        }
      } catch (err) {
        // Failures in prerequisite steps such as model resolution / graph construction (errors in the streaming phase are handled by the inner catch)
        const message = err instanceof Error ? err.message : String(err)
        logger.warn(`[SubAgent] ${sa.name} failed to initialize:`, err)
        const output = mainFormat(m.subagent.failed, { message })
        push({ kind: 'sub_end', name: sa.name, causeId, output } satisfies SubAgentRecord)
        return output
      }
    },
    {
      name: 'task',
      description: buildTaskDescription(ctx.subAgents),
      schema: taskSchema
    }
  )
}
