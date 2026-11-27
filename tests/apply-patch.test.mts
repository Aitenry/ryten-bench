/**
 * apply_patch 纯逻辑回归（`runtime/harness/apply-patch.ts`，不碰文件系统/Electron）。
 *
 * 跑法：`node --no-warnings tests/apply-patch.test.mts`
 *
 * 覆盖：
 * - Add / Update / Delete 三种指令的解析与 hunk 推导（空格=上下文、-=删除、+=新增）；
 * - 多 hunk 顺序应用、CRLF 归一化、末尾换行保留；
 * - 匹配失败/空 hunk/缺 Begin/End/空补丁的结构化错误；
 * - 更新块找不到上下文时绝不改内容（调用方据此整体放弃）。
 */
import assert from 'node:assert/strict'
import {
  applyHunks,
  parsePatch,
  type PatchHunk
} from '../src/main/runtime/harness/apply-patch.ts'

const PATCH = `*** Begin Patch
*** Add File: /docs/new.md
+# Title
+body line
*** Update File: /src/a.ts
@@ first change
 const a = 1
-const b = 2
+const b = 3
@@ second change
 const c = 4
+const d = 5
*** Delete File: /old.txt
*** End Patch`

const parsed = parsePatch(PATCH)
assert.equal(parsed.ok, true)
if (parsed.ok) {
  assert.equal(parsed.operations.length, 3)
  const [add, update, del] = parsed.operations
  assert.deepEqual(add, { kind: 'add', path: '/docs/new.md', lines: ['# Title', 'body line'] })
  assert.equal(del.kind, 'delete')
  assert.equal(del.kind === 'delete' && del.path, '/old.txt')
  assert.equal(update.kind, 'update')
  if (update.kind === 'update') {
    assert.equal(update.path, '/src/a.ts')
    assert.equal(update.hunks.length, 2)
    assert.deepEqual(update.hunks[0].oldLines, ['const a = 1', 'const b = 2'])
    assert.deepEqual(update.hunks[0].newLines, ['const a = 1', 'const b = 3'])
    assert.deepEqual(update.hunks[1].oldLines, ['const c = 4'])
    assert.deepEqual(update.hunks[1].newLines, ['const c = 4', 'const d = 5'])
  }
}

// ── 应用：单 hunk ─────────────────────────────────────────────────────
const one: PatchHunk[] = [{ oldLines: ['a', 'b'], newLines: ['a', 'B'] }]
assert.deepEqual(applyHunks('x\na\nb\ny\n', one), { ok: true, content: 'x\na\nB\ny\n' })
assert.deepEqual(applyHunks('a\nb', one), { ok: true, content: 'a\nB' })

// ── 应用：多 hunk 顺序、从上一个之后继续找 ───────────────────────────
const two: PatchHunk[] = [
  { oldLines: ['first'], newLines: ['first changed'] },
  { oldLines: ['second'], newLines: ['second changed'] }
]
assert.deepEqual(applyHunks('first\nsecond\n', two), {
  ok: true,
  content: 'first changed\nsecond changed\n'
})

// ── CRLF 输入：按 LF 匹配并输出 ──────────────────────────────────────
assert.deepEqual(applyHunks('a\r\nb\r\nc', [{ oldLines: ['b'], newLines: ['B'] }]), {
  ok: true,
  content: 'a\nB\nc'
})

// ── 找不到上下文：返回结构化失败，内容不动 ──────────────────────────
const notFound = applyHunks('a\nb\n', [{ oldLines: ['zzz'], newLines: ['x'] }], '/src/a.ts')
assert.equal(notFound.ok, false)
if (!notFound.ok) {
  assert.equal(notFound.failure.code, 'hunk-not-found')
  assert.equal(notFound.failure.code === 'hunk-not-found' && notFound.failure.hunk, 0)
  assert.equal(notFound.failure.code === 'hunk-not-found' && notFound.failure.path, '/src/a.ts')
}

// 第二个 hunk 失败时 index 要对（1-based 只在文案层加）
const secondFails = applyHunks('a\nb\n', [
  { oldLines: ['a'], newLines: ['A'] },
  { oldLines: ['zzz'], newLines: ['x'] }
])
assert.equal(secondFails.ok, false)
if (!secondFails.ok && secondFails.failure.code === 'hunk-not-found') {
  assert.equal(secondFails.failure.hunk, 1)
}

// 空 hunk（只有 @@ 没有内容）
const empty = applyHunks('a\n', [{ oldLines: [], newLines: [] }], '/f')
assert.equal(empty.ok, false)
if (!empty.ok) assert.equal(empty.failure.code, 'empty-hunk')

// ── 解析错误 ─────────────────────────────────────────────────────────
const noBegin = parsePatch('*** Update File: a\n x\n')
assert.deepEqual(noBegin, { ok: false, error: 'missing-begin' })
const noEnd = parsePatch('*** Begin Patch\n*** Add File: a\n+x\n')
assert.deepEqual(noEnd, { ok: false, error: 'missing-end' })
const emptyPatch = parsePatch('*** Begin Patch\n*** End Patch')
assert.deepEqual(emptyPatch, { ok: false, error: 'empty-patch' })
const unknown = parsePatch('*** Begin Patch\n*** Move File: a\n*** End Patch')
assert.equal(unknown.ok, false)

// 上下文行不带前缀时按上下文处理（宽松容错）
const loose = parsePatch(`*** Begin Patch
*** Update File: /a.txt
 no-prefix line
-gone
+new
*** End Patch`)
assert.equal(loose.ok, true)
if (loose.ok && loose.operations[0].kind === 'update') {
  assert.deepEqual(loose.operations[0].hunks[0].oldLines, ['no-prefix line', 'gone'])
  assert.deepEqual(loose.operations[0].hunks[0].newLines, ['no-prefix line', 'new'])
}


// ── 行尾空白容错 ─────────────────────────────────────────────────────
// 模型从编辑器复制的上下文常带行尾空格；只放宽行尾，行首缩进仍然严格。
const trailing = applyHunks('const a = 1\nconst b = 2   \nnext\n', [
  { oldLines: ['const b = 2'], newLines: ['const b = 3'] }
])
assert.deepEqual(trailing, { ok: true, content: 'const a = 1\nconst b = 3\nnext\n' })

// 补丁侧带行尾空白、文件侧没有，同样可匹配
const trailingPatch = applyHunks('one\ntwo\n', [
  { oldLines: ['one   '], newLines: ['ONE'] }
])
assert.deepEqual(trailingPatch, { ok: true, content: 'ONE\ntwo\n' })

// 行首缩进不同 **不** 容忍（避免补丁打到错误的缩进层级）
assert.deepEqual(
  applyHunks('  indented\n', [{ oldLines: ['indented'], newLines: ['x'] }]),
  { ok: false, failure: { code: 'hunk-not-found', path: '', hunk: 0 } }
)

// 精确匹配优先于行尾容错：同样内容出现两次时，先命中的精确位置被替换
const preferExact = applyHunks('x\nx   \n', [{ oldLines: ['x'], newLines: ['X'] }])
assert.deepEqual(preferExact, { ok: true, content: 'X\nx   \n' })

console.log('apply-patch: all assertions passed')
