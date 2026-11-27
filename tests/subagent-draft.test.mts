/**
 * 子代理配置草稿的共享校验规则（shared/harness/subagent.ts）回归测试。
 *
 * 跑法：`node --no-warnings tests/subagent-draft.test.mts`
 *
 * 为什么单独测这一层：设置页的表单规则、IPC 写入、主智能体的 `agent_create` 工具都依赖
 * 这同一份纯函数；规则漂移会表现为「界面能保存但工具创建失败」这类难查的问题。
 */
import assert from 'node:assert/strict'
import {
  SUBAGENT_MODEL_PATTERN,
  SUBAGENT_NAME_MAX_LENGTH,
  SUBAGENT_NAME_PATTERN,
  validateSubAgentDraft,
  type SubAgentDraft
} from '../src/shared/harness/subagent.ts'

const base: SubAgentDraft = {
  name: 'researcher',
  displayName: '研究员',
  description: '调研仓库结构与实现方案',
  systemPrompt: 'You are a research subagent. Return concise findings with file references.'
}

// ── 1. 合法草稿：通过且不产生错误 ─────────────────────────────────────────────
assert.deepEqual(validateSubAgentDraft(base), [])

// ── 2. 标识规则：与设置页表单同一正则 ─────────────────────────────────────────
assert.equal(SUBAGENT_NAME_PATTERN.test('researcher'), true)
assert.equal(SUBAGENT_NAME_PATTERN.test('code-reviewer-2'), true)
assert.equal(SUBAGENT_NAME_PATTERN.test('Researcher'), false)
assert.equal(SUBAGENT_NAME_PATTERN.test('1researcher'), false)
assert.equal(SUBAGENT_NAME_PATTERN.test('re_searcher'), false)

assert.deepEqual(validateSubAgentDraft({ ...base, name: '' }), ['name is required'])
assert.deepEqual(validateSubAgentDraft({ ...base, name: 'Bad Name' }), [
  'name must match ^[a-z][a-z0-9-]*$ (lowercase letters, digits, hyphen)'
])
assert.deepEqual(
  validateSubAgentDraft({ ...base, name: 'a'.repeat(SUBAGENT_NAME_MAX_LENGTH + 1) }),
  [`name must be at most ${SUBAGENT_NAME_MAX_LENGTH} characters`]
)

// ── 3. 描述 / 系统提示词：必填 ────────────────────────────────────────────────
assert.deepEqual(validateSubAgentDraft({ ...base, description: '   ' }), [
  'description is required'
])
assert.deepEqual(validateSubAgentDraft({ ...base, systemPrompt: '' }), ['systemPrompt is required'])

// ── 4. 模型覆盖：只接受 provider:model ────────────────────────────────────────
assert.equal(SUBAGENT_MODEL_PATTERN.test('lmstudio:qwen3.5-9b'), true)
assert.deepEqual(validateSubAgentDraft({ ...base, model: 'qwen3.5' }), [
  'model must be in "provider:model" form'
])
assert.deepEqual(validateSubAgentDraft({ ...base, model: 'lmstudio:qwen3.5-9b' }), [])

// ── 5. 工具 / 技能列表：拒绝空名 ──────────────────────────────────────────────
assert.deepEqual(validateSubAgentDraft({ ...base, tools: ['read_file', ''] }), [
  'tools must not contain empty names'
])
assert.deepEqual(validateSubAgentDraft({ ...base, skills: ['  '] }), [
  'skills must not contain empty ids'
])
assert.deepEqual(
  validateSubAgentDraft({ ...base, tools: ['read_file', 'write_file', 'execute'] }),
  []
)

console.log('subagent draft validation tests passed')
