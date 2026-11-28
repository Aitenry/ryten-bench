// Document domain handlers (dispatched by the materials_docs_* tools).
//
// Design notes (2026-11 materials organization rework):
// - Read: doc.search / doc.toc / doc.get / doc.find. doc.get outputs line numbers + the revision
//   by default, and large documents can be read in segments via startLine/endLine; doc.find
//   returns matches precise to line and column (code point);
// - Write: besides whole-document update/create/delete, adds line-range replacement, in-line
//   column-range replacement, text-fragment replacement, insertion, line/range deletion and batch
//   patch. All writes support dryRun and expectedRevision; replace/delete also support verbatim
//   expectedOld checks to prevent wrong edits caused by line-number drift;
// - Concurrency: before each write the content hash is checked against expectedRevision; on
//   mismatch the write is rejected with a prompt to re-read, avoiding overwriting changes just
//   made by the user/editor;
// - Editor sync: after a successful write, harness:harness-doc-changed is still broadcast so the
//   renderer editor can reload or prompt accordingly.
import { BrowserWindow } from 'electron'
import { mainFormat, mainPlural } from '../../i18n'
import { getDocsToolTexts } from '../../i18n/tool-results-docs'
import type { DocWithContent } from '../../database/mapper/notes/document'
import { safeSend } from '../../safe-send'
import {
  DocEditError,
  applyEdits,
  deleteLines,
  deleteRange,
  findInContent,
  insertText,
  lineCountOf,
  parseDocument,
  previewChange,
  replaceLines,
  replaceRange,
  replaceText,
  revisionOf,
  summarizeChange,
  type DocEdit
} from './doc-edit'

/**
 * Broadcast that a document was modified/deleted by a tool (fix: the editor was completely
 * unaware of tool writes, and continuing to edit would overwrite the content the tool had just
 * written; the broadcast lets the editor reload or prompt)
 */
function broadcastDocChanged(docId: number, action: 'updated' | 'deleted'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      // The channel name is written as a literal because plugins must not import harness, matching
      // the name declared via ctx.registerEvent in the harness plugin's install(ctx) (comments on
      // both sides point at each other)
      safeSend(win.webContents, 'harness:harness-doc-changed', { docId, action })
    }
  }
}

// ============================================================================
// Shared helpers
// ============================================================================

type DocRow = DocWithContent

function contentOf(doc: DocRow): string {
  const raw = (doc as unknown as Record<string, unknown>).content
  return typeof raw === 'string' ? raw : ''
}

function missingParam(param: string): string {
  return mainFormat(getDocsToolTexts().docs.missingParam, { param })
}

async function loadDoc(docId: number | undefined): Promise<DocRow | null> {
  if (docId === undefined || !Number.isInteger(docId) || docId <= 0) return null
  const { getDocById } = await import('../../database/mapper/notes/document')
  return getDocById(docId)
}

interface HeadingRef {
  id: string
  level: number
  title: string
  lineIndex: number
}

/** Parse Markdown headings; ids stay compatible with the old version (h-0, h-1, …) so historical headingIds remain usable */
function collectHeadings(content: string): HeadingRef[] {
  const headings: HeadingRef[] = []
  // Use parseDocument instead of a bare split: each line of a CRLF document keeps a trailing \r,
  // and heading/line-number display must be clean
  const lines = parseDocument(content).lines
  let counter = 0
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)/)
    if (match) {
      headings.push({
        id: `h-${counter++}`,
        level: match[1].length,
        title: match[2].trim(),
        lineIndex: i
      })
    }
  }
  return headings
}

/** 1-based inclusive line range of a heading's section (includes the heading line, up to the next heading of the same or higher level) */
function sectionRange(
  headings: HeadingRef[],
  targetIndex: number
): { startLine: number; endLine: number } {
  const target = headings[targetIndex]
  let endLine = Number.MAX_SAFE_INTEGER
  for (let i = targetIndex + 1; i < headings.length; i++) {
    if (headings[i].level <= target.level) {
      // A 0-based lineIndex equals the 1-based line number of the "previous line"
      endLine = headings[i].lineIndex
      break
    }
  }
  return { startLine: target.lineIndex + 1, endLine }
}

function clip(text: string, max = 240): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

// ============================================================================
// Queries
// ============================================================================

export async function searchDocsHandler(params: {
  query?: string
  page?: number
  pageSize?: number
}): Promise<string> {
  const tr = getDocsToolTexts()
  // An omitted / blank query means "list documents" (most recently updated first). The model
  // often wants the index before choosing one, and forcing a keyword just made it invent one.
  const query = params.query?.trim() ?? ''
  const isList = query === ''
  const { getDocPage } = await import('../../database/mapper/notes/document')
  const page = Math.max(1, params.page ?? 1)
  const pageSize = Math.min(50, Math.max(1, params.pageSize ?? 10))
  // getDocPage searches title/summary/tags + body; an empty pattern matches every row, so the
  // same query serves as the plain document list
  const result = await getDocPage(query, page, pageSize)
  if (!result.items.length) {
    return isList ? tr.docs.listEmpty : mainFormat(tr.docs.searchEmpty, { query })
  }
  const count = mainPlural(tr.docs.searchCount_one, tr.docs.searchCount_other, result.total)
  const lines = [
    isList
      ? mainFormat(tr.docs.listHeader, { count })
      : mainFormat(tr.docs.searchHeader, { query, count })
  ]
  for (const doc of result.items) {
    lines.push(`  [${doc.id}] **${doc.title}**`)
    if (doc.tags) {
      const tagList = JSON.parse(doc.tags) as string[]
      lines.push(`    ${mainFormat(tr.docs.tagsLabel, { tags: tagList.join(tr.listSeparator) })}`)
    }
    if (doc.summary) lines.push(`    ${mainFormat(tr.docs.summaryLabel, { summary: doc.summary })}`)
    lines.push('')
  }
  if (result.total > pageSize) {
    lines.push(
      mainFormat(tr.docs.searchPage, {
        page,
        pages: Math.max(1, Math.ceil(result.total / pageSize))
      })
    )
  }
  return lines.join('\n')
}

export async function getDocTocHandler(params: { docId: number }): Promise<string> {
  const tr = getDocsToolTexts()
  const doc = await loadDoc(params.docId)
  if (!doc) return mainFormat(tr.docs.notFound, { docId: params.docId })

  const content = contentOf(doc)
  const revision = revisionOf(content)
  const total = lineCountOf(content)
  if (!content) {
    return mainFormat(tr.docs.noContentRevision, {
      title: doc.title,
      revision,
      lineCount: total
    })
  }

  const headings = collectHeadings(content)
  if (!headings.length) return mainFormat(tr.docs.noHeadings, { title: doc.title })

  const output = [
    mainFormat(tr.docs.tocHeader, {
      title: doc.title,
      count: mainPlural(tr.docs.tocCount_one, tr.docs.tocCount_other, headings.length)
    }),
    mainFormat(tr.docs.getMeta, { revision, lineCount: total }),
    ''
  ]
  const stack: { level: number }[] = []
  for (const h of headings) {
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
      stack.pop()
    }
    const depth = stack.length
    const indent = '  '.repeat(depth + 1)
    output.push(
      mainFormat(tr.docs.tocLine, {
        indent,
        headingId: h.id,
        hashes: '#'.repeat(h.level),
        title: h.title,
        line: h.lineIndex + 1
      })
    )
    stack.push({ level: h.level })
  }
  return output.join('\n')
}

export async function getDocHandler(params: {
  docId: number
  headingId?: string
  startLine?: number
  endLine?: number
  maxChars?: number
}): Promise<string> {
  const tr = getDocsToolTexts()
  const doc = await loadDoc(params.docId)
  if (!doc) return mainFormat(tr.docs.notFound, { docId: params.docId })

  const content = contentOf(doc)
  const revision = revisionOf(content)
  const total = lineCountOf(content)
  if (!content) {
    return mainFormat(tr.docs.noContentRevision, {
      title: doc.title,
      revision,
      lineCount: total
    })
  }

  if (params.headingId && (params.startLine !== undefined || params.endLine !== undefined)) {
    return tr.docs.headingAndRange
  }

  let startLine = params.startLine ?? 1
  let endLine = params.endLine ?? total
  if (params.headingId) {
    const headings = collectHeadings(content)
    const targetIndex = headings.findIndex((h) => h.id === params.headingId)
    if (targetIndex === -1) {
      return mainFormat(tr.docs.headingNotFound, {
        headingId: params.headingId,
        headings: headings.map((h) => `[${h.id}] ${h.title}`).join(tr.listSeparator)
      })
    }
    const range = sectionRange(headings, targetIndex)
    startLine = range.startLine
    endLine = Math.min(total, range.endLine)
  }

  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > total
  ) {
    return mainFormat(tr.docs.editErrors.rangeOutOfRange, {
      startLine,
      endLine,
      lineCount: total
    })
  }

  const tags = doc.tags
    ? `\n${mainFormat(tr.docs.tagsLabel, {
        tags: (JSON.parse(doc.tags) as string[]).join(tr.listSeparator)
      })}`
    : ''
  const summary = doc.summary
    ? `\n${mainFormat(tr.docs.summaryLabel, { summary: doc.summary })}`
    : ''
  const rangeInfo =
    startLine !== 1 || endLine !== total
      ? ` · ${mainFormat(tr.docs.getRange, { startLine, endLine })}`
      : ''

  const lines = parseDocument(content).lines
  const maxChars = Math.max(1000, params.maxChars ?? 30000)
  const width = String(total).length
  const body: string[] = []
  let used = 0
  let lastLine = startLine - 1
  for (let line = startLine; line <= endLine; line++) {
    const text = lines[line - 1] ?? ''
    const rendered = `${String(line).padStart(width)}| ${text}`
    if (used + rendered.length + 1 > maxChars && body.length > 0) break
    if (rendered.length > maxChars && body.length === 0) {
      body.push(`${rendered.slice(0, maxChars)}…`)
      lastLine = line
      used = maxChars
      break
    }
    body.push(rendered)
    used += rendered.length + 1
    lastLine = line
  }

  const truncated = lastLine < endLine
  const output = [
    mainFormat(tr.docs.getHeader, { title: doc.title, docId: doc.id }) +
      tags +
      summary +
      `\n${mainFormat(tr.docs.getMeta, { revision, lineCount: total })}${
        rangeInfo ? `\n${rangeInfo.replace(/^ · /, '')}` : ''
      }`,
    '',
    '---',
    body.join('\n'),
    '---'
  ]
  if (truncated) {
    output.push(
      mainFormat(tr.docs.getTruncated, {
        lastLine,
        nextLine: lastLine + 1
      })
    )
  }
  return output.join('\n')
}

export async function findInDocHandler(params: {
  docId: number
  query: string
  regex?: boolean
  caseSensitive?: boolean
  maxMatches?: number
  contextLines?: number
}): Promise<string> {
  const tr = getDocsToolTexts()
  if (!params.query) return missingParam('query')
  const doc = await loadDoc(params.docId)
  if (!doc) return mainFormat(tr.docs.notFound, { docId: params.docId })

  const content = contentOf(doc)
  let result: ReturnType<typeof findInContent>
  try {
    result = findInContent(content, {
      query: params.query,
      regex: params.regex,
      caseSensitive: params.caseSensitive,
      maxMatches: params.maxMatches,
      contextLines: params.contextLines
    })
  } catch (err) {
    return formatDocEditError(err)
  }

  if (!result.matches.length) {
    return mainFormat(tr.docs.findEmpty, {
      docId: doc.id,
      title: doc.title,
      query: params.query,
      revision: result.revision
    })
  }

  const output = [
    mainFormat(tr.docs.findHeader, {
      docId: doc.id,
      title: doc.title,
      query: params.query,
      count: mainPlural(tr.docs.findCount_one, tr.docs.findCount_other, result.total),
      revision: result.revision
    })
  ]
  for (const match of result.matches) {
    output.push(
      match.line === match.endLine
        ? mainFormat(tr.docs.findMatch, {
            line: match.line,
            column: match.column,
            endColumn: match.endColumn,
            text: clip(match.text)
          })
        : mainFormat(tr.docs.findMatchMultiLine, {
            line: match.line,
            column: match.column,
            endLine: match.endLine,
            endColumn: match.endColumn,
            text: clip(match.text)
          })
    )
    output.push(mainFormat(tr.docs.findContext, { snippet: match.snippet }))
  }
  if (result.truncated) {
    output.push(
      mainFormat(tr.docs.findTruncated, {
        shown: result.matches.length,
        total: result.total
      })
    )
  }
  return output.join('\n')
}

// ============================================================================
// Document writes (whole-document + fine-grained edits)
// ============================================================================

export async function createDocHandler(params: {
  title: string
  summary?: string
  tags?: string
  content?: string
}): Promise<string> {
  const tr = getDocsToolTexts()
  if (!params.title?.trim()) return tr.docs.titleRequired
  const { addDoc } = await import('../../database/mapper/notes/document')
  const content = params.content ?? ''
  const id = await addDoc({
    title: params.title,
    summary: params.summary ?? null,
    tags: params.tags ?? null,
    content: content || null,
    image: null
  })
  return mainFormat(tr.docs.created, { id, title: params.title, revision: revisionOf(content) })
}

export async function updateDocHandler(params: {
  docId: number
  title?: string
  summary?: string
  tags?: string
  content?: string
  expectedRevision?: string
}): Promise<string> {
  const tr = getDocsToolTexts()
  if (params.title !== undefined && !params.title.trim()) return tr.docs.titleRequired
  const doc = await loadDoc(params.docId)
  if (!doc) return mainFormat(tr.docs.notFound, { docId: params.docId })

  const currentContent = contentOf(doc)
  const currentRevision = revisionOf(currentContent)
  if (params.content !== undefined && params.expectedRevision !== undefined) {
    if (params.expectedRevision !== currentRevision) {
      return mainFormat(tr.docs.revisionMismatch, {
        docId: params.docId,
        expected: params.expectedRevision,
        actual: currentRevision
      })
    }
  }

  const updates: Record<string, string | null> = {}
  if (params.title !== undefined) updates.title = params.title
  if (params.summary !== undefined) updates.summary = params.summary
  if (params.tags !== undefined) updates.tags = params.tags
  if (params.content !== undefined && params.content !== currentContent) {
    updates.content = params.content
  }

  if (Object.keys(updates).length === 0) return tr.docs.noFieldsToUpdate

  const { updateDoc } = await import('../../database/mapper/notes/document')
  await updateDoc(params.docId, updates)
  broadcastDocChanged(params.docId, 'updated')
  const revision =
    params.content !== undefined && params.content !== currentContent
      ? revisionOf(params.content)
      : currentRevision
  return mainFormat(tr.docs.updated, {
    docId: params.docId,
    title: params.title ?? doc.title,
    revision
  })
}

export async function deleteDocHandler(params: { docId: number }): Promise<string> {
  const tr = getDocsToolTexts()
  const doc = await loadDoc(params.docId)
  if (!doc) return mainFormat(tr.docs.notFound, { docId: params.docId })
  const { deleteDoc } = await import('../../database/mapper/notes/document')
  await deleteDoc(params.docId)
  broadcastDocChanged(params.docId, 'deleted')
  return mainFormat(tr.docs.deleted, { docId: params.docId, title: doc.title })
}

// ── Shared plumbing for fine-grained edits ──

type LoadedEditableDoc =
  { ok: true; doc: DocRow; content: string; revision: string } | { ok: false; message: string }

async function loadDocForEdit(
  docId: number | undefined,
  expectedRevision?: string
): Promise<LoadedEditableDoc> {
  const tr = getDocsToolTexts()
  if (docId === undefined) return { ok: false, message: missingParam('docId') }
  const doc = await loadDoc(docId)
  if (!doc) return { ok: false, message: mainFormat(tr.docs.notFound, { docId }) }
  const content = contentOf(doc)
  const revision = revisionOf(content)
  if (expectedRevision !== undefined && expectedRevision !== revision) {
    return {
      ok: false,
      message: mainFormat(tr.docs.revisionMismatch, {
        docId,
        expected: expectedRevision,
        actual: revision
      })
    }
  }
  return { ok: true, doc, content, revision }
}

function summaryVars(
  summary: ReturnType<typeof summarizeChange>,
  total: number
): {
  startLine: number
  removed: number
  added: number
  total: number
} {
  return {
    startLine: summary?.startLine ?? 1,
    removed: summary?.removed ?? 0,
    added: summary?.added ?? 0,
    total
  }
}

async function persistDocEdit(
  loaded: Extract<LoadedEditableDoc, { ok: true }>,
  nextContent: string,
  dryRun: boolean
): Promise<string> {
  const tr = getDocsToolTexts()
  const { doc, content, revision } = loaded
  if (nextContent === content) {
    return mainFormat(tr.docs.noChange, {
      docId: doc.id,
      title: doc.title,
      revision
    })
  }

  const summary = summarizeChange(content, nextContent)
  const preview = previewChange(content, nextContent)
  const total = lineCountOf(nextContent)
  const vars = summaryVars(summary, total)

  if (dryRun) {
    const parts = [mainFormat(tr.docs.dryRunDone, { docId: doc.id, title: doc.title, ...vars })]
    if (preview) {
      parts.push(
        mainFormat(tr.docs.changePreview, {
          oldStart: preview.oldStart,
          newStart: preview.newStart,
          oldText: preview.oldText,
          newText: preview.newText
        })
      )
    }
    return parts.join('\n\n')
  }

  const { updateDoc } = await import('../../database/mapper/notes/document')
  await updateDoc(doc.id, { content: nextContent })
  broadcastDocChanged(doc.id, 'updated')
  const nextRevision = revisionOf(nextContent)
  const parts = [
    mainFormat(tr.docs.editDone, {
      docId: doc.id,
      title: doc.title,
      revision: nextRevision,
      ...vars
    })
  ]
  if (preview) {
    parts.push(
      mainFormat(tr.docs.changePreview, {
        oldStart: preview.oldStart,
        newStart: preview.newStart,
        oldText: preview.oldText,
        newText: preview.newText
      })
    )
  }
  return parts.join('\n\n')
}

async function runDocEdit(
  params: { docId?: number; expectedRevision?: string; dryRun?: boolean },
  edit: (content: string) => string
): Promise<string> {
  const loaded = await loadDocForEdit(params.docId, params.expectedRevision)
  if (!loaded.ok) return loaded.message
  let nextContent: string
  try {
    nextContent = edit(loaded.content)
  } catch (err) {
    return formatDocEditError(err)
  }
  return persistDocEdit(loaded, nextContent, params.dryRun === true)
}

export async function replaceDocLinesHandler(params: {
  docId?: number
  startLine?: number
  endLine?: number
  newText?: string
  expectedOld?: string
  expectedRevision?: string
  dryRun?: boolean
}): Promise<string> {
  if (params.startLine === undefined || params.endLine === undefined) {
    return missingParam(params.startLine === undefined ? 'startLine' : 'endLine')
  }
  // An explicit empty string means delete the lines; "not passed" is not the same as an empty
  // string, so a model that omits the parameter does not silently delete lines
  if (params.newText === undefined) return missingParam('newText')
  return runDocEdit(params, (content) =>
    replaceLines(content, {
      startLine: params.startLine!,
      endLine: params.endLine!,
      newText: params.newText ?? '',
      expectedOld: params.expectedOld
    })
  )
}

export async function replaceDocTextHandler(params: {
  docId?: number
  oldText?: string
  newText?: string
  all?: boolean
  occurrence?: number
  startLine?: number
  endLine?: number
  regex?: boolean
  caseSensitive?: boolean
  expectedRevision?: string
  dryRun?: boolean
}): Promise<string> {
  if (!params.oldText) return missingParam('oldText')
  if (params.newText === undefined) return missingParam('newText')
  return runDocEdit(params, (content) =>
    replaceText(content, {
      oldText: params.oldText!,
      newText: params.newText ?? '',
      all: params.all,
      occurrence: params.occurrence,
      startLine: params.startLine,
      endLine: params.endLine,
      regex: params.regex,
      caseSensitive: params.caseSensitive
    })
  )
}

export async function replaceDocRangeHandler(params: {
  docId?: number
  line?: number
  startColumn?: number
  endColumn?: number
  newText?: string
  expectedOld?: string
  expectedRevision?: string
  dryRun?: boolean
}): Promise<string> {
  if (params.line === undefined) return missingParam('line')
  if (params.newText === undefined) return missingParam('newText')
  return runDocEdit(params, (content) =>
    replaceRange(content, {
      line: params.line!,
      startColumn: params.startColumn,
      endColumn: params.endColumn,
      newText: params.newText ?? '',
      expectedOld: params.expectedOld
    })
  )
}

export async function insertDocTextHandler(params: {
  docId?: number
  position?: 'at' | 'before' | 'after' | 'start' | 'end'
  line?: number
  column?: number
  newText?: string
  expectedRevision?: string
  dryRun?: boolean
}): Promise<string> {
  if (!params.newText) return missingParam('newText')
  const position = params.position ?? 'at'
  if (position !== 'start' && position !== 'end' && params.line === undefined) {
    return missingParam('line')
  }
  return runDocEdit(params, (content) =>
    insertText(content, {
      position,
      line: params.line,
      column: params.column,
      newText: params.newText!
    })
  )
}

export async function deleteDocLinesHandler(params: {
  docId?: number
  startLine?: number
  endLine?: number
  expectedOld?: string
  expectedRevision?: string
  dryRun?: boolean
}): Promise<string> {
  if (params.startLine === undefined || params.endLine === undefined) {
    return missingParam(params.startLine === undefined ? 'startLine' : 'endLine')
  }
  return runDocEdit(params, (content) =>
    deleteLines(content, {
      startLine: params.startLine!,
      endLine: params.endLine!,
      expectedOld: params.expectedOld
    })
  )
}

export async function deleteDocRangeHandler(params: {
  docId?: number
  line?: number
  startColumn?: number
  endColumn?: number
  expectedOld?: string
  expectedRevision?: string
  dryRun?: boolean
}): Promise<string> {
  if (params.line === undefined) return missingParam('line')
  return runDocEdit(params, (content) =>
    deleteRange(content, {
      line: params.line!,
      startColumn: params.startColumn,
      endColumn: params.endColumn,
      expectedOld: params.expectedOld
    })
  )
}

export async function patchDocHandler(params: {
  docId?: number
  edits?: DocEdit[]
  expectedRevision?: string
  dryRun?: boolean
}): Promise<string> {
  const tr = getDocsToolTexts()
  if (!params.edits?.length) return tr.docs.patchEmpty
  return runDocEdit(params, (content) => applyEdits(content, params.edits!))
}

// ============================================================================
// Error messages
// ============================================================================

export function formatDocEditError(err: unknown): string {
  const tr = getDocsToolTexts()
  if (!(err instanceof DocEditError)) {
    return mainFormat(tr.docs.editErrors.failed, {
      message: err instanceof Error ? err.message : String(err)
    })
  }

  let message: string
  switch (err.code) {
    case 'line-out-of-range':
      message = mainFormat(tr.docs.editErrors.lineOutOfRange, {
        line: String(err.details.line),
        lineCount: Number(err.details.lineCount)
      })
      break
    case 'range-out-of-range':
      message = mainFormat(tr.docs.editErrors.rangeOutOfRange, {
        startLine: Number(err.details.startLine),
        endLine: Number(err.details.endLine),
        lineCount: Number(err.details.lineCount)
      })
      break
    case 'column-out-of-range':
      message = mainFormat(tr.docs.editErrors.columnOutOfRange, {
        line: Number(err.details.line),
        length: Number(err.details.length),
        startColumn: Number(err.details.startColumn),
        endColumn: Number(err.details.endColumn)
      })
      break
    case 'expected-old-mismatch-lines':
      message = mainFormat(tr.docs.editErrors.expectedOldLines, {
        startLine: Number(err.details.startLine),
        endLine: Number(err.details.endLine),
        actual: String(err.details.actual ?? '')
      })
      break
    case 'expected-old-mismatch-range':
      message = mainFormat(tr.docs.editErrors.expectedOldRange, {
        line: Number(err.details.line),
        startColumn: Number(err.details.startColumn),
        endColumn: Number(err.details.endColumn),
        actual: String(err.details.actual ?? '')
      })
      break
    case 'empty-query':
      message = tr.docs.editErrors.emptyQuery
      break
    case 'no-match':
      message = mainFormat(tr.docs.editErrors.noMatch, { query: String(err.details.query ?? '') })
      break
    case 'ambiguous-match':
      message = mainFormat(tr.docs.editErrors.ambiguousMatch, {
        count: Number(err.details.count),
        query: String(err.details.query ?? '')
      })
      break
    case 'occurrence-out-of-range':
      message = mainFormat(tr.docs.editErrors.occurrenceOutOfRange, {
        occurrence: Number(err.details.occurrence),
        count: Number(err.details.count)
      })
      break
    case 'invalid-regex':
      message = mainFormat(tr.docs.editErrors.invalidRegex, {
        message: String(err.details.message ?? '')
      })
      break
    case 'empty-edit':
      message = tr.docs.editErrors.emptyEdit
      break
    case 'missing-new-text':
      message = mainFormat(tr.docs.editErrors.missingNewText, {
        type: String(err.details.type ?? '')
      })
      break
    case 'unknown-edit-type':
      message = mainFormat(tr.docs.editErrors.unknownEditType, {
        type: String(err.details.type ?? '')
      })
      break
    case 'patch-empty':
      message = tr.docs.patchEmpty
      break
    default:
      message = mainFormat(tr.docs.editErrors.failed, { message: err.code })
  }

  if (err.editIndex !== undefined) {
    return mainFormat(tr.docs.patchEditFailed, { index: err.editIndex, message })
  }
  return message
}
