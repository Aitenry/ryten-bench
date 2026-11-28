import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import { pruneOldestFiles } from './prune-oldest'

/**
 * Tool result detail store (the side channel for the raw result of built-in tools).
 *
 * Difference from spill (the overflow strategy): spill is **for the model** — it only saves when
 * output is oversized, and it puts the file inside the workspace so the model can search it with
 * read_file/grep; this store is **for humans** — built-in tool results are no longer sent over IPC
 * or persisted, chat keeps only a card, and when the user expands it the main process reads this
 * detail (ls entries, glob path list, grep matching lines, execute stdout).
 *
 * Location: <userData>/tool-output/<topicId>/<callId>.txt
 *  - In userData rather than the workspace: the workspace is mounted as the virtual '/', so
 *    dropping files there would pollute the user's project and show up in the model's own
 *    ls/glob results (the spill directory is model-visible, this one is deliberately not shared);
 *  - Per-topic subdirectories: deleting a topic removes the whole directory, matching the cleanup
 *    rules of spill / todo / goal;
 *  - Each topic has a file-count cap; the oldest files are deleted when it is exceeded (prevents
 *    disk growth in long sessions).
 *
 * This module does not import electron: the directory is injected by the caller (at main-process
 * startup), so it can be verified directly by offline scripts.
 */

/** Maximum number of detail files kept per topic */
const MAX_FILES_PER_TOPIC = 300

/**
 * Size limit for one detail (characters): beyond it nothing extra is saved (and the card hides
 * "view details")
 */
export const MAX_DETAIL_CHARS = 512_000

export class ToolOutputStore {
  private readonly baseDir: string
  /**
   * Topics currently being pruned (serialized/merged so concurrent writes do not trigger repeated
   * full-directory scans)
   */
  private readonly pruning = new Set<number>()

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  /** Full path: <baseDir>/<topicId>/<callId>.txt */
  private filePath(topicId: number, callId: string): string {
    return path.join(this.baseDir, String(topicId), `${sanitizeCallId(callId)}.txt`)
  }

  /**
   * Save one detail; returns whether it succeeded (failures are best-effort and do not affect the
   * main flow)
   */
  save(topicId: number, callId: string, text: string): boolean {
    if (!topicId || !callId) return false
    if (!text || text.length > MAX_DETAIL_CHARS) return false
    try {
      fs.mkdirSync(path.join(this.baseDir, String(topicId)), { recursive: true })
      fs.writeFileSync(this.filePath(topicId, callId), text, 'utf-8')
      this.prune(topicId)
      return true
    } catch (err) {
      logger.warn('[ToolOutput] Failed to save tool result detail:', err)
      return false
    }
  }

  /** Read one detail; returns null when it does not exist */
  read(topicId: number, callId: string): string | null {
    if (!callId) return null
    const exact = topicId ? this.readAt(topicId, callId) : null
    if (exact !== null) return exact
    // When the topic does not match, fall back to scanning by callId (branch persistence: a
    // branch session copies the blocks into a new topic, so the card still carries the original
    // callId while the detail file stays in the original topic directory — without the fallback
    // the card could only show "details unavailable")
    return this.readAcrossTopics(callId)
  }

  /** Read exactly from the topic directory */
  private readAt(topicId: number, callId: string): string | null {
    try {
      return fs.readFileSync(this.filePath(topicId, callId), 'utf-8')
    } catch {
      return null
    }
  }

  /** Fall back to searching across topic directories by file name (the newest one wins) */
  private readAcrossTopics(callId: string): string | null {
    const name = `${sanitizeCallId(callId)}.txt`
    let topics: fs.Dirent[]
    try {
      topics = fs.readdirSync(this.baseDir, { withFileTypes: true })
    } catch {
      return null
    }
    let best: { text: string; mtime: number } | null = null
    for (const topic of topics) {
      if (!topic.isDirectory()) continue
      const full = path.join(this.baseDir, topic.name, name)
      try {
        const stat = fs.statSync(full)
        if (best && stat.mtimeMs <= best.mtime) continue
        best = { text: fs.readFileSync(full, 'utf-8'), mtime: stat.mtimeMs }
      } catch {
        // This topic does not have this detail; keep looking
      }
    }
    return best?.text ?? null
  }

  /** Remove every detail of a topic (called when the topic is deleted) */
  removeTopic(topicId: number): void {
    if (!topicId) return
    try {
      fs.rmSync(path.join(this.baseDir, String(topicId)), { recursive: true, force: true })
    } catch (err) {
      logger.warn('[ToolOutput] Failed to purge tool result detail:', err)
    }
  }

  /**
   * Delete the oldest files so a topic stays under its file cap (write first, then prune — same
   * rule as spill)
   */
  private prune(topicId: number): void {
    // Asynchronous pruning (performance audit P19): with dense tool calls, synchronous
    // readdir/stat/unlink would block the event loop.
    // Pruning of the same topic is serialized and merged, so concurrent writes do not trigger
    // repeated full-directory scans.
    if (this.pruning.has(topicId)) return
    this.pruning.add(topicId)
    const dir = path.join(this.baseDir, String(topicId))
    void pruneOldestFiles(dir, {
      keep: MAX_FILES_PER_TOPIC,
      match: (name) => name.endsWith('.txt')
    }).finally(() => this.pruning.delete(topicId))
  }
}

/**
 * callId may come from a third-party provider (containing / \ : etc.); normalize it into a safe
 * file name
 */
function sanitizeCallId(callId: string): string {
  return callId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

// ── Process-level singleton (directory injected at startup; unconfigured operations are no-ops) ──

let store: ToolOutputStore | null = null

/** Inject the storage directory at main-process startup (userData/tool-output) */
export function configureToolOutputStore(baseDir: string): void {
  store = new ToolOutputStore(baseDir)
}

/** Get the process-level store; returns null when unconfigured */
export function getToolOutputStore(): ToolOutputStore | null {
  return store
}
