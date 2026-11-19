import { getChunks } from '@codemirror/merge'
import { type EditorState } from '@codemirror/state'
import type { FileChangeView } from '../types/file-change'

/** 差异规模：处数 / 新增行 / 删除行 */
export interface MergeStats {
  chunks: number
  added: number
  removed: number
}

/**
 * 差异工具条上那行统计的**唯一算法**（`{{count}} 处差异 · +{{added}} −{{removed}}`）。
 *
 * 抽成纯函数是为了能脱离 React 直接验证：`getChunks` 在各种情形下到底返回什么，
 * 必须在**真编辑器**上量过，不能靠读代码推断（工装：scripts/probe-diff-stats.mjs）。
 *
 * 唯一的「算不出差异」情形：**没有改动前快照**（`hasBefore=false`——新建文件、
 * 命令执行期间被文件监听捕获的写入）。差异视图在这一支压根不装 `unifiedMergeView`，
 * `getChunks(state)` 直接返回 `null`，于是统计只能回落用**改动记录自带的统计**
 * （落库时算的那份，与历史列表、资源管理器徽标同源）。
 *
 * 用户 2026-09-23 报的「新建文件显示 0 处差异 · +0 −0」就是它：右侧正文整篇标成新增，
 * 统计行却是 0 —— 旧实现见 `!result` 就写死 `{chunks:0, added:0, removed:0}`，
 * 把「这里没有合并视图」误当成「这里没有改动」。
 *
 * `Array.isArray` 守卫是纯防御：库文档写明 `getChunks` 可能返回 `{ chunks: null }`
 * （`ChunkField.create` 的初值就是 null），实测 6.12.2 的 `unifiedMergeView` 走
 * `ChunkField.init` 在构造时同步建好 chunks，构造态就已经是数组，所以这一支目前到不了。
 */
export function computeMergeStats(
  state: EditorState | null,
  original: string | null,
  fallback: Pick<FileChangeView, 'added' | 'removed'>
): MergeStats {
  // 没有编辑器实例（首帧）/ 没有 original（快照还没读回来）：如实报 0，别谎报记录里的数
  if (!state || original === null) return { chunks: 0, added: 0, removed: 0 }

  const result = getChunks(state)
  // 没有合并视图（不装 unifiedMergeView）：回落到记录自带的统计。
  // 处数记 1：这份记录在语义上就是**一整块**改动（整份文件都是新增/删除），
  // 报 0 会与「+14」自相矛盾（用户看到的正是「0 处差异 · +0 −0」这种读不通的话）。
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
