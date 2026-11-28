import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'
import { BaseChatModel } from '../../ai/chat-model'
import type { QueueRef } from './agent'
import logger from 'electron-log'
import * as fs from 'fs'
import * as path from 'path'
import { buildSkillsPromptSection, loadSkills } from './skills-core'
import type { SpillStore } from './spill'
import { subagentSessions, type SubagentSessionRuntime } from './subagent-sessions'
import { subagentTeamPromptSection, teamModeStore } from './team-mode'
import type { SubAgentConfig, SubAgentMainModelDescriptor } from '../../services/harness/types'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'

/**
 * Subagent (task tool): delegates work to dedicated subagents.
 *
 * Mechanics (2026-11-28 unified UI):
 * - every call starts a **subagent session** (`subagentSessions.start`) and returns immediately;
 *   the transcript therefore always lives in the top-bar subagent list and the main conversation
 *   only receives a compact "dispatched" card (see stream-producers);
 * - delegation is non-blocking: the model continues its turn and calls `job_output(job_id,
 *   wait=true)` when it needs the result (or `send_message` to continue the session);
 * - the model is resolved from 'provider:model', falling back to the main model (a missing
 *   dependency degrades instead of failing);
 * - the subagent list (name/description) is injected dynamically into the task tool
 *   description and schema, so the main model can decide whether to delegate and which
 *   subagent to pick.
 */

/** Subagent runtime context */
export interface SubAgentRuntimeContext {
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
  /** Main model descriptor at spawn time: persisted with subagent sessions so cold resume returns to the same model */
  mainModelDescriptor?: SubAgentMainModelDescriptor
  /** Business tool construction (by the tool names declared by the subagent) */
  buildTools: (subAgent: SubAgentConfig) => StructuredToolInterface[]
  /** Record queue reference (no longer consumed by the task tool itself; kept for callers) */
  queue?: QueueRef
  /** Spill-store reference (shared with the main graph for the same request) */
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

/** Mount paths needed to build the subagent session prompt (shared by task / background sessions / cold resume) */
export interface SubAgentPromptPaths {
  memoryPath?: string
  skillsPath?: string
}

/**
 * Build the subagent system prompt: base systemPrompt + dedicated memory + skills section +
 * team collaboration section.
 *
 * Extracted as a standalone export because cold resume (`subagent-resume.ts`) has no
 * `SubAgentRuntimeContext` (no main model / tool builder and other runtime dependencies)
 * yet must use exactly the same prompt rules as every session run; otherwise the resumed
 * subagent's behavior would drift.
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
- Dispatch returns immediately (non-blocking). If the next step depends on the subagent's result, call job_output(job_id, wait=true) before continuing; otherwise keep working and poll later.
- Every delegation runs as a subagent session shown in the top-bar subagent list; the conversation only shows a compact dispatch card. The subagent's full output is shown to the user there.`
}

/** Subagent executor: start the shared session machinery and return its receipt (non-blocking) */
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
    prompt: z.string().describe('Complete task instructions to hand to the subagent')
  })

  return tool(
    async ({ subagent_type, prompt }, config) => {
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

      const configurable = (config?.configurable ?? {}) as Record<string, unknown>
      const topicId = typeof configurable.topicId === 'number' ? configurable.topicId : 0
      const runtime: SubagentSessionRuntime = {
        mainModel: ctx.mainModel,
        resolveModel: ctx.resolveModel,
        buildTools: ctx.buildTools,
        recursionLimit: ctx.recursionLimit,
        maxToolCalls: ctx.maxToolCalls,
        spillRef: ctx.spillRef,
        extendSystemPrompt: (s) =>
          buildSubAgentSessionPrompt(
            s,
            { memoryPath: ctx.memoryPath, skillsPath: ctx.skillsPath },
            teamModeStore.isEnabled(topicId)
          ),
        mainModelDescriptor: ctx.mainModelDescriptor
      }
      // Non-blocking: start the session and return the receipt immediately. The session runs in
      // the top-bar list; the model polls job_output(job_id, wait=true) when it needs the result,
      // and keeps working otherwise.
      const row = subagentSessions.start(topicId, sa, prompt, runtime)
      return mainFormat(m.subagent.backgroundStarted, { id: row.id, label: row.label })
    },
    {
      name: 'task',
      description: buildTaskDescription(ctx.subAgents),
      schema: taskSchema
    }
  )
}
