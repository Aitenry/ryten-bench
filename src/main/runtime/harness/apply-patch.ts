/**
 * `apply_patch` 的纯解析与应用逻辑（无 electron / 无文件系统依赖，可离线测试）。
 *
 * 格式与 DSH / OpenAI 的 apply_patch 一致：
 *
 * ```
 * *** Begin Patch
 * *** Add File: docs/new.md
 * +第一行
 * *** Update File: src/a.ts
 * @@ optional context
 *  上下文行
 * -旧行
 * +新行
 * *** Delete File: old.txt
 * *** End Patch
 * ```
 *
 * 设计取舍：
 * - 更新块按「连续上下文 + 删除行」的**精确序列**匹配（空白与换行必须一致），
 *   不做模糊匹配——补丁失败时宁可报错让模型重读文件，也不要在错误位置改代码；
 * - 每个 hunk 的匹配从上一个 hunk 之后开始，保证多 hunk 自上而下应用；
 * - CRLF 输入统一按 LF 解析/输出（本项目所有文本工具都按 UTF-8 文本处理）。
 */

/** 一个更新块：old 是上下文 + 删除行，new 是上下文 + 新增行 */
export interface PatchHunk {
  oldLines: string[]
  newLines: string[]
}

export type PatchOperation =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; hunks: PatchHunk[] }

export type ParsePatchResult =
  | { ok: true; operations: PatchOperation[] }
  | { ok: false; error: string }

/** 解析失败/应用失败的结构化原因（上层负责本地化文案） */
export type PatchFailure =
  | { code: 'missing-begin' }
  | { code: 'missing-end' }
  | { code: 'empty-patch' }
  | { code: 'unknown-directive'; line: string }
  | { code: 'missing-path' }
  | { code: 'hunk-not-found'; path: string; hunk: number }
  | { code: 'empty-hunk'; path: string; hunk: number }

/** 去掉行尾 \r，统一按 LF 处理 */
function normalizeLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

/**
 * 解析补丁文本。失败返回结构化错误（不抛异常），由工具层翻译成界面语言。
 */
export function parsePatch(input: string): ParsePatchResult {
  const lines = normalizeLines(input)
  let index = 0
  // 允许补丁前有空行/说明文字，但第一条指令必须是 Begin Patch
  while (index < lines.length && lines[index].trim() === '') index++
  if (index >= lines.length || !/^\*\*\* Begin Patch\s*$/.test(lines[index].trim())) {
    return { ok: false, error: 'missing-begin' }
  }
  index++

  const operations: PatchOperation[] = []
  let sawEnd = false

  while (index < lines.length) {
    const raw = lines[index]
    const line = raw.trimEnd()
    if (line.trim() === '') {
      index++
      continue
    }
    if (/^\*\*\* End Patch\s*$/.test(line.trim())) {
      sawEnd = true
      index++
      break
    }

    const add = /^\*\*\* Add File:\s*(.+?)\s*$/.exec(line)
    const update = /^\*\*\* Update File:\s*(.+?)\s*$/.exec(line)
    const del = /^\*\*\* Delete File:\s*(.+?)\s*$/.exec(line)

    if (add) {
      const path = add[1]
      index++
      const added: string[] = []
      while (index < lines.length && !/^\*\*\* /.test(lines[index].trimStart())) {
        const body = lines[index]
        if (body.startsWith('+')) added.push(body.slice(1))
        else if (body.trim() !== '') added.push(body) // 容错：Add File 里未加 + 的行按字面加入
        index++
      }
      operations.push({ kind: 'add', path, lines: added })
      continue
    }

    if (del) {
      operations.push({ kind: 'delete', path: del[1] })
      index++
      continue
    }

    if (update) {
      const path = update[1]
      index++
      const hunks: PatchHunk[] = []
      let current: { oldLines: string[]; newLines: string[] } | null = null
      const flush = (): void => {
        if (!current) return
        hunks.push({ oldLines: current.oldLines, newLines: current.newLines })
        current = null
      }
      while (index < lines.length) {
        const body = lines[index]
        const trimmed = body.trimStart()
        if (/^\*\*\* End Patch\s*$/.test(body.trim()) || /^\*\*\* (Add|Update|Delete) File:/.test(trimmed)) {
          break
        }
        if (trimmed.startsWith('@@')) {
          flush()
          current = { oldLines: [], newLines: [] }
          index++
          continue
        }
        if (trimmed.startsWith('*** End of File')) {
          index++
          continue
        }
        if (body.startsWith('*** ')) {
          return { ok: false, error: `unknown-directive:${body.trim()}` }
        }
        if (!current) current = { oldLines: [], newLines: [] }
        const marker = body[0]
        if (marker === '+') {
          current.newLines.push(body.slice(1))
        } else if (marker === '-') {
          current.oldLines.push(body.slice(1))
        } else if (marker === ' ' || marker === undefined) {
          current.oldLines.push(body.slice(1))
          current.newLines.push(body.slice(1))
        } else if (marker === '@') {
          // 以 @ 开头的上下文行（非 @@ 指令）：按上下文处理
          current.oldLines.push(body)
          current.newLines.push(body)
        } else {
          // 无前缀的行按上下文处理（宽松但不破坏匹配语义）
          current.oldLines.push(body)
          current.newLines.push(body)
        }
        index++
      }
      flush()
      if (hunks.length === 0) {
        return { ok: false, error: `empty-hunk:${path}` }
      }
      operations.push({ kind: 'update', path, hunks })
      continue
    }

    return { ok: false, error: `unknown-directive:${line.trim()}` }
  }

  if (!sawEnd) return { ok: false, error: 'missing-end' }
  if (operations.length === 0) return { ok: false, error: 'empty-patch' }
  return { ok: true, operations }
}

export type ApplyHunksResult =
  | { ok: true; content: string }
  | { ok: false; failure: PatchFailure }

/**
 * 把若干 hunk 依次应用到文本内容。
 *
 * @param content 原文（LF 或 CRLF 均可）
 * @param hunks 解析出的更新块
 * @param path 仅用于错误信息（哪个文件的第几个 hunk 没匹配上）
 */
export function applyHunks(content: string, hunks: PatchHunk[], path = ''): ApplyHunksResult {
  const hasTrailingNewline = /\n$/.test(content)
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (hasTrailingNewline) lines.pop()

  let searchStart = 0
  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
    const hunk = hunks[hunkIndex]
    if (hunk.oldLines.length === 0) {
      return { ok: false, failure: { code: 'empty-hunk', path, hunk: hunkIndex } }
    }
    const at = findSequence(lines, hunk.oldLines, searchStart)
    if (at < 0) {
      return { ok: false, failure: { code: 'hunk-not-found', path, hunk: hunkIndex } }
    }
    lines.splice(at, hunk.oldLines.length, ...hunk.newLines)
    searchStart = at + hunk.newLines.length
  }

  return { ok: true, content: lines.join('\n') + (hasTrailingNewline ? '\n' : '') }
}

/** 在 lines 中从 from 开始查找一段连续序列，返回起始下标；找不到返回 -1 */
function findSequence(lines: string[], sequence: string[], from: number): number {
  const exact = findSequenceWith(lines, sequence, from, (line, expected) => line === expected)
  if (exact >= 0) return exact
  // 容错回退：只忽略**行尾**空白（模型从编辑器复制时常见）。行首缩进仍然严格匹配——
  // 代码里前导空白有语义，宽容它会把补丁打到错误的分支/缩进层级上。
  return findSequenceWith(lines, sequence, from, (line, expected) => line.trimEnd() === expected.trimEnd())
}

/** 按给定的行比较器查找连续序列 */
function findSequenceWith(
  lines: string[],
  sequence: string[],
  from: number,
  equals: (line: string, expected: string) => boolean
): number {
  for (let start = Math.max(0, from); start <= lines.length - sequence.length; start++) {
    let match = true
    for (let offset = 0; offset < sequence.length; offset++) {
      if (!equals(lines[start + offset], sequence[offset])) {
        match = false
        break
      }
    }
    if (match) return start
  }
  return -1
}
