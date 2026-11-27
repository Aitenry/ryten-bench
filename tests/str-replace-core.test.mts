/**
 * str_replace_editor 纯逻辑回归（`runtime/harness/str-replace-core.ts`）。
 *
 * 跑法：`node --no-warnings tests/str-replace-core.test.mts`
 *
 * 覆盖：
 * - view 的行号格式 / 行区间 / 越界与非法区间 / 超长截断；
 * - str_replace 的唯一匹配（0 处、多处都失败，且内容不变）；
 * - insert 的 0 基位置语义、末尾追加、越界拒绝、CRLF 归一化。
 */
import assert from 'node:assert/strict'
import {
  MAX_VIEW_LINES,
  applyInsert,
  applyStrReplace,
  formatView
} from '../src/main/runtime/harness/str-replace-core.ts'

// ── 1. view ───────────────────────────────────────────────────────────
const content = 'alpha\nbeta\ngamma\n'
const view = formatView(content)
assert.equal(view.totalLines, 3)
assert.equal(view.truncated, false)
assert.equal(view.text, '1  alpha\n2  beta\n3  gamma')

const ranged = formatView(content, [2, 3])
assert.equal(ranged.text, '2  beta\n3  gamma')
assert.equal(ranged.totalLines, 3)

// 非法区间（start > end / 0 / 负数）退回全文
assert.equal(formatView(content, [3, 1]).text, view.text)
assert.equal(formatView(content, [0, 2]).text, view.text)

// 越界区间被夹到文件范围
assert.equal(formatView(content, [2, 99]).text, '2  beta\n3  gamma')

// 空文件
assert.equal(formatView('').text, '')
assert.equal(formatView('').totalLines, 0)

// 超长截断
const long = Array.from({ length: MAX_VIEW_LINES + 10 }, (_, i) => `line${i + 1}`).join('\n')
const clipped = formatView(long)
assert.equal(clipped.truncated, true)
assert.equal(clipped.totalLines, MAX_VIEW_LINES + 10)
assert.ok(clipped.text.startsWith(`(${MAX_VIEW_LINES + 10} lines total; showing lines 1-${MAX_VIEW_LINES})`))

// CRLF 归一化后行号正确
assert.equal(formatView('a\r\nb\r\n').text, '1  a\n2  b')

// ── 2. str_replace ────────────────────────────────────────────────────
const replaced = applyStrReplace('one two three', 'two', 'TWO')
assert.deepEqual(replaced, { ok: true, content: 'one TWO three', replacements: 1 })

assert.deepEqual(applyStrReplace('one two', 'missing', 'x'), {
  ok: false,
  failure: 'not-found'
})
assert.deepEqual(applyStrReplace('a a', 'a', 'b'), { ok: false, failure: 'not-unique' })
assert.deepEqual(applyStrReplace('abc', '', 'x'), { ok: false, failure: 'not-found' })

// 多行替换：精确匹配空白与换行
const multi = applyStrReplace('if (a) {\n  b()\n}\n', 'if (a) {\n  b()\n}', 'if (c) {\n  d()\n}')
assert.equal(multi.ok, true)
if (multi.ok) assert.equal(multi.content, 'if (c) {\n  d()\n}\n')

// ── 3. insert ─────────────────────────────────────────────────────────
assert.deepEqual(applyInsert('a\nb\n', 0, 'top'), { ok: true, content: 'top\na\nb\n' })
assert.deepEqual(applyInsert('a\nb\n', 1, 'mid'), { ok: true, content: 'a\nmid\nb\n' })
assert.deepEqual(applyInsert('a\nb', 2, 'end'), { ok: true, content: 'a\nb\nend\n' })
assert.deepEqual(applyInsert('a\nb', 3, 'x'), { ok: false, failure: 'invalid-line' })
assert.deepEqual(applyInsert('a\nb', -1, 'x'), { ok: false, failure: 'invalid-line' })
assert.deepEqual(applyInsert('a\nb', 1.5, 'x'), { ok: false, failure: 'invalid-line' })

// 插入多行 + CRLF 输入归一化
assert.deepEqual(applyInsert('a\r\nb\r\n', 0, 'x\r\ny'), {
  ok: true,
  content: 'x\ny\na\nb\n'
})

console.log('str-replace-core: all assertions passed')
