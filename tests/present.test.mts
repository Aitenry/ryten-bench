/**
 * present 路径校验回归（`tools/harness/present-core.ts`，纯逻辑）。
 *
 * 跑法：`node --no-warnings tests/present.test.mts`
 *
 * 覆盖：
 * - 虚拟路径 / 相对路径 / 反斜杠 / ./ 前缀都归一化成同一个虚拟路径；
 * - 绝对磁盘路径与 .. 逃逸被拒绝；
 * - 没配工作区、文件不存在、路径是目录分别给出结构化原因；
 * - 正常文件返回真实路径。
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { normalizePresentPath } from '../src/main/tools/harness/present-core.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-present-'))
fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
fs.writeFileSync(path.join(root, 'docs', 'report.md'), '# report\n', 'utf-8')

// ── 1. 正常路径归一化 ─────────────────────────────────────────────────
for (const input of ['/docs/report.md', 'docs/report.md', './docs/report.md', 'docs\\report.md']) {
  const result = normalizePresentPath(input, root)
  assert.equal(result.ok, true, `${input} should resolve`)
  if (result.ok) {
    assert.equal(result.virtualPath, '/docs/report.md')
    assert.equal(result.realPath, path.join(root, 'docs', 'report.md'))
  }
}

// ── 2. 拒绝项 ────────────────────────────────────────────────────────
assert.deepEqual(normalizePresentPath('   ', root), { ok: false, failure: { code: 'empty' } })
assert.deepEqual(normalizePresentPath('', root), { ok: false, failure: { code: 'empty' } })

// 没配工作区：即使路径看起来合法也拒绝（present 只能在有工作区的会话里用）
assert.deepEqual(normalizePresentPath('/docs/report.md'), {
  ok: false,
  failure: { code: 'no-workspace' }
})

// 绝对磁盘路径（Windows 盘符）
assert.deepEqual(normalizePresentPath('C:\\Windows\\win.ini', root), {
  ok: false,
  failure: { code: 'escape', path: 'C:\\Windows\\win.ini' }
})

// .. 逃逸
assert.deepEqual(normalizePresentPath('../secret.txt', root), {
  ok: false,
  failure: { code: 'escape', path: '../secret.txt' }
})
assert.deepEqual(normalizePresentPath('/docs/../../etc/passwd', root), {
  ok: false,
  failure: { code: 'escape', path: '/docs/../../etc/passwd' }
})

// 不存在
assert.deepEqual(normalizePresentPath('/docs/missing.md', root), {
  ok: false,
  failure: { code: 'missing', path: '/docs/missing.md' }
})

// 目录不是文件
assert.deepEqual(normalizePresentPath('/docs', root), {
  ok: false,
  failure: { code: 'not-file', path: '/docs' }
})

fs.rmSync(root, { recursive: true, force: true })
console.log('present: all assertions passed')
