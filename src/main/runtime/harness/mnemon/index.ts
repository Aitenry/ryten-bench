import type { StructuredToolInterface } from '../../../ai/tools'
import logger from 'electron-log'
import { mainToolMessages } from '../../../i18n'
import { DocumentController } from './documents'
import { RuntimeMemoryController } from './runtime-memory'
import { MnemonService } from './service'
import { buildMnemonTools } from './tools'
import { buildRoutingSection, buildRuntimeMemorySection } from './prompt'

/**
 * Mnemon component assembly — entry point of the memory mechanism
 *
 * Storage root layout:
 *   <storageRoot>/
 *   ├── runtime/            # hot memory: memories.json (source of truth) + USER.md / MEMORY.md (projections)
 *   ├── documents/          # project documents: index.json + active/ + archived/
 *   └── data/               # long-term memory spaces: .memory-bodies.json (registry) + <space-id>/ (PGlite)
 */

export interface MnemonComponent {
  service: MnemonService
  runtimeMemory: RuntimeMemoryController
  documents: DocumentController
  tools: StructuredToolInterface[]
  /** Sections appended to the system prompt (routing + runtime memory) */
  promptSections: string[]

  /** Close all resources (called on app exit) */
  close(): Promise<void>
}

export function buildMnemon(storageRoot: string, workspaceName?: string): MnemonComponent {
  // 1. Hot memory controller (MEMORY overflow → archive to the long-term layer)
  let serviceRef: MnemonService | null = null
  const runtimeMemory = new RuntimeMemoryController(storageRoot, {
    archiveEntries: async (entries) => {
      // Archive hook: sink entries into the space with role='archive' (created automatically if missing)
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
      // Contract: archivedIndexes are "local indexes within the passed entries subarray", converted
      // to global indexes in the data file by RuntimeMemoryController.runArchive
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
          // Duplicate content is treated as already archived (even when dedup fails the hot-memory
          // entry is still removed, so the hot layer is not filled up by the same content)
        }
        archivedIndexes.push(entries.indexOf(entry))
      }
      return { archivedIndexes, memoryBodyIds: [body.id] }
    }
  })

  // 2. Project documents
  const documents = new DocumentController(storageRoot)

  // 3. Long-term memory space service (hot memory/document references injected lazily)
  const service = new MnemonService({ storageRoot, runtimeMemory, documents })
  serviceRef = service

  // 4. Tool set
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
