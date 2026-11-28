import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'
import { createSubAgentDefinition } from '../../services/harness/subagents'
import {
  SUBAGENT_DESCRIPTION_MAX_LENGTH,
  SUBAGENT_NAME_MAX_LENGTH,
  SUBAGENT_NAME_PATTERN,
  SUBAGENT_PROMPT_MAX_LENGTH
} from '../../../shared/harness/subagent'

/**
 * Subagent authoring tool (`agent_create`) — the main agent can "delegate the construction" of a
 * reusable subagent config.
 *
 * It writes through the same service path as the Settings "Agents" page
 * (`services/harness/subagents.ts`):
 * - validation/normalization/persistence/cache invalidation are shared, so there is only one set of
 *   rules;
 * - after creation it writes an `agent_config` row (isolated per workspace, kept across restarts)
 *   that the user can see and edit in Settings;
 * - the `task` tool re-resolves the subagent list at call time, so a just-created subagent can be
 *   dispatched **within the same turn**;
 * - the tool is mounted only on the main agent (lead); subagents get no authoring ability, which
 *   prevents recursive agent creation.
 *
 * The model authors an `agent_config` row (its fields map one-to-one to the authoring inputs).
 */
export interface AgentAuthoringContext {
  /** Current workspace id: configs are isolated per workspace and it must already exist */
  workspaceId: number
  /** Main agent tool names this turn (a new subagent inherits this list when `tools` is omitted) */
  availableToolNames: string[]
}

export function createAgentAuthoringTool(ctx: AgentAuthoringContext): StructuredToolInterface {
  /** Default toolset: inherits the main agent's real tools this turn (internal tools are filtered out by the registry when building subagent tools) */
  const defaultTools = Array.from(new Set(ctx.availableToolNames))

  const schema = z.object({
    name: z
      .string()
      .min(1)
      .max(SUBAGENT_NAME_MAX_LENGTH)
      .describe(
        `Unique identifier of the new subagent (matches ${SUBAGENT_NAME_PATTERN}). It is also the task(subagent_type=...) value and must not collide with an existing subagent.`
      ),
    display_name: z
      .string()
      .optional()
      .describe('Human-readable display name (optional; falls back to name).'),
    description: z
      .string()
      .min(1)
      .max(SUBAGENT_DESCRIPTION_MAX_LENGTH)
      .describe(
        'One-line capability description. It is shown in the task tool catalog so you/other turns know what this subagent is for.'
      ),
    system_prompt: z
      .string()
      .min(1)
      .max(SUBAGENT_PROMPT_MAX_LENGTH)
      .describe(
        'Complete system prompt for the subagent: role, working rules, output expectations. It has its own toolset/model and does not see this conversation history.'
      ),
    tools: z
      .array(z.string())
      .optional()
      .describe(
        `Tool names the subagent may use (real tool names only). Omit to inherit the main agent's current toolset (${defaultTools.length} tools).`
      ),
    model: z
      .string()
      .optional()
      .describe('Optional "provider:model" override. Omit to inherit the main model.'),
    skills: z.array(z.string()).optional().describe('Optional enabled skill ids; omit for none.')
  })

  return tool(
    async (args) => {
      const m = getAgentToolTexts()
      try {
        const result = await createSubAgentDefinition({
          workspaceId: ctx.workspaceId,
          name: args.name,
          displayName: args.display_name,
          description: args.description,
          systemPrompt: args.system_prompt,
          tools: args.tools ?? defaultTools,
          model: args.model,
          skills: args.skills
        })
        return mainFormat(m.agentAuthoring.created, {
          name: result.config.name,
          id: result.id
        })
      } catch (err) {
        // A validation failure is an input error the model can fix itself: return readable text so
        // it can retry instead of failing the whole turn
        return mainFormat(m.agentAuthoring.failed, {
          message: err instanceof Error ? err.message : String(err)
        })
      }
    },
    {
      name: 'agent_create',
      description:
        'Create a reusable subagent definition for the current workspace when no configured subagent fits the work. The definition persists (visible/editable in Settings → Agents), and task(subagent_type=<name>) can delegate to it immediately, including later in this same turn. Prefer existing subagents; do not recreate one that already exists.',
      schema
    }
  )
}
