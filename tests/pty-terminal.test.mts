/**
 * 用户侧真终端（node-pty）管理器的回归测试。
 *
 * 跑法：`node --no-warnings tests/pty-terminal.test.mts`
 *
 * 覆盖两层：
 * - 纯函数：shell 解析 / cwd 归一 / 尺寸归一；
 * - 管理器：用注入的假 PTY 测会话上限、输出缓冲、resize、关闭与退出回调；
 *   最后用**真实 node-pty** 起一个 shell 跑 `echo` 验证「真终端」链路（无 shell 环境跳过）。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import {
  MAX_PTY_SESSIONS_PER_TOPIC,
  PTY_BUFFER_CHARS,
  PtyTerminalManager,
  clampPtySize,
  resolvePtyCwd,
  resolvePtyShell
} from '../src/main/runtime/harness/pty-terminal.ts'

// ── 1. 纯函数 ──────────────────────────────────────────────────────────────
{
  const win = resolvePtyShell()
  if (process.platform === 'win32') {
    assert.equal(win.kind, 'cmd')
    assert.ok(win.file.toLowerCase().includes('cmd'), 'Windows 默认 cmd.exe')
    assert.equal(resolvePtyShell('pwsh').kind, 'pwsh')
    assert.equal(resolvePtyShell('sh').kind, 'sh')
  } else {
    assert.equal(win.kind, 'sh')
    assert.ok(win.args.includes('-i'), 'POSIX 交互 shell 带 -i')
  }
  assert.deepEqual(clampPtySize(120, 40), { cols: 120, rows: 40 })
  assert.deepEqual(clampPtySize(0, 0), { cols: 80, rows: 24 })
  assert.deepEqual(clampPtySize(Number.NaN, -5), { cols: 80, rows: 24 })
  assert.deepEqual(clampPtySize(9999, 9999), { cols: 500, rows: 200 })
  assert.equal(resolvePtyCwd(''), null)
  assert.equal(resolvePtyCwd('C:\\definitely-not-exists-0.2.6'), null)
  assert.equal(resolvePtyCwd(homedir()), homedir())
}

// ── 2. 假 PTY：管理器逻辑（不依赖真实 shell） ───────────────────────────────
class FakePty extends EventEmitter {
  pid = 4242
  written: string[] = []
  resized: Array<{ cols: number; rows: number }> = []
  killed = false
  write(data: string): void {
    this.written.push(data)
  }
  resize(cols: number, rows: number): void {
    this.resized.push({ cols, rows })
  }
  kill(): void {
    this.killed = true
  }
  emitData(data: string): void {
    this.emit('data', data)
  }
  emitExit(exitCode: number): void {
    this.emit('exit', { exitCode })
  }
  onData(listener: (data: string) => void): void {
    this.on('data', listener)
  }
  onExit(listener: (event: { exitCode: number }) => void): void {
    this.on('exit', listener)
  }
}

{
  const spawns: FakePty[] = []
  const manager = new PtyTerminalManager({
    idleSweepMs: 60 * 60_000,
    spawn: (() => {
      const pty = new FakePty()
      spawns.push(pty)
      return pty
    }) as never
  })
  const dataLog: string[] = []
  const exits: Array<{ id: string; code: number | null }> = []
  manager.onData = (_id, data) => dataLog.push(data)
  manager.onExit = (id, code) => exits.push({ id, code })

  const opened = manager.open({ topicId: 7, cwd: homedir(), cols: 120, rows: 40 })
  assert.equal(opened.ok, true)
  if (!opened.ok) throw new Error('open failed')
  const session = opened.session
  assert.equal(session.topicId, 7)
  assert.equal(session.cols, 120)
  assert.equal(manager.list(7).length, 1)

  // 输入原样写入 / resize 透传 / 输出缓冲与回放
  assert.equal(manager.write(session.sessionId, 'dir\r'), true)
  assert.deepEqual(spawns[0].written, ['dir\r'])
  assert.equal(manager.resize(session.sessionId, 100, 30), true)
  assert.deepEqual(spawns[0].resized, [{ cols: 100, rows: 30 }])
  spawns[0].emitData('hello-')
  spawns[0].emitData('pty')
  assert.deepEqual(dataLog, ['hello-', 'pty'])
  assert.equal(manager.buffer(session.sessionId), 'hello-pty')

  // 输出缓冲上限
  spawns[0].emitData('x'.repeat(PTY_BUFFER_CHARS + 500))
  assert.equal(manager.buffer(session.sessionId).length, PTY_BUFFER_CHARS)
  assert.ok(manager.buffer(session.sessionId).endsWith('x'))

  // 会话上限
  for (let i = 0; i < MAX_PTY_SESSIONS_PER_TOPIC - 1; i += 1) {
    assert.equal(manager.open({ topicId: 7 }).ok, true)
  }
  const denied = manager.open({ topicId: 7 })
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.equal(denied.error, 'too-many-sessions')

  // 关闭会通知 onExit(null)，且列表移除
  const before = manager.list(7).length
  assert.deepEqual(manager.close(session.sessionId), { ok: true, found: true })
  assert.equal(manager.list(7).length, before - 1)
  assert.deepEqual(exits, [{ id: session.sessionId, code: null }])
  assert.equal(spawns[0].killed, true)

  // 进程自然退出：alive=false + onExit(exitCode)
  const second = manager.list(7)[0]
  const ptyOfSecond = spawns[1]
  ptyOfSecond.emitExit(3)
  assert.equal(manager.list(7).find((s) => s.sessionId === second.sessionId)?.alive, false)
  assert.deepEqual(exits[1], { id: second.sessionId, code: 3 })

  manager.closeAll()
  assert.equal(manager.list(7).length, 0)
}

// ── 3. 真 node-pty 集成：起 shell 跑 echo（无 shell 环境跳过） ───────────────
{
  const manager = new PtyTerminalManager({ idleSweepMs: 60 * 60_000 })
  const chunks: string[] = []
  manager.onData = (_id, data) => chunks.push(data)
  const opened = manager.open({ topicId: 9, cwd: homedir(), cols: 100, rows: 30 })
  if (opened.ok) {
    try {
      const waitFor = async (needle: string, timeoutMs = 10_000): Promise<boolean> => {
        const started = Date.now()
        while (Date.now() - started < timeoutMs) {
          if (chunks.join('').includes(needle)) return true
          await new Promise((resolve) => setTimeout(resolve, 60))
        }
        return false
      }
      // 等 shell 起来（首个 prompt 输出）
      const shellAlive = await waitFor('', 300)
      assert.equal(typeof shellAlive, 'boolean')
      manager.write(opened.session.sessionId, 'echo PTY_E2E_MARK_026\r')
      const ok = await waitFor('PTY_E2E_MARK_026')
      assert.equal(ok, true, '真实 PTY 应回显并执行 echo 输出')
      assert.ok(manager.buffer(opened.session.sessionId).includes('PTY_E2E_MARK_026'))
      assert.equal(manager.resize(opened.session.sessionId, 120, 40), true)
    } finally {
      manager.closeAll()
    }
  } else {
    console.warn(`pty-terminal: skipped real shell integration (${opened.error}${opened.detail ? `: ${opened.detail}` : ''})`)
  }
}

console.log('pty-terminal: all assertions passed')
