/**
 * 权限策略离线回归（permission.ts 是零 import 的纯逻辑，可直接 node 跑）。
 *
 * 覆盖 2026-11 安全审计 S02 的修复：
 * - 会构建/执行模型写的代码的插件工坊工具必须归 `code` 类，受限档要用户确认；
 * - 其余工具分类不回归（write/read/exec/external）；
 * - 危险命令在 workspace-write 仍弹窗、read-only 仍拒绝。
 *
 * 跑法：`node --no-warnings tests/permission.test.mts`
 */
import assert from 'node:assert/strict'
import { classifyTool, evaluateCall } from '../src/main/runtime/harness/permission.ts'

// ── 1. 工具分类 ───────────────────────────────────────────────────────
assert.equal(classifyTool('plugin_verify'), 'code')
assert.equal(classifyTool('plugin_build'), 'code')
assert.equal(classifyTool('plugin_publish'), 'code')
assert.equal(classifyTool('plugin_draft'), 'write')

// 回归：既有分类不变
assert.equal(classifyTool('write_file'), 'write')
assert.equal(classifyTool('edit_file'), 'write')
assert.equal(classifyTool('read_file'), 'read')
assert.equal(classifyTool('web_fetch'), 'read')
assert.equal(classifyTool('execute'), 'exec')
assert.equal(classifyTool('some_mcp_tool'), 'external')

// ── 2. plugin 代码类工具：受限档必须审批 ──────────────────────────────
for (const toolName of ['plugin_build', 'plugin_verify', 'plugin_publish']) {
  const ws = evaluateCall({ mode: 'workspace-write', toolName, args: {} })
  assert.equal(ws.action, 'approve', `${toolName} must require approval in workspace-write`)
  assert.equal(ws.reason, 'code-exec')
  assert.equal(ws.access, 'code')

  const ro = evaluateCall({ mode: 'read-only', toolName, args: {} })
  assert.equal(ro.action, 'deny', `${toolName} must be denied in read-only`)
  assert.equal(ro.reason, 'read-only-exec')

  const danger = evaluateCall({ mode: 'danger-full-access', toolName, args: {} })
  assert.equal(danger.action, 'allow')
}

// plugin_draft 是写类：read-only 拒绝、workspace-write 放行（不弹窗）
assert.equal(evaluateCall({ mode: 'read-only', toolName: 'plugin_draft', args: {} }).action, 'deny')
assert.equal(
  evaluateCall({ mode: 'workspace-write', toolName: 'plugin_draft', args: {} }).action,
  'allow'
)

// ── 3. 未知外部工具保持原语义（workspace-write 放行 / read-only 弹窗）──
assert.equal(
  evaluateCall({ mode: 'workspace-write', toolName: 'some_mcp_tool', args: {} }).action,
  'allow'
)
assert.equal(
  evaluateCall({ mode: 'read-only', toolName: 'some_mcp_tool', args: {} }).action,
  'approve'
)

// ── 4. 命令风险判定不回归 ─────────────────────────────────────────────
assert.equal(
  evaluateCall({ mode: 'workspace-write', toolName: 'execute', args: { command: 'ls -la' } }).action,
  'allow'
)
const risky = evaluateCall({
  mode: 'workspace-write',
  toolName: 'execute',
  args: { command: 'git reset --hard' }
})
assert.equal(risky.action, 'approve')
assert.equal(risky.reason, 'risky-command')
assert.equal(
  evaluateCall({ mode: 'read-only', toolName: 'execute', args: { command: 'git reset --hard' } })
    .action,
  'deny'
)

console.log('permission: all assertions passed')
