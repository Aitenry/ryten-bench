import { gunzipSync } from 'node:zlib'

/**
 * Three-way merge decision layer for cloud sync (**pure functions**, no electron / fs, so they are
 * easy to unit test).
 *
 * Background (2026-11-25): the previous "merge cloud data" was an unconditional union - all local
 * rows kept, cloud-only rows appended. It had no **merge base** (the snapshot from the last sync),
 * so it could not tell "deleted locally" from "added in the cloud": as long as the cloud still
 * held the old snapshot, deleted/modified rows were guaranteed to come back on the next merge, and
 * transactions with a changed amount became two rows because the content fingerprint changed.
 *
 * It now follows the git model:
 * - `revs[plugin]` / base.rev = **merge base** (the data_rev of the last successful sync);
 * - `dirty` + comparison with the base snapshot = **whether the working copy has local changes**;
 * - only one side changed -> fast-forward (push / pull);
 * - both sides changed -> **conflict**, never auto-overwrite or union; the user chooses explicitly;
 * - push always carries `data_rev`, never `force`.
 *
 * Snapshot comparison must skip fields that change on every export, such as `exportedAt`, and must
 * see through a plugin's own gzip+base64 envelope (bookkeeping / task planning / world time zones
 * are packed above 240KiB), otherwise every export counts as "changed" and merging conflicts
 * forever.
 */

/** Fields that change on every export but do not represent user data (ignored when comparing) */
const VOLATILE_KEYS = new Set(['exportedAt', 'exported_at', 'generatedAt', 'generated_at'])

/** Encoding marker for a plugin's large-snapshot envelope (all three plugins use `gzip+base64`) */
const PACKED_ENCODING = 'gzip+base64'

/** Maximum inflated output (prevents malicious cloud data from zip-bombing the main process) */
const MAX_INFLATED_BYTES = 8 * 1024 * 1024

/**
 * Merge base for the current snapshot: cloud snapshot at the last successful sync + its data_rev
 */
export interface MergeBaseSnapshot {
  rev: number
  data: unknown
  at?: number
}

export type MergeDecision = 'push' | 'pull' | 'sync' | 'conflict' | 'no-base'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Row array: every element is an object with an id (compared after sorting to avoid false diffs
 * from SQL row order)
 */
function isRowArray(items: unknown[]): boolean {
  return (
    items.length > 0 &&
    items.every(
      (item) => isRecord(item) && (typeof item.id === 'number' || typeof item.id === 'string')
    )
  )
}

function rowId(item: unknown): string {
  const id = isRecord(item) ? item.id : ''
  return typeof id === 'number' ? id.toString().padStart(20, '0') : String(id)
}

/**
 * Normalizes a snapshot: sort object keys, unpack large-snapshot envelopes, sort row arrays by id,
 * ignore volatile fields.
 *
 * Used only for **comparison**; plugin data is never written back, and envelopes that fail to
 * unpack stay as-is (degrading to a conservative "may have changed").
 */
export function normalizeSnapshot(value: unknown, depth = 0): unknown {
  if (depth > 16) return value
  if (Array.isArray(value)) {
    const items = value.map((item) => normalizeSnapshot(item, depth + 1))
    if (items.length > 1 && isRowArray(items)) {
      items.sort((left, right) => rowId(left).localeCompare(rowId(right)))
    }
    return items
  }
  if (!isRecord(value)) return value

  if (value.encoding === PACKED_ENCODING) {
    const packed =
      typeof value.packed === 'string'
        ? value.packed
        : typeof value.data === 'string'
          ? value.data
          : ''
    if (packed) {
      try {
        const inflated = gunzipSync(Buffer.from(packed, 'base64'), {
          maxOutputLength: MAX_INFLATED_BYTES
        }).toString('utf8')
        return normalizeSnapshot(JSON.parse(inflated), depth + 1)
      } catch {
        // Unpack failed: compare as a plain object (better a false "changed" than a missed real
        // edit)
      }
    }
  }

  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE_KEYS.has(key)) continue
    out[key] = normalizeSnapshot(value[key], depth + 1)
  }
  return out
}

/**
 * Whether two snapshots are identical at the user-data level (ignores export time, row order,
 * packed envelopes)
 */
export function snapshotsEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(normalizeSnapshot(left)) === JSON.stringify(normalizeSnapshot(right))
  } catch {
    return false
  }
}

/**
 * Next action for a three-way merge.
 *
 * - `hasBase=false`: no baseline yet (first sync after an upgrade, or a node switch) -> do not
 *   guess; require one sync first;
 * - `serverRev < baseRev`: server rev went backwards (node switch / data wiped) -> do not guess
 *   either;
 * - only local changed -> `push` (push deletions/modifications up; they will not be refilled by
 *   stale cloud data);
 * - only cloud changed -> `pull` (no unsynced local changes; safe fast-forward);
 * - both changed -> `conflict` (never auto-union; let the user choose).
 */
export function decideMergeAction(input: {
  hasBase: boolean
  baseRev: number
  serverRev: number
  dirty: boolean
  localDrift: boolean
}): MergeDecision {
  if (!input.hasBase) return 'no-base'
  if (input.serverRev < input.baseRev) return 'no-base'
  const localChanged = input.dirty || input.localDrift
  const remoteChanged = input.serverRev > input.baseRev
  if (!localChanged && !remoteChanged) return 'sync'
  if (localChanged && !remoteChanged) return 'push'
  if (!localChanged && remoteChanged) return 'pull'
  return 'conflict'
}
