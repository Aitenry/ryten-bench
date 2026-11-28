import { settingsStore } from '../../context'
import type { IpcHandlerMap } from '../register'
import { mainMessages } from '../../i18n'
import { getActiveWorkspaceId } from '../../database/workspace-context'
import { HarnessSettings } from '../../types/settings'
import type { MnemonComponent } from '../../runtime/harness/mnemon'

// Current memory directory (read from settings)
function currentMemoryPath(): string | undefined {
  const harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined
  return harnessSettings?.memoryPath || undefined
}

/**
 * Mnemon component for the current session.
 *
 * @param rawScope Scope passed back from the renderer (`plugin:<plugin id>` / `chat`; empty or
 *   invalid = current workspace). **Follows the current session**: plugin sessions read that
 *   plugin's own memory (`<memoryPath>/plugin-<id>/mnemon`), sessions in "chat" mode read
 *   `<memoryPath>/chat/mnemon` (that mode has no workspace, so memory shouldn't hang off one),
 *   and workspace sessions read `<memoryPath>/workspace-<id>/mnemon` (user wording 2026-09-28:
 *   "plugin memory doesn't show in the sidebar like memory inside a workspace"). The scope is
 *   only a string; path sanitization happens in the main process's `memoryScopeDirName`, so the
 *   renderer cannot change memoryPath.
 */
async function currentMnemonComponent(rawScope?: unknown): Promise<MnemonComponent | undefined> {
  const { getMnemonComponent } = await import('../../services/harness/mnemon-singleton')
  return getMnemonComponent(currentMemoryPath(), getActiveWorkspaceId(), rawScope as string | null)
}

/**
 * Mnemon memory management IPC (three layers: hot memory / long-term spaces / archive).
 *
 * Channel names are always `harness:<original flat name>`; the memory component is isolated by
 * "memory directory + session scope" — every channel can take a scope argument at the end
 * (omitted = current workspace, so older callers keep their behavior), and when no memory
 * directory is configured each channel returns configured:false / an empty result instead of
 * throwing.
 */
export function mnemonIpcHandlers(): IpcHandlerMap {
  const handlers: IpcHandlerMap = {}
  /** Channel receiver: the plugin's namespace prefix appears only here */
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`harness:${channel}`] = handler
  }

  // Memory system overview snapshot
  handle('mnemon-snapshot', async (scope?: string | null) => {
    const component = await currentMnemonComponent(scope)
    if (!component) {
      return { configured: false, error: mainMessages().error.memoryDirNotConfigured }
    }
    const [runtime, bodies, documents] = await Promise.all([
      Promise.resolve(component.runtimeMemory.snapshot()),
      component.service.bodies(),
      Promise.resolve(component.documents.snapshot())
    ])
    return { configured: true, runtime, bodies, documents }
  })

  // Hot memory add/replace/remove (add / replace / remove)
  handle(
    'mnemon-runtime-mutate',
    async (
      request: {
        action: string
        target: string
        content?: string
        old_text?: string
        importance?: string
      },
      scope?: string | null
    ) => {
      const component = await currentMnemonComponent(scope)
      if (!component)
        return { success: false, message: mainMessages().error.memoryDirNotConfigured }
      // Argument guard (fix: when request is undefined, `request.action` throws a TypeError
      // directly, and this handler has no try/catch, so the exception hangs the caller)
      if (
        !request ||
        typeof request !== 'object' ||
        typeof request.action !== 'string' ||
        typeof request.target !== 'string'
      ) {
        return { success: false, message: mainMessages().error.invalidRequest }
      }
      return await component.runtimeMemory.mutate({
        action: request.action as 'add' | 'replace' | 'remove',
        target: request.target as 'user' | 'memory',
        content: request.content,
        oldText: request.old_text,
        importance: request.importance as 'critical' | 'normal' | 'low' | undefined
      })
    }
  )

  // Long-term memory space directory
  handle('mnemon-bodies', async (scope?: string | null) => {
    const component = await currentMnemonComponent(scope)
    if (!component) return { items: [], total: 0, activeCount: 0, directory: '', generatedAt: '' }
    return await component.service.bodies()
  })

  // Create a memory space
  handle(
    'mnemon-body-create',
    async (request: { name: string; description: string }, scope?: string | null) => {
      const component = await currentMnemonComponent(scope)
      if (!component)
        return { success: false, message: mainMessages().error.memoryDirNotConfigured }
      try {
        const body = await component.service.createBody(request)
        return { success: true, body }
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // Update a memory space (name/description/activation)
  handle(
    'mnemon-body-update',
    async (
      id: string,
      request: { name?: string; description?: string; active?: boolean },
      scope?: string | null
    ) => {
      const component = await currentMnemonComponent(scope)
      if (!component)
        return { success: false, message: mainMessages().error.memoryDirNotConfigured }
      try {
        const body = component.service.updateBody(id, request)
        return { success: true, body }
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // Browse memory space contents
  handle('mnemon-body-list', async (memoryBodyIds?: string[], scope?: string | null) => {
    const component = await currentMnemonComponent(scope)
    if (!component) return []
    try {
      return await component.service.list(memoryBodyIds, 200)
    } catch {
      return []
    }
  })

  // Archive snapshot
  handle('mnemon-document-snapshot', async (scope?: string | null) => {
    const component = await currentMnemonComponent(scope)
    if (!component) return null
    return component.documents.snapshot()
  })

  return handlers
}
