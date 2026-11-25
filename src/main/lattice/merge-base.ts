import { gunzipSync } from 'node:zlib'

/**
 * 云同步的「三方合并」决策层（**纯函数**，不碰 electron / fs，方便单测）。
 *
 * 背景（用户 2026-11-25）：原来的「合并云端数据」是无条件并集——本机行全部保留、
 * 云端独有的行追加。它没有 **merge base**（上次同步时的快照），所以分不清
 * 「本机删掉了」和「云端新增了」：只要云端还留着旧快照，删掉/改过的行下一次合并
 * 一定会被加回来，改过金额的流水还会因为内容指纹变化变成两条。
 *
 * 现在按 git 的模型来：
 * - `revs[plugin]` / base.rev = **merge base**（上次成功同步的 data_rev）；
 * - `dirty` + 与 base 快照的比对 = **工作区有没有本地改动**；
 * - 只有一边动了 → 快进（push / pull）；
 * - 两边都动了 → **冲突**，绝不自动覆盖或并集，由用户显式选择；
 * - push 一律带 `data_rev`，不带 `force`。
 *
 * 快照比对必须能跳过 `exportedAt` 这类「每次导出都变」的字段，并且要能穿透插件
 * 自己的 gzip+base64 信封（记账 / 任务规划 / 全球时区在超过 240KiB 时都会打包），
 * 否则每次导出都算「变过」，合并就永远是冲突。
 */

/** 每次导出都会变、但不代表用户数据变化的字段（比较时忽略） */
const VOLATILE_KEYS = new Set(['exportedAt', 'exported_at', 'generatedAt', 'generated_at'])

/** 插件大快照信封的编码标记（三个插件都用 `gzip+base64`） */
const PACKED_ENCODING = 'gzip+base64'

/** 解包时最多允许的输出（防止云端脏数据做成 zip bomb 把主进程打爆） */
const MAX_INFLATED_BYTES = 8 * 1024 * 1024

/** 当前快照的 merge base：上次成功同步时的云端快照 + 对应 data_rev */
export interface MergeBaseSnapshot {
  rev: number
  data: unknown
  at?: number
}

export type MergeDecision = 'push' | 'pull' | 'sync' | 'conflict' | 'no-base'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 行数组：元素都是带 id 的对象（排序后比较，避免 SQL 返回顺序造成假差异） */
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
 * 规范化一份快照：对象按键排序、大快照信封解包、行数组按 id 排序、忽略易变字段。
 *
 * 只用于**比较**，不会回写插件数据；解不开的信封保持原样（退化成保守的「可能变了」）。
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
        // 解包失败：当成普通对象比较（宁可误判「变过」，也不要漏掉真实修改）
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

/** 两份快照在「用户数据」层面是否一致（忽略导出时间、行顺序、压缩信封） */
export function snapshotsEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(normalizeSnapshot(left)) === JSON.stringify(normalizeSnapshot(right))
  } catch {
    return false
  }
}

/**
 * 三方合并的下一步动作。
 *
 * - `hasBase=false`：还没建立基线（升级后第一次、或换节点）→ 不猜，要求先同步一次；
 * - `serverRev < baseRev`：服务端 rev 回退（换节点 / 数据被清）→ 同样不猜；
 * - 只有本机动 → `push`（把删除/修改推上去，不会被云端旧数据回填）；
 * - 只有云端动 → `pull`（本机没有未同步改动，安全快进）；
 * - 两边都动 → `conflict`（绝不自动并集，交给用户选）。
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
