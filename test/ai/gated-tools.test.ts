/**
 * 危险工具的档位门禁回归（`terminal_open/send` 与 `run_code`）。
 *
 * 这三者都会以用户身份执行代码/命令，**只允许在 danger-full-access 档**使用；
 * 门禁写错等于把任意执行暴露给受限档，因此这里用真实工具对象做集成断言：
 * - 受限档：返回本地化拒绝文本，不启动 shell、不执行代码；
 * - 完全权限档：terminal 的非法 cwd 在 spawn 前被拒绝（不启动进程）；
 * - run_code：桥接只暴露只读工具，写类工具与自身不可见，且能正常执行并回传结果。
 *
 * 由 `scripts/ai-selftest.mjs` 打包（electron 用 stub），不依赖真实窗口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as os from 'node:os'
import * as z from 'zod'
import type { StructuredToolInterface } from '../../src/main/ai/tools'
import { buildTerminalTools } from '../../src/main/runtime/harness/terminal-tools'
import { buildRunCodeTool } from '../../src/main/runtime/harness/run-code-tool'

/** 最小工具替身（isConcurrencySafe 等可选） */
function fakeTool(name: string): StructuredToolInterface {
  return {
    name,
    description: `fake ${name}`,
    schema: z.object({}),
    invoke: async () => `result-of-${name}`
  } as unknown as StructuredToolInterface
}

function toolByName(tools: StructuredToolInterface[], name: string): StructuredToolInterface {
  const found = tools.find((candidate) => candidate.name === name)
  assert.ok(found, `tool ${name} not mounted`)
  return found as StructuredToolInterface
}

const config = (sandboxMode: string) => ({ configurable: { topicId: 1, sandboxMode } })

test('gated tools: terminal_open/send refuse limited modes', async () => {
  const tools = buildTerminalTools({ workspacePath: os.tmpdir() })
  assert.equal(tools.length, 5)
  const open = toolByName(tools, 'terminal_open')
  const send = toolByName(tools, 'terminal_send')

  for (const mode of ['read-only', 'workspace-write']) {
    const openResult = await open.invoke({}, config(mode))
    assert.equal(typeof openResult, 'string')
    assert.match(openResult as string, /完全权限/)
    const sendResult = await send.invoke(
      { session_id: 'term-missing', command: 'echo hi' },
      config(mode)
    )
    assert.match(sendResult as string, /完全权限/)
  }
})

test('gated tools: terminal_open in danger mode validates cwd before spawning', async () => {
  const tools = buildTerminalTools({ workspacePath: os.tmpdir() })
  const open = toolByName(tools, 'terminal_open')
  const result = (await open.invoke(
    { cwd: 'definitely-missing-dir-xyz-123' },
    config('danger-full-access')
  )) as string
  assert.match(result, /工作目录/)
})

test('gated tools: run_code refuses limited modes', async () => {
  const runCode = buildRunCodeTool({ availableTools: [fakeTool('read_file')] })
  for (const mode of ['read-only', 'workspace-write']) {
    const result = (await runCode.invoke({ code: 'return 1 + 1' }, config(mode))) as string
    assert.match(result, /完全权限/)
    assert.doesNotMatch(result, /返回值/)
  }
})

test('gated tools: run_code bridges read-only tools only', async () => {
  const available = [
    fakeTool('read_file'),
    fakeTool('write_file'),
    fakeTool('edit_file'),
    fakeTool('terminal_send'),
    fakeTool('run_code')
  ]
  const runCode = buildRunCodeTool({ availableTools: available })
  const result = (await runCode.invoke(
    {
      code: `const names = Object.keys(tools).sort()
return names`
    },
    config('danger-full-access')
  )) as string
  assert.match(result, /"read_file"/)
  // 写类工具、终端与自身都不能出现在桥里（只匹配 JSON 里的名字，避免命中结果抬头）
  assert.doesNotMatch(result, /"write_file"/)
  assert.doesNotMatch(result, /"edit_file"/)
  assert.doesNotMatch(result, /"terminal_send"/)
  assert.doesNotMatch(result, /"run_code"/)
})

test('gated tools: run_code executes code in danger mode', async () => {
  const runCode = buildRunCodeTool({ availableTools: [fakeTool('read_file')] })
  const result = (await runCode.invoke(
    {
      description: 'sum',
      code: `console.log('log-line')
const items = [1, 2, 3]
return { sum: items.reduce((a, b) => a + b, 0) }`
    },
    config('danger-full-access')
  )) as string
  assert.match(result, /log-line/)
  assert.match(result, /"sum": 6/)
  assert.match(result, /工具调用 0 次/)
})
