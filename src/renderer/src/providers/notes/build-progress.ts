import type { BaseNotification } from '@renderer/types/notification'

/**
 * Context and state types for graph build progress (notes plugin).
 *
 * Ownership: this previously lived in core's `src/renderer/src/{providers,types,hooks}` and was
 * the only place where the shell hard-coded plugin channel names (the three
 * `notes:graph-build-*`). It now lives entirely in the plugin's renderer: Provider / Context /
 * useBuildProgress / state types and the progress modal belong to the same plugin and subscribe to
 * **the plugin's own channels** (`renderer/api.ts`); disabling notes unmounts the Provider with it
 * — core no longer knows any plugin channel names.
 *
 * The notification center (`useNotification`) is a core service that plugins may import; so build
 * progress is still written into the shell's bell (see `BuildProgressNotification` below for the
 * notification item type).
 */

/** Notification click "jump to graph": event name within the shell (dispatched/listened inside the plugin so core need not know plugin semantics) */
export const OPEN_WIKI_GRAPH_EVENT = 'open-wiki-graph'

/** Build progress context: the progress modal and the graph view (both inside this plugin) exchange state through it */
export interface BuildProgressContextType {
  /** Status of all current builds (including completed/minimized; consumers filter as needed) */
  builds: BuildProgressState[]
  startBuild: (wikiId: number, wikiTitle: string) => void
  restoreBuild: (wikiId: number) => void
  /** Minimize the progress modal (only sets minimized, does not delete state) */
  minimizeBuild: (wikiId: number) => void
  navigateToGraph: (wikiId: number) => void
  subscribeToRefresh: (wikiId: number, callback: () => void) => () => void
}

/** Build progress state */
export interface BuildProgressState {
  wikiId: number
  wikiTitle: string
  phase: string
  phaseLabel: string
  phaseProgress: number
  overallProgress: number
  processedDocs: number
  totalDocs: number
  processedChunks: number
  totalChunks: number
  entityCount: number
  relationCount: number
  message: string
  minimized: boolean
  completed: boolean
}

/**
 * Graph build progress notification (payload written into the core notification center).
 *
 * The type stays in the plugin: `NotificationItem` keeps only generic fields in core (string
 * discriminant + optional extension fields), and the notification list renders by field name, so
 * plugins need not push their own types back into core.
 */
export interface BuildProgressNotification extends BaseNotification {
  type: 'build_progress'
  wikiId: number
  wikiTitle: string
  phaseLabel: string
  phaseProgress: number
  overallProgress: number
  entityCount: number
  relationCount: number
  message: string
  completed: boolean
  minimized: boolean
}
