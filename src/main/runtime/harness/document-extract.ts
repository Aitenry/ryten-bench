/**
 * 文档文本抽取（docx / xlsx / pptx / 纯文本）——纯逻辑，无 electron 依赖，可离线测试。
 *
 * 为什么需要：`read_file` 只读 UTF-8 文本，Office 文档对模型是"二进制黑盒"；而工作区里
 * 最常见的资料恰恰是 Word/Excel/PPT。这里按扩展名分派到对应的抽取器：
 *
 * - `.docx` → mammoth 抽取纯文本（与笔记导入同一条路径，可靠）；
 * - `.xlsx` → JSZip + cheerio 解析工作簿 XML：工作表名、单元格值（共享字符串/内联/数字）；
 * - `.pptx` → JSZip + cheerio 解析每页 `<a:t>` 文本；
 * - `.csv/.tsv/.md/.txt/.json/.log/.yaml` → 按 UTF-8 原样返回；
 * - `.pdf` → 明确返回不支持（避免模型把二进制当文本读）。
 *
 * 输出有上限（默认 20k 字符），超出部分截断并标注；解析失败返回结构化原因，
 * 由工具层翻译成界面语言。
 */
import JSZip from 'jszip'
import mammoth from 'mammoth'
import * as cheerio from 'cheerio'

/** 可识别的文档类型 */
export type DocumentKind = 'docx' | 'xlsx' | 'pptx' | 'text' | 'pdf' | 'unsupported'

export const DEFAULT_MAX_DOCUMENT_CHARS = 20_000

export interface ExtractDocumentInput {
  fileName: string
  buffer: Buffer
  maxChars?: number
}

export type DocumentExtraction =
  | {
      ok: true
      kind: DocumentKind
      /** 结构化摘要（工作表数、幻灯片数等），一行一条 */
      meta: string[]
      text: string
      truncated: boolean
      totalChars: number
    }
  | { ok: false; reason: 'unsupported' | 'empty' | 'failed'; message?: string }

/** 按扩展名判断类型（大小写不敏感） */
export function detectDocumentKind(fileName: string): DocumentKind {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase()
  if (ext === 'docx') return 'docx'
  if (ext === 'xlsx') return 'xlsx'
  if (ext === 'pptx') return 'pptx'
  if (['csv', 'tsv', 'md', 'markdown', 'txt', 'json', 'log', 'yaml', 'yml'].includes(ext)) {
    return 'text'
  }
  if (ext === 'pdf') return 'pdf'
  return 'unsupported'
}

/** 把文本按上限截断（保留开头） */
function clip(
  text: string,
  maxChars: number
): { text: string; truncated: boolean; totalChars: number } {
  const totalChars = text.length
  if (totalChars <= maxChars) return { text, truncated: false, totalChars }
  return { text: text.slice(0, maxChars), truncated: true, totalChars }
}

/** 最小 XML 节点形状（不依赖 cheerio 内部的 AnyNode 类型导出） */
interface XmlNode {
  tagName?: string
}

/** 取某个标签的全部元素（XML 命名空间前缀按完整 tagName 比较） */
function elementsByTag($: cheerio.CheerioAPI, tagName: string): XmlNode[] {
  const out: XmlNode[] = []
  $('*').each((_, element) => {
    const tag = (element as { tagName?: string }).tagName?.toLowerCase?.()
    if (tag === tagName) out.push(element as unknown as XmlNode)
  })
  return out
}

/** 元素下所有同名文本拼接（用于 `<si><t>a</t><t>b</t></si>`） */
function textOfTags($: cheerio.CheerioAPI, root: XmlNode, tagName: string): string {
  let text = ''
  $(root as never)
    .find('*')
    .each((_, element) => {
      const tag = (element as { tagName?: string }).tagName?.toLowerCase?.()
      if (tag === tagName) text += $(element).text()
    })
  return text
}

/** 数字文件名排序（sheet1 < sheet2 < sheet10） */
function numericSuffix(name: string): number {
  const match = /(\d+)\.xml$/i.exec(name)
  return match ? Number(match[1]) : 0
}

/** XML 文本里的常见实体还原（工作簿/演示文稿里会以转义形式出现） */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 抽取 xlsx：工作表名 + 逐行单元格值 */
async function extractXlsx(buffer: Buffer): Promise<{ meta: string[]; text: string }> {
  const zip = await JSZip.loadAsync(buffer)
  const workbookFile = zip.file('xl/workbook.xml')
  const workbookXml = workbookFile ? await workbookFile.async('string') : ''
  const workbook = workbookXml ? cheerio.load(workbookXml, { xmlMode: true }) : null
  const sheetNames = workbook
    ? elementsByTag(workbook, 'sheet')
        .map((element) => workbook(element as never).attr('name') ?? '')
        .filter(Boolean)
    : []

  // 共享字符串表：<si><t>...</t></si>，单元格 t="s" 的 <v> 是这里的下标
  const sharedStrings: string[] = []
  const sharedFile = zip.file('xl/sharedStrings.xml')
  if (sharedFile) {
    const shared = cheerio.load(await sharedFile.async('string'), { xmlMode: true })
    for (const si of elementsByTag(shared, 'si')) {
      sharedStrings.push(decodeXmlEntities(textOfTags(shared, si, 't')))
    }
  }

  const sheetFiles = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => numericSuffix(a) - numericSuffix(b))

  const parts: string[] = []
  const meta: string[] = []
  for (let index = 0; index < sheetFiles.length; index++) {
    const file = zip.file(sheetFiles[index])
    if (!file) continue
    const sheet = cheerio.load(await file.async('string'), { xmlMode: true })
    const title = sheetNames[index] || `sheet${index + 1}`
    const rows: string[] = []
    for (const row of elementsByTag(sheet, 'row')) {
      const cells: string[] = []
      for (const element of sheet(row as never).find('*').toArray()) {
        const tag = (element as { tagName?: string }).tagName?.toLowerCase?.()
        if (tag !== 'c') continue
        const cell = sheet(element as never)
        const type = cell.attr('t')
        if (type === 's') {
          const value = Number(cell.find('v').first().text())
          cells.push(sharedStrings[value] ?? '')
        } else if (type === 'inlineStr') {
          cells.push(cell.find('t').first().text())
        } else {
          cells.push(cell.find('v').first().text() || cell.find('t').first().text())
        }
      }
      const line = cells.filter((value) => value.length > 0).join('\t')
      if (line) rows.push(line)
    }
    meta.push(`${title}: ${rows.length} rows`)
    parts.push(`## ${title}\n${rows.join('\n')}`)
  }
  return { meta, text: parts.join('\n\n') }
}

/** 抽取 pptx：每页幻灯片文本 */
async function extractPptx(buffer: Buffer): Promise<{ meta: string[]; text: string }> {
  const zip = await JSZip.loadAsync(buffer)
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => numericSuffix(a) - numericSuffix(b))
  const parts: string[] = []
  for (let index = 0; index < slideFiles.length; index++) {
    const file = zip.file(slideFiles[index])
    if (!file) continue
    const slide = cheerio.load(await file.async('string'), { xmlMode: true })
    const texts = elementsByTag(slide, 'a:t')
      .map((element) => decodeXmlEntities(slide(element as never).text()).trim())
      .filter(Boolean)
    parts.push(`## Slide ${index + 1}\n${texts.join('\n')}`)
  }
  return { meta: [`slides: ${slideFiles.length}`], text: parts.join('\n\n') }
}

/**
 * 抽取一个文档的文本。
 *
 * 失败一律返回结构化结果（不抛异常）：调用方据此给出本地化提示。
 */
export async function extractDocument(input: ExtractDocumentInput): Promise<DocumentExtraction> {
  const kind = detectDocumentKind(input.fileName)
  const maxChars = Math.max(1, Math.floor(input.maxChars ?? DEFAULT_MAX_DOCUMENT_CHARS))
  if (kind === 'unsupported') return { ok: false, reason: 'unsupported' }
  if (kind === 'pdf') return { ok: false, reason: 'unsupported', message: 'pdf' }

  try {
    if (kind === 'text') {
      const clipped = clip(input.buffer.toString('utf-8'), maxChars)
      if (!clipped.text.trim()) return { ok: false, reason: 'empty' }
      return { ok: true, kind, meta: [], ...clipped }
    }
    if (kind === 'docx') {
      const result = await mammoth.extractRawText({ buffer: input.buffer })
      const clipped = clip(result.value ?? '', maxChars)
      if (!clipped.text.trim()) return { ok: false, reason: 'empty' }
      return { ok: true, kind, meta: [], ...clipped }
    }
    if (kind === 'xlsx') {
      const { meta, text } = await extractXlsx(input.buffer)
      const clipped = clip(text, maxChars)
      if (!clipped.text.trim()) return { ok: false, reason: 'empty' }
      return { ok: true, kind, meta, ...clipped }
    }
    const { meta, text } = await extractPptx(input.buffer)
    const clipped = clip(text, maxChars)
    if (!clipped.text.trim()) return { ok: false, reason: 'empty' }
    return { ok: true, kind, meta, ...clipped }
  } catch (err) {
    return {
      ok: false,
      reason: 'failed',
      message: err instanceof Error ? err.message : String(err)
    }
  }
}
