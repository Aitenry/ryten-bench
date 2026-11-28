/**
 * Turn blocks → "what this scheduled run actually did" (pure, no electron / no DB).
 *
 * The run record stores the conversation and reply id; the panel's process list and artifact list
 * are derived from that reply's message blocks on the main process side when the run finishes:
 *
 * - **steps**: every completed tool call, in order, with its path when the tool card has one
 *   (`write_file` / `read_file` / `grep` …). Failed calls keep `status: 'error'` so the panel can
 *   show where it broke.
 * - **artifacts**: files written by `write_file` / `edit_file` / `apply_patch` (kind `file`) plus
 *   files declared with the `present` tool (kind `deliverable`, description kept).
 *
 * Reads and searches are steps, not artifacts: a run "produced" only what it wrote or declared.
 */
import type { ScheduleRunArtifact, ScheduleRunStep } from './schedule-types'

/** Per-tool-call shape we care about (subset of the persisted ToolCall) */
interface BlockToolLike {
  name?: unknown
  status?: unknown
  input?: unknown
  card?: unknown
}

interface BlockLike {
  type?: unknown
  tool?: BlockToolLike
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch'])
/** Bookkeeping tools: they show up as artifacts / UI affordances, not as process steps */
const NON_STEP_TOOLS = new Set(['present', 'propose_action'])

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function pathOf(tool: BlockToolLike): string | null {
  const card = tool.card as { path?: unknown } | undefined
  return str(card?.path) ?? str((tool.input as { file_path?: unknown } | undefined)?.file_path)
}

/** Parse the dialogue's `blocks` JSON (any malformed value → empty result) */
function parseBlocks(raw: string | null | undefined): BlockLike[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as BlockLike[]) : []
  } catch {
    return []
  }
}

export function extractRunSteps(blocksJson: string | null | undefined): {
  steps: ScheduleRunStep[]
  artifacts: ScheduleRunArtifact[]
} {
  const steps: ScheduleRunStep[] = []
  const artifacts: ScheduleRunArtifact[] = []
  /** One entry per path: a file that was written **and** declared stays one artifact, upgraded to
   * `deliverable` (it keeps the description and the order of first appearance) */
  const byPath = new Map<string, ScheduleRunArtifact>()

  for (const block of parseBlocks(blocksJson)) {
    if (block?.type !== 'tool') continue
    const tool = block.tool
    const name = str(tool?.name)
    if (!tool || !name) continue

    const finished = tool.status === 'completed' || tool.status === undefined
    const cardStatus = (tool.card as { status?: unknown } | undefined)?.status
    const failed = cardStatus === 'error'
    if (!NON_STEP_TOOLS.has(name)) {
      if (finished && !failed) {
        steps.push({ name, path: pathOf(tool), status: 'ok' })
      } else if (failed) {
        steps.push({ name, path: pathOf(tool), status: 'error' })
      }
    }

    const kind = name === 'present' ? 'deliverable' : WRITE_TOOLS.has(name) ? 'file' : null
    if (!kind) continue
    if (kind === 'deliverable') {
      const files = (tool.input as { files?: unknown } | undefined)?.files
      if (!Array.isArray(files)) continue
      for (const file of files as Array<{ path?: unknown; description?: unknown }>) {
        const path = str(file?.path)
        if (!path) continue
        const previous = byPath.get(path)
        byPath.set(path, {
          kind: 'deliverable',
          path,
          description: str(file?.description) ?? previous?.description ?? null
        })
      }
      continue
    }
    const path = pathOf(tool)
    if (!path || !finished || failed || byPath.has(path)) continue
    byPath.set(path, { kind: 'file', path, description: null })
  }

  artifacts.push(...byPath.values())
  return { steps, artifacts }
}
