/**
 * 行级差异统计（纯函数，无 IO / 无 Electron 依赖，可被 node 脚本直接验证）。
 *
 * 用途：改动记录落库时给出一份「+N −M」，供资源管理器徽标、历史列表与悬浮明细显示。
 * 精确的行级 diff（CodeMirror 的合并视图）在渲染进程算——那里才有真正的编辑文档；
 * 这里只需要一个够快、够准的统计，且**大文件不能拖住主进程**。
 *
 * 算法：Myers 贪心（O(ND)）。先剥掉公共前缀/后缀——真实编辑几乎总是局部的，
 * 剥完之后 D 很小，绝大多数情况瞬间出结果。D 超预算时退化为「粗算」并标记
 * exact=false（前后缀之外的中间段整体视为重写），不去做线性空间的中间蛇优化。
 */

export interface LineDiffStat {
  /** 新增行数；exact=false 时为粗算值 */
  added: number
  /** 删除行数；exact=false 时为粗算值 */
  removed: number
  /** 是否为精确值 */
  exact: boolean
}

/** D 的上限：超过就退化为粗算（内存 = (2D+1) × D 个 int32，1000 约 8MB，且只存活一次调用） */
const MAX_D = 1000

/** 逐行比较用不到最后一行之后的换行差异，这里按 \n 切分并保留行内容 */
function splitLines(text: string): string[] {
  return text.split('\n')
}

/** Myers 贪心：返回编辑距离对应的 (added, removed)，超过 maxD 返回 null */
function myersDelta(
  a: string[],
  b: string[],
  maxD: number
): { added: number; removed: number } | null {
  const n = a.length
  const m = b.length
  const offset = maxD
  // 两端各留一格：k 取到 ±d 时会读 v[k-1] / v[k+1]
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
        // 回溯统计插入/删除
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
 * 统计把 before 改成 after 新增/删除了多少行。
 * 内容完全相同时返回全 0（调用方据此跳过记录）。
 */
export function diffStatByLines(before: string, after: string): LineDiffStat {
  if (before === after) return { added: 0, removed: 0, exact: true }

  const a = splitLines(before)
  const b = splitLines(after)

  // 公共前缀 / 后缀裁剪（逐行）
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

  // 粗算：中间段整体视为重写（宁可高估，也不要为了一个徽标把主进程拖住）
  return { added: midB.length, removed: midA.length, exact: false }
}

/**
 * 文本的行数。
 *
 * `'a\nb\n'` 是 **2** 行——末尾换行是最后一行的结束符，不是多出来的一行；
 * 空文本 0 行；末行没有换行时照样算一行。这与 git 的口径一致
 * （`git diff --numstat` 对新建的 2 行文件报 `2 0`，不是 `3 0`）。
 * 改前这里是 `split('\n').length`，新建文件于是**永远多报一行**：这条数字现在会长在
 * 聊天卡片上（`+N −M`），多一行是最容易被一眼看穿的错。
 */
export function lineCount(text: string): number {
  if (text === '') return 0
  const lines = text.split('\n').length
  return text.endsWith('\n') ? lines - 1 : lines
}

/**
 * 一次「改动前后」的差异规模：新建 = 整份新增、删除 = 整份删除、其余走行级 diff。
 *
 * 这是改动规模统计的**唯一口径**：改动记录落库（file-history）与聊天里的写改卡片
 * （fs-backend 登记 added/removed 事实）都调它。两边若各写一份，卡片上的「+N −M」
 * 与差异视图/历史列表迟早会给出互相矛盾的数字——用户看到的将是同一个改动两套说法。
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

/** 内容是否为二进制（含 NUL 即视为二进制；快照与差异对它没有意义） */
export function looksBinary(text: string): boolean {
  return text.includes('\u0000')
}
