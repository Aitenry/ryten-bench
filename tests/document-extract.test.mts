/**
 * 文档文本抽取回归（`runtime/harness/document-extract.ts`，纯逻辑）。
 *
 * 跑法：`node --no-warnings tests/document-extract.test.mts`
 *
 * 覆盖：类型识别、纯文本抽取与截断、xlsx（共享字符串/内联/数值/多表）、
 * pptx（多页文本）、空文档、PDF/未知类型、损坏压缩包（结构化失败而非抛错）。
 */
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import {
  DEFAULT_MAX_DOCUMENT_CHARS,
  detectDocumentKind,
  extractDocument
} from '../src/main/runtime/harness/document-extract.ts'

// ── 1. 类型识别 ──────────────────────────────────────────────────────
assert.equal(detectDocumentKind('/a/report.DOCX'), 'docx')
assert.equal(detectDocumentKind('sheet.xlsx'), 'xlsx')
assert.equal(detectDocumentKind('slides.pptx'), 'pptx')
assert.equal(detectDocumentKind('notes.md'), 'text')
assert.equal(detectDocumentKind('data.csv'), 'text')
assert.equal(detectDocumentKind('paper.pdf'), 'pdf')
assert.equal(detectDocumentKind('archive.zip'), 'unsupported')

// ── 2. 纯文本：正常 / 截断 / 空 ──────────────────────────────────────
const csv = await extractDocument({
  fileName: 'people.csv',
  buffer: Buffer.from('name,age\nAlice,30\nBob,25\n', 'utf-8')
})
assert.equal(csv.ok, true)
if (csv.ok) {
  assert.equal(csv.kind, 'text')
  assert.equal(csv.truncated, false)
  assert.ok(csv.text.includes('Alice,30'))
}

const clipped = await extractDocument({
  fileName: 'big.txt',
  buffer: Buffer.from('x'.repeat(50), 'utf-8'),
  maxChars: 10
})
assert.equal(clipped.ok, true)
if (clipped.ok) {
  assert.equal(clipped.text, 'x'.repeat(10))
  assert.equal(clipped.truncated, true)
  assert.equal(clipped.totalChars, 50)
}

const empty = await extractDocument({ fileName: 'empty.txt', buffer: Buffer.from('   ') })
assert.deepEqual(empty, { ok: false, reason: 'empty' })

// ── 3. xlsx：共享字符串 / 内联字符串 / 数值 / 多工作表 ───────────────
const xlsxZip = new JSZip()
xlsxZip.file(
  'xl/workbook.xml',
  '<workbook><sheets><sheet name="Data" sheetId="1"/><sheet name="Second" sheetId="2"/></sheets></workbook>'
)
xlsxZip.file(
  'xl/sharedStrings.xml',
  '<sst><si><t>Name</t></si><si><t>Alice</t></si></sst>'
)
xlsxZip.file(
  'xl/worksheets/sheet1.xml',
  '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2"><v>42</v></c></row>' +
    '</sheetData></worksheet>'
)
xlsxZip.file(
  'xl/worksheets/sheet2.xml',
  '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>inline</t></is></c></row></sheetData></worksheet>'
)
const xlsxBuffer = Buffer.from(await xlsxZip.generateAsync({ type: 'nodebuffer' }))
const xlsx = await extractDocument({ fileName: 'book.xlsx', buffer: xlsxBuffer })
assert.equal(xlsx.ok, true)
if (xlsx.ok) {
  assert.equal(xlsx.kind, 'xlsx')
  assert.deepEqual(xlsx.meta, ['Data: 2 rows', 'Second: 1 rows'])
  assert.ok(xlsx.text.includes('## Data'))
  assert.ok(xlsx.text.includes('Name\tAlice'))
  assert.ok(xlsx.text.includes('42'))
  assert.ok(xlsx.text.includes('## Second'))
  assert.ok(xlsx.text.includes('inline'))
}

// ── 4. pptx：多页文本、按页码排序 ────────────────────────────────────
const pptxZip = new JSZip()
pptxZip.file(
  'ppt/slides/slide2.xml',
  '<p:sld><a:t>Second slide</a:t></p:sld>'
)
pptxZip.file(
  'ppt/slides/slide1.xml',
  '<p:sld><p:spTree><a:p><a:r><a:t>Hello</a:t></a:r><a:r><a:t>World</a:t></a:r></a:p></p:spTree></p:sld>'
)
const pptxBuffer = Buffer.from(await pptxZip.generateAsync({ type: 'nodebuffer' }))
const pptx = await extractDocument({ fileName: 'deck.pptx', buffer: pptxBuffer })
assert.equal(pptx.ok, true)
if (pptx.ok) {
  assert.equal(pptx.kind, 'pptx')
  assert.deepEqual(pptx.meta, ['slides: 2'])
  const slide1 = pptx.text.indexOf('## Slide 1')
  const slide2 = pptx.text.indexOf('## Slide 2')
  assert.ok(slide1 >= 0 && slide2 > slide1)
  assert.ok(pptx.text.includes('Hello'))
  assert.ok(pptx.text.includes('World'))
}

// ── 5. PDF / 未知类型 / 损坏文件 ────────────────────────────────────
assert.deepEqual(await extractDocument({ fileName: 'paper.pdf', buffer: Buffer.from('%PDF') }), {
  ok: false,
  reason: 'unsupported',
  message: 'pdf'
})
assert.deepEqual(await extractDocument({ fileName: 'a.bin', buffer: Buffer.from('AA') }), {
  ok: false,
  reason: 'unsupported'
})
const corrupt = await extractDocument({ fileName: 'broken.xlsx', buffer: Buffer.from('not a zip') })
assert.equal(corrupt.ok, false)
if (!corrupt.ok) assert.equal(corrupt.reason, 'failed')

// 默认上限是 20k
assert.equal(DEFAULT_MAX_DOCUMENT_CHARS, 20_000)

console.log('document-extract: all assertions passed')
