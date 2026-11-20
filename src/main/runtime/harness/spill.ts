import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import logger from 'electron-log'
import { mainFormat } from '../../i18n'
import { getFsToolTexts } from '../../i18n/tool-results-fs'

/**
 * 工具结果溢出存储（spill）— 对应 deepseek-harness 的 spill 体系
 * （dsh-spill / dsh-spill-local / dsh-spill-policy）
 *
 * 机制（参考 dsh-spill-policy）：
 * - 工具最终输出超过内联上限时，不再硬截断丢数据，而是把完整文本写入
 *   溢出文件，模型只拿到「有界 head/tail 预览 + 溢出文件定位符 + 检索指引」；
 * - 溢出文件放在工作区或记忆目录下，自动挂载进虚拟文件系统
 *   （/.spill/ 或 /memories/spill/），模型可用 read_file / grep 按需检索；
 * - 溢出失败是 best-effort：保存失败时保留原始结果可见（不丢内容）；
 * - 每个话题保留的溢出文件数有上限，超出时删除最旧文件（防磁盘膨胀）。
 */

/** 内联输出上限（字符）：超过即溢出到文件，模型只拿到预览 + 定位符 */
export const MAX_INLINE_CHARS = 12_000
/** 预览保留：头部字符数 */
const PREVIEW_HEAD_CHARS = 8_000
/** 预览保留：尾部字符数 */
const PREVIEW_TAIL_CHARS = 2_000
/** 每个话题保留的溢出文件上限 */
const MAX_FILES_PER_TOPIC = 100

/** 溢出文件描述（虚拟路径供模型通过文件工具访问） */
export interface SpillLocator {
  /** 虚拟文件系统中的访问路径（如 /.spill/42/spill-<uuid>.txt） */
  virtualPath: string
}

/**
 * 话题级溢出存储。
 *
 * 目录选择（与虚拟文件系统挂载保持一致，保证模型可读）：
 * - 配置了 AI 工作区 → <workspacePath>/.spill/<topicId>/（挂载为 /.spill/...）
 * - 否则记忆目录 → <memoryPath>/spill/<topicId>/（挂载为 /memories/spill/...）
 * - 都没有 → 溢出禁用（保持原有截断行为，best-effort）
 */
export class SpillStore {
  private readonly dir?: string
  private readonly virtualPrefix?: string

  constructor(workspacePath?: string, memoryPath?: string, topicId = 0) {
    if (workspacePath) {
      this.dir = path.join(workspacePath, '.spill', String(topicId))
      this.virtualPrefix = `/.spill/${topicId}/`
    } else if (memoryPath) {
      this.dir = path.join(memoryPath, 'spill', String(topicId))
      this.virtualPrefix = `/memories/spill/${topicId}/`
    }
  }

  /** 是否可用（未配置目录时禁用溢出） */
  get enabled(): boolean {
    return !!this.dir && !!this.virtualPrefix
  }

  /**
   * 溢出策略主入口：文本超限时保存完整内容并返回「预览 + 定位符」的模型可见文本；
   * 未超限或保存失败时原样返回（best-effort，参考 dsh-spill-policy）。
   */
  trySpill(text: string): string {
    if (!this.enabled || text.length <= MAX_INLINE_CHARS) return text
    try {
      return this.saveAndPreview(text)
    } catch (err) {
      logger.warn('[Spill] 溢出保存失败，回退为原文可见:', err)
      return text
    }
  }

  /** 保存完整文本到溢出文件，返回模型可见的预览 + 检索指引 */
  private saveAndPreview(text: string): string {
    // 返回文案跟随界面语言（会渲染在工具调用卡片上），函数体内取当前语言
    const tr = getFsToolTexts()
    fs.mkdirSync(this.dir!, { recursive: true })

    const fileName = `spill-${randomUUID()}.txt`
    fs.writeFileSync(path.join(this.dir!, fileName), text, 'utf-8')
    // 先写后剪：确保写完后目录不超过上限（先剪会残留 101 个的窗口）
    this.prune()
    const virtualPath = `${this.virtualPrefix}${fileName}`

    const omitted = text.length - PREVIEW_HEAD_CHARS - PREVIEW_TAIL_CHARS
    const head = text.slice(0, PREVIEW_HEAD_CHARS)
    const tail = text.slice(-PREVIEW_TAIL_CHARS)
    const middle =
      omitted > 0
        ? `\n${mainFormat(tr.spill.middleOmitted, { omitted: omitted.toLocaleString() })}\n`
        : '\n'
    // 检索指引（对齐 dsh-spill-policy 的 retrievalHint 语义：read 带 offset/limit + grep 检索）
    const locator = mainFormat(tr.spill.locator, {
      total: text.length.toLocaleString(),
      virtualPath
    })
    return `${head}${middle}${tail}\n\n${locator}`
  }

  /** 删除最旧溢出文件，保证每个话题文件数不超过上限 */
  private prune(): void {
    let files: fs.Dirent[]
    try {
      files = fs.readdirSync(this.dir!, { withFileTypes: true })
    } catch {
      return
    }
    const spillFiles = files
      .filter((e) => e.isFile() && e.name.startsWith('spill-'))
      .map((e) => {
        const full = path.join(this.dir!, e.name)
        try {
          return { full, mtime: fs.statSync(full).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((f): f is { full: string; mtime: number } => f !== null)
      .sort((a, b) => a.mtime - b.mtime)
    for (let i = 0; i < spillFiles.length - MAX_FILES_PER_TOPIC; i++) {
      try {
        fs.unlinkSync(spillFiles[i].full)
      } catch {
        // 删除失败不阻塞保存
      }
    }
  }

  /**
   * 清理某话题的全部溢出文件（话题删除时由 IPC 层调用）。
   * 静态方法：不依赖实例状态，直接按目录约定定位。
   */
  static pruneTopic(workspacePath?: string, memoryPath?: string, topicId = 0): void {
    const candidates = [
      workspacePath ? path.join(workspacePath, '.spill', String(topicId)) : undefined,
      memoryPath ? path.join(memoryPath, 'spill', String(topicId)) : undefined
    ].filter((p): p is string => !!p)
    for (const dir of candidates) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        logger.warn('[Spill] 清理溢出目录失败:', err)
      }
    }
  }
}
