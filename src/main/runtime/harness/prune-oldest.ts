/**
 * 目录内「最旧文件」清理（异步、best-effort，零第三方依赖）。
 *
 * 为什么单独抽出来：工具详情目录与 spill 目录都按「先写后剪」维护文件数上限，
 * 原实现用 `readdirSync` + 逐文件 `statSync` + `unlinkSync`，在工具调用密集时会
 * 直接阻塞主进程事件循环（性能审计 P19）。这里统一成异步实现，两处共用，
 * 也便于离线断言（返回被删除的文件、串行合并用调用方自己的标志位）。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Dirent } from 'node:fs'

export interface PruneOldestOptions {
  /** 只处理满足条件的文件（例如扩展名 / 文件名前缀） */
  match: (fileName: string) => boolean
  /** 保留多少个最新文件 */
  keep: number
}

/**
 * 按 mtime 升序删除最旧文件，直到目录内匹配文件数不超过 `keep`。
 *
 * @returns 实际删除的文件路径（删除失败的会被跳过，不抛错）
 */
export async function pruneOldestFiles(
  dir: string,
  options: PruneOldestOptions
): Promise<string[]> {
  if (options.keep < 0) return []
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    // 目录不存在（还没写过文件）或不可读：没有可清理的东西
    return []
  }
  const files: Array<{ full: string; mtime: number }> = []
  for (const entry of entries) {
    if (!entry.isFile() || !options.match(entry.name)) continue
    const full = path.join(dir, entry.name)
    try {
      const stat = await fs.stat(full)
      files.push({ full, mtime: stat.mtimeMs })
    } catch {
      // 已被并发删除/无权限：跳过
    }
  }
  files.sort((a, b) => a.mtime - b.mtime)
  const removed: string[] = []
  for (let i = 0; i < files.length - options.keep; i += 1) {
    try {
      await fs.unlink(files[i].full)
      removed.push(files[i].full)
    } catch {
      // 删除失败不阻塞写入
    }
  }
  return removed
}
