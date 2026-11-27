/**
 * `run_code`（PTC）执行核心回归（`runtime/harness/run-code.ts`，node:vm，无 electron）。
 *
 * 跑法：`node --no-warnings tests/run-code.test.mts`
 *
 * 覆盖：返回值与 console 收集、异步工具桥（含调用计数）、错误捕获、空/超长代码、
 * 同步死循环超时、异步超时、工具调用上限、返回值截断与循环引用序列化。
 */
import assert from 'node:assert/strict'
import { executeRunCode, serializeValue } from '../src/main/runtime/harness/run-code.ts'

// ── 1. 基础：返回值 + console ───────────────────────────────────────
const basic = await executeRunCode({
  code: `console.log('hello', 42)
return { sum: 1 + 2 }`
})
assert.equal(basic.ok, true)
assert.equal(basic.logs, 'hello 42')
assert.equal(basic.result, '{\n  "sum": 3\n}')
assert.equal(basic.toolCalls, 0)

// 没有 return → 空结果
const emptyReturn = await executeRunCode({ code: '1 + 1' })
assert.equal(emptyReturn.ok, true)
assert.equal(emptyReturn.result, '')

// ── 2. 工具桥：异步调用 + 计数 ──────────────────────────────────────
const bridge = await executeRunCode({
  tools: {
    read_file: async (args) => `content-of:${args.file_path}`,
    grep: async () => 'match'
  },
  code: `const files = ['/a', '/b']
const rows = []
for (const file of files) rows.push(await tools.read_file({ file_path: file }))
console.log('scanned', rows.length)
return rows`
})
assert.equal(bridge.ok, true)
assert.equal(bridge.toolCalls, 2)
assert.equal(bridge.logs, 'scanned 2')
assert.equal(bridge.result, '[\n  "content-of:/a",\n  "content-of:/b"\n]')

// ── 3. 错误捕获 ─────────────────────────────────────────────────────
const thrown = await executeRunCode({ code: `throw new Error('boom')` })
assert.equal(thrown.ok, false)
assert.match(thrown.error ?? '', /boom/)

// 语法错误也要被捕获（不能把异常抛给调用方）
const syntax = await executeRunCode({ code: 'function (' })
assert.equal(syntax.ok, false)
assert.ok((syntax.error ?? '').length > 0)

// ── 4. 前置校验 ─────────────────────────────────────────────────────
assert.deepEqual((await executeRunCode({ code: '   ' })).failure, 'empty')
assert.deepEqual((await executeRunCode({ code: 'x'.repeat(20_001) })).failure, 'too-long')

// ── 5. 超时 ─────────────────────────────────────────────────────────
// 同步死循环：vm 的 sync timeout 兜住
const syncLoop = await executeRunCode({ code: 'while (true) {}', syncTimeoutMs: 100 })
assert.equal(syncLoop.timedOut, true)
assert.equal(syncLoop.ok, false)

// 异步一直不结束：整体时限兜住，且之后工具桥关闭
const asyncHang = await executeRunCode({
  code: `await new Promise(() => {})`,
  timeoutMs: 200
})
assert.equal(asyncHang.timedOut, true)

// ── 6. 工具调用上限 ─────────────────────────────────────────────────
const overLimit = await executeRunCode({
  tools: { ping: async () => 'pong' },
  maxToolCalls: 3,
  code: `for (let i = 0; i < 10; i++) { await tools.ping({}) }`
})
assert.equal(overLimit.ok, false)
assert.match(overLimit.error ?? '', /tool call limit/)
assert.equal(overLimit.toolCalls, 3)

// ── 7. 序列化：循环引用 / 截断 ──────────────────────────────────────
const circular: Record<string, unknown> = { a: 1 }
circular.self = circular
const circularText = serializeValue(circular, 1000)
assert.equal(circularText.truncated, false)
assert.ok(circularText.text.includes('[object Object]') || circularText.text.includes('[unserializable'))

const big = serializeValue({ lines: Array.from({ length: 1000 }, (_, i) => `line-${i}`) }, 100)
assert.equal(big.truncated, true)
assert.ok(big.text.length <= 100)

// 结果截断标记
const bigResult = await executeRunCode({
  code: `return 'x'.repeat(500)`,
  maxResultChars: 50
})
assert.equal(bigResult.truncated, true)
assert.ok(bigResult.result.length <= 50)

console.log('run-code: all assertions passed')
