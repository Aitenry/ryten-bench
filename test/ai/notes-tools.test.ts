/**
 * 文档精修引擎 + 旧工具名迁移的离线回归（node:test）。
 *
 * 这些用例覆盖用户 2026-11 反馈的核心：
 * - 可以按行、按行内列区间、按文本片段替换/插入/删除；
 * - 中文与 emoji 的列号不被 UTF-16 代理对切坏；
 * - CRLF 不被悄悄改成 LF；
 * - expectedOld / expectedRevision / patch 原子性；
 * - 旧的 manage_docs 等四个工具名自动迁移到 manage_materials。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DocEditError,
  applyEdits,
  deleteLines,
  deleteRange,
  findInContent,
  insertText,
  lineCountOf,
  parseDocument,
  previewChange,
  replaceLines,
  replaceRange,
  replaceText,
  revisionOf,
  summarizeChange
} from '../../src/main/tools/notes/doc-edit'
import {
  MATERIALS_TOOL_NAME,
  canonicalToolName,
  effectiveMainAgentTools
} from '../../src/shared/harness/mcp'

function expectEditError(fn: () => unknown, code: string): DocEditError {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof DocEditError, `expected DocEditError, got ${String(err)}`)
    assert.equal(err.code, code)
    return err
  }
  assert.fail(`expected DocEditError(${code})`)
}

// ============================================================================
// 基础
// ============================================================================

test('revisionOf: 12 位内容哈希，内容变则修订变', () => {
  assert.equal(revisionOf('abc').length, 12)
  assert.equal(revisionOf('abc'), revisionOf('abc'))
  assert.notEqual(revisionOf('abc'), revisionOf('abd'))
})

test('lineCountOf / parseDocument：行号 1 起，末尾换行算一个空行', () => {
  assert.equal(lineCountOf(''), 1)
  assert.equal(lineCountOf('a'), 1)
  assert.equal(lineCountOf('a\nb'), 2)
  assert.equal(lineCountOf('a\nb\n'), 3)
  assert.deepEqual(parseDocument('a\r\nb').lines, ['a', 'b'])
})

// ============================================================================
// 按行替换 / 删除
// ============================================================================

test('replaceLines：单行替换、多行替换、空串删行', () => {
  assert.equal(
    replaceLines('one\ntwo\nthree', { startLine: 2, endLine: 2, newText: 'TWO' }),
    'one\nTWO\nthree'
  )
  assert.equal(
    replaceLines('one\ntwo\nthree', { startLine: 2, endLine: 2, newText: 'TWO\n2.5' }),
    'one\nTWO\n2.5\nthree'
  )
  assert.equal(
    replaceLines('one\ntwo\nthree', { startLine: 2, endLine: 2, newText: '' }),
    'one\nthree'
  )
  assert.equal(replaceLines('', { startLine: 1, endLine: 1, newText: 'x' }), 'x')
})

test('replaceLines：expectedOld 逐字校验，行号漂移时拒绝', () => {
  const ok = replaceLines('a\nb\nc', {
    startLine: 2,
    endLine: 2,
    newText: 'B',
    expectedOld: 'b'
  })
  assert.equal(ok, 'a\nB\nc')

  const err = expectEditError(
    () =>
      replaceLines('a\nCHANGED\nc', {
        startLine: 2,
        endLine: 2,
        newText: 'B',
        expectedOld: 'b'
      }),
    'expected-old-mismatch-lines'
  )
  assert.match(String(err.details.actual), /CHANGED/)
})

test('replaceLines：越界行号给出结构化错误', () => {
  expectEditError(
    () => replaceLines('a\nb', { startLine: 3, endLine: 3, newText: 'x' }),
    'range-out-of-range'
  )
  expectEditError(
    () => replaceLines('a\nb', { startLine: 2, endLine: 1, newText: 'x' }),
    'range-out-of-range'
  )
})

test('deleteLines：中间行、末尾空行', () => {
  assert.equal(deleteLines('a\nb\nc', { startLine: 2, endLine: 2 }), 'a\nc')
  assert.equal(deleteLines('a\nb\n', { startLine: 3, endLine: 3 }), 'a\nb')
})

// ============================================================================
// 行内列区间
// ============================================================================

test('replaceRange：中文按码点、闭区间替换', () => {
  assert.equal(
    replaceRange('你好世界', { line: 1, startColumn: 2, endColumn: 3, newText: '爱' }),
    '你爱界'
  )
})

test('replaceRange：emoji 不被代理对切坏', () => {
  assert.equal(replaceRange('a😀b', { line: 1, startColumn: 2, endColumn: 2, newText: 'X' }), 'aXb')
})

test('replaceRange：行首/行尾插入与多行替换', () => {
  assert.equal(replaceRange('abc', { line: 1, startColumn: 4, endColumn: 3, newText: 'X' }), 'abcX')
  assert.equal(replaceRange('abc', { line: 1, startColumn: 1, endColumn: 0, newText: 'X' }), 'Xabc')
  assert.equal(
    replaceRange('abc', { line: 1, startColumn: 2, endColumn: 2, newText: 'X\nY' }),
    'aX\nYc'
  )
})

test('replaceRange：expectedOld 校验被替换的字符段', () => {
  assert.equal(
    replaceRange('abcdef', {
      line: 1,
      startColumn: 3,
      endColumn: 4,
      newText: 'X',
      expectedOld: 'cd'
    }),
    'abXef'
  )
  expectEditError(
    () =>
      replaceRange('abZZef', {
        line: 1,
        startColumn: 3,
        endColumn: 4,
        newText: 'X',
        expectedOld: 'cd'
      }),
    'expected-old-mismatch-range'
  )
})

test('replaceRange：列越界 / 空区间非法', () => {
  expectEditError(
    () => replaceRange('abc', { line: 1, startColumn: 5, endColumn: 4, newText: 'x' }),
    'column-out-of-range'
  )
  expectEditError(
    () => replaceRange('abc', { line: 1, startColumn: 2, endColumn: 4, newText: 'x' }),
    'column-out-of-range'
  )
})

test('deleteRange：删行内区间', () => {
  assert.equal(deleteRange('abcdef', { line: 1, startColumn: 2, endColumn: 4 }), 'aef')
})

// ============================================================================
// 插入
// ============================================================================

test('insertText：行内、行前、行后、文首、文末', () => {
  assert.equal(
    insertText('ab\ncd', { position: 'at', line: 2, column: 2, newText: 'X' }),
    'ab\ncXd'
  )
  assert.equal(insertText('ab\ncd', { position: 'before', line: 2, newText: 'X' }), 'ab\nX\ncd')
  assert.equal(insertText('ab\ncd', { position: 'after', line: 2, newText: 'X' }), 'ab\ncd\nX')
  assert.equal(insertText('ab\ncd', { position: 'start', newText: 'X' }), 'X\nab\ncd')
  assert.equal(insertText('ab\ncd', { position: 'end', newText: 'X' }), 'ab\ncd\nX')
  assert.equal(insertText('', { position: 'start', newText: 'X' }), 'X')
})

test('insertText：空内容拒绝', () => {
  expectEditError(() => insertText('a', { position: 'end', newText: '' }), 'empty-edit')
})

// ============================================================================
// 文本片段替换
// ============================================================================

test('replaceText：唯一命中才允许省略 occurrence/all', () => {
  assert.equal(replaceText('hello world', { oldText: 'world', newText: 'there' }), 'hello there')
  const err = expectEditError(
    () => replaceText('a a', { oldText: 'a', newText: 'b' }),
    'ambiguous-match'
  )
  assert.equal(err.details.count, 2)
})

test('replaceText：all / occurrence / 行区间限定', () => {
  assert.equal(replaceText('a a a', { oldText: 'a', newText: 'b', all: true }), 'b b b')
  assert.equal(replaceText('a a a', { oldText: 'a', newText: 'b', occurrence: 2 }), 'a b a')
  assert.equal(
    replaceText('a\nb\na', { oldText: 'a', newText: 'X', startLine: 2, endLine: 3 }),
    'a\nb\nX'
  )
})

test('replaceText：默认忽略大小写，可用 caseSensitive 收紧', () => {
  assert.equal(replaceText('Hello hello', { oldText: 'hello', newText: 'hi', all: true }), 'hi hi')
  assert.equal(
    replaceText('Hello hello', {
      oldText: 'hello',
      newText: 'hi',
      all: true,
      caseSensitive: true
    }),
    'Hello hi'
  )
})

test('replaceText：正则替换与非法正则错误', () => {
  assert.equal(
    replaceText('a1b22', { oldText: '\\d+', newText: 'N', all: true, regex: true }),
    'aNbN'
  )
  expectEditError(
    () => replaceText('abc', { oldText: '(', newText: 'x', regex: true }),
    'invalid-regex'
  )
  expectEditError(() => replaceText('abc', { oldText: '', newText: 'x' }), 'empty-query')
  expectEditError(() => replaceText('abc', { oldText: 'z', newText: 'x' }), 'no-match')
})

// ============================================================================
// 批量编辑 / 预览
// ============================================================================

test('applyEdits：按顺序应用，行号基于上一步结果', () => {
  const result = applyEdits('one\ntwo\nthree', [
    { type: 'replace_lines', startLine: 1, endLine: 1, newText: 'ONE' },
    { type: 'insert', position: 'after', line: 2, newText: '2.5' }
  ])
  assert.equal(result, 'ONE\ntwo\n2.5\nthree')
})

test('applyEdits：任意一处失败带 editIndex，且不产生半截结果（纯内存）', () => {
  const err = expectEditError(
    () =>
      applyEdits('one\ntwo', [
        { type: 'replace_lines', startLine: 1, endLine: 1, newText: 'ONE' },
        { type: 'replace_lines', startLine: 9, endLine: 9, newText: 'X' }
      ]),
    'range-out-of-range'
  )
  assert.equal(err.editIndex, 2)
  expectEditError(() => applyEdits('a', []), 'patch-empty')

  const missingNewText = expectEditError(
    () => applyEdits('a', [{ type: 'replace_lines', startLine: 1, endLine: 1 } as never]),
    'missing-new-text'
  )
  assert.equal(missingNewText.editIndex, 1)
})

test('summarizeChange / previewChange：插入、替换、删除', () => {
  const inserted = summarizeChange('a\nb', 'a\nx\nb')
  assert.equal(inserted?.removed, 0)
  assert.equal(inserted?.added, 1)
  assert.equal(inserted?.startLine, 2)
  assert.equal(inserted?.endLine, 1)

  const replaced = summarizeChange('a\nb\nc', 'a\nX\nc')
  assert.equal(replaced?.removed, 1)
  assert.equal(replaced?.added, 1)
  assert.equal(replaced?.startLine, 2)

  const removed = summarizeChange('a\nb\nc', 'a\nc')
  assert.equal(removed?.removed, 1)
  assert.equal(removed?.added, 0)

  const preview = previewChange('a\nb', 'a\nx\nb')
  assert.equal(preview?.newText, 'x')
  assert.equal(preview?.oldText, '')
})

// ============================================================================
// 查找 / EOL
// ============================================================================

test('findInContent：字面量、行列（码点）、上下文', () => {
  const result = findInContent('hello\nworld hello', {
    query: 'hello',
    contextLines: 0
  })
  assert.equal(result.total, 2)
  assert.equal(result.matches[0].line, 1)
  assert.equal(result.matches[0].column, 1)
  assert.equal(result.matches[0].endColumn, 5)
  assert.equal(result.matches[1].line, 2)
  assert.equal(result.matches[1].column, 7)
  assert.match(result.matches[1].snippet, /2\| world hello/)
})

test('findInContent：正则、截断标记', () => {
  const result = findInContent('a1 b22 c333', {
    query: '\\d+',
    regex: true,
    maxMatches: 2
  })
  assert.equal(result.total, 3)
  assert.equal(result.matches.length, 2)
  assert.equal(result.truncated, true)
})

test('编辑保持原文 EOL（CRLF 不会被改成 LF）', () => {
  const result = replaceLines('a\r\nb\r\n', { startLine: 1, endLine: 1, newText: 'A' })
  assert.equal(result, 'A\r\nb\r\n')
  assert.equal(result.includes('\n') && !result.includes('\r\n'), false)
})

test('编辑保持换行风格：模型给 CRLF 也归一后按原文落盘', () => {
  const result = replaceLines('a\nb', { startLine: 1, endLine: 1, newText: 'A\r\nB' })
  assert.equal(result, 'A\nB\nb')
})

// ============================================================================
// 旧工具名迁移
// ============================================================================

test('canonicalToolName：四个旧资料工具名都归一到 manage_materials', () => {
  for (const legacy of ['manage_docs', 'manage_todos', 'manage_wikis', 'search_graph']) {
    assert.equal(canonicalToolName(legacy), MATERIALS_TOOL_NAME)
  }
  assert.equal(canonicalToolName('get_time'), 'get_time')
  assert.equal(canonicalToolName('manage_materials'), 'manage_materials')
})

test('effectiveMainAgentTools：旧勾选自动迁移并去重，不影响其它工具', () => {
  assert.deepEqual(
    effectiveMainAgentTools({
      tools: ['manage_docs', 'manage_todos', 'get_time', 'manage_materials']
    }),
    ['manage_materials', 'get_time']
  )
  assert.deepEqual(effectiveMainAgentTools({ tools: ['search_graph'], mcpTools: ['mcp__a__x'] }), [
    'manage_materials',
    'mcp__a__x'
  ])
})
