/**
 * MCP 资源工具的纯逻辑回归（`tools/harness/mcp-resources-core.ts`）。
 *
 * 跑法：`node --no-warnings tests/mcp-resources.test.mts`
 *
 * 工具外壳（zod schema / 数据源注入）由类型检查与装配覆盖；这里钉住真正容易出错的
 * 投影规则：
 * - 资源 / 模板列表的格式化、分页游标提示、空列表；
 * - 服务器名校验（未连接 / 名字写错）的两类提示；
 * - 读取内容：文本拼接、图片 blob → data URL、其它二进制只报类型与大小、空内容；
 * - 模板替换的边界（缺失占位符保持原样）。
 */
import assert from 'node:assert/strict'
import {
  MAX_RESOURCE_IMAGE_CHARS,
  fill,
  formatReadResult,
  formatResourceList,
  formatTemplateList,
  serverErrorMessage,
  type McpToolTexts
} from '../src/main/tools/harness/mcp-resources-core.ts'

const TEXTS: McpToolTexts = {
  common: {
    unknownServer: 'unknown {{server}}; connected: {{servers}}',
    noServers: 'no servers connected',
    failed: 'failed {{server}}: {{message}}'
  },
  listResources: {
    header: '## resources {{server}}',
    empty: 'none on {{server}}',
    item: '- {{uri}}{{name}}{{mime}}',
    nextCursor: ' | cursor={{cursor}}'
  },
  listTemplates: {
    header: '## templates {{server}}',
    empty: 'no templates on {{server}}',
    item: '- {{uriTemplate}}{{name}}{{mime}}',
    nextCursor: ' | cursor={{cursor}}'
  },
  read: {
    header: '## read {{uri}}',
    textPart: '{{text}}',
    binaryPart: '[bin {{mimeType}} {{bytes}}]',
    empty: 'empty {{uri}}',
    imageNote: 'image {{uri}}'
  }
}

// ── 1. 模板替换 ───────────────────────────────────────────────────────
assert.equal(fill('a {{x}} b {{y}}', { x: 1, y: 'z' }), 'a 1 b z')
assert.equal(fill('keep {{missing}}', {}), 'keep {{missing}}')

// ── 2. 资源 / 模板列表 ────────────────────────────────────────────────
const resources = formatResourceList(
  fill,
  TEXTS,
  'docs',
  [
    { uri: 'doc://a', name: 'A', mimeType: 'text/plain', description: 'first' },
    { uri: 'doc://b' }
  ],
  'c2'
)
assert.ok(resources.startsWith('## resources docs'))
assert.ok(resources.includes('- doc://a (A, text/plain) — first'))
assert.ok(resources.includes('- doc://b'))
assert.ok(resources.endsWith('| cursor=c2'))

const emptyResources = formatResourceList(fill, TEXTS, 'docs', [])
assert.ok(emptyResources.includes('none on docs'))

const templates = formatTemplateList(
  fill,
  TEXTS,
  'docs',
  [{ uriTemplate: 'doc://{id}', name: 'Doc template', mimeType: 'text/markdown' }],
  undefined
)
assert.ok(templates.includes('- doc://{id} (Doc template, text/markdown)'))
assert.ok(!templates.includes('cursor='))
assert.ok(formatTemplateList(fill, TEXTS, 'docs', []).includes('no templates on docs'))

// ── 3. 服务器名校验 ───────────────────────────────────────────────────
assert.equal(serverErrorMessage(TEXTS, 'docs', ['docs', 'search']), null)
assert.equal(
  serverErrorMessage(TEXTS, 'nope', ['docs', 'search']),
  'unknown nope; connected: docs, search'
)
assert.equal(serverErrorMessage(TEXTS, 'docs', []), 'no servers connected')

// ── 4. 读取内容投影 ──────────────────────────────────────────────────
const textResult = formatReadResult(fill, TEXTS, 'doc://a', [
  { uri: 'doc://a', mimeType: 'text/plain', text: 'hello' },
  { uri: 'doc://a', mimeType: 'text/markdown', text: 'world' }
])
assert.ok(textResult.text.includes('## read doc://a'))
assert.ok(textResult.text.includes('hello'))
assert.ok(textResult.text.includes('world'))
assert.equal(textResult.images.length, 0)

const imageResult = formatReadResult(fill, TEXTS, 'doc://img', [
  { uri: 'doc://img', mimeType: 'image/png', blob: 'QUJD' }
])
assert.equal(imageResult.images.length, 1)
assert.deepEqual(imageResult.images[0], {
  dataUrl: 'data:image/png;base64,QUJD',
  mimeType: 'image/png',
  uri: 'doc://img'
})
assert.ok(imageResult.text.includes('image doc://img'))

// 非白名单图片类型 / 超长图片：退化为二进制说明，不内联
const svgResult = formatReadResult(fill, TEXTS, 'doc://svg', [
  { uri: 'doc://svg', mimeType: 'image/svg+xml', blob: 'PHN2Zz4=' }
])
assert.equal(svgResult.images.length, 0)
assert.ok(svgResult.text.includes('[bin image/svg+xml 8]'))

const hugeResult = formatReadResult(fill, TEXTS, 'doc://huge', [
  { uri: 'doc://huge', mimeType: 'image/png', blob: 'A'.repeat(MAX_RESOURCE_IMAGE_CHARS + 1) }
])
assert.equal(hugeResult.images.length, 0)
assert.ok(hugeResult.text.includes('[bin image/png'))

// 其它二进制：只报类型与大小
const pdf = formatReadResult(fill, TEXTS, 'doc://pdf', [
  { uri: 'doc://pdf', mimeType: 'application/pdf', blob: 'AAAA' }
])
assert.ok(pdf.text.includes('[bin application/pdf 4]'))
assert.equal(pdf.images.length, 0)

// 空内容
assert.ok(formatReadResult(fill, TEXTS, 'doc://empty', []).text.includes('empty doc://empty'))
assert.ok(
  formatReadResult(fill, TEXTS, 'doc://text-empty', [{ text: '' }]).text.includes(
    'empty doc://text-empty'
  )
)

console.log('mcp-resources: all assertions passed')
