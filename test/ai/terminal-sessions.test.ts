/**
 * 持久终端会话层集成测试（真实 shell）。
 *
 * 由 `scripts/ai-selftest.mjs` 用 esbuild 打包后跑 node:test；不依赖 electron。
 * 非 Windows 自动跳过；Windows 上优先 pwsh，没有 pwsh 时用 cmd 回退（本机就是这种情况），
 * 两套命令集在测试里按 shell 种类分支。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as os from 'node:os'
import {
  TerminalSessionManager,
  type TerminalSendResult
} from '../../src/main/runtime/harness/terminal-sessions'

/** 当前可用的 shell 命令集（按 shell 种类分支） */
interface ShellCommands {
  setEnv: string
  readEnv: string
  readEnvPattern: RegExp
  changeDir: string
  readDir: string
  failingCommand: string
  sleepCommand: string
  echoAfter: string
}

function commandsFor(kind: 'pwsh' | 'cmd' | 'sh'): ShellCommands {
  if (kind === 'pwsh') {
    return {
      setEnv: `$env:RB_TERM_TEST = 'alive'`,
      readEnv: 'Write-Output "value=$env:RB_TERM_TEST"',
      readEnvPattern: /value=alive/,
      changeDir: 'Set-Location $env:TEMP; (Get-Location).Path',
      readDir: '(Get-Location).Path',
      failingCommand: 'Get-Item C:\\definitely-missing-path-xyz',
      sleepCommand: 'Start-Sleep -Milliseconds 2500',
      echoAfter: 'Write-Output "after-timeout"'
    }
  }
  return {
    setEnv: 'set RB_TERM_TEST=alive',
    readEnv: 'echo value=%RB_TERM_TEST%',
    readEnvPattern: /value=alive/,
    changeDir: 'cd %TEMP% && cd',
    readDir: 'cd',
    failingCommand: 'dir C:\\definitely-missing-path-xyz',
    sleepCommand: 'ping -n 3 127.0.0.1 > nul',
    echoAfter: 'echo after-timeout'
  }
}

/** 打开一条会话；不满足条件时返回 null（用例 skip） */
async function openSession(topicId: number): Promise<{
  manager: TerminalSessionManager
  id: string
  commands: ShellCommands
} | null> {
  if (process.platform !== 'win32') return null
  const manager = new TerminalSessionManager()
  const opened = await manager.open({ topicId, workspaceRoot: os.tmpdir() })
  if (!opened.ok) {
    manager.closeAll()
    return null
  }
  return {
    manager,
    id: opened.session.sessionId,
    commands: commandsFor(opened.session.shell as 'pwsh' | 'cmd' | 'sh')
  }
}

/** 断言一次 send 成功并返回输出（失败时把错误码带进断言消息） */
async function sendOk(
  manager: TerminalSessionManager,
  id: string,
  command: string,
  waitMs?: number
): Promise<TerminalSendResult> {
  const result = await manager.send(id, command, waitMs)
  assert.equal(result.ok, true, `send failed: ${result.ok ? '' : result.error}`)
  if (!result.ok) throw new Error('unreachable')
  return result.result
}

test('terminal sessions: state persists across commands', async (t) => {
  const session = await openSession(7)
  if (!session) {
    t.skip('needs Windows with cmd or pwsh')
    return
  }
  const { manager, id, commands } = session
  try {
    // 1. 环境变量跨命令保持
    await sendOk(manager, id, commands.setEnv)
    const echo = await sendOk(manager, id, commands.readEnv)
    assert.match(echo.output, commands.readEnvPattern)

    // 2. cd 保持：切换目录后下一条命令仍在同一目录
    const cd = await sendOk(manager, id, commands.changeDir)
    const pwd = await sendOk(manager, id, commands.readDir)
    assert.equal(pwd.output.trim().toLowerCase(), cd.output.trim().toLowerCase())

    // 3. 失败命令不会杀死会话
    await sendOk(manager, id, commands.failingCommand)
    const after = await sendOk(manager, id, 'echo after-error')
    assert.match(after.output, /after-error/)

    // 4. read 能取到输出且不残留内部完成标记
    const read = manager.read(id)
    assert.equal(read.ok, true)
    if (read.ok) {
      assert.equal(typeof read.text, 'string')
      assert.doesNotMatch(read.text, /__RB_DONE_/)
    }
  } finally {
    manager.closeAll()
  }
  assert.equal(manager.activeCount, 0)
})

test('terminal sessions: timeout leaves the session usable', async (t) => {
  const session = await openSession(8)
  if (!session) {
    t.skip('needs Windows with cmd or pwsh')
    return
  }
  const { manager, id, commands } = session
  try {
    const slow = await manager.send(id, commands.sleepCommand, 300)
    assert.equal(slow.ok, true)
    if (slow.ok) assert.equal(slow.result.timedOut, true)

    // 超时后会话仍可用：等它跑完后发送新命令能拿到输出
    const after = await sendOk(manager, id, commands.echoAfter, 20_000)
    assert.match(after.output, /after-timeout/)
  } finally {
    manager.closeAll()
  }
  assert.equal(manager.activeCount, 0)
})

test('terminal sessions: validation errors are stable codes', async (t) => {
  const session = await openSession(9)
  if (!session) {
    t.skip('needs Windows with cmd or pwsh')
    return
  }
  const { manager, id } = session
  try {
    assert.deepEqual(await manager.send('term-missing', 'echo hi'), {
      ok: false,
      error: 'session-not-found'
    })
    assert.deepEqual(await manager.send(id, '   '), { ok: false, error: 'empty-command' })
    assert.deepEqual(await manager.send(id, 'a\u0000b'), { ok: false, error: 'nul-command' })
    assert.deepEqual(manager.read('term-missing'), { ok: false, error: 'session-not-found' })

    // 每个话题最多 3 条会话
    const second = await manager.open({ topicId: 9, workspaceRoot: os.tmpdir() })
    const third = await manager.open({ topicId: 9, workspaceRoot: os.tmpdir() })
    const fourth = await manager.open({ topicId: 9, workspaceRoot: os.tmpdir() })
    assert.equal(second.ok, true)
    assert.equal(third.ok, true)
    assert.deepEqual(fourth, { ok: false, error: 'too-many-sessions' })
  } finally {
    manager.closeAll()
  }
  assert.equal(manager.activeCount, 0)
})
