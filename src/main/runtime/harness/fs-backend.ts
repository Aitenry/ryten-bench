import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import { mainFormat, mainPlural } from '../../i18n'
import { getFsToolTexts } from '../../i18n/tool-results-fs'
import { recordToolFacts } from './tool-result-facts'
import { MAX_IMAGE_BYTES, readImageFile, toolMedia, type ImageMimeType } from './image-tool'
import { normalizeImageDataUrl } from './image-encode'
import { applyHunks, parsePatch } from './apply-patch'
import { applyInsert, applyStrReplace, formatView } from './str-replace-core'
import { recordFileChange } from '../../workspace/file-history'
import { changeStats } from '../../workspace/line-diff'
import { beginToolWriteWindow, endToolWriteWindow } from '../../workspace/watcher'
import { permissionGate } from './permission-gate'
import { isPermissionMode } from './permission'
import { runConfinedShell, sandboxDenialText, sandboxUnavailableText } from '../../sandbox/exec'
import type { SandboxMode } from '../../sandbox/types'
import { jobsRegistry } from './jobs'
import {
  MAX_EXEC_CHARS,
  MAX_FILE_CHARS,
  MAX_FILE_READ_CHARS,
  MAX_OUTPUT_CHARS,
  MAX_SCAN_ENTRIES
} from './tool-limits'

/**
 * 虚拟文件系统工具集 — 替代 deepagents FilesystemBackend / SafeFilesystemBackend
 *
 * 挂载规则（虚拟路径 → 真实路径）：
 * - '/memories/' → memoryPath（记忆目录）
 * - '/'          → workspacePath（AI 工作区；未配置时无此挂载）
 *
 * 设计要点（对应论文 §6.1 系统边界 / §6.3 声明即能力）：
 * - 工具按次构建、无共享状态（隔离）；
 * - 虚拟路径越界直接拒绝（能力衰减）；
 * - grep/glob 捕获 EPERM（延续原 SafeFilesystemBackend 逻辑）。
 *
 * 输出边界（MAX_FILE_CHARS / MAX_EXEC_CHARS 等）统一放在 tool-limits.ts：
 * 前端投影（service/tool-presentation.ts）要按同一批常量判断结果是否被截断。
 */

/** EPERM / EACCES - 无权限访问的错误码 */
const ACCESS_DENIED_CODES = new Set(['EPERM', 'EACCES'])

/**
 * 升权重试参数（与 DSH 的 sandbox_permissions / justification 同名同义）。
 *
 * 为什么写在 schema 里而不是留给模型自由发挥：参数必须能被解析到工具层（zod 会剥掉
 * 未声明的键），闸门才知道这是一次「升权重试」。但**合法用法**只有一种——同一次被
 * 沙箱拒绝过的调用原样重试并带上它（校验见 permission.ts 的 parseEscalation）：
 * 目标档位必须严格更宽，且必须给 justification，否则连审批弹窗都不弹。
 */
const sandboxPermissionField = {
  sandbox_permissions: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .optional()
    .describe(
      'Only valid as a one-shot retry of an operation the sandbox just denied: the narrowest wider sandbox mode that would let this exact call through. Requires justification; the user is asked to approve it once.'
    ),
  justification: z
    .string()
    .optional()
    .describe(
      'One-sentence reason for the escalated retry. Required whenever sandbox_permissions is set.'
    )
}

/**
 * 从工具运行配置里取本次调用的 toolCallId（agent.ts 注入 `configurable.toolCallId`）。
 * 供工具把结构化事实（行数/字节/替换处数/失败原因）登记给前端卡片用——
 * 工具的返回值是**给模型的文本**，里面没有可靠的结构化信号。
 */
function callIdOf(config: unknown): string | undefined {
  const cfg = config as { configurable?: Record<string, unknown> } | undefined
  const id = cfg?.configurable?.toolCallId
  return typeof id === 'string' ? id : undefined
}

/** 本次调用的归属信息（会话 id + 工具调用 id），改动记录与命令窗口都要用 */
function runContextOf(config: unknown): { callId?: string; topicId?: number } {
  const cfg = config as { configurable?: Record<string, unknown> } | undefined
  const topicId = cfg?.configurable?.topicId
  return {
    callId: callIdOf(config),
    topicId: typeof topicId === 'number' ? topicId : undefined
  }
}

/**
 * 本次执行该用哪个沙箱档位。
 *
 * 优先取权限闸门注入的 `configurable.sandboxMode`（那才是「这次调用实际生效的档位」，
 * 升权重试后会更宽）。注入缺失时回落到话题当前档位——**绝不能默认成完全权限**，
 * 否则一次注入 bug 就等于把沙箱关掉。
 */
function sandboxModeOf(config: unknown, topicId?: number): SandboxMode {
  const cfg = config as { configurable?: Record<string, unknown> } | undefined
  const injected = cfg?.configurable?.sandboxMode
  if (isPermissionMode(injected)) return injected
  return permissionGate.modeFor(topicId ?? 0)
}

/** execute 的单次执行时限（毫秒）与终止提示 */
const EXEC_TIMEOUT_MS = 30_000

/**
 * 后台 execute 任务的输出留存上限（字符）。
 *
 * 前台 execute 只留 8K（`MAX_EXEC_CHARS`，直接进模型上下文）；后台任务的日志是
 * 按需增量读取的，需要留得更久（例如 dev server 启动日志、构建进度），但也不能
 * 让一个话痨进程无限吃内存。超过后丢弃后续输出并补一行提示。
 */
const MAX_BACKGROUND_OUTPUT_CHARS = 200_000

/** 后台任务标签长度上限（任务列表只做展示；完整命令在工具调用参数里） */
const BACKGROUND_JOB_LABEL_CHARS = 160

/** 把命令压成一行、截断成任务标签（多行 heredoc 不能把任务列表撑开） */
function backgroundJobLabel(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim()
  return oneLine.length > BACKGROUND_JOB_LABEL_CHARS
    ? `${oneLine.slice(0, BACKGROUND_JOB_LABEL_CHARS)}…`
    : oneLine
}

/**
 * 启动一次后台命令，立即返回任务 id（不等待命令结束）。
 *
 * 与前台 execute 的三点差别：
 * 1. **不占用工具的取消信号**：后台任务要活过本轮对话/工具调用，因此用独立的
 *    AbortController，只由 job_kill / 停止按钮 / 话题删除 / 退出触发；
 * 2. **不设超时**：dev server 这类命令本来就不会自己退出（`timeoutMs: 0`）；
 * 3. **不占「命令执行窗口」**：文件监听把窗口内的落盘变化归给最近一次调用，
 *    一个跑几十分钟的后台进程会把之后用户和其他工具的改动都算到它头上。
 *    工作区监听仍会广播刷新，只是不记为「本次 execute 的改动」。
 *
 * 输出按块追加进任务注册表：模型可 job_output 增量读取，界面可 peek 查看；
 * 超过 `MAX_BACKGROUND_OUTPUT_CHARS` 后丢弃后续输出并补一行说明。
 */
function startBackgroundCommand(params: {
  command: string
  mode: SandboxMode
  workspacePath: string
  topicId: number
}): string {
  const { command, mode, workspacePath, topicId } = params
  const tr = getFsToolTexts()
  // 命令输出是字节流切片：帧之间原样拼接（不能像子代理文本那样插换行）
  const job = jobsRegistry.start(topicId, 'exec', backgroundJobLabel(command), undefined, {
    frameSeparator: ''
  })
  const controller = new AbortController()
  jobsRegistry.attachCancel(job.id, () => controller.abort())

  void (async () => {
    let captured = 0
    let truncated = false
    const onOutput = (chunk: string): void => {
      if (captured >= MAX_BACKGROUND_OUTPUT_CHARS) {
        truncated = true
        return
      }
      const room = MAX_BACKGROUND_OUTPUT_CHARS - captured
      const kept = chunk.length > room ? chunk.slice(0, room) : chunk
      captured += kept.length
      if (kept) job.appendOutput(kept)
      if (kept.length < chunk.length) truncated = true
    }

    try {
      const result = await runConfinedShell({
        command,
        mode,
        workspaceRoot: workspacePath,
        maxChars: MAX_EXEC_CHARS,
        // 后台命令没有默认时限：停止由用户（顶部栏 / job_kill）或话题删除决定
        timeoutMs: 0,
        signal: controller.signal,
        onOutput
      })

      if (result.unavailable) {
        // 命令根本没跑：与「命令失败」区分开，detail 会随任务一起展示
        job.settle(
          'failed',
          undefined,
          sandboxUnavailableText(
            mainFormat(tr.exec.sandboxUnavailable, { reason: result.unavailable })
          )
        )
        return
      }
      if (result.runnerFailure) {
        job.settle(
          'failed',
          undefined,
          mainFormat(tr.exec.sandboxRunnerFailed, {
            detail: result.runnerFailure.slice(0, 400)
          })
        )
        return
      }
      if (truncated) job.appendOutput(`\n${tr.exec.backgroundTruncated}`)
      // 用户点了停止：取消信号先于「正常退出」判定，任务记为 killed 而不是 failed
      if (controller.signal.aborted) {
        job.settle('killed')
        return
      }
      if (result.timedOut) job.appendOutput(`\n${tr.exec.timedOut}`)
      if (result.denied) {
        job.appendOutput(
          `\n${sandboxDenialText(mode, mainFormat(tr.exec.sandboxDenied, { mode }))}`
        )
      }
      const exitCode = result.exitCode ?? 1
      job.appendOutput(`\n${mainFormat(tr.exec.backgroundExitCode, { code: exitCode })}`)
      job.settle(result.denied || result.timedOut || exitCode !== 0 ? 'failed' : 'completed')
    } catch (error) {
      job.settle(
        'failed',
        undefined,
        mainFormat(tr.exec.backgroundFailed, { message: (error as Error).message })
      )
    }
  })()

  return job.id
}

interface FsMount {
  /** 虚拟前缀，如 '/' 或 '/memories/' */
  prefix: string
  /** 真实根目录 */
  root: string
}

export interface FsBackendOptions {
  /** AI 工作区目录（挂载为虚拟 '/'） */
  workspacePath?: string
  /** 记忆目录（挂载为虚拟 '/memories/'） */
  memoryPath?: string
  /** 当前工作区 ID（文件改动史按工作区归属；缺省则不记录改动） */
  workspaceId?: number
  /**
   * 本轮路由的模型是否声明支持图片输入（models-profile 的 supports_image_input）。
   *
   * 三态语义与 DSH 的 read_image 门禁对齐：`false`（明确不支持/档案未声明）时
   * `read_image` 执行期拒绝；`true` 放行；`undefined`（运行时未拿到模型信息，例如
   * 离线测试/子代理）也放行，由 provider 自己报错，避免把工具意外锁死。
   */
  supportsImageInput?: boolean
}

/**
 * 工作区内的写入记账（可追溯 / 可回溯的唯一入口）。
 *
 * 只有落在工作区挂载内的写入才记录：'/memories/...' 是记忆目录，属于模型私有数据，
 * 不参与「文件改动审查」。记录失败绝不影响工具本身的结果。
 */
async function recordWorkspaceWrite(args: {
  options: FsBackendOptions
  config: unknown
  realPath: string
  before: string | null
  after: string | null
  source: 'write_file' | 'edit_file'
  /**
   * 本次改动的差异规模（+N −M）。
   *
   * 由工具算好传进来，而不是让记录层再 diff 一遍：同一份数字要同时出现在
   * **改动记录**（资源管理器徽标 / 历史列表 / 差异视图回落值）与**聊天卡片**上，
   * 两处各算一次就是两个可能互相矛盾的口径（口径本身在 workspace/line-diff.ts）。
   */
  stats: { added: number; removed: number }
}): Promise<void> {
  const root = args.options.workspacePath
  const workspaceId = args.options.workspaceId
  if (!root || !workspaceId) return
  const relative = path.relative(root, args.realPath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return
  const { callId, topicId } = runContextOf(args.config)
  try {
    await recordFileChange({
      workspaceId,
      workspaceRoot: root,
      realPath: args.realPath,
      before: args.before,
      after: args.after,
      source: args.source,
      topicId,
      callId,
      stats: args.stats
    })
  } catch (err) {
    logger.warn('[FsBackend] Failed to record file change:', err)
  }
}

/** 读出改动前正文；文件不存在（或不可读）返回 null（= 本次是新建） */
function readBeforeOrNull(filePath: string): string | null {
  try {
    if (!fs.statSync(filePath).isFile()) return null
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

/** 由选项构建挂载表（IPC 层读取虚拟路径文件时复用同一套映射） */
export function buildFsMounts(options: FsBackendOptions): FsMount[] {
  const mounts: FsMount[] = []
  if (options.workspacePath) {
    mounts.push({ prefix: '/', root: options.workspacePath })
  }
  if (options.memoryPath) {
    mounts.push({ prefix: '/memories/', root: options.memoryPath })
  }
  return mounts
}

/** 解析虚拟路径 → 真实路径；越界或未挂载返回错误 */
function resolveVirtualPath(
  vp: string,
  mounts: FsMount[]
): { realPath: string } | { error: string } {
  const tr = getFsToolTexts()
  if (!vp) return { error: tr.path.empty }

  // 统一为 POSIX 分隔符
  let normalized = vp.replace(/\\/g, '/')
  // Windows 绝对路径（如 E:\...）一律拒绝，防止扫描驱动器
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return { error: mainFormat(tr.path.absolute, { path: vp }) }
  }
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized
  }
  // 去除末尾斜杠（根路径除外）
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }

  // 最长前缀优先匹配挂载
  const mountsSorted = [...mounts].sort((a, b) => b.prefix.length - a.prefix.length)
  for (const mount of mountsSorted) {
    if (normalized === mount.prefix.slice(0, -1) || normalized.startsWith(mount.prefix)) {
      const rel = normalized.slice(mount.prefix.length).replace(/^\//, '')
      const realPath = path.join(mount.root, ...(rel ? rel.split('/') : []))
      // 二次校验：确保解析结果仍在挂载根内（防 ../ 逃逸）
      const relative = path.relative(mount.root, realPath)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return { error: mainFormat(tr.path.escapesMount, { path: vp }) }
      }
      return { realPath }
    }
  }

  return { error: mainFormat(tr.path.notMounted, { path: vp }) }
}

/** 工具输出统一格式化（字符串原样；对象 JSON 序列化；超硬上限截断，溢出策略负责内联预览） */
function formatOutput(output: unknown): string {
  if (output == null) return 'OK'
  const text = typeof output === 'string' ? output : JSON.stringify(output)
  if (text.length > MAX_OUTPUT_CHARS) {
    const tr = getFsToolTexts()
    const note = mainFormat(tr.output.truncated, { total: text.length })
    return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...${note}`
  }
  return text
}

/** 简易 glob → 正则（支持 *、**、?） */
function globToRegExp(pattern: string): RegExp {
  const GLOBSTAR = '__GLOBSTAR__'
  let re = pattern
    .replace(/\*\*/g, GLOBSTAR) // 临时占位
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(new RegExp(GLOBSTAR, 'g'), '.*')
  // 纯文件名模式也匹配路径末尾
  if (!re.includes('/')) {
    re = `(?:^|/)${re}$`
  } else {
    re = `^${re}$`
  }
  return new RegExp(re)
}

/** 递归收集目录下的相对路径列表（限界） */
function walkDir(root: string, relDir: string, out: string[], cap = MAX_SCAN_ENTRIES): void {
  if (out.length >= cap) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= cap) return
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(rel + '/')
      walkDir(root, rel, out, cap)
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
}

/**
 * 按像素/字节预算缩放或重编码图片（Electron nativeImage）。
 *
 * 真正的解码/编码在 `image-encode.ts`（与用户上传附件共用同一套规则）；这里只把
 * 返回结构适配成 read_image 需要的形状（带虚拟路径与 ImageMimeType）。
 */
function normalizeImageForContext(image: {
  dataUrl: string
  mimeType: ImageMimeType
  bytes: number
  dimensions?: { width: number; height: number }
}): {
  dataUrl: string
  mimeType: ImageMimeType
  bytes: number
  dimensions?: { width: number; height: number }
  normalized: boolean
} {
  const normalized = normalizeImageDataUrl(image.dataUrl)
  const dimensions =
    normalized.width && normalized.height
      ? { width: normalized.width, height: normalized.height }
      : image.dimensions
  return {
    dataUrl: normalized.dataUrl,
    mimeType: normalized.mimeType as ImageMimeType,
    bytes: normalized.bytes || image.bytes,
    dimensions,
    normalized: normalized.normalized
  }
}

/**
 * 构建文件系统工具集。无任何挂载时返回空数组（组件不激活，对应论文「依赖缺失 = 不激活」）。
 */
export function buildFsTools(options: FsBackendOptions): StructuredToolInterface[] {
  const mounts: FsMount[] = buildFsMounts(options)
  if (mounts.length === 0) return []

  const tr = getFsToolTexts()
  const resolve = (vp: string): { realPath: string } | { error: string } =>
    resolveVirtualPath(vp, mounts)

  const tools: StructuredToolInterface[] = [
    tool(
      async ({ file_path, offset, limit }, config) => {
        const callId = callIdOf(config)
        const resolved = resolve(file_path)
        if ('error' in resolved) {
          recordToolFacts(callId, { error: resolved.error })
          return resolved.error
        }
        try {
          const stat = fs.statSync(resolved.realPath)
          if (!stat.isFile()) {
            const notFile = mainFormat(tr.read.notFile, { path: file_path })
            recordToolFacts(callId, { error: notFile })
            return notFile
          }
          let content = fs.readFileSync(resolved.realPath, 'utf-8')
          // 内存保护：超过 2M 字符的文件只保留前 2M 字符
          const oversized = content.length > MAX_FILE_READ_CHARS
          if (oversized) {
            content = content.slice(0, MAX_FILE_READ_CHARS)
          }
          // 行区间读取（offset 从 1 开始）：大文件按需读取指定片段
          if (offset != null || limit != null) {
            const startLine = Math.max(1, offset ?? 1)
            const lines = content.split('\n')
            const endLine = limit != null ? startLine + limit - 1 : lines.length
            const sliced = lines.slice(startLine - 1, endLine)
            const shownEnd = Math.min(endLine, lines.length)
            const lineNote = mainFormat(
              oversized ? tr.read.lineRangeOversized : tr.read.lineRange,
              { start: startLine, end: shownEnd, total: lines.length }
            )
            // 结构化事实：卡片展示「文件共 N 行 · 本次读 start-end」
            recordToolFacts(callId, {
              lines: lines.length,
              truncated: oversized,
              range: { start: startLine, end: shownEnd, total: lines.length }
            })
            return lineNote + sliced.join('\n')
          }
          // 内联读取上限：超出部分不进入模型上下文（read 工具自有边界，不走溢出策略，
          // 参考 dsh-spill-policy 的 read 豁免——大文件用 offset/limit 或 grep 按需读取）
          if (content.length > MAX_FILE_CHARS) {
            const note = mainFormat(tr.read.truncated, {
              total: content.length.toLocaleString()
            })
            recordToolFacts(callId, {
              lines: content.split('\n').length,
              truncated: true
            })
            return `${content.slice(0, MAX_FILE_CHARS)}\n...${note}`
          }
          recordToolFacts(callId, {
            lines: content.split('\n').length,
            truncated: oversized
          })
          return content
        } catch (err) {
          const failed = mainFormat(tr.read.failed, { message: (err as Error).message })
          recordToolFacts(callId, { error: failed })
          return failed
        }
      },
      {
        name: 'read_file',
        isConcurrencySafe: () => true,
        description:
          'Read a file (UTF-8) from the virtual filesystem. Paths are virtual and must start with "/", e.g. /uploads/report.txt or /memories/_global/memories/AGENTS.md. When a file exceeds the inline limit, the result starts with a spill locator for the full content: use offset/limit to read a line range of that file, or grep to locate what you need.',
        schema: z.object({
          file_path: z.string().describe('Virtual path of the file to read'),
          offset: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'Start line number (1-based); use to read one part of a large file on demand'
            ),
          limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Number of lines to read, used together with offset')
        })
      }
    ),

    /**
     * 读取磁盘图片并把图像本身交给模型（对应 DSH 的 read_image）。
     *
     * 与 read_file 的分工：文本走 read_file，二进制图片走这里。返回值不是纯文本，而是
     * 本项目的「文本 + 图像」工具结果（ToolMediaResult）：运行时把 text 当工具结果，
     * 把图像作为紧随其后的一条用户消息送进模型——这样所有 provider 都无需改动
     * （OpenAI 兼容协议的工具消息本身不能带图）。
     */
    tool(
      async ({ file_path }, config) => {
        const callId = callIdOf(config)
        // 视觉门禁：模型档案明确声明不支持图片输入时，在执行边界拒绝（与 DSH 的
        // route-gated read_image 同义）。放在读字节之前，避免为一次注定失败的调用白读文件。
        if (options.supportsImageInput === false) {
          const refused = tr.readImage.modelUnsupported
          recordToolFacts(callId, { error: refused })
          return refused
        }
        const resolved = resolve(file_path)
        if ('error' in resolved) {
          recordToolFacts(callId, { error: resolved.error })
          return resolved.error
        }
        const result = readImageFile(resolved.realPath)
        if (!result.ok) {
          const text =
            result.code === 'not-file'
              ? mainFormat(tr.readImage.notFile, { path: file_path })
              : result.code === 'too-large'
                ? mainFormat(tr.readImage.tooLarge, {
                    bytes: (result.bytes ?? 0).toLocaleString(),
                    limit: MAX_IMAGE_BYTES.toLocaleString()
                  })
                : result.code === 'unsupported'
                  ? mainFormat(tr.readImage.unsupported, { path: file_path })
                  : mainFormat(tr.readImage.failed, { message: result.message })
          recordToolFacts(callId, { error: text })
          return text
        }
        // 规范化：大图/大字节先缩放或重编码，再进上下文（失败自动退回原图）
        const normalized = normalizeImageForContext(result)
        const note = normalized.normalized ? tr.readImage.normalizedNote : ''
        const text = (
          normalized.dimensions
            ? mainFormat(tr.readImage.ok, {
                path: file_path,
                mime: normalized.mimeType,
                width: normalized.dimensions.width,
                height: normalized.dimensions.height,
                bytes: normalized.bytes.toLocaleString()
              })
            : mainFormat(tr.readImage.okNoDimensions, {
                path: file_path,
                mime: normalized.mimeType,
                bytes: normalized.bytes.toLocaleString()
              })
        ) + note
        recordToolFacts(callId, {
          image: true,
          bytes: normalized.bytes,
          mimeType: normalized.mimeType,
          width: normalized.dimensions?.width,
          height: normalized.dimensions?.height
        })
        return toolMedia(text, [
          { dataUrl: normalized.dataUrl, path: file_path, mimeType: normalized.mimeType }
        ])
      },
      {
        name: 'read_image',
        isConcurrencySafe: () => true,
        description:
          'Read a PNG / JPEG / WebP / GIF image from the virtual filesystem and put the image itself into the conversation, so you can actually look at a screenshot, diagram, chart or photo instead of guessing from its name. Requires a vision-capable model; the default cap is 10 MB per image. The image is attached right after this tool result.',
        schema: z.object({
          file_path: z
            .string()
            .describe('Virtual path of the image file, e.g. /uploads/screenshot.png')
        })
      }
    ),

    tool(
      async ({ file_path, content }, config) => {
        const callId = callIdOf(config)
        const resolved = resolve(file_path)
        if ('error' in resolved) {
          recordToolFacts(callId, { error: resolved.error })
          return resolved.error
        }
        try {
          // 异步写（修复：同步写阻塞主进程事件循环）
          await fs.promises.mkdir(path.dirname(resolved.realPath), { recursive: true })
          // 改动前正文（供差异视图与撤销）；新建时为 null
          const before = readBeforeOrNull(resolved.realPath)
          await fs.promises.writeFile(resolved.realPath, content, 'utf-8')
          const bytes = Buffer.byteLength(content, 'utf-8')
          recordToolFacts(callId, { bytes })
          // 卡片上的「+N −M」：与改动记录用同一份数字（见 recordWorkspaceWrite 的 stats）
          const stats = changeStats(before, content)
          recordToolFacts(callId, { added: stats.added, removed: stats.removed })
          // 记账在返回结果之前完成：渲染进程收到「文件已改动」时，磁盘上已经是新内容
          await recordWorkspaceWrite({
            options,
            config,
            realPath: resolved.realPath,
            before,
            after: content,
            source: 'write_file',
            stats
          })
          return mainFormat(tr.write.written, { path: file_path, bytes })
        } catch (err) {
          const failed = mainFormat(tr.write.failed, { message: (err as Error).message })
          recordToolFacts(callId, { error: failed })
          return failed
        }
      },
      {
        name: 'write_file',
        description:
          'Write a file in the virtual filesystem, overwriting it if it already exists. Missing parent directories are created automatically.',
        schema: z.object({
          file_path: z.string().describe('Virtual path of the file to write'),
          content: z.string().describe('Full file content'),
          ...sandboxPermissionField
        })
      }
    ),

    tool(
      async ({ file_path, old_string, new_string, replace_all }, config) => {
        const callId = callIdOf(config)
        // 空 old_string 会使下方的非重叠计数循环永不终止（indexOf('', idx) 恒等于 idx，
        // idx = found + 0 永不前进）——同步死循环直接卡死主进程事件循环，入口必须显式拒绝
        if (!old_string) {
          recordToolFacts(callId, { error: tr.edit.emptyOldString })
          return tr.edit.emptyOldString
        }
        const resolved = resolve(file_path)
        if ('error' in resolved) {
          recordToolFacts(callId, { error: resolved.error })
          return resolved.error
        }
        try {
          const current = fs.readFileSync(resolved.realPath, 'utf-8')
          // 非重叠计数
          let count = 0
          let idx = 0
          while (true) {
            const found = current.indexOf(old_string, idx)
            if (found === -1) break
            count++
            idx = found + old_string.length
          }
          if (count === 0) {
            recordToolFacts(callId, { error: tr.edit.noMatch })
            return tr.edit.noMatch
          }
          if (count > 1 && !replace_all) {
            const multiple = mainPlural(tr.edit.occurrences_one, tr.edit.occurrences_other, count)
            recordToolFacts(callId, { error: multiple })
            return multiple
          }
          const updated = replace_all
            ? current.split(old_string).join(new_string)
            : current.replace(old_string, new_string)
          fs.writeFileSync(resolved.realPath, updated, 'utf-8')
          recordToolFacts(callId, { replacements: count })
          // 「N 处」说的是替换次数，「+N −M」说的是这个文件实际变了多少行：
          // 一次 replace_all 可能改 3 处却动 40 行，两个数都得在卡片上（口径见 changeStats）
          const stats = changeStats(current, updated)
          recordToolFacts(callId, { added: stats.added, removed: stats.removed })
          await recordWorkspaceWrite({
            options,
            config,
            realPath: resolved.realPath,
            before: current,
            after: updated,
            source: 'edit_file',
            stats
          })
          return mainFormat(mainPlural(tr.edit.updated_one, tr.edit.updated_other, count), {
            path: file_path
          })
        } catch (err) {
          const failed = mainFormat(tr.edit.failed, { message: (err as Error).message })
          recordToolFacts(callId, { error: failed })
          return failed
        }
      },
      {
        name: 'edit_file',
        description:
          'Edit a file in the virtual filesystem by replacing old_string with new_string. old_string must match the file content exactly and be unique; when it occurs more than once, either provide a longer unique context or set replace_all to true. Prefer this over write_file for targeted changes.',
        schema: z.object({
          file_path: z.string().describe('Virtual path of the file to edit'),
          old_string: z
            .string()
            .min(1, 'old_string must not be empty')
            .describe(
              'Exact text to find and replace (must match the file content character for character)'
            ),
          new_string: z.string().describe('Replacement text'),
          replace_all: z
            .boolean()
            .optional()
            .describe(
              'When true, replace every occurrence; defaults to false (a unique match is required)'
            ),
          ...sandboxPermissionField
        })
      }
    ),

    /**
     * 多文件补丁（对应 DSH / OpenAI 的 apply_patch）。
     *
     * 两阶段执行：先在内存里读入并应用全部操作、逐块校验；任何一处失败就整体放弃
     * （一个字节都不写）。全部通过后再统一落盘，并逐文件记录改动（差异视图可撤销）。
     */
    tool(
      async ({ input }, config) => {
        const callId = callIdOf(config)
        const parsed = parsePatch(input)
        if (!parsed.ok) {
          const message = mainFormat(tr.applyPatch.parseFailed, { code: parsed.error })
          recordToolFacts(callId, { error: message })
          return message
        }

        interface PlannedChange {
          path: string
          realPath: string
          before: string | null
          after: string | null
          /** 沿用既有来源枚举（DB 有 CHECK 约束）：新增算 write_file，更新/删除算 edit_file */
          source: 'write_file' | 'edit_file'
        }
        const planned: PlannedChange[] = []
        const summaries: string[] = []

        for (const operation of parsed.operations) {
          const resolved = resolve(operation.path)
          if ('error' in resolved) {
            recordToolFacts(callId, { error: resolved.error })
            return resolved.error
          }

          if (operation.kind === 'add') {
            if (fs.existsSync(resolved.realPath)) {
              const message = mainFormat(tr.applyPatch.addExists, { path: operation.path })
              recordToolFacts(callId, { error: message })
              return message
            }
            const after = operation.lines.length > 0 ? `${operation.lines.join('\n')}\n` : ''
            planned.push({
              path: operation.path,
              realPath: resolved.realPath,
              before: null,
              after,
              source: 'write_file'
            })
            summaries.push(
              mainFormat(tr.applyPatch.summaryAdd, {
                path: operation.path,
                lines: operation.lines.length
              })
            )
            continue
          }

          if (operation.kind === 'delete') {
            if (!fs.existsSync(resolved.realPath)) {
              const message = mainFormat(tr.applyPatch.deleteMissing, { path: operation.path })
              recordToolFacts(callId, { error: message })
              return message
            }
            planned.push({
              path: operation.path,
              realPath: resolved.realPath,
              before: fs.readFileSync(resolved.realPath, 'utf-8'),
              after: null,
              source: 'edit_file'
            })
            summaries.push(mainFormat(tr.applyPatch.summaryDelete, { path: operation.path }))
            continue
          }

          // update
          if (!fs.existsSync(resolved.realPath)) {
            const message = mainFormat(tr.applyPatch.updateMissing, { path: operation.path })
            recordToolFacts(callId, { error: message })
            return message
          }
          const before = fs.readFileSync(resolved.realPath, 'utf-8')
          const applied = applyHunks(before, operation.hunks, operation.path)
          if (!applied.ok) {
            const failure = applied.failure
            const hunk = 'hunk' in failure ? failure.hunk + 1 : 1
            const message =
              failure.code === 'empty-hunk'
                ? mainFormat(tr.applyPatch.emptyHunk, { path: operation.path, hunk })
                : mainFormat(tr.applyPatch.hunkNotFound, { path: operation.path, hunk })
            recordToolFacts(callId, { error: message })
            return message
          }
          const stats = changeStats(before, applied.content)
          planned.push({
            path: operation.path,
            realPath: resolved.realPath,
            before,
            after: applied.content,
            source: 'edit_file'
          })
          summaries.push(
            mainFormat(tr.applyPatch.summaryUpdate, {
              path: operation.path,
              added: stats.added,
              removed: stats.removed
            })
          )
        }

        try {
          for (const change of planned) {
            if (change.after === null) {
              fs.unlinkSync(change.realPath)
            } else {
              fs.mkdirSync(path.dirname(change.realPath), { recursive: true })
              fs.writeFileSync(change.realPath, change.after, 'utf-8')
            }
          }
        } catch (err) {
          const message = mainFormat(tr.applyPatch.failed, { message: (err as Error).message })
          recordToolFacts(callId, { error: message })
          return message
        }

        let added = 0
        let removed = 0
        for (const change of planned) {
          const stats = changeStats(change.before, change.after)
          added += stats.added
          removed += stats.removed
          await recordWorkspaceWrite({
            options,
            config,
            realPath: change.realPath,
            before: change.before,
            after: change.after,
            source: change.source,
            stats
          })
        }
        recordToolFacts(callId, { added, removed, files: planned.length })
        return mainFormat(tr.applyPatch.applied, {
          files: planned.length,
          summary: summaries.join('\n')
        })
      },
      {
        name: 'apply_patch',
        description:
          'Apply one multi-file patch in a single call. Format: "*** Begin Patch" then "*** Add File: path" (+lines), "*** Update File: path" (hunks of " context", "-old", "+new" lines, optionally split by "@@"), or "*** Delete File: path", and finally "*** End Patch". Update hunks match context and removed lines exactly (whitespace-sensitive); if any hunk does not match, nothing is written and the error names the file and hunk. Prefer this over several edit_file calls when the changes belong together.',
        schema: z.object({
          input: z
            .string()
            .describe('Full patch text, including the *** Begin Patch / *** End Patch markers')
        })
      }
    ),

    /**
     * 文本编辑器（对应 DSH 的 str_replace_editor）：
     * `view`（带行号查看） / `create`（新建，已存在则失败） / `str_replace`（唯一字面替换） /
     * `insert`（在第 N 行后插入）。写入同样进入文件改动审查。
     */
    tool(
      async (
        { command, path: filePath, file_text, insert_line, new_str, old_str, view_range },
        config
      ) => {
        const callId = callIdOf(config)
        const resolved = resolve(filePath)
        if ('error' in resolved) {
          recordToolFacts(callId, { error: resolved.error })
          return resolved.error
        }
        const realPath = resolved.realPath
        try {
          if (command === 'view') {
            if (!fs.existsSync(realPath)) {
              const message = mainFormat(tr.strEditor.missing, { path: filePath })
              recordToolFacts(callId, { error: message })
              return message
            }
            const content = fs.readFileSync(realPath, 'utf-8')
            const view = formatView(content, view_range as [number, number] | undefined)
            recordToolFacts(callId, { lines: view.totalLines, truncated: view.truncated })
            return view.text || tr.strEditor.viewEmpty
          }

          if (command === 'create') {
            if (fs.existsSync(realPath)) {
              const message = mainFormat(tr.strEditor.exists, { path: filePath })
              recordToolFacts(callId, { error: message })
              return message
            }
            const content = file_text ?? ''
            fs.mkdirSync(path.dirname(realPath), { recursive: true })
            fs.writeFileSync(realPath, content, 'utf-8')
            const stats = changeStats(null, content)
            recordToolFacts(callId, {
              bytes: Buffer.byteLength(content, 'utf-8'),
              added: stats.added,
              removed: stats.removed
            })
            await recordWorkspaceWrite({
              options,
              config,
              realPath,
              before: null,
              after: content,
              source: 'write_file',
              stats
            })
            return mainFormat(tr.strEditor.created, {
              path: filePath,
              lines: content.split('\n').length
            })
          }

          if (!fs.existsSync(realPath)) {
            const message = mainFormat(tr.strEditor.missing, { path: filePath })
            recordToolFacts(callId, { error: message })
            return message
          }
          const current = fs.readFileSync(realPath, 'utf-8')
          let next: string
          let summary: string

          if (command === 'str_replace') {
            const result = applyStrReplace(current, old_str ?? '', new_str ?? '')
            if (!result.ok) {
              const message =
                result.failure === 'not-unique' ? tr.strEditor.notUnique : tr.strEditor.notFound
              recordToolFacts(callId, { error: message })
              return message
            }
            next = result.content
            summary = mainFormat(tr.strEditor.replaced, {
              path: filePath,
              total: next.split('\n').length
            })
          } else {
            const maxLine = current.split('\n').length
            const result = applyInsert(current, insert_line ?? 0, new_str ?? '')
            if (!result.ok) {
              const message = mainFormat(tr.strEditor.invalidLine, { max: maxLine })
              recordToolFacts(callId, { error: message })
              return message
            }
            next = result.content
            summary = mainFormat(tr.strEditor.inserted, {
              path: filePath,
              line: insert_line ?? 0,
              total: next.split('\n').length
            })
          }

          fs.writeFileSync(realPath, next, 'utf-8')
          const stats = changeStats(current, next)
          recordToolFacts(callId, { added: stats.added, removed: stats.removed })
          await recordWorkspaceWrite({
            options,
            config,
            realPath,
            before: current,
            after: next,
            source: 'edit_file',
            stats
          })
          return summary
        } catch (err) {
          const message = mainFormat(tr.strEditor.failed, { message: (err as Error).message })
          recordToolFacts(callId, { error: message })
          return message
        }
      },
      {
        name: 'str_replace_editor',
        description:
          'Text editor with four commands: view (line-numbered content, optional view_range), create (fails if the file exists; needs file_text), str_replace (old_str must occur exactly once; needs old_str + new_str) and insert (insert new_str after line insert_line, where 0 inserts at the top). Use view before a replace when the old content is not fresh.',
        schema: z.object({
          command: z.enum(['view', 'create', 'str_replace', 'insert']),
          path: z.string().describe('Virtual path of the file, e.g. /src/a.ts'),
          file_text: z.string().optional().describe('create: full file content'),
          insert_line: z
            .number()
            .int()
            .optional()
            .describe('insert: line number to insert after (0 inserts at the top)'),
          new_str: z.string().optional().describe('str_replace/insert: the new text'),
          old_str: z
            .string()
            .optional()
            .describe('str_replace: the exact, unique text to replace'),
          view_range: z
            .array(z.number().int())
            .length(2)
            .optional()
            .describe('view: optional [start, end] line range (1-based, inclusive)'),
          ...sandboxPermissionField
        })
      }
    ),

    tool(
      async ({ path: dirPath }, config) => {
        const callId = callIdOf(config)
        const resolved = resolve(dirPath ?? '/')
        if ('error' in resolved) {
          recordToolFacts(callId, { error: resolved.error })
          return resolved.error
        }
        try {
          const entries = fs.readdirSync(resolved.realPath, { withFileTypes: true })
          const files: string[] = []
          const dirs: string[] = []
          for (const entry of entries) {
            if (entry.isDirectory()) dirs.push(entry.name)
            else if (entry.isFile()) files.push(entry.name)
          }
          return JSON.stringify({ path: dirPath ?? '/', files, dirs })
        } catch (err) {
          const failed = mainFormat(tr.ls.failed, { message: (err as Error).message })
          recordToolFacts(callId, { error: failed })
          return failed
        }
      },
      {
        name: 'ls',
        isConcurrencySafe: () => true,
        description:
          'List the files and subdirectories directly inside a virtual filesystem directory (one level, not recursive). Use glob to match paths recursively by pattern.',
        schema: z.object({
          path: z
            .string()
            .optional()
            .describe('Virtual path of the directory, defaults to the root /')
        })
      }
    ),

    tool(
      async ({ pattern, path: searchPath }, config) => {
        const callId = callIdOf(config)
        const resolved = resolve(searchPath ?? '/')
        if ('error' in resolved) {
          recordToolFacts(callId, { error: resolved.error })
          return resolved.error
        }
        try {
          const regex = globToRegExp(pattern)
          const relPaths: string[] = []
          walkDir(resolved.realPath, '', relPaths)
          const matches = relPaths.filter((rel) => regex.test(rel)).slice(0, 200)
          return JSON.stringify({ pattern, files: matches })
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          if (typeof code === 'string' && ACCESS_DENIED_CODES.has(code)) {
            logger.warn(`[FsBackend] glob "${pattern}" blocked by ${code}`)
            return JSON.stringify({ pattern, files: [] })
          }
          const failed = mainFormat(tr.glob.failed, { message: (err as Error).message })
          recordToolFacts(callId, { error: failed })
          return failed
        }
      },
      {
        name: 'glob',
        isConcurrencySafe: () => true,
        description:
          'Find files and directories by path pattern in the virtual filesystem. Patterns support *, ** and ? (e.g. **/*.md) and are matched against paths, not file contents; use grep to search inside files.',
        schema: z.object({
          pattern: z.string().describe('Glob pattern, e.g. **/*.md'),
          path: z
            .string()
            .optional()
            .describe('Virtual path of the directory to start from, defaults to the root /')
        })
      }
    ),

    tool(
      async ({ pattern, path: searchPath, glob: fileGlob }, config) => {
        const callId = callIdOf(config)
        const resolved = resolve(searchPath ?? '/')
        if ('error' in resolved) {
          recordToolFacts(callId, { error: resolved.error })
          return resolved.error
        }
        try {
          const regex = new RegExp(pattern)
          const fileRegex = fileGlob ? globToRegExp(fileGlob) : null
          const relPaths: string[] = []
          walkDir(resolved.realPath, '', relPaths)
          const matches: { path: string; line: number; content: string }[] = []
          for (const rel of relPaths) {
            if (rel.endsWith('/')) continue
            if (fileRegex && !fileRegex.test(rel)) continue
            if (matches.length >= 100) break
            try {
              const abs = path.join(resolved.realPath, rel)
              const stat = fs.statSync(abs)
              if (stat.size > 1024 * 1024) continue // 跳过 >1MB 文件
              const lines = fs.readFileSync(abs, 'utf-8').split('\n')
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  matches.push({ path: '/' + rel, line: i + 1, content: lines[i].slice(0, 200) })
                  if (matches.length >= 100) break
                }
              }
            } catch {
              // 单个文件失败（EPERM 等）跳过
            }
          }
          return JSON.stringify({ matches })
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          if (typeof code === 'string' && ACCESS_DENIED_CODES.has(code)) {
            logger.warn(`[FsBackend] grep "${pattern}" blocked by ${code}`)
            return JSON.stringify({ matches: [] })
          }
          const failed = mainFormat(tr.glob.failed, { message: (err as Error).message })
          recordToolFacts(callId, { error: failed })
          return failed
        }
      },
      {
        name: 'grep',
        isConcurrencySafe: () => true,
        description:
          'Search file contents in the virtual filesystem and return matching lines with their paths and line numbers. The pattern is a regular expression matched against each line; use glob to narrow which files are searched.',
        schema: z.object({
          pattern: z
            .string()
            .describe('Regular expression matched against each line of file content'),
          path: z
            .string()
            .optional()
            .describe('Virtual path of the directory to start from, defaults to the root /'),
          glob: z.string().optional().describe('Optional glob filter for the file paths to search')
        })
      }
    )
  ]

  // execute 仅在工作区目录存在时启用（对应论文 §6.1：命令执行是系统边界外的副作用，需显式开放）
  if (options.workspacePath) {
    tools.push(
      tool(
        async ({ command, run_in_background }, config) => {
          const { callId, topicId } = runContextOf(config)
          const mode = sandboxModeOf(config, topicId)

          /**
           * 后台运行：立即返回任务 id，模型可以继续处理/总结，不阻塞本轮。
           *
           * 任务归属当前话题（顶部栏按 topicId 过滤）：没有话题上下文（例如子代理图）
           * 就拒绝——挂到 0 号话题的任务既不可见也不可管理，比明确报错更糟。
           */
          if (run_in_background) {
            if (topicId == null || topicId <= 0) {
              const text = tr.exec.backgroundNoTopic
              recordToolFacts(callId, { error: text })
              return text
            }
            const jobId = startBackgroundCommand({
              command,
              mode,
              workspacePath: options.workspacePath as string,
              topicId
            })
            return JSON.stringify({
              jobId,
              background: true,
              status: 'running',
              command,
              note: mainFormat(tr.exec.backgroundStarted, { id: jobId })
            })
          }

          // 命令执行窗口：这期间被磁盘监听捕获的文件变化归到这次调用名下
          // （命令没有精确的前后快照，只能如实记录「被命令改过、不可回溯」）
          beginToolWriteWindow({ topicId, callId })
          try {
            // 真正在沙箱里跑（档位 → OS 隔离原语；拿不到后端就拒绝执行，见 sandbox/exec.ts）
            const result = await runConfinedShell({
              command,
              mode,
              workspaceRoot: options.workspacePath,
              maxChars: MAX_EXEC_CHARS,
              timeoutMs: EXEC_TIMEOUT_MS,
              signal: config?.signal
            })

            if (result.unavailable) {
              // 故障关闭：命令没有执行，必须让模型知道「不是命令失败，是没有沙箱可用」
              const text = sandboxUnavailableText(
                mainFormat(tr.exec.sandboxUnavailable, { reason: result.unavailable })
              )
              recordToolFacts(callId, { error: text })
              return text
            }
            if (result.runnerFailure) {
              const text = mainFormat(tr.exec.sandboxRunnerFailed, {
                detail: result.runnerFailure.slice(0, 400)
              })
              recordToolFacts(callId, { error: text })
              return text
            }

            let text = result.output
            if (result.timedOut) {
              text += (text ? '\n' : '') + tr.exec.timedOut
            }
            if (result.denied) {
              // 沙箱把写拒了：附上协议标记与升权提示（模型可据此申请一次人工提权）
              text = sandboxDenialText(
                mode,
                `${mainFormat(tr.exec.sandboxDenied, { mode })}${text ? `\n${text}` : ''}`
              )
            }
            if (text.length > MAX_EXEC_CHARS) {
              text = `${text.slice(0, MAX_EXEC_CHARS)}\n...${tr.exec.truncated}`
            }
            return JSON.stringify({ exitCode: result.exitCode ?? 1, stdout: text })
          } finally {
            // 命令已退出：关窗口（后续 1.5s 宽限内的落盘仍归给它，见 watcher.ts）
            endToolWriteWindow(callId)
          }
        },
        {
          name: 'execute',
          description:
            'Run a shell command (Windows) with the workspace directory as the working directory, returning stdout/stderr and the exit code. The command runs inside an OS-level sandbox: under "workspace-write" it may write inside the workspace (and its private temp directory) but every write outside is denied by the operating system, and under "read-only" no write is possible at all. A denied write returns a [sandbox: ...] marker plus an escalation hint. Set run_in_background=true for long-running processes (dev servers, watchers, builds that never exit): the call returns immediately with a job id instead of blocking the turn; read its output incrementally with job_output(job_id=..., wait=...) and stop it with job_kill(job_id=...). Prefer `read_file`, `write_file`, `ls`, `glob` and `grep` for file and directory work.',
          schema: z.object({
            command: z.string().describe('Shell command to execute'),
            run_in_background: z
              .boolean()
              .optional()
              .describe(
                'Run the command as a background job and return immediately with a job id (default false: wait for the command to exit, up to 30 s). Use this for long-running processes that never exit on their own; continue working without waiting, use job_output to read new output and job_kill to stop it.'
              ),
            ...sandboxPermissionField
          })
        }
      )
    )
  }

  return tools
}

/**
 * 读取虚拟路径下的文本文件（渲染进程「点开工具卡片里的文件」用）。
 *
 * 与 workspace-read-file 的区别：那条通道只允许工作区内的路径（纯文件浏览器的边界），
 * 而工具卡片里的路径可能是记忆挂载（/memories/...）。这里复用同一套挂载解析，
 * 边界仍然是「必须落在某个已挂载根目录内」。
 *
 * @returns 文件内容；路径非法或读取失败时返回 { error }
 */
export function readVirtualTextFile(
  options: FsBackendOptions,
  virtualPath: string
): { content: string } | { error: string } {
  const mounts = buildFsMounts(options)
  if (mounts.length === 0) {
    return { error: mainFormat(getFsToolTexts().path.notMounted, { path: virtualPath }) }
  }
  const resolved = resolveVirtualPath(virtualPath, mounts)
  if ('error' in resolved) return resolved
  try {
    const stat = fs.statSync(resolved.realPath)
    if (!stat.isFile()) {
      return { error: mainFormat(getFsToolTexts().read.notFile, { path: virtualPath }) }
    }
    return { content: fs.readFileSync(resolved.realPath, 'utf-8') }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

/** 供其他模块复用的输出格式化（子代理最终输出等） */
export { formatOutput }
