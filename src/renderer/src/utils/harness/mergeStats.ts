import { getChunks } from '@codemirror/merge'
import { type EditorState } from '@codemirror/state'
import type { FileChangeView } from '../../types/harness/file-change'

/** Diff size: chunk count / added lines / removed lines */
export interface MergeStats {
  chunks: number
  added: number
  removed: number
}

/**
 * The **single algorithm** behind the stats line in the diff toolbar
 * (`{{count}} changes · +{{added}} −{{removed}}`).
 *
 * It is extracted as a pure function so it can be verified outside React: what `getChunks`
 * actually returns in each situation has to be measured on a **real editor**, not inferred
 * from reading the code (tooling: scripts/probe-diff-stats.mjs).
 *
 * The only "cannot compute the diff" case: **no pre-change snapshot** (`hasBefore=false` — a new
 * file, or a write captured by the file watcher while a command was running). The diff view
 * doesn't mount `unifiedMergeView` on that branch at all, so `getChunks(state)` returns `null`
 * directly and the stats can only fall back to the **stats carried by the change record**
 * (computed when persisting, the same source as the history list and the explorer badges).
 *
 * This is exactly the "new file shows 0 changes · +0 −0" report from the user on 2026-09-23:
 * the whole body is marked as added while the stats line says 0 — the old implementation wrote
 * `{chunks:0, added:0, removed:0}` whenever `!result`, mistaking "there is no merge view here"
 * for "there are no changes here".
 *
 * The `Array.isArray` guard is pure defence: the library docs say `getChunks` may return
 * `{ chunks: null }` (the initial value of `ChunkField.create` is null), but in 6.12.2
 * `unifiedMergeView` builds chunks synchronously in the constructor through `ChunkField.init`,
 * so the constructed state is already an array and this branch is currently unreachable.
 */
export function computeMergeStats(
  state: EditorState | null,
  original: string | null,
  fallback: Pick<FileChangeView, 'added' | 'removed'>
): MergeStats {
  // No editor instance (first frame) / no original (snapshot not read back yet): honestly report
  // 0, don't claim the numbers from the record
  if (!state || original === null) return { chunks: 0, added: 0, removed: 0 }

  const result = getChunks(state)
  // No merge view (unifiedMergeView not mounted): fall back to the stats carried by the record.
  // The chunk count is 1: this record semantically is **one whole** change (the entire file is
  // added/removed), and reporting 0 would contradict "+14" (exactly the unreadable
  // "0 changes · +0 −0" the user saw).
  if (!result || !Array.isArray(result.chunks)) {
    return { chunks: 1, added: fallback.added, removed: fallback.removed }
  }

  let added = 0
  let removed = 0
  for (const chunk of result.chunks) {
    const aStartLine = original.slice(0, chunk.fromA).split('\n').length
    const aEndLine = original.slice(0, chunk.toA).split('\n').length
    const bStartLine = state.doc.lineAt(chunk.fromB).number
    const bEndLine = state.doc.lineAt(Math.min(chunk.toB, state.doc.length)).number
    removed += Math.max(0, aEndLine - aStartLine)
    added += Math.max(0, bEndLine - bStartLine + (chunk.toB > chunk.fromB ? 1 : 0))
  }
  return { chunks: result.chunks.length, added, removed }
}
