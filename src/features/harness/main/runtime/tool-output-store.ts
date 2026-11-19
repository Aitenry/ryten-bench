import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'

/**
 * 工具结果详情存储（内置工具的「结果原文」旁路）。
 *
 * 与 spill（溢出策略）的区别：spill 是**给模型的**——只在输出超长时保存，
 * 并且把文件放在工作区里让模型用 read_file/grep 自己检索；这里是**给人的**——
 * 内置工具的结果一律不再随 IPC 下发/落库，聊天里只留一张卡片，用户要点开时
 * 才由主进程读这份详情（ls 的条目、glob 的路径表、grep 的匹配行、execute 的 stdout）。
 *
 * 存放位置：<userData>/tool-output/<topicId>/<callId>.txt
 *  - 放在 userData 而不是工作区：工作区挂载为虚拟 '/'，塞进去会污染用户项目，
 *    也会出现在模型自己的 ls/glob 结果里（spill 的目录是模型可见的，这里刻意不共用）；
 *  - 按话题分目录：话题删除时整目录清掉，与 spill / todo / goal 的清理口径一致；
 *  - 每话题有文件数上限，超出时删最旧的（防长会话磁盘膨胀）。
 *
 * 本模块不 import electron：目录由调用方（主进程启动时）注入，因此可被离线脚本直接验证。
 */

/** 每个话题保留的详情文件上限 */
const MAX_FILES_PER_TOPIC = 300

/** 单份详情的大小上限（字符）：超过则不再另存（卡片也就不显示「查看详情」） */
export const MAX_DETAIL_CHARS = 512_000

export class ToolOutputStore {
  private readonly baseDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  /** 完整路径：<baseDir>/<topicId>/<callId>.txt */
  private filePath(topicId: number, callId: string): string {
    return path.join(this.baseDir, String(topicId), `${sanitizeCallId(callId)}.txt`)
  }

  /** 保存一份详情；返回是否成功（失败是 best-effort，不影响主流程） */
  save(topicId: number, callId: string, text: string): boolean {
    if (!topicId || !callId) return false
    if (!text || text.length > MAX_DETAIL_CHARS) return false
    try {
      fs.mkdirSync(path.join(this.baseDir, String(topicId)), { recursive: true })
      fs.writeFileSync(this.filePath(topicId, callId), text, 'utf-8')
      this.prune(topicId)
      return true
    } catch (err) {
      logger.warn('[ToolOutput] 保存工具结果详情失败:', err)
      return false
    }
  }

  /** 读取一份详情；不存在返回 null */
  read(topicId: number, callId: string): string | null {
    if (!callId) return null
    const exact = topicId ? this.readAt(topicId, callId) : null
    if (exact !== null) return exact
    // 话题对不上时按 callId 兜底扫一遍（分支持久化：分支会话是把 blocks 复制到新话题的，
    // 卡片里的 callId 还是原值，但详情文件留在原话题目录下——不兜底就只能显示「详情不可用」）
    return this.readAcrossTopics(callId)
  }

  /** 精确按话题目录读取 */
  private readAt(topicId: number, callId: string): string | null {
    try {
      return fs.readFileSync(this.filePath(topicId, callId), 'utf-8')
    } catch {
      return null
    }
  }

  /** 跨话题目录按文件名兜底查找（同名取最新的一份） */
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
        // 该话题下没有这份详情，继续找
      }
    }
    return best?.text ?? null
  }

  /** 清理某话题的全部详情（话题删除时调用） */
  removeTopic(topicId: number): void {
    if (!topicId) return
    try {
      fs.rmSync(path.join(this.baseDir, String(topicId)), { recursive: true, force: true })
    } catch (err) {
      logger.warn('[ToolOutput] 清理工具结果详情失败:', err)
    }
  }

  /** 删除最旧文件，保证单话题文件数不超过上限（先写后剪，与 spill 同口径） */
  private prune(topicId: number): void {
    const dir = path.join(this.baseDir, String(topicId))
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.txt'))
      .map((entry) => {
        const full = path.join(dir, entry.name)
        try {
          return { full, mtime: fs.statSync(full).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((item): item is { full: string; mtime: number } => item !== null)
      .sort((a, b) => a.mtime - b.mtime)
    for (let i = 0; i < files.length - MAX_FILES_PER_TOPIC; i += 1) {
      try {
        fs.unlinkSync(files[i].full)
      } catch {
        // 删除失败不阻塞写入
      }
    }
  }
}

/** callId 可能来自第三方 provider（含 / \ : 等），统一洗成安全文件名 */
function sanitizeCallId(callId: string): string {
  return callId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

// ── 进程级单例（目录由主进程启动时注入；未配置时所有操作降级为 no-op）──

let store: ToolOutputStore | null = null

/** 主进程启动时注入存储目录（userData/tool-output） */
export function configureToolOutputStore(baseDir: string): void {
  store = new ToolOutputStore(baseDir)
}

/** 取进程级存储；未配置返回 null */
export function getToolOutputStore(): ToolOutputStore | null {
  return store
}
