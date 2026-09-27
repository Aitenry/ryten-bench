import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import { mainFormat, mainPlural } from '../../../../main/i18n'
import { getFsToolTexts } from '../../../../main/i18n/tool-results-fs'
import { recordToolFacts } from './tool-result-facts'
import { recordFileChange } from '../workspace/file-history'
import { changeStats } from '../workspace/line-diff'
import { beginToolWriteWindow, endToolWriteWindow } from '../workspace/watcher'
import { permissionGate } from './permission-gate'
import { isPermissionMode } from './permission'
import { runConfinedShell, sandboxDenialText, sandboxUnavailableText } from '../sandbox/exec'
import type { SandboxMode } from '../sandbox/types'
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
    logger.warn('[FsBackend] 文件改动记录失败:', err)
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
        async ({ command }, config) => {
          const { callId, topicId } = runContextOf(config)
          // 命令执行窗口：这期间被磁盘监听捕获的文件变化归到这次调用名下
          // （命令没有精确的前后快照，只能如实记录「被命令改过、不可回溯」）
          beginToolWriteWindow({ topicId, callId })
          const mode = sandboxModeOf(config, topicId)
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
            'Run a shell command (Windows) with the workspace directory as the working directory, returning stdout/stderr and the exit code. The command runs inside an OS-level sandbox: under "workspace-write" it may write inside the workspace (and its private temp directory) but every write outside is denied by the operating system, and under "read-only" no write is possible at all. A denied write returns a [sandbox: ...] marker plus an escalation hint. Prefer `read_file`, `write_file`, `ls`, `glob` and `grep` for file and directory work.',
          schema: z.object({
            command: z.string().describe('Shell command to execute'),
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
