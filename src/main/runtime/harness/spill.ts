import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import logger from 'electron-log'
import { mainFormat } from '../../i18n'
import { getFsToolTexts } from '../../i18n/tool-results-fs'
import { pruneOldestFiles } from './prune-oldest'

/**
 * Tool-result spill storage (spill)
 *
 * Mechanism:
 * - when a tool's final output exceeds the inline cap, it is no longer hard-truncated (losing data)
 *   but written in full to a spill file, and the model only gets a "bounded head/tail preview +
 *   spill file locator + retrieval hint";
 * - spill files live under the workspace or the memory directory and are mounted into the virtual
 *   file system (/.spill/ or /memories/spill/), so the model can search them with read_file / grep
 *   on demand;
 * - spilling is best-effort: when saving fails the raw result stays visible (no content lost);
 * - the number of spill files kept per topic is capped; the oldest ones are deleted beyond it
 *   (prevents disk bloat).
 */

/** Inline output cap (chars): beyond it output spills to a file and the model only gets a preview + locator */
export const MAX_INLINE_CHARS = 12_000
/** Head characters kept for the preview */
const PREVIEW_HEAD_CHARS = 8_000
/** Tail characters kept for the preview */
const PREVIEW_TAIL_CHARS = 2_000
/** Spill file cap kept per topic */
const MAX_FILES_PER_TOPIC = 100

/** Spill file descriptor (the virtual path lets the model access it through file tools) */
export interface SpillLocator {
  /** Access path in the virtual file system (e.g. /.spill/42/spill-<uuid>.txt) */
  virtualPath: string
}

/**
 * Topic-level spill store.
 *
 * Directory selection (consistent with the virtual file system mounts so the model can read the
 * files):
 * - AI workspace configured -> <workspacePath>/.spill/<topicId>/ (mounted as /.spill/...)
 * - otherwise the memory directory -> <memoryPath>/spill/<topicId>/ (mounted as
 *   /memories/spill/...)
 * - neither -> spill disabled (keeps the existing truncation behavior, best-effort)
 */
export class SpillStore {
  private readonly dir?: string
  private readonly virtualPrefix?: string
  /** Whether an async prune is running (merges duplicate scans triggered by concurrent writes) */
  private pruning = false

  constructor(workspacePath?: string, memoryPath?: string, topicId = 0) {
    if (workspacePath) {
      this.dir = path.join(workspacePath, '.spill', String(topicId))
      this.virtualPrefix = `/.spill/${topicId}/`
    } else if (memoryPath) {
      this.dir = path.join(memoryPath, 'spill', String(topicId))
      this.virtualPrefix = `/memories/spill/${topicId}/`
    }
  }

  /** Whether it is usable (spill is disabled when no directory is configured) */
  get enabled(): boolean {
    return !!this.dir && !!this.virtualPrefix
  }

  /**
   * Spill policy entry point: when the text is too long, save the full content and return the
   * model-visible "preview + locator" text; otherwise (or when saving fails) return it unchanged
   * (best-effort).
   */
  trySpill(text: string): string {
    if (!this.enabled || text.length <= MAX_INLINE_CHARS) return text
    try {
      return this.saveAndPreview(text)
    } catch (err) {
      logger.warn('[Spill] Failed to save spill file, falling back to raw text:', err)
      return text
    }
  }

  /** Save the full text to a spill file and return the model-visible preview + retrieval hint */
  private saveAndPreview(text: string): string {
    // The output text follows the UI language (it is rendered on the tool call card), so fetch the
    // current language inside the function
    const tr = getFsToolTexts()
    fs.mkdirSync(this.dir!, { recursive: true })

    const fileName = `spill-${randomUUID()}.txt`
    fs.writeFileSync(path.join(this.dir!, fileName), text, 'utf-8')
    // Write first, then prune: the directory never exceeds the cap after writing (pruning first
    // leaves a brief window with 101 files)
    this.prune()
    const virtualPath = `${this.virtualPrefix}${fileName}`

    const omitted = text.length - PREVIEW_HEAD_CHARS - PREVIEW_TAIL_CHARS
    const head = text.slice(0, PREVIEW_HEAD_CHARS)
    const tail = text.slice(-PREVIEW_TAIL_CHARS)
    const middle =
      omitted > 0
        ? `\n${mainFormat(tr.spill.middleOmitted, { omitted: omitted.toLocaleString() })}\n`
        : '\n'
    // Retrieval hint (read with offset/limit + grep search)
    const locator = mainFormat(tr.spill.locator, {
      total: text.length.toLocaleString(),
      virtualPath
    })
    return `${head}${middle}${tail}\n\n${locator}`
  }

  /** Delete the oldest spill files so each topic stays under the cap (async, never blocks the loop) */
  private prune(): void {
    if (!this.dir || this.pruning) return
    this.pruning = true
    void pruneOldestFiles(this.dir, {
      keep: MAX_FILES_PER_TOPIC,
      match: (name) => name.startsWith('spill-')
    }).finally(() => {
      this.pruning = false
    })
  }

  /**
   * Remove all spill files of a topic (called by the IPC layer when the topic is deleted).
   * Static: no instance state needed, it locates directories by the same convention.
   */
  static pruneTopic(workspacePath?: string, memoryPath?: string, topicId = 0): void {
    const candidates = [
      workspacePath ? path.join(workspacePath, '.spill', String(topicId)) : undefined,
      memoryPath ? path.join(memoryPath, 'spill', String(topicId)) : undefined
    ].filter((p): p is string => !!p)
    for (const dir of candidates) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        logger.warn('[Spill] Failed to purge spill directory:', err)
      }
    }
  }
}
