/**
 * Line-level diff statistics (pure functions, no IO / no Electron dependency, verifiable
 * directly by a node script).
 *
 * Purpose: produce a "+N −M" when a change record is stored, for explorer badges, the history
 * list and hover details. The precise line-level diff (CodeMirror's merge view) is computed in
 * the renderer — that is where the real editor document lives; here we only need a fast enough
 * and accurate enough statistic, and **large files must not stall the main process**.
 *
 * Algorithm: Myers greedy (O(ND)). Strip the common prefix/suffix first — real edits are almost
 * always local, so D is small after stripping and the result is instant in the vast majority of
 * cases. When D exceeds the budget it degrades to a "rough estimate" with exact=false (the
 * middle segment beyond the prefix/suffix is treated as a full rewrite), without the linear-space
 * middle-snake optimization.
 */

export interface LineDiffStat {
  /** Number of added lines; a rough estimate when exact=false */
  added: number
  /** Number of removed lines; a rough estimate when exact=false */
  removed: number
  /** Whether the values are exact */
  exact: boolean
}

/** Upper bound on D: beyond it, degrade to a rough estimate (memory = (2D+1) × D int32, about 8MB at 1000, alive for one call only) */
const MAX_D = 1000

/** Line-by-line comparison does not care about trailing-newline differences after the last line; split on \n and keep line content */
function splitLines(text: string): string[] {
  return text.split('\n')
}

/** Myers greedy: returns the (added, removed) for the edit distance, or null when maxD is exceeded */
function myersDelta(
  a: string[],
  b: string[],
  maxD: number
): { added: number; removed: number } | null {
  const n = a.length
  const m = b.length
  const offset = maxD
  // One spare cell on each side: k reaches ±d and reads v[k-1] / v[k+1]
  const size = 2 * maxD + 3
  const v = new Int32Array(size)
  const trace: Int32Array[] = []

  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]
      } else {
        x = v[offset + k - 1] + 1
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        // Walk back to count insertions/deletions
        let added = 0
        let removed = 0
        let cx = n
        let cy = m
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd]
          const kk = cx - cy
          let prevK: number
          if (kk === -dd || (kk !== dd && pv[offset + kk - 1] < pv[offset + kk + 1])) {
            prevK = kk + 1
          } else {
            prevK = kk - 1
          }
          const prevX = pv[offset + prevK]
          const prevY = prevX - prevK
          while (cx > prevX && cy > prevY) {
            cx--
            cy--
          }
          if (cx === prevX) added++
          else removed++
          cx = prevX
          cy = prevY
        }
        return { added, removed }
      }
    }
  }
  return null
}

/**
 * Count how many lines are added/removed when changing before into after.
 * Returns all zeros when the contents are identical (callers skip recording on that basis).
 */
export function diffStatByLines(before: string, after: string): LineDiffStat {
  if (before === after) return { added: 0, removed: 0, exact: true }

  const a = splitLines(before)
  const b = splitLines(after)

  // Trim the common prefix / suffix (line by line)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  if (midA.length === 0) return { added: midB.length, removed: 0, exact: true }
  if (midB.length === 0) return { added: 0, removed: midA.length, exact: true }

  const budget = Math.min(MAX_D, midA.length + midB.length)
  const exact = myersDelta(midA, midB, budget)
  if (exact) return { ...exact, exact: true }

  // Rough estimate: treat the middle segment as a full rewrite (better to overestimate than to stall the main process for a badge)
  return { added: midB.length, removed: midA.length, exact: false }
}

/**
 * Number of lines in the text.
 *
 * `'a\nb\n'` is **2** lines — the trailing newline terminates the last line, it is not an extra
 * line; an empty text has 0 lines; a last line without a newline still counts as one line. This
 * matches git's convention (`git diff --numstat` reports `2 0`, not `3 0`, for a new 2-line
 * file). This used to be `split('\n').length`, so new files **always reported one extra line**:
 * the number now shows up on chat cards (`+N −M`), and an off-by-one is the easiest error to
 * spot at a glance.
 */
export function lineCount(text: string): number {
  if (text === '') return 0
  const lines = text.split('\n').length
  return text.endsWith('\n') ? lines - 1 : lines
}

/**
 * Diff size for one "before/after" pair: create = whole content added, delete = whole content
 * removed, everything else goes through the line-level diff.
 *
 * This is the **single definition** of change size: both change-record storage (file-history)
 * and the write/edit cards in chat (fs-backend records added/removed facts) call it. If each side
 * computed its own, the "+N −M" on the card and the diff view / history list would eventually
 * contradict each other — the user would see two accounts of the same change.
 */
export function changeStats(
  before: string | null,
  after: string | null
): { added: number; removed: number } {
  if (before === null) return { added: lineCount(after ?? ''), removed: 0 }
  if (after === null) return { added: 0, removed: lineCount(before) }
  const stat = diffStatByLines(before, after)
  return { added: stat.added, removed: stat.removed }
}

/** Whether the content is binary (containing NUL counts as binary; snapshots and diffs are meaningless for it) */
export function looksBinary(text: string): boolean {
  return text.includes('\u0000')
}
