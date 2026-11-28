import type { ExtractedEntity, ExtractedRelation, EntityStats } from './types'

// ==================== Text chunking helpers ====================

/**
 * Detect scene break markers (common in fiction and other narrative text).
 * Supports --- / *** / * * * / ___ and blank-line-wrapped short centered titles.
 * Returns the list of break positions (character indexes in the text).
 */
export function findSceneBreaks(text: string): number[] {
  const positions: number[] = []

  // 1. Markdown horizontal rules: ^---+$ | ^\*{3,}$ | ^_{3,}$ | ^\* \* \*$
  const hrPattern = /^(?:---+|\*{3,}|_{3,}|(?:\* ){2,}\*|(?:- ){2,}-)$/gm
  let hrMatch: RegExpExecArray | null
  while ((hrMatch = hrPattern.exec(text)) !== null) {
    positions.push(hrMatch.index)
  }

  // 2. Short title lines surrounded by blank lines
  const sceneTitlePattern = /(?:^|\n)\s*\n(?!\s*#)(\S[^\n]{0,30}\S)\s*\n\s*\n/gm
  let stMatch: RegExpExecArray | null
  while ((stMatch = sceneTitlePattern.exec(text)) !== null) {
    const titleText = stMatch[1].trim()
    const isVeryShort = titleText.length <= 6
    if (isVeryShort) {
      positions.push(stMatch.index + stMatch[0].indexOf(titleText))
    }
  }

  // Sort and deduplicate (merge positions within 50 characters of each other)
  positions.sort((a, b) => a - b)
  const merged: number[] = []
  for (const pos of positions) {
    if (merged.length === 0 || pos - merged[merged.length - 1] > 50) {
      merged.push(pos)
    }
  }
  return merged
}

/**
 * Split text by Markdown heading levels.
 * - Preserve the heading hierarchy as context (e.g. "# A > ## B > ### C") to improve the semantic
 *   accuracy of entity extraction
 * - Skip heading lines inside code blocks (so ```java # Title``` is not mistaken for a heading)
 * - Fall back to paragraph chunking when a single section is too long
 * - When headings are sparse, detect scene breaks as extra split points (for fiction and other
 *   narrative text)
 */
export function splitByMarkdownHeaders(text: string, maxChunkSize = 2000): string[] {
  // 1. Locate all code blocks so heading detection can skip them
  const codeBlockPattern = /```[\s\S]*?```/g
  const codeBlockRanges: Array<[number, number]> = []
  let codeMatch: RegExpExecArray | null
  while ((codeMatch = codeBlockPattern.exec(text)) !== null) {
    codeBlockRanges.push([codeMatch.index, codeMatch.index + codeMatch[0].length])
  }

  const isInCodeBlock = (pos: number): boolean =>
    codeBlockRanges.some(([start, end]) => pos >= start && pos < end)

  // 2. Locate all heading lines
  const headerPattern = /^(#+)\s+(.*)/gm

  interface HeaderInfo {
    index: number // start index of the heading line
    endIndex: number // end index of the heading line (start of the next line)
    level: number // heading level (# = 1, ## = 2, ...)
    text: string // heading text
  }

  const headers: HeaderInfo[] = []
  let headerMatch: RegExpExecArray | null
  while ((headerMatch = headerPattern.exec(text)) !== null) {
    if (!isInCodeBlock(headerMatch.index)) {
      headers.push({
        index: headerMatch.index,
        endIndex: headerMatch.index + headerMatch[0].length,
        level: headerMatch[1].length,
        text: headerMatch[2].trim()
      })
    }
  }

  // No headings: fall back to paragraph chunking
  if (headers.length === 0) {
    return fallbackParagraphChunk(text, maxChunkSize)
  }

  // Sparse-heading detection: long text with few headings (e.g. one # heading per chapter) →
  // inject scene breaks as virtual level-2 headings
  if (headers.length === 1 && text.length > maxChunkSize * 1.5) {
    const sceneBreaks = findSceneBreaks(text)
    if (sceneBreaks.length > 0) {
      // Inject each scene break as a virtual ## heading
      for (const pos of sceneBreaks) {
        // Take the first 15 characters after the break as the scene label
        const afterBreak = text.slice(pos).split('\n').slice(0, 3).join(' ').slice(0, 30).trim()
        headers.push({
          index: pos,
          endIndex: pos,
          level: 2,
          text: `[场景] ${afterBreak || '...'}`
        })
      }
      // Re-sort by position
      headers.sort((a, b) => a.index - b.index)
    }
  }

  // 3. Split by heading, carrying the full hierarchy context into each section
  const chunks: string[] = []
  const headerStack: string[] = []
  let lastEnd = 0
  let currentBody = ''

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]

    // Flush the previous section (if heading context already exists)
    if (headerStack.length > 0) {
      const bodyContent = text.slice(lastEnd, h.index).trim()
      if (bodyContent) {
        currentBody += bodyContent + '\n'
        const headerPath = headerStack.join(' > ')
        const fullContent = `# ${headerPath}\n\n${currentBody.trim()}`

        if (fullContent.trim().length > maxChunkSize) {
          chunks.push(...splitLongContent(fullContent, maxChunkSize))
        } else {
          chunks.push(fullContent.trim())
        }
      }
      currentBody = ''
    }

    // Update the heading stack: pop while the stack depth is >= the current level
    while (headerStack.length >= h.level) {
      headerStack.pop()
    }
    headerStack.push(h.text)
    lastEnd = h.endIndex
  }

  // 4. Handle the last section
  if (lastEnd < text.length) {
    const remaining = text.slice(lastEnd).trim()
    if (remaining) currentBody += remaining
  }
  if (headerStack.length > 0 && currentBody.trim()) {
    const headerPath = headerStack.join(' > ')
    const fullContent = `# ${headerPath}\n\n${currentBody.trim()}`
    if (fullContent.trim().length > maxChunkSize) {
      chunks.push(...splitLongContent(fullContent, maxChunkSize))
    } else {
      chunks.push(fullContent.trim())
    }
  }

  return chunks.length > 0 ? chunks : [text]
}

/**
 * Further split an overlong section by paragraph, keeping the heading path as a context prefix
 */
export function splitLongContent(fullContent: string, maxSize: number): string[] {
  const headerEnd = fullContent.indexOf('\n\n')
  if (headerEnd === -1) {
    // No clear heading/body separator: split by characters
    return splitByCharOverlap(fullContent, maxSize)
  }

  const headerPrefix = fullContent.slice(0, headerEnd)
  const body = fullContent.slice(headerEnd + 2)

  if (body.length <= maxSize) return [fullContent]

  // Split the body by paragraph, prefixing each chunk with the header
  const paragraphs = body.split(/\n\s*\n/)
  const chunks: string[] = []
  let current = ''
  const overlap = 100

  for (const para of paragraphs) {
    const trimmed = para.trim()
    if (!trimmed) continue

    if (current.length + trimmed.length > maxSize && current.length > 0) {
      chunks.push(`${headerPrefix}\n\n${current.trim()}`)
      // Overlap: keep the last paragraph
      const lastPara = current.split(/\n\s*\n/).pop() || ''
      current = lastPara.length > overlap ? lastPara.slice(-overlap) + '\n\n' : lastPara + '\n\n'
    }
    current += trimmed + '\n\n'
  }

  if (current.trim()) {
    chunks.push(`${headerPrefix}\n\n${current.trim()}`)
  }

  return chunks.length > 0 ? chunks : [fullContent]
}

/**
 * Plain character-level overlapping split (fallback when there are no headings)
 */
export function splitByCharOverlap(text: string, maxSize: number, overlap = 200): string[] {
  if (text.length <= maxSize) return [text]

  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + maxSize, text.length)
    chunks.push(text.slice(start, end))
    start += maxSize - overlap
  }
  return chunks
}

/**
 * Paragraph-level fallback chunking (used when there are no Markdown headings)
 */
export function fallbackParagraphChunk(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text]

  const paragraphs = text.split(/\n\s*\n/)
  const chunks: string[] = []
  let current = ''
  const overlap = 200

  for (const para of paragraphs) {
    const trimmed = para.trim()
    if (!trimmed) continue

    if (current.length + trimmed.length > maxSize && current.length > 0) {
      chunks.push(current.trim())
      const lastPara = current.split(/\n\s*\n/).pop() || ''
      current = lastPara.length > overlap ? lastPara.slice(-overlap) + '\n\n' : lastPara + '\n\n'
    }
    current += trimmed + '\n\n'
  }

  if (current.trim()) {
    chunks.push(current.trim())
  }

  return chunks.length > 0 ? chunks : [text]
}

/**
 * Precompute: batch check which entities appear in the text (case-insensitive).
 * Lowercases the text once instead of repeating the conversion O(n*m) times
 */
export function filterEntitiesInText(entityNames: string[], text: string): string[] {
  const lowerText = text.toLowerCase()
  return entityNames.filter((name) => lowerText.includes(name.toLowerCase()))
}

/**
 * Assemble document content, avoiding duplication when the title repeats the first-line heading.
 * For example, when title is "Chapter 4" and content is "# Chapter 4\n...", the title is not
 * prepended again
 */
export function assembleDocContent(title: string, content: string): string {
  const trimmedContent = content.trimStart()
  // Check whether content's first line is a Markdown heading equal or highly similar to the title
  const firstLine = trimmedContent.split('\n')[0] || ''
  const headingMatch = firstLine.match(/^#+\s+(.*)/)
  if (headingMatch) {
    const headingText = headingMatch[1].trim()
    // Heading text containment (either one containing the other is enough)
    if (headingText === title || headingText.includes(title) || title.includes(headingText)) {
      return trimmedContent
    }
  }
  return `${title}\n${trimmedContent}`
}

// ==================== Confidence calculation ====================

export function calculateStatConfidence(
  entity: ExtractedEntity & { relationCount?: number },
  stats: EntityStats
): number {
  const docFreqScore = Math.min(entity.source_doc_ids.length / stats.totalDocs, 1)
  const relationScore =
    stats.totalRelations > 0 ? Math.min((entity.relationCount ?? 0) / stats.totalRelations, 0.5) : 0
  const descScore = Math.min(entity.description.length / 15, 1)

  const combined = docFreqScore * 0.4 + relationScore * 0.3 + descScore * 0.3
  return Math.max(0.3, Math.min(1.0, combined))
}

export function applyHybridConfidence(
  entities: ExtractedEntity[],
  relations: (ExtractedRelation & { source_note_id: number })[],
  llmWeight: number = 0.6,
  statWeight: number = 0.4
): ExtractedEntity[] {
  const entityRelationCount = new Map<string, number>()
  for (const rel of relations) {
    entityRelationCount.set(rel.source, (entityRelationCount.get(rel.source) || 0) + 1)
    entityRelationCount.set(rel.target, (entityRelationCount.get(rel.target) || 0) + 1)
  }

  const allDocIds = new Set<number>()
  for (const entity of entities) {
    entity.source_doc_ids.forEach((id) => allDocIds.add(id))
  }

  const stats: EntityStats = {
    relationCount: relations.length,
    totalEntities: entities.length,
    totalDocs: allDocIds.size || 1,
    totalRelations: relations.length
  }

  return entities.map((entity) => {
    const statScore = calculateStatConfidence(
      { ...entity, relationCount: entityRelationCount.get(entity.name) || 0 },
      stats
    )
    const finalConfidence = Math.max(
      0.3,
      Math.min(1.0, entity.confidence * llmWeight + statScore * statWeight)
    )
    return { ...entity, confidence: finalConfidence }
  })
}
