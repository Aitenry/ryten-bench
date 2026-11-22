import type { StructuredToolInterface } from '@langchain/core/tools'
import logger from 'electron-log'
import { mainToolMessages } from '../../../i18n'
import { DocumentController } from './documents'
import { RuntimeMemoryController } from './runtime-memory'
import { MnemonService } from './service'
import { buildMnemonTools } from './tools'
import { buildRoutingSection, buildRuntimeMemorySection } from './prompt'

/**
 * Mnemon 组件组装 — 记忆机制入口
 *
 * 存储根目录结构（与 dsh-mnemon 保持一致）：
 *   <storageRoot>/
 *   ├── runtime/            # 热记忆：memories.json（事实源）+ USER.md / MEMORY.md（投影）
 *   ├── documents/          # 项目档案：index.json + active/ + archived/
 *   └── data/               # 长期记忆空间：.memory-bodies.json（注册表）+ <space-id>/（PGlite）
 */

export interface MnemonComponent {
  service: MnemonService
  runtimeMemory: RuntimeMemoryController
  documents: DocumentController
  tools: StructuredToolInterface[]
  /** 附加到系统提示词的 section（routing + runtime memory） */
  promptSections: string[]

  /** 关闭全部资源（应用退出时调用） */
  close(): Promise<void>
}

export function buildMnemon(storageRoot: string, workspaceName?: string): MnemonComponent {
  // 1. 热记忆控制器（MEMORY 溢出 → 归档到长期层）
  let serviceRef: MnemonService | null = null
  const runtimeMemory = new RuntimeMemoryController(storageRoot, {
    archiveEntries: async (entries) => {
      // 归档钩子：把条目沉淀进 role='archive' 的空间（不存在则自动创建）
      if (!serviceRef) return { archivedIndexes: [], memoryBodyIds: [] }
      const targets = serviceRef.registry.active()
      let body = targets.find((b) => b.role === 'archive')
      if (!body) {
        const names = mainToolMessages().mnemon.defaultNames
        body = await serviceRef.createBody({
          name: names.archiveSpace,
          description: names.archiveSpaceDescription,
          role: 'archive'
        })
      }
      // 契约：archivedIndexes 为「传入 entries 子数组内的局部索引」，
      // 由 RuntimeMemoryController.runArchive 换算为数据文件的全局索引
      const archivedIndexes: number[] = []
      for (const entry of entries) {
        try {
          await serviceRef.remember({
            content: entry.content,
            category: 'context',
            importance: entry.importance === 'critical' ? 5 : entry.importance === 'normal' ? 3 : 2,
            source: 'agent',
            memoryBodyId: body.id
          })
        } catch (err) {
          logger.warn(`[Mnemon] Failed to archive entry (possibly duplicate):`, err)
          // 重复内容视为已归档（查重失败仍移除热记忆条目，避免热层被同一内容占满）
        }
        archivedIndexes.push(entries.indexOf(entry))
      }
      return { archivedIndexes, memoryBodyIds: [body.id] }
    }
  })

  // 2. 项目档案
  const documents = new DocumentController(storageRoot)

  // 3. 长期记忆空间服务（延迟注入热记忆/文档引用）
  const service = new MnemonService({ storageRoot, runtimeMemory, documents })
  serviceRef = service

  // 4. 工具集
  const tools = buildMnemonTools({ service, runtimeMemory, documents, workspaceName })

  // 5. prompt sections
  const promptSections = [buildRoutingSection(), buildRuntimeMemorySection(runtimeMemory)]

  logger.info(
    `[Mnemon] Initialized: storageRoot=${storageRoot}, hot memories ${runtimeMemory.snapshot().entries.length}, documents ${documents.snapshot().total}, spaces ${service.registry.list().length}`
  )

  return {
    service,
    runtimeMemory,
    documents,
    tools,
    promptSections,
    close: () => service.close()
  }
}
