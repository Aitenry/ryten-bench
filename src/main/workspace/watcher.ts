import * as fs from 'fs'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import logger from 'electron-log'
import { safeSend } from '../safe-send'
import { isRecentlyWritten, recordFileChange } from './file-history'

/**
 * 工作区文件监听：磁盘变了，界面必须跟着变。
 *
 * 解决两个此前一直存在的缺口：
 * 1. **模型改了文件，编辑器里还是旧内容**（原来只有重新打开页签才会读到新内容）；
 * 2. **资源管理器不刷新**（新建/删除的文件要手动点刷新才能看到）。
 *
 * 分工：
 * - 内置文件工具（write_file / edit_file）在写入处**已经**记录了改动（有精确快照），
 *   监听只负责广播刷新，靠 `isRecentlyWritten` 去重，不重复记录；
 * - 其余变化（execute 执行命令、外部编辑器保存、git 操作）没有精确快照：
 *   落在工具执行窗口内的按 `execute` 记一条**无快照**记录（如实告知不可回溯），
 *   完全外部的变化只广播刷新，不产生审查记录（否则一次 git checkout 会灌进几百条）。
 */

/** 不监听的重目录（构建产物 / 依赖 / 版本库内部文件） */
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.cache',
  '.next',
  '.turbo',
  'coverage'
])

/** 合并窗口：编辑器保存一次、模型写一次，往往触发多个底层事件 */
const DEBOUNCE_MS = 220
/** 单批最多为多少个文件记录「命令执行改动」（防一次批量写把库灌满） */
const MAX_TOOL_ATTRIBUTED_PER_BATCH = 12
/** execute 结束后仍把变化归给它的宽限时间（磁盘事件常晚于进程退出） */
const WINDOW_GRACE_MS = 1500

/** 一批变化里的单个条目 */
export interface WorkspaceFsChange {
  path: string
  relPath: string
  exists: boolean
  isDirectory: boolean
}

let watcher: fs.FSWatcher | null = null
let watchedRoot = ''
let watchedWorkspaceId = 0
/**
 * 已确认「根目录不存在」的工作区路径。
 *
 * 工作区目录被删除 / 移走（最常见：改了「插件存放路径」后旧插件工作区还记着老路径，
 * 或删掉插件草稿只留会话）时，`fs.watch` 会抛 ENOENT。每次设置更新都会 sync 一次，
 * 不能每次都打两条堆栈；这里只对同一个缺失根提示一次，目录回来后自动清空。
 */
let missingRoot = ''
const pendingPaths = new Set<string>()
let debounceTimer: NodeJS.Timeout | null = null

/** 正在执行的工具（execute 期间的磁盘变化归给它）。可能并发（子代理 / 工作流），按栈式记录取最新的一个。 */
const activeWindows: {
  topicId: number | null
  callId: string | null
  startedAt: number
}[] = []
/** 最近结束的工具窗口（进程退出与实际落盘之间有时间差） */
let endedWindow: { topicId: number | null; callId: string | null; endedAt: number } | null = null

/** 工具执行开始：其间的磁盘变化归到这次调用名下 */
export function beginToolWriteWindow(info: { topicId?: number; callId?: string }): void {
  activeWindows.push({
    topicId: info.topicId ?? null,
    callId: info.callId ?? null,
    startedAt: Date.now()
  })
}

/** 工具执行结束（宽限窗口内仍归给它） */
export function endToolWriteWindow(callId?: string): void {
  const index = callId
    ? activeWindows.findIndex((w) => w.callId === callId)
    : activeWindows.length - 1
  if (index < 0) return
  const [closed] = activeWindows.splice(index, 1)
  endedWindow = { topicId: closed.topicId, callId: closed.callId, endedAt: Date.now() }
}

/** 当前生效的归属窗口（无则 null） */
function currentWindow(): { topicId: number | null; callId: string | null } | null {
  if (activeWindows.length > 0) return activeWindows[activeWindows.length - 1]
  if (endedWindow && Date.now() - endedWindow.endedAt <= WINDOW_GRACE_MS) return endedWindow
  return null
}

function isIgnored(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((segment) => IGNORED_SEGMENTS.has(segment) || segment === '')
}

/**
 * 主进程 → 渲染层的事件通道（只有发送方）。
 *
 * 通道名一律 `harness:<原扁平名>`：工作区文件监听属「AI 助手」；渲染层经 preload 的
 * 系统桥订阅，不需要再登记白名单。
 */
export const WORKSPACE_FS_CHANGED = 'harness:workspace-fs-changed'

/** 广播刷新（渲染进程据此刷新资源管理器目录与已打开的页签内容） */
function broadcastFsChanged(changes: WorkspaceFsChange[]): void {
  if (changes.length === 0) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) safeSend(win.webContents, WORKSPACE_FS_CHANGED, { changes })
  }
}

/** 读取文件正文（文本、且不超过上限时才读；否则返回 null） */
async function readTextIfSmall(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile() || stat.size > 1_500_000) return null
    const text = await fs.promises.readFile(filePath, 'utf-8')
    return text.includes('\u0000') ? null : text
  } catch {
    return null
  }
}

/** 处理一批（去抖后的）磁盘变化 */
async function flush(): Promise<void> {
  debounceTimer = null
  if (!watchedRoot) return
  const batch = [...pendingPaths]
  pendingPaths.clear()
  if (batch.length === 0) return

  const changes: WorkspaceFsChange[] = []
  const toolWindow = currentWindow()
  let attributed = 0

  for (const abs of batch) {
    const relPath = path.relative(watchedRoot, abs)
    if (isIgnored(relPath)) continue
    let exists = true
    let isDirectory = false
    try {
      const stat = await fs.promises.stat(abs)
      isDirectory = stat.isDirectory()
    } catch {
      exists = false
    }
    changes.push({ path: abs, relPath: relPath.split(path.sep).join('/'), exists, isDirectory })

    // 命令执行窗口内的文件变化：记一条「无快照」改动（可追溯、但如实标注不可回溯）
    if (
      exists &&
      !isDirectory &&
      toolWindow &&
      !isRecentlyWritten(abs) &&
      attributed < MAX_TOOL_ATTRIBUTED_PER_BATCH
    ) {
      const after = await readTextIfSmall(abs)
      if (after !== null) {
        attributed++
        void recordFileChange({
          workspaceId: watchedWorkspaceId,
          workspaceRoot: watchedRoot,
          realPath: abs,
          before: null,
          after,
          kind: 'modify',
          source: 'execute',
          topicId: toolWindow.topicId,
          callId: toolWindow.callId,
          note: 'command'
        })
      }
    }
  }

  broadcastFsChanged(changes)
}

/** 目标根目录存在且是目录吗（工作区目录被删/移走时 `fs.watch` 必然 ENOENT） */
function isExistingDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** 当前正在监听的工作区根（空字符串 = 没在监听） */
export function watchedWorkspaceRoot(): string {
  return watchedRoot
}

/**
 * `dir` 是否被工作区监听**直接或间接**占用（监听根 = dir，或监听根在 dir 里面）。
 *
 * Windows 上 `fs.watch` 打开的目录句柄没有 `FILE_SHARE_DELETE`：只要监听还挂在
 * 这个目录（或它的子目录）上，删除/改名它就会得到 `EPERM`。替换插件源码目录、
 * 删除草稿之前必须先 `stopWorkspaceWatcher()`（installSourceBytes / 工坊删除都这么做）。
 *
 * 反过来的情况（dir 在监听根里面）不算：监听挂在父目录上时，子目录名可以正常删除/改名。
 */
export function isWatchingPath(dir: string): boolean {
  if (!watchedRoot) return false
  const root = path.resolve(watchedRoot)
  const target = path.resolve(dir)
  return root === target || root.startsWith(target + path.sep)
}

/** 开始监听工作区（切换工作区时先停再起；同一工作区重复调用是空操作） */
export function startWorkspaceWatcher(root: string, workspaceId: number): void {
  if (!root) {
    stopWorkspaceWatcher()
    return
  }

  // 目录不在：不 watch、也不走「递归不可用 → 再试一次」的兜底（那只会打两条堆栈）。
  // 停掉旧根的监听，同一缺失根只提示一次；恢复目录或切到别的工作区后会重新开始监听。
  // 这个判断必须在「已在监听同一根」之前：目录就是**在监听期间**被删掉时，watcher 仍是
  // 非空的，先返回就永远发现不了它已经失效。
  if (!isExistingDirectory(root)) {
    if (watchedRoot) stopWorkspaceWatcher()
    if (missingRoot !== root) {
      missingRoot = root
      logger.warn(
        `[WorkspaceWatcher] Workspace folder is missing (or is not a directory), file watching skipped: ${root}` +
          ' (restore it or switch workspace to resume watching)'
      )
    }
    return
  }
  missingRoot = ''

  if (watcher && watchedRoot === root && watchedWorkspaceId === workspaceId) return

  stopWorkspaceWatcher()
  watchedRoot = root
  watchedWorkspaceId = workspaceId
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const rel = filename.toString()
      if (isIgnored(rel)) return
      pendingPaths.add(path.join(root, rel))
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => void flush(), DEBOUNCE_MS)
    })
    watcher.on('error', (err) => logger.warn('[WorkspaceWatcher] Watch error:', err))
    logger.info(`[WorkspaceWatcher] Started watching ${root}`)
  } catch (err) {
    // Linux 上 fs.watch 不支持 recursive：退化为只监听根目录（不致命，刷新按钮仍可用）
    logger.warn(
      '[WorkspaceWatcher] Recursive watch unavailable, falling back to root-only watch:',
      err
    )
    try {
      watcher = fs.watch(root, (_event, filename) => {
        if (!filename) return
        pendingPaths.add(path.join(root, filename.toString()))
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => void flush(), DEBOUNCE_MS)
      })
    } catch (inner) {
      logger.error('[WorkspaceWatcher] Failed to start watcher:', inner)
      watcher = null
    }
  }
}

/** 停止监听 */
export function stopWorkspaceWatcher(): void {
  if (watcher) {
    try {
      watcher.close()
    } catch {
      // 已关闭
    }
    watcher = null
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  pendingPaths.clear()
  watchedRoot = ''
  watchedWorkspaceId = 0
}
