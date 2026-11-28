/**
 * Shared contract for subagent (agent) configuration.
 *
 * Why it lives in `shared/`:
 * - the settings page (renderer), the main process's IPC writes, and the tool that has the main
 *   agent delegate construction of a subagent (`agent_create`) must all follow **the same**
 *   naming / length / tool-name rules, otherwise you get "the UI can save it but the model tool
 *   rejects it" or the other way round;
 * - only pure functions and constants live here, no database/electron, so the renderer and the
 *   main process can import it directly, and node regressions such as
 *   `tests/subagent-draft.test.mts` can cover it directly.
 *
 * For the persisted shape see `src/main/database/schema/harness/agent.ts`; for the runtime shape
 * `SubAgentConfig` see `src/main/services/harness/types.ts`.
 */

/** Subagent identifier (the value of `task.subagent_type`): same rule as the settings page form */
export const SUBAGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/

/** Identifier length cap (the database column is text, but longer is meaningless in tool schemas/prompts) */
export const SUBAGENT_NAME_MAX_LENGTH = 32
/** Description cap: spliced into the `task` tool description, too long crowds out the main prompt */
export const SUBAGENT_DESCRIPTION_MAX_LENGTH = 200
/** System prompt cap: the subagent graph carries it on every request, too long slows every turn */
export const SUBAGENT_PROMPT_MAX_LENGTH = 8000
/** Tool count cap: the subagent tool set is built from the registry by name, more is meaningless */
export const SUBAGENT_TOOLS_MAX_LENGTH = 64

/** `provider:model` model override (optional); matches the runtime `resolveSubAgentModel` parsing convention */
export const SUBAGENT_MODEL_PATTERN = /^[^:\s]+:\S+$/

/** Draft (the common shape after normalizing the settings form / `agent_create` tool arguments) */
export interface SubAgentDraft {
  /** Unique identifier (unique within the workspace), also `task.subagent_type` */
  name: string
  /** UI display name (optional; the settings page labels it "display name") */
  displayName?: string
  /** Description: used in the capability list of the `task` tool */
  description: string
  /** System prompt */
  systemPrompt: string
  /** Available tool names (optional; when omitted the caller decides the inheritance scope) */
  tools?: string[]
  /** Optional model override `provider:model` */
  model?: string
  /** Enabled skill ids (optional) */
  skills?: string[]
}

/**
 * Validate the **pure format rules** of a draft (no database, no tool registry).
 *
 * Returns a human-readable error list (empty array = pass). The settings page can show the first
 * entry on the form directly; the main process's `agent_create` tool returns these errors to the
 * model as-is so it can correct its arguments.
 */
export function validateSubAgentDraft(draft: SubAgentDraft): string[] {
  const errors: string[] = []

  const name = draft.name?.trim() ?? ''
  if (!name) {
    errors.push('name is required')
  } else if (name.length > SUBAGENT_NAME_MAX_LENGTH) {
    errors.push(`name must be at most ${SUBAGENT_NAME_MAX_LENGTH} characters`)
  } else if (!SUBAGENT_NAME_PATTERN.test(name)) {
    errors.push('name must match ^[a-z][a-z0-9-]*$ (lowercase letters, digits, hyphen)')
  }

  const description = draft.description?.trim() ?? ''
  if (!description) {
    errors.push('description is required')
  } else if (description.length > SUBAGENT_DESCRIPTION_MAX_LENGTH) {
    errors.push(`description must be at most ${SUBAGENT_DESCRIPTION_MAX_LENGTH} characters`)
  }

  const systemPrompt = draft.systemPrompt?.trim() ?? ''
  if (!systemPrompt) {
    errors.push('systemPrompt is required')
  } else if (systemPrompt.length > SUBAGENT_PROMPT_MAX_LENGTH) {
    errors.push(`systemPrompt must be at most ${SUBAGENT_PROMPT_MAX_LENGTH} characters`)
  }

  if (draft.model != null && draft.model.trim() !== '') {
    if (!SUBAGENT_MODEL_PATTERN.test(draft.model.trim())) {
      errors.push('model must be in "provider:model" form')
    }
  }

  if (draft.tools != null) {
    if (draft.tools.length > SUBAGENT_TOOLS_MAX_LENGTH) {
      errors.push(`tools must contain at most ${SUBAGENT_TOOLS_MAX_LENGTH} entries`)
    }
    if (draft.tools.some((tool) => !tool.trim())) {
      errors.push('tools must not contain empty names')
    }
  }

  if (draft.skills != null && draft.skills.some((skill) => !skill.trim())) {
    errors.push('skills must not contain empty ids')
  }

  return errors
}
