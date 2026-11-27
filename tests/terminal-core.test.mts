/**
 * 持久终端纯逻辑回归（`runtime/harness/terminal-core.ts`，不启动进程）。
 *
 * 跑法：`node --no-warnings tests/terminal-core.test.mts`
 *
 * 覆盖：shell 选择、完成标记拼装/切分（含半行与 CRLF）、命令规范化、
 * ANSI 清理、二进制判定、环形缓冲的容量/增量/丢弃语义、尾部截断。
 */
import assert from 'node:assert/strict'
import {
  MAX_COMMAND_CHARS,
  OutputRing,
  buildCommandLine,
  createSentinel,
  looksBinary,
  normalizeCommand,
  resolveShell,
  splitAtSentinel,
  stripAnsi,
  truncateTail
} from '../src/main/runtime/harness/terminal-core.ts'

// ── 1. shell 选择 ────────────────────────────────────────────────────
const pwsh = resolveShell('win32', true)
assert.equal(pwsh.kind, 'pwsh')
assert.equal(pwsh.command, 'pwsh.exe')
assert.equal(pwsh.newline, '\r\n')
assert.deepEqual(pwsh.initCommands, ["function prompt { '' }"])

const cmd = resolveShell('win32', false)
assert.equal(cmd.kind, 'cmd')
assert.equal(cmd.command, 'cmd.exe')

const sh = resolveShell('linux', true)
assert.equal(sh.kind, 'sh')
assert.equal(sh.command, '/bin/bash')
assert.equal(sh.newline, '\n')

// ── 2. 完成标记 ──────────────────────────────────────────────────────
assert.equal(createSentinel('abc123'), '__RB_DONE_abc123__')
// 非字母数字被清掉；全空时退回 x
assert.equal(createSentinel('a b-c/d'), '__RB_DONE_abcd__')
assert.equal(createSentinel('!!!'), '__RB_DONE_x__')

// ── 3. 命令拼装 ──────────────────────────────────────────────────────
const sentinel = createSentinel('n1')
const line = buildCommandLine('cd /tmp', sentinel, pwsh)
assert.equal(line, `cd /tmp\r\necho ${sentinel}\r\n`)
// 末尾换行被规范化掉；多行保留
const multi = buildCommandLine('echo a\necho b\n', sentinel, sh)
assert.equal(multi, `echo a\necho b\necho ${sentinel}\n`)

// ── 4. 命令规范化 ────────────────────────────────────────────────────
assert.deepEqual(normalizeCommand('  echo hi  '), { ok: true, command: '  echo hi' })
assert.deepEqual(normalizeCommand('   '), { ok: false, reason: 'empty' })
assert.deepEqual(normalizeCommand(''), { ok: false, reason: 'empty' })
assert.deepEqual(normalizeCommand('a\u0000b'), { ok: false, reason: 'nul' })
assert.deepEqual(normalizeCommand('x'.repeat(MAX_COMMAND_CHARS + 1)), {
  ok: false,
  reason: 'too-long'
})
assert.deepEqual(normalizeCommand('a\r\nb\n\n'), { ok: true, command: 'a\nb' })

// ── 5. ANSI 清理与二进制判定 ────────────────────────────────────────
assert.equal(stripAnsi('\u001b[31mred\u001b[0m plain'), 'red plain')
assert.equal(stripAnsi('\u001b]0;title\u0007text'), 'text')
assert.equal(looksBinary('hello world\nsecond line'), false)
assert.equal(looksBinary('abc\u0000def'), true)
assert.equal(looksBinary('\u0001\u0002\u0003\u0004normal'), true)
assert.equal(looksBinary(''), false)

// ── 6. 完成标记切分 ──────────────────────────────────────────────────
const frame = `out1${'\r\n'}${sentinel}${'\r\n'}`
assert.deepEqual(splitAtSentinel(frame, sentinel), { output: 'out1\r', rest: '' })
// 半行（标记还没收全）不切
assert.equal(splitAtSentinel('out1\r\n__RB_DONE_n', sentinel), null)
// 输出里出现相同文本但不在独立行 → 不误切
assert.equal(splitAtSentinel(`echo ${sentinel} done\r\n`, sentinel), null)
// 空输出 + 标记 → output 为空
assert.deepEqual(splitAtSentinel(`${sentinel}\n`, sentinel), { output: '', rest: '' })
// 标记后还有下一条命令的输出（正常不会发生，但协议要稳）
assert.deepEqual(splitAtSentinel(`${sentinel}\nnext\n`, sentinel), { output: '', rest: 'next\n' })

// ── 7. 环形缓冲 ─────────────────────────────────────────────────────
const ring = new OutputRing(10)
ring.push('abc')
assert.equal(ring.unreadChars, 3)
assert.deepEqual(ring.drain(100), { text: 'abc', truncated: false, dropped: 0 })
assert.equal(ring.unreadChars, 0)

ring.push('0123456789ABCDEF') // 超过容量 10 → 丢最旧
const drained = ring.drain(100)
assert.equal(drained.text, '6789ABCDEF')
assert.ok(drained.dropped >= 6)
assert.equal(ring.dropped, 0, 'drain 后丢弃计数清零')

ring.push('0123456789ABCDEF')
ring.push('GH')
const partial = ring.drain(5)
assert.equal(partial.text, '89ABC')
assert.equal(partial.truncated, true)
assert.equal(ring.unreadChars, 5)
const rest = ring.drain(100)
assert.equal(rest.text, 'DEFGH')

ring.clear()
assert.equal(ring.unreadChars, 0)

// snapshot 是只读快照：不消费未读输出（用户侧终端面板轮询不能抢模型该读的内容）
const snapRing = new OutputRing(100)
snapRing.push('hello-')
snapRing.push('world')
const snap = snapRing.snapshot(5)
assert.equal(snap.text, 'world')
assert.equal(snap.truncated, true)
assert.equal(snapRing.unreadChars, 11, 'snapshot 后未读字符数不变')
const snapAll = snapRing.snapshot(100)
assert.equal(snapAll.text, 'hello-world')
assert.equal(snapAll.truncated, false)
assert.equal(snapRing.unreadChars, 11)
assert.equal(snapRing.drain(100).text, 'hello-world', 'snapshot 之后 drain 仍能取到全部输出')
ring.clear()

// ── 8. 尾部截断 ─────────────────────────────────────────────────────
const long = `start-${'x'.repeat(50)}-END`
const cut = truncateTail(long, 20)
assert.equal(cut.truncated, true)
assert.ok(cut.text.endsWith('END'))
assert.ok(cut.text.includes('已省略'))
assert.deepEqual(truncateTail('short', 20), { text: 'short', truncated: false })

console.log('terminal-core: all assertions passed')
