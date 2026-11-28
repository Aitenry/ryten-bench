import { registerIpcHandlers } from '../ipc/register'
import {
  registerBuiltinHarnessTools,
  unregisterBuiltinHarnessTools
} from '../tools/harness/builders'
import { todoIpcHandlers } from '../ipc/notes/todo'
import { documentIpcHandlers } from '../ipc/notes/document'
import { wikiIpcHandlers } from '../ipc/notes/wiki'
import { nodePositionIpcHandlers } from '../ipc/notes/node-position'
import { graphIpcHandlers } from '../ipc/notes/graph'
import { notesToolContributions } from '../tools/notes'

/**
 * Main-process assembly for the library (system-level feature, no longer a plugin).
 *
 * - **Channel table**: 5 domains (todo / document / wiki / node-position / graph), one file per
 *   domain, all channel names prefixed with `notes:*`;
 * - **AI tools**: `manage_materials` (material organization) is a single entry point covering
 *   documents / todos / knowledge bases / graphs (implementation in `tools/notes/**`); it is
 *   registered in the harness tool registry so the model can read and write the library. It uses
 *   the same `harness.tool` consumption point as third-party plugins, but comes from a built-in
 *   source compiled into the app;
 * - **Graph events**: `notes:graph-build-{progress,complete,error}` are broadcast by the main
 *   process and subscribed to by the renderer's `BuildProgressProvider`; the preload system
 *   bridge allows the channel prefix.
 */
let disposers: Array<() => void> = []
let started = false

export function startNotes(): void {
  if (started) return
  started = true

  disposers = [
    registerIpcHandlers(todoIpcHandlers),
    registerIpcHandlers(documentIpcHandlers),
    registerIpcHandlers(wikiIpcHandlers),
    registerIpcHandlers(nodePositionIpcHandlers),
    registerIpcHandlers(graphIpcHandlers)
  ]

  registerBuiltinHarnessTools(notesToolContributions)
}

export function stopNotes(): void {
  if (!started) return
  started = false
  unregisterBuiltinHarnessTools(notesToolContributions)
  for (const dispose of disposers.reverse()) {
    try {
      dispose()
    } catch {
      // Ignored: no throwing on the shutdown path
    }
  }
  disposers = []
}
