import type { ExtractedEntity, ExtractedRelation, EntityStats } from './types'

// ==================== 文本分块工具 ====================

/**
 * 检测场景分隔符（小说等叙事文本常用）
 * 支持：--- / *** / * * * / ___ / 空行 + 短居中标题 + 空行 等模式
 * 返回分隔符的位置列表（文本中的字符索引）
 */
export function findSceneBreaks(text: string): number[] {
  const positions: number[] = []

  // 1. Markdown 水平分隔线：^---+$ | ^\*{3,}$ | ^_{3,}$ | ^\* \* \*$
  const hrPattern = /^(?:---+|\*{3,}|_{3,}|(?:\* ){2,}\*|(?:- ){2,}-)$/gm
  let hrMatch: RegExpExecArray | null
  while ((hrMatch = hrPattern.exec(text)) !== null) {
    positions.push(hrMatch.index)
  }

  // 2. 空行包围的短标题行
  const sceneTitlePattern = /(?:^|\n)\s*\n(?!\s*#)(\S[^\n]{0,30}\S)\s*\n\s*\n/gm
  let stMatch: RegExpExecArray | null
  while ((stMatch = sceneTitlePattern.exec(text)) !== null) {
    const titleText = stMatch[1].trim()
    const isVeryShort = titleText.length <= 6
    if (isVeryShort) {
      positions.push(stMatch.index + stMatch[0].indexOf(titleText))
    }
  }

  // 排序并去重（相邻 50 字符内合并）
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
 * 按 Markdown 标题层级切分文本（参考 LightRAG / GraphRAG 的分块策略）
 * - 保持标题层级上下文（如 "# A > ## B > ### C"），提升实体抽取的语义准确性
 * - 跳过代码块内的标题行（避免将 ```java # Title``` 误识别为标题）
 * - 单段过长时回退到段落分块
 * - 标题稀疏时自动检测场景分隔符作为补充分块点（适配小说等叙事文本）
 */
export function splitByMarkdownHeaders(text: string, maxChunkSize = 2000): string[] {
  // 1. 定位所有代码块的范围，标题检测时跳过这些区域
  const codeBlockPattern = /```[\s\S]*?```/g
  const codeBlockRanges: Array<[number, number]> = []
  let codeMatch: RegExpExecArray | null
  while ((codeMatch = codeBlockPattern.exec(text)) !== null) {
    codeBlockRanges.push([codeMatch.index, codeMatch.index + codeMatch[0].length])
  }

  const isInCodeBlock = (pos: number): boolean =>
    codeBlockRanges.some(([start, end]) => pos >= start && pos < end)

  // 2. 定位所有标题行
  const headerPattern = /^(#+)\s+(.*)/gm

  interface HeaderInfo {
    index: number // 标题行起始位置
    endIndex: number // 标题行结束位置（下一行开头）
    level: number // 标题层级（# = 1, ## = 2, ...）
    text: string // 标题文本
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

  // 无标题时回退到段落分块
  if (headers.length === 0) {
    return fallbackParagraphChunk(text, maxChunkSize)
  }

  // 标题稀疏检测：文本很长但标题很少（如小说一章仅一个 # 标题）→ 注入场景分隔符作为虚拟二级标题
  if (headers.length === 1 && text.length > maxChunkSize * 1.5) {
    const sceneBreaks = findSceneBreaks(text)
    if (sceneBreaks.length > 0) {
      // 将场景分隔符注入为虚拟 ## 标题
      for (const pos of sceneBreaks) {
        // 提取分隔符后的前 15 个字符作为场景标签
        const afterBreak = text.slice(pos).split('\n').slice(0, 3).join(' ').slice(0, 30).trim()
        headers.push({
          index: pos,
          endIndex: pos,
          level: 2,
          text: `[场景] ${afterBreak || '...'}`
        })
      }
      // 重新按位置排序
      headers.sort((a, b) => a.index - b.index)
    }
  }

  // 3. 按标题切分，每段携带完整层级上下文
  const chunks: string[] = []
  const headerStack: string[] = []
  let lastEnd = 0
  let currentBody = ''

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]

    // 保存上一个 section（如果已有标题上下文）
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

    // 更新标题栈：当前层级 <= 栈大小时，弹出到上一级
    while (headerStack.length >= h.level) {
      headerStack.pop()
    }
    headerStack.push(h.text)
    lastEnd = h.endIndex
  }

  // 4. 处理最后一个 section
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
 * 过长的单个 section 进一步按段落拆分，保留标题路径作为上下文前缀
 */
export function splitLongContent(fullContent: string, maxSize: number): string[] {
  const headerEnd = fullContent.indexOf('\n\n')
  if (headerEnd === -1) {
    // 没有明显的标题/正文分隔，直接按字符切分
    return splitByCharOverlap(fullContent, maxSize)
  }

  const headerPrefix = fullContent.slice(0, headerEnd)
  const body = fullContent.slice(headerEnd + 2)

  if (body.length <= maxSize) return [fullContent]

  // 按段落切分 body，每段带上 header 前缀
  const paragraphs = body.split(/\n\s*\n/)
  const chunks: string[] = []
  let current = ''
  const overlap = 100

  for (const para of paragraphs) {
    const trimmed = para.trim()
    if (!trimmed) continue

    if (current.length + trimmed.length > maxSize && current.length > 0) {
      chunks.push(`${headerPrefix}\n\n${current.trim()}`)
      // 重叠：保留最后一段
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
 * 纯字符级重叠切分（无标题时的兜底策略）
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
 * 段落级回退分块（无 Markdown 标题时使用）
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
 * 预计算：批量检查哪些实体出现在文本中（不区分大小写）
 * 一次性 lowerCase 文本，避免 O(n*m) 次重复转换
 */
export function filterEntitiesInText(entityNames: string[], text: string): string[] {
  const lowerText = text.toLowerCase()
  return entityNames.filter((name) => lowerText.includes(name.toLowerCase()))
}

/**
 * 组装文档内容：避免 title 与 content 首行标题重复
 * 例如 note.title="第四章" 且 content="# 第四章\n..." 时，不再重复拼接
 */
export function assembleDocContent(title: string, content: string): string {
  const trimmedContent = content.trimStart()
  // 判断 content 首行是否是 Markdown 标题且与 title 相同或高度相似
  const firstLine = trimmedContent.split('\n')[0] || ''
  const headingMatch = firstLine.match(/^#+\s+(.*)/)
  if (headingMatch) {
    const headingText = headingMatch[1].trim()
    // 标题文本包含关系（任一包含另一即可）
    if (headingText === title || headingText.includes(title) || title.includes(headingText)) {
      return trimmedContent
    }
  }
  return `${title}\n${trimmedContent}`
}

// ==================== 置信度计算 ====================

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
