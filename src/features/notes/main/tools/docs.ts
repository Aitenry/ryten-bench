// 本工具（manage_docs）归属 notes 插件：文档 CRUD 走本插件的 mapper，文档变更广播发
// harness 的「plugin:harness:harness-doc-changed」事件通道（渲染端编辑器订阅，见 preload）。
// 经 harness 的**工具贡献点**（HARNESS_TOOL_CONTRIBUTION，契约见 src/main/plugins/tool-contract.ts）
// 注册给 AI：插件未启用时 harness 拉不到这条贡献，工具自然不出现在模型面前。
import { BrowserWindow } from 'electron'
import { tool } from '@langchain/core/tools'
import type { StructuredToolInterface } from '@langchain/core/tools'
import * as z from 'zod/v4'
import { safeSend } from '../../../../main/safe-send'
import { mainFormat, mainPlural } from '../../../../main/i18n'
import { getDocsToolTexts } from '../../../../main/i18n/tool-results-docs'
import type { PluginToolContribution } from '../../../../main/plugins/tool-contract'

/**
 * 广播文档被工具修改/删除（修复：编辑器对工具写入完全无感知,继续编辑会把工具刚写入的
 * 内容整体覆盖——广播后编辑器可重载或提示）
 */
function broadcastDocChanged(docId: number, action: 'updated' | 'deleted'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      // 通道名按「插件不得 import harness」的铁律写成字面量，与 harness 插件
      // install(ctx) 里 ctx.registerEvent 声明的名字一致（那边有注释互相指向）
      safeSend(win.webContents, 'plugin:harness:harness-doc-changed', { docId, action })
    }
  }
}

// ============================================================================
// Document Handlers — 渐进式浏览 + CRUD
// ============================================================================

// ── 查询 ──

async function searchDocsHandler(params: {
  query: string
  page?: number
  pageSize?: number
}): Promise<string> {
  const { getAllDocs } = await import('../db/mapper/document')
  const result = await getAllDocs(params.page ?? 1, params.pageSize ?? 10, undefined, params.query)
  const tr = getDocsToolTexts()
  if (!result.items.length) return mainFormat(tr.docs.searchEmpty, { query: params.query })
  const lines = [
    mainFormat(tr.docs.searchHeader, {
      query: params.query,
      count: mainPlural(tr.docs.searchCount_one, tr.docs.searchCount_other, result.total)
    })
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
  return lines.join('\n')
}

async function getDocHandler(params: { docId: number; headingId?: string }): Promise<string> {
  const { getDocById } = await import('../db/mapper/document')
  const doc = await getDocById(params.docId)
  const tr = getDocsToolTexts()
  if (!doc) return mainFormat(tr.docs.notFound, { docId: params.docId })

  const rawContent = (doc as unknown as Record<string, unknown>).content
  const content = typeof rawContent === 'string' ? rawContent : ''
  if (!content) return mainFormat(tr.docs.noContent, { title: doc.title })

  const tags = doc.tags
    ? `\n${mainFormat(tr.docs.tagsLabel, {
        tags: (JSON.parse(doc.tags) as string[]).join(tr.listSeparator)
      })}`
    : ''
  const summary = doc.summary
    ? `\n${mainFormat(tr.docs.summaryLabel, { summary: doc.summary })}`
    : ''
  const image = doc.image ? `\n${tr.docs.hasImage}` : ''

  if (!params.headingId) {
    return `**${doc.title}** [${doc.id}]${tags}${summary}${image}\n\n---\n${content}\n---`
  }

  const lines = content.split('\n')

  interface HeadingRef {
    id: string
    level: number
    title: string
    lineIndex: number
  }

  const headings: HeadingRef[] = []
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

  const targetIdx = headings.findIndex((h) => h.id === params.headingId)
  if (targetIdx === -1)
    return mainFormat(tr.docs.headingNotFound, {
      headingId: params.headingId,
      headings: headings.map((h) => `[${h.id}] ${h.title}`).join(tr.listSeparator)
    })

  const target = headings[targetIdx]

  let endLine = lines.length
  for (let i = targetIdx + 1; i < headings.length; i++) {
    if (headings[i].level <= target.level) {
      endLine = headings[i].lineIndex
      break
    }
  }

  const section = lines.slice(target.lineIndex, endLine).join('\n')
  return `**${doc.title}** › ${'#'.repeat(target.level)} ${target.title}${tags}${summary}\n\n---\n${section}\n---`
}

async function getDocTocHandler(params: { docId: number }): Promise<string> {
  const { getDocById } = await import('../db/mapper/document')
  const doc = await getDocById(params.docId)
  const tr = getDocsToolTexts()
  if (!doc) return mainFormat(tr.docs.notFound, { docId: params.docId })

  const rawContent = (doc as unknown as Record<string, unknown>).content
  const content = typeof rawContent === 'string' ? rawContent : ''
  if (!content) return mainFormat(tr.docs.noContent, { title: doc.title })

  interface HeadingRef {
    id: string
    level: number
    title: string
  }

  const headings: HeadingRef[] = []
  let counter = 0
  const lines = content.split('\n')
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)/)
    if (match) {
      headings.push({
        id: `h-${counter++}`,
        level: match[1].length,
        title: match[2].trim()
      })
    }
  }

  if (!headings.length) return mainFormat(tr.docs.noHeadings, { title: doc.title })

  const output = [
    mainFormat(tr.docs.tocHeader, {
      title: doc.title,
      count: mainPlural(tr.docs.tocCount_one, tr.docs.tocCount_other, headings.length)
    })
  ]
  const stack: { level: number }[] = []
  for (const h of headings) {
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
      stack.pop()
    }
    const depth = stack.length
    const indent = '  '.repeat(depth)
    output.push(`${indent}  [${h.id}] ${'#'.repeat(h.level)} ${h.title}`)
    stack.push({ level: h.level })
  }

  return output.join('\n')
}

// ── 文档 CRUD ──

async function createDocHandler(params: {
  title: string
  summary?: string
  tags?: string
  content?: string
}): Promise<string> {
  const { addDoc } = await import('../db/mapper/document')
  const id = await addDoc({
    title: params.title,
    summary: params.summary ?? null,
    tags: params.tags ?? null,
    content: params.content ?? null,
    image: null
  })
  return mainFormat(getDocsToolTexts().docs.created, { id, title: params.title })
}

async function updateDocHandler(params: {
  docId: number
  title?: string
  summary?: string
  tags?: string
  content?: string
}): Promise<string> {
  const { updateDoc, getDocById } = await import('../db/mapper/document')
  const doc = await getDocById(params.docId)
  const tr = getDocsToolTexts()
  if (!doc) return mainFormat(tr.docs.notFound, { docId: params.docId })

  const updates: Record<string, string | null> = {}
  if (params.title !== undefined) updates.title = params.title
  if (params.summary !== undefined) updates.summary = params.summary
  if (params.tags !== undefined) updates.tags = params.tags
  if (params.content !== undefined) updates.content = params.content

  if (Object.keys(updates).length === 0) return tr.docs.noFieldsToUpdate

  await updateDoc(params.docId, updates)
  broadcastDocChanged(params.docId, 'updated')
  return mainFormat(tr.docs.updated, { docId: params.docId, title: doc.title })
}

async function deleteDocHandler(params: { docId: number }): Promise<string> {
  const { deleteDoc, getDocById } = await import('../db/mapper/document')
  const doc = await getDocById(params.docId)
  const tr = getDocsToolTexts()
  if (!doc) return mainFormat(tr.docs.notFound, { docId: params.docId })
  await deleteDoc(params.docId)
  broadcastDocChanged(params.docId, 'deleted')
  return mainFormat(tr.docs.deleted, { docId: params.docId, title: doc.title })
}

// ============================================================================
// Tool Builder
// ============================================================================

export function buildManageDocsTool(): StructuredToolInterface {
  return tool(
    async ({ command, ...params }) => {
      switch (command) {
        // 查询
        case 'search':
          return searchDocsHandler(params as unknown as Parameters<typeof searchDocsHandler>[0])
        case 'toc':
          return getDocTocHandler(params as unknown as Parameters<typeof getDocTocHandler>[0])
        case 'get':
          return getDocHandler(params as unknown as Parameters<typeof getDocHandler>[0])
        // CRUD
        case 'create':
          return createDocHandler(params as unknown as Parameters<typeof createDocHandler>[0])
        case 'update':
          return updateDocHandler(params as unknown as Parameters<typeof updateDocHandler>[0])
        case 'delete':
          return deleteDocHandler(params as unknown as Parameters<typeof deleteDocHandler>[0])
        default:
          return mainFormat(getDocsToolTexts().docs.unknownCommand, { command })
      }
    },
    {
      name: 'manage_docs',
      description:
        'Manage documents (progressive browsing + CRUD).\n' +
        '  Query commands:\n' +
        '    search - Full-text search over documents, returning id, title, tags, summary; requires query, optional page, pageSize\n' +
        '    toc - Get the Markdown heading tree of a document (id, title, indented by # level); requires docId\n' +
        '    get - Get document content. Without headingId it returns the full text; with headingId it returns that section; requires docId, optional headingId\n' +
        '  Document CRUD:\n' +
        '    create - Create a document; requires title, optional summary, tags (JSON array string), content (Markdown)\n' +
        '    update - Update a document; requires docId, optional title, summary, tags, content\n' +
        '    delete - Permanently delete a document (irreversible); requires docId\n' +
        '  Typical workflow: search → toc → get (browse sections on demand); or use the manage_wikis tool via list → directories → docs to obtain a document ID, then read it with get.',
      schema: z.object({
        command: z
          .enum(['search', 'toc', 'get', 'create', 'update', 'delete'])
          .describe('Operation type'),
        query: z.string().optional().describe('[search] Search keywords'),
        page: z.number().optional().default(1).describe('[search] Page number'),
        pageSize: z.number().optional().default(10).describe('[search] Number of items per page'),
        docId: z.number().optional().describe('[toc/get/update/delete] Document ID'),
        headingId: z
          .string()
          .optional()
          .describe('[get] Heading ID (from toc, e.g. h-2); omit to return the full text'),
        title: z.string().optional().describe('[create/update] Document title'),
        summary: z.string().optional().describe('[create/update] Document summary'),
        tags: z
          .string()
          .optional()
          .describe('[create/update] Document tags (JSON array string, e.g. \'["tag1","tag2"]\')'),
        content: z.string().optional().describe('[create/update] Document content (Markdown)')
      })
    }
  )
}

// ============================================================================
// Harness 工具贡献
// ============================================================================

/** 本插件贡献给 harness 的 AI 工具（由 main/index.ts 经 ctx.contribute 注册） */
export const docToolContributions: PluginToolContribution[] = [
  {
    name: 'manage_docs',
    info: {
      name: 'manage_docs',
      label: 'Documents',
      description: 'Search, view, create, edit and delete documents',
      icon: 'RiFileSearchLine',
      color: '#722ed1'
    },
    build: buildManageDocsTool
  }
]
