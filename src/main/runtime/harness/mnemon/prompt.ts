import type { RuntimeMemoryController } from './runtime-memory'
import { RUNTIME_ENTRY_DELIMITER } from './types'

/**
 * Mnemon system prompt injection
 *
 * Two prompt sections:
 * - `mnemon:routing`: layered query boundaries (when to use which memory layer);
 * - `mnemon:runtime-memory`: USER.md / MEMORY.md content + saving rules.
 */

/** Layered query boundaries (routing section) */
export function buildRoutingSection(): string {
  return `\n\n## Memory System (Mnemon)
This workspace has three memory layers:
1. **Hot memory** (runtime memory): the compact user profile (USER) and project memory (MEMORY) injected directly into every turn; it is the context available immediately in the current turn.
2. **Project Documents**: complete Markdown design/procedure/handover documents; read them in full, fast, with mnemon_document_search.
3. **Long-term Memory Spaces**: stable insights accumulated across sessions; recall them on demand with mnemon_recall.

Query order: current conversation and repository facts → hot memory (already in context) → project document search → long-term Memory Space recall → trace cold references only when you need the full text.
If the user already provided the current facts, or the repository can answer directly, do not recall merely to "show memory".`
}

/** Hot memory content + saving rules (runtime-memory section) */
export function buildRuntimeMemorySection(controller: RuntimeMemoryController): string {
  const snapshot = controller.snapshot()
  const userEntries = snapshot.entries.filter((e) => e.target === 'user')
  const memoryEntries = snapshot.entries.filter((e) => e.target === 'memory')

  let section = `\n\n## Runtime Memory (injected every turn; check for duplicates before saving)
### User Profile (USER, capacity ${snapshot.targets.user.used}/${snapshot.targets.user.limit} bytes)`
  if (userEntries.length === 0) {
    section += `\n(none yet)`
  } else {
    section += `\n` + userEntries.map((e) => `- ${e.content}`).join('\n')
  }
  section += `\n\n### Project Memory (MEMORY, capacity ${snapshot.targets.memory.used}/${snapshot.targets.memory.limit} bytes)`
  if (memoryEntries.length === 0) {
    section += `\n(none yet)`
  } else {
    section += `\n` + memoryEntries.map((e) => `- ${e.content}`).join('\n')
  }
  section += `\n\n### Saving Rules
- **Hot memory (mnemon_runtime_memory)**: explicit user preferences, stable project conventions, environment facts, and frequently reused lessons; target=user stores identity/role/long-term preferences/communication style, target=memory stores project/environment/decisions/conventions/reusable lessons; importance=critical|normal|low sets the compaction priority; never add content that is already present verbatim; replace/remove must pass a unique substring.
- **Project Documents (mnemon_document_manage)**: designs, investigations, procedures, or handovers that form a complete structure and rationale.
- **Long-term spaces (mnemon_remember)**: stable insights that must persist across tasks, or that benefit from graph relations and deep recall.
- **Skip**: questions, guesses, temporary progress, completed-work logs, raw dumps, secrets, and repository facts that are easy to rediscover.`
  return section
}

export { RUNTIME_ENTRY_DELIMITER }
