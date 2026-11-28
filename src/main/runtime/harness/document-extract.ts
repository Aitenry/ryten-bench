/**
 * Document text extraction (docx / xlsx / pptx / plain text) — pure logic, no electron
 * dependencies, testable offline.
 *
 * Why this exists: `read_file` reads UTF-8 text only, so Office documents are a "binary black
 * box" to the model, yet Word/Excel/PPT files are the most common material in a workspace.
 * Extraction dispatches by extension:
 *
 * - `.docx` -> mammoth extracts plain text (the same reliable path used by notes import);
 * - `.xlsx` -> JSZip + cheerio parse the workbook XML: sheet names, cell values (shared strings/inline/numeric);
 * - `.pptx` -> JSZip + cheerio parse the `<a:t>` text of each slide;
 * - `.csv/.tsv/.md/.txt/.json/.log/.yaml` -> returned as-is as UTF-8;
 * - `.pdf` -> explicitly returns unsupported (so the model does not read binary as text).
 *
 * Output is capped (20k characters by default) with the excess truncated and flagged; parse
 * failures return a structured reason that the tool layer translates for the UI.
 */
import JSZip from 'jszip'
import mammoth from 'mammoth'
import * as cheerio from 'cheerio'

/** Recognized document kinds */
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
      /** Structural summary (sheet count, slide count, etc.), one per line */
      meta: string[]
      text: string
      truncated: boolean
      totalChars: number
    }
  | { ok: false; reason: 'unsupported' | 'empty' | 'failed'; message?: string }

/** Determine the kind by extension (case-insensitive) */
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

/** Truncate text to the limit (keeping the beginning) */
function clip(
  text: string,
  maxChars: number
): { text: string; truncated: boolean; totalChars: number } {
  const totalChars = text.length
  if (totalChars <= maxChars) return { text, truncated: false, totalChars }
  return { text: text.slice(0, maxChars), truncated: true, totalChars }
}

/** Minimal XML node shape (avoids depending on cheerio's internal AnyNode export) */
interface XmlNode {
  tagName?: string
}

/** Get all elements of a tag (XML namespace prefixes compared by full tagName) */
function elementsByTag($: cheerio.CheerioAPI, tagName: string): XmlNode[] {
  const out: XmlNode[] = []
  $('*').each((_, element) => {
    const tag = (element as { tagName?: string }).tagName?.toLowerCase?.()
    if (tag === tagName) out.push(element as unknown as XmlNode)
  })
  return out
}

/** Concatenate all same-name text under an element (for `<si><t>a</t><t>b</t></si>`) */
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

/** Sort numeric file names (sheet1 < sheet2 < sheet10) */
function numericSuffix(name: string): number {
  const match = /(\d+)\.xml$/i.exec(name)
  return match ? Number(match[1]) : 0
}

/** Restore common XML entities (workbooks/presentations store them escaped) */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Extract xlsx: sheet names + per-row cell values */
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

  // Shared string table: <si><t>...</t></si>; the <v> of a cell with t="s" is an index into it
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

/** Extract pptx: per-slide text */
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
 * Extract the text of one document.
 *
 * Failures always return a structured result (no exception): the caller localizes the message from it.
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
