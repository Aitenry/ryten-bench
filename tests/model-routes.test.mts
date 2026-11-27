/**
 * 模型路由清单的纯格式化回归（`runtime/harness/model-routes-core.ts`）。
 *
 * 跑法：`node --no-warnings tests/model-routes.test.mts`
 */
import assert from 'node:assert/strict'
import {
  capabilityLabels,
  formatModelRoutes,
  type ModelRouteEntry,
  type ModelRoutesTexts
} from '../src/main/runtime/harness/model-routes-core.ts'

const TEXTS: ModelRoutesTexts = {
  header: '## routes ({{count}})',
  empty: 'none enabled',
  item: '- {{spec}} ({{name}} · {{capabilities}}){{defaultTag}}',
  capabilities: 'capabilities',
  defaultTag: '[default]',
  hint: 'hint: set model to provider:model',
  none: 'unknown',
  image: 'IMAGE',
  tools: 'TOOLS',
  reasoning: 'REASON'
}

/** 与主进程 i18n 同义的极简插值 */
const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    values[key] === undefined ? match : String(values[key])
  )

const entries: ModelRouteEntry[] = [
  {
    spec: 'openai:gpt-5',
    name: 'OpenAI',
    providerType: 'openai',
    model: 'gpt-5',
    isDefault: false,
    capabilities: { image: true, tools: true, reasoning: true }
  },
  {
    spec: 'anthropic:claude-x',
    name: 'Anthropic',
    providerType: 'anthropic',
    model: 'claude-x',
    isDefault: true,
    capabilities: { image: true, tools: true }
  },
  {
    spec: 'local:qwen',
    name: 'Local',
    providerType: 'local',
    model: 'qwen',
    isDefault: false
  }
]

// 能力标签
assert.equal(
  capabilityLabels(TEXTS, entries[0]),
  'IMAGE · TOOLS · REASON'
)
assert.equal(capabilityLabels(TEXTS, entries[2]), 'unknown')
assert.equal(capabilityLabels(TEXTS, entries[1]), 'IMAGE · TOOLS')

// 列表：默认路由置顶，未知能力显示 unknown，默认标记只在默认项出现
const rendered = formatModelRoutes(fill, TEXTS, entries)
assert.ok(rendered.startsWith('## routes (3)'))
const lines = rendered.split('\n')
assert.equal(lines[1], '- anthropic:claude-x (Anthropic · IMAGE · TOOLS) [default]')
assert.equal(lines[2], '- local:qwen (Local · unknown)')
assert.equal(lines[3], '- openai:gpt-5 (OpenAI · IMAGE · TOOLS · REASON)')
assert.ok(rendered.includes('hint: set model to provider:model'))
// 默认标记不应出现在非默认项
assert.equal(rendered.split('[default]').length, 2)

// 空清单：提示去启用供应商，同时保留 hint
const empty = formatModelRoutes(fill, TEXTS, [])
assert.ok(empty.startsWith('## routes (0)'))
assert.ok(empty.includes('none enabled'))
assert.ok(empty.includes('hint: set model to provider:model'))

// 排序稳定：同默认状态下按 spec 字典序
const unordered: ModelRouteEntry[] = [
  { spec: 'z:1', name: 'Z', providerType: 'z', model: '1', isDefault: false },
  { spec: 'a:1', name: 'A', providerType: 'a', model: '1', isDefault: false }
]
const sorted = formatModelRoutes(fill, TEXTS, unordered)
assert.ok(sorted.indexOf('a:1') < sorted.indexOf('z:1'))

console.log('model-routes: all assertions passed')
