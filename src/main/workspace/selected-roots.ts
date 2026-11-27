/**
 * 「用户经系统对话框亲自选过」的目录登记表。
 *
 * 背景（安全审计 S03）：渲染层可以把 `harness.workspacePath` 改成任意目录，而
 * 文件类 IPC 用这个值当工作区根做 `assertInsideWorkspace`——于是越权读写任意文件。
 * 只校验「路径在库里」还不够：`workspace-create` 本身也接受渲染层传入的任意 path。
 *
 * 因此工作区目录的信任来源收敛为两条：
 * 1. 用户在系统目录选择框（`dialog.showOpenDialog`）里**亲手点过**的目录（本模块记录）；
 * 2. 已经落进 `workspace` 表的工作区行（由主进程写入，渲染层只能引用其 id/路径）。
 *
 * 这是一个内存态白名单：重启后需要重新选目录——可接受，因为新建工作区本来就要先弹框；
 * 已存在的用户工作区走第 2 条，不受影响。
 */
import { resolve, sep } from 'path'

/** 最多记住的目录数（防止渲染层反复弹框把内存撑大；对话框本身需要用户操作，实际很难触顶） */
const MAX_REMEMBERED_ROOTS = 64

const selectedRoots = new Set<string>()

/** 路径比较键：去掉尾部分隔符，Windows 下大小写不敏感 */
export function workspacePathKey(input: string): string {
  const normalized = resolve(input).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** 记录一个用户亲手选过的目录（按 LRU 上限淘汰最旧的） */
export function rememberSelectedRoot(dir: string): void {
  if (typeof dir !== 'string' || !dir.trim()) return
  const key = workspacePathKey(dir)
  selectedRoots.delete(key)
  selectedRoots.add(key)
  while (selectedRoots.size > MAX_REMEMBERED_ROOTS) {
    const oldest = selectedRoots.values().next().value
    if (oldest === undefined) break
    selectedRoots.delete(oldest)
  }
}

/** 该目录是否是用户经系统对话框亲手选过的 */
export function isUserSelectedRoot(dir: string): boolean {
  if (typeof dir !== 'string' || !dir.trim()) return false
  return selectedRoots.has(workspacePathKey(dir))
}

/**
 * 目标路径是否落在给定的根目录内（字符串级；符号链接的 realpath 校验由调用方补）。
 * 抽出来是因为 IPC 层与文件工具层都需要同一套边界语义，避免两份 `isPathInside` 漂移。
 */
export function isPathInsideRoot(target: string, root: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedTarget = resolve(target)
  const key = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value
  const r = key(normalizedRoot)
  const t = key(normalizedTarget)
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep)
}
