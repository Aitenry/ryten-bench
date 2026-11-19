import type { ToolCard } from '../types'
import { MAX_EXEC_CHARS, MAX_FILE_CHARS } from '../runtime/tool-limits'
import type { ToolResultFacts } from '../runtime/tool-result-facts'

/**
 * 内置工具结果的「前端投影」——决定一次工具调用有哪些内容会离开主进程。
 *
 * 背景（本次重构的动因）：内置文件/命令工具（read_file / write_file / edit_file /
 * ls / glob / grep / execute）的结果此前被**原样**发往渲染进程并原样落库，而聊天里
 * 这些工具走的是定制卡片（只显示路径/命令/计数）——也就是说，一份几十 KB 的
 * read_file 正文、一份整文件的 write_file 入参、几百条 grep 匹配，被完整地
 * 传输 + 存进数据库，却**从来没有人看**。一个工具密集轮次能白白搬运数 MB。
 *
 * 现在的口径：
 *  - 卡片需要的元信息 → `card`（路径、计数、行数、字节、退出码、失败原因）；
 *  - 需要看内容 → 点击卡片，在右侧面板打开真实文件（文件类工具）
 *    或结果详情页签（ls / glob / grep / execute，详情另存于 runtime/tool-output-store）；
 *  - 因此 `input` 只保留卡片必需的字段（write_file 的 content、edit_file 的
 *    old_string/new_string 这类大入参一律丢弃），`output` 一律置空。
 *
 * 安全网：**卡片生成不出来时保留一小段输出**（≤ FALLBACK_CHARS）。否则一旦出现
 * 未预期的调用形态（模型把参数名写错等），前端会看到一张既没有卡片、又没有内容的
 * 空块——宁可多传 2KB，也不能让错误从界面上消失。
 *
 * 本模块保持零依赖（只用类型与常量），可被 node 离线回归脚本直接导入验证。
 */

/** 无卡片兜底时保留的输出上限（字符） */
export const FALLBACK_OUTPUT_CHARS = 2_000
/** 卡片摘要文本上限（字符） */
const MESSAGE_CHARS = 200
/** 需要另存结果详情的工具：卡片点开后在右侧面板查看 */
const DETAIL_TOOLS = new Set(['ls', 'glob', 'grep', 'execute'])
/** 参与投影的工具（其余工具保持原样下发） */
export const PROJECTED_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'ls',
  'glob',
  'grep',
  'execute'
])

export interface ToolProjection {
  /** 下发/落库用的输入（已裁剪到卡片所需） */
  input: Record<string, unknown>
  /** 下发/落库用的输出（内置工具一律为空串；无卡片时保留一小段兜底文本） */
  output: string
  /** 卡片数据 */
  card?: ToolCard
  /** 需要另存的结果详情原文（ls / glob / grep / execute） */
  detailText?: string
}

/** 非空字符串取用 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 单行摘要：折叠空白 + 截断（卡片只展示一行） */
function clampLine(text: string | undefined, max = MESSAGE_CHARS): string | undefined {
  if (!text) return undefined
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (!oneLine) return undefined
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** 按白名单挑字段（丢弃 undefined） */
function pick(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const value = input?.[key]
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

/** 安全 JSON 解析（失败返回 null） */
function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * 裁剪工具**入参**（执行中/完成态共用）。
 *
 * write_file 的 `content` 可能是整个文件（几百 KB~MB）；edit_file 的
 * `old_string`/`new_string` 同样可能是成段代码。前端卡片只需要路径，
 * 这两类大字段必须在进入 IPC 之前就丢掉。
 */
export function projectToolInput(
  name: string,
  input: Record<string, unknown> | undefined
): Record<string, unknown> {
  const raw = input ?? {}
  switch (name) {
    case 'read_file':
      return pick(raw, ['file_path', 'offset', 'limit'])
    case 'write_file': {
      // content 是整份文件正文：只保留长度供卡片展示，正文本身不进 IPC/库
      const out = pick(raw, ['file_path'])
      if (typeof raw.content === 'string')
        out.content_bytes = Buffer.byteLength(raw.content, 'utf-8')
      return out
    }
    case 'edit_file': {
      const out = pick(raw, ['file_path', 'replace_all'])
      if (typeof raw.old_string === 'string')
        out.old_string_bytes = Buffer.byteLength(raw.old_string, 'utf-8')
      if (typeof raw.new_string === 'string')
        out.new_string_bytes = Buffer.byteLength(raw.new_string, 'utf-8')
      return out
    }
    case 'ls':
      return pick(raw, ['path'])
    case 'glob':
      return pick(raw, ['pattern', 'path'])
    case 'grep':
      return pick(raw, ['pattern', 'path', 'glob'])
    case 'execute':
      return pick(raw, ['command'])
    default:
      return raw
  }
}

/**
 * 构建一次工具调用的完整投影（完成态）。
 *
 * @param name    工具名
 * @param input   模型给出的入参
 * @param output  工具返回的原始文本（模型看到的那份）
 * @param facts   执行期登记的结构化事实（失败原因/字节/替换处数/行数），见 tool-result-facts
 */
export function buildToolProjection(params: {
  name: string
  input: Record<string, unknown> | undefined
  output: string
  facts?: ToolResultFacts
}): ToolProjection {
  const { name, output, facts } = params
  const input = projectToolInput(name, params.input)
  const error = str(facts?.error)

  /** 兜底：没有卡片 → 保留一小段输出，别让内容凭空消失 */
  const fallback = (): ToolProjection => ({
    input,
    output: output.length > FALLBACK_OUTPUT_CHARS ? output.slice(0, FALLBACK_OUTPUT_CHARS) : output,
    card: error ? { status: 'error', message: clampLine(error) } : undefined
  })

  switch (name) {
    case 'read_file': {
      const path = str(params.input?.file_path)
      if (!path) return fallback()
      // 截断判定：正常读取的正文不超过 MAX_FILE_CHARS；被截断时输出必然超过它
      // （返回的是「前 N 字符 + 省略提示」）。工具另有 facts.truncated 时以其为准。
      const truncated = facts?.truncated ?? output.length > MAX_FILE_CHARS
      const card: ToolCard = {
        kind: 'file',
        path,
        status: error ? 'error' : 'ok',
        message: clampLine(error),
        chars: output.length,
        truncated,
        lines: facts?.lines,
        range: facts?.range
      }
      return { input, output: '', card }
    }

    case 'write_file': {
      const path = str(params.input?.file_path)
      if (!path) return fallback()
      // 写文件的返回值是一句很短的本地化确认文本（含路径与字节数），保留它没有成本，
      // 也是「这次写入到底做了什么」的唯一记录
      const card: ToolCard = {
        kind: 'file',
        path,
        status: error ? 'error' : 'ok',
        message: error ? clampLine(error) : clampLine(output),
        bytes:
          facts?.bytes ??
          (typeof input.content_bytes === 'number' ? input.content_bytes : undefined),
        added: facts?.added,
        removed: facts?.removed
      }
      return { input, output: error ? '' : output, card }
    }

    case 'edit_file': {
      const path = str(params.input?.file_path)
      if (!path) return fallback()
      const card: ToolCard = {
        kind: 'file',
        path,
        status: error ? 'error' : 'ok',
        message: error ? clampLine(error) : clampLine(output),
        count: facts?.replacements,
        // 替换处数 + 差异规模：一个说「改了几处」，一个说「文件实际变了多少行」
        added: facts?.added,
        removed: facts?.removed
      }
      return { input, output: error ? '' : output, card }
    }

    case 'ls': {
      const path = str(params.input?.path) ?? '/'
      const parsed = parseJson(output)
      const files = Array.isArray(parsed?.files) ? (parsed.files as string[]).length : 0
      const dirs = Array.isArray(parsed?.dirs) ? (parsed.dirs as string[]).length : 0
      if (!parsed && !error) return fallback()
      const card: ToolCard = {
        kind: 'dir',
        path,
        status: error ? 'error' : 'ok',
        message: error ? clampLine(error) : undefined,
        files,
        dirs,
        count: files + dirs,
        detail: !error
      }
      return { input, output: '', card, detailText: error ? undefined : output }
    }

    case 'glob': {
      const pattern = str(params.input?.pattern)
      const parsed = parseJson(output)
      const files = Array.isArray(parsed?.files) ? (parsed.files as unknown[]).length : undefined
      if (!parsed && !error) return fallback()
      const card: ToolCard = {
        kind: 'search',
        pattern,
        path: str(params.input?.path),
        status: error ? 'error' : 'ok',
        message: error ? clampLine(error) : undefined,
        files,
        count: files,
        detail: !error
      }
      return { input, output: '', card, detailText: error ? undefined : output }
    }

    case 'grep': {
      const pattern = str(params.input?.pattern)
      const parsed = parseJson(output)
      const matches = Array.isArray(parsed?.matches)
        ? (parsed.matches as { path?: unknown }[])
        : undefined
      if (!parsed && !error) return fallback()
      const fileSet = new Set<string>()
      for (const match of matches ?? []) {
        const p = str(match?.path)
        if (p) fileSet.add(p)
      }
      const card: ToolCard = {
        kind: 'search',
        pattern,
        path: str(params.input?.path),
        status: error ? 'error' : 'ok',
        message: error ? clampLine(error) : undefined,
        count: matches?.length,
        fileCount: matches ? fileSet.size : undefined,
        detail: !error
      }
      return { input, output: '', card, detailText: error ? undefined : output }
    }

    case 'execute': {
      const command = str(params.input?.command)
      if (!command) return fallback()
      const parsed = parseJson(output)
      const exitCode = typeof parsed?.exitCode === 'number' ? parsed.exitCode : undefined
      if (error) {
        return {
          input,
          output: '',
          card: { kind: 'command', command, status: 'error', message: clampLine(error) }
        }
      }
      if (!parsed) return fallback()
      const stdout = typeof parsed.stdout === 'string' ? parsed.stdout : ''
      const card: ToolCard = {
        kind: 'command',
        command,
        status: exitCode !== undefined && exitCode !== 0 ? 'error' : 'ok',
        exitCode,
        chars: stdout.length,
        // 命令输出被 MAX_EXEC_CHARS 截断时，末尾带本地化省略提示；长度即可判定
        truncated: stdout.length > MAX_EXEC_CHARS,
        detail: true
      }
      return { input, output: '', card, detailText: output }
    }

    default:
      // 非内置工具（mnemon_* / manage_* 等）：保持原样下发与落库，
      // 它们自带条数上限，且前端要解析 JSON 渲染专属卡片
      return { input, output }
  }
}

/** 判断某次工具调用是否需要另存结果详情 */
export function needsDetailStore(name: string): boolean {
  return DETAIL_TOOLS.has(name)
}
