import logger from 'electron-log'
import type { SubAgentConfig, SubAgentMainModelDescriptor } from '../../services/harness/types'
import { MAX_TOOL_CALLS, MIN_TOOL_CALLS } from './agent'
import { subagentSessions } from './subagent-sessions'
import { getMnemonComponent } from '../../services/harness/mnemon-singleton'

/**
 * Background memory-curation subagent — the actual executor of "save to memory" in the message action
 * bar.
 *
 * Why not write directly: hot memory holds "long-term facts for every future turn", and a single
 * assistant reply is often thousands of words; truncating that into MEMORY would only fill up hot
 * memory with a pile of one-off progress. The right approach is a dedicated subagent that reads this
 * turn's Q&A, decides which parts are **reusable facts** (user preferences, project decisions,
 * environment pitfalls, failure lessons), then decides which layer to store them in (hot memory /
 * project documents / long-term memory space) and writes them itself.
 *
 * Benefits of reusing the existing background subagent system (subagentSessions):
 * - The merged "collaboration" entry in the top bar automatically shows the subagent item; clicking it
 *   shows the live session, with no new UI needed;
 * - It is also registered as a background job of the same name (manageable via job_output/job_kill);
 * - It is cleaned up by clearTopic when the topic is deleted.
 *
 * The tool set deliberately contains only mnemon_* (no filesystem/business tools): this agent's scope
 * is memory itself.
 */

/** Subagent identifier (the top-bar display name goes through an i18n template; a stable ASCII name is used here) */
export const MEMORY_AGENT_NAME = 'memory-curator'

/** Cap on the answer length read per curation: overly long answers are truncated to the first N characters to avoid stuffing a whole file into the prompt */
const MAX_SOURCE_CHARS = 20_000

/** System prompt (prompts are always English, consistent with the rest of the project) */
export const MEMORY_AGENT_PROMPT = `You are the memory curator: a background subagent that runs when the user marks one assistant reply as worth remembering.

Your job is to decide what from that exchange deserves long-term memory and to store it yourself with the Mnemon tools. Never just report what should be stored — actually store it.

Worth keeping (durable, reusable):
- user preferences, habits, and corrections that should change future behaviour;
- project decisions, conventions, and the reason behind them;
- environment facts, tool quirks, and lessons learned from failures.

Never store: transient progress, completed-work logs, raw dumps, one-off values, secrets, or anything already stored.

How to store:
- Your system prompt already carries the current hot memory and the Mnemon routing rules: never duplicate an entry that is already there — use replace when an existing entry can be made more precise.
- Before writing something new into project documents or a memory space, search first (mnemon_document_search / mnemon_recall) so you merge instead of duplicating.
- Hot memory via mnemon_runtime_memory: target "user" only for who the user is; target "memory" for project, environment and tool facts. Keep entries compact and self-contained.
- Substantial structured knowledge (architecture notes, multi-step recipes, evidence) belongs in a project document via mnemon_document_manage.
- Reusable conclusions can also go to a long-term memory space with mnemon_remember; search first (mnemon_recall) so you merge instead of duplicating.
- Record facts, not commentary: no "the user asked me to remember", no dates unless the date is the point.

Finish with 1-3 lines: what you stored and where.`

export interface StartMemoryAgentParams {
  /** Owning topic (the top bar lists background agents by topic) */
  topicId: number
  /** Assistant reply body (the material to curate) */
  answer: string
  /** The user question of that turn (only the answer is curated when unavailable) */
  question?: string
  /** Current workspace (memory is isolated per workspace) */
  workspaceId: number
  /**
   * The memory scope **string** for this session (`plugin:<id>` / `chat`; empty = workspace).
   * main/memory-scope.ts and shared/memory-scope.ts define this: a plugin session lands in that
   * plugin's own directory, "chat" mode lands in `<memoryPath>/chat/`, with zero crossover with
   * working memory.
   */
  memoryScope?: string | null
  /** Memory storage root; the memory system is entirely unavailable when not configured */
  memoryPath?: string
  /** Provider ID; the default provider is used when omitted */
  providerId?: number
  /** Model-level "tool call rounds" limit */
  maxToolRounds?: number
}

export type StartMemoryAgentResult =
  | { ok: true; agentId: string; label: string }
  | { ok: false; reason: 'memory-disabled' | 'no-model' | 'model-failed'; message?: string }

/**
 * Resolve the provider ID: explicit argument > default provider in settings > first enabled one.
 *
 * `ProviderService.createModel()` deliberately no longer falls back to the default provider (it
 * requires an explicit ID; chat turns pass the currently selected model from the frontend). This
 * button path has no "current selection" at all, so a fallback chain is added here; otherwise a
 * providerId of undefined would always throw "target model does not exist".
 */
async function resolveProviderId(explicit?: number): Promise<number | undefined> {
  if (explicit != null) return explicit
  const { getDefaultProvider, getEnabledProviders } = await import('../../database/mapper/provider')
  const preferred = await getDefaultProvider()
  if (preferred) return preferred.id
  const enabled = await getEnabledProviders()
  return enabled[0]?.id
}

/** Assemble the task message handed to the subagent (material + explicit wrap-up requirement) */
export function buildTaskMessage(answer: string, question?: string): string {
  const trimmedAnswer = answer.trim()
  const body =
    trimmedAnswer.length > MAX_SOURCE_CHARS
      ? `${trimmedAnswer.slice(0, MAX_SOURCE_CHARS)}\n\n[... truncated at ${MAX_SOURCE_CHARS} characters ...]`
      : trimmedAnswer
  const ask = question?.trim()
  return [
    'Curate this exchange and store what is worth keeping long-term.',
    '',
    '## User question',
    ask || '(not available)',
    '',
    '## Assistant answer',
    body,
    '',
    'Store the durable parts with the Mnemon tools, then reply with 1-3 lines describing what you stored and where.'
  ].join('\n')
}

/**
 * Start a memory-curation subagent (returns immediately, without waiting for it to finish).
 *
 * Model and guards share the same source as the main turn: the provider is decided by the caller
 * (defaulting to the default provider), and "tool call rounds" comes from that model's settings,
 * clamped between MIN_TOOL_CALLS..MAX_TOOL_CALLS.
 */
export async function startMemoryAgent(
  params: StartMemoryAgentParams
): Promise<StartMemoryAgentResult> {
  const mnemon = getMnemonComponent(params.memoryPath, params.workspaceId, params.memoryScope)
  if (!mnemon) return { ok: false, reason: 'memory-disabled' }

  // Lazy import: same approach as resolveSubAgentModel in runtime.ts; the module itself is not tied to
  // the provider layer
  const { getProviderService } = await import('../../provider/service')
  const providerService = getProviderService()

  let providerId: number | undefined
  try {
    providerId = await resolveProviderId(params.providerId)
  } catch (err) {
    return { ok: false, reason: 'model-failed', message: (err as Error)?.message }
  }
  if (providerId == null) return { ok: false, reason: 'no-model' }

  let model
  let usedProviderId = providerId
  try {
    model = await providerService.createModel(providerId)
  } catch (err) {
    // The specified provider may have been disabled/deleted (e.g. it was the model used by that
    // reply): fall back to the default provider instead of letting the button die; only error if the
    // fallback also fails.
    const fallbackId = await resolveProviderId(undefined).catch(() => undefined)
    if (fallbackId != null && fallbackId !== providerId) {
      logger.warn(
        `[MemoryAgent] Provider ${providerId} unavailable, falling back to ${fallbackId}: ${(err as Error)?.message}`
      )
      try {
        model = await providerService.createModel(fallbackId)
        if (model) usedProviderId = fallbackId
      } catch {
        /* falls through to the failure return below */
      }
    }
    if (!model) return { ok: false, reason: 'model-failed', message: (err as Error)?.message }
  }

  // Model descriptor at spawn time: after the session is persisted, a cold resume still returns to
  // the model this memory-curation task used
  let modelDescriptor: SubAgentMainModelDescriptor | undefined
  try {
    const providerConfig = await providerService.getConfig(usedProviderId)
    modelDescriptor = { providerId: providerConfig.id, model: providerConfig.model }
  } catch {
    /* The descriptor only affects cold-resume fidelity; falling back to the default provider is fine when it is unavailable */
  }

  const maxToolCalls = Math.max(MIN_TOOL_CALLS, Math.floor(params.maxToolRounds ?? MAX_TOOL_CALLS))
  const config: SubAgentConfig = {
    name: MEMORY_AGENT_NAME,
    description: 'Summarises a conversation turn and writes the durable parts into Mnemon memory.',
    systemPrompt: MEMORY_AGENT_PROMPT
  }

  const row = subagentSessions.start(
    params.topicId,
    config,
    buildTaskMessage(params.answer, params.question),
    {
      mainModel: model,
      mainModelDescriptor: modelDescriptor,
      // Do not parse 'provider:model': memory curation follows the current default model, without
      // picking a model separately
      resolveModel: async () => undefined,
      // Memory tools only: this agent does not touch the filesystem or business data
      buildTools: () => mnemon.tools,
      recursionLimit: maxToolCalls * 2 + 20,
      maxToolCalls,
      // Memory routing rules (when to use hot memory/documents/spaces) share the same source as the
      // main agent, preventing it from writing facts to the wrong layer
      extendSystemPrompt: () => `${MEMORY_AGENT_PROMPT}${mnemon.promptSections.join('')}`
    }
  )

  return { ok: true, agentId: row.id, label: row.label }
}
