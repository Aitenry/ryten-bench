import { app } from 'electron'
import { join } from 'path'
import logger from 'electron-log'
import { awaitInitialized } from '../database/instance'
import { APP_EVENT_WORKSPACE_CHANGED } from '../plugins/app-hooks'
import { onAppEvent } from '../plugins/app-events'
import { configureFileHistory } from '../workspace/file-history'
import { configureToolOutputStore } from '../runtime/harness/tool-output-store'
import { configureScheduleStoreBackend } from '../runtime/harness/schedule-store'
import { configureScheduleConversationResolver } from '../runtime/harness/schedule-target'
import { scheduleRunner } from '../runtime/harness/schedule-runner'
import { DbScheduleStore, migrateLegacySchedules } from '../database/schedule-db'
import { getTopicById, getWorkspaceById } from '../database/mapper/harness/harness'
import { terminalSessions } from '../runtime/harness/terminal-sessions'
import { preloadHarnessData } from '../services/harness/preload-cache'
import { clearSubAgentCache } from '../services/harness/subagents'
import { clearProviderCache } from '../provider/cache'
import { todoStore } from '../runtime/harness/todo'
import { goalStore } from '../runtime/harness/goal'
import { harnessQueue } from '../services/harness/queue-store'
import { goalRoundDriver } from '../services/harness/goal-driver'
import { jobsRegistry } from '../runtime/harness/jobs'
import { subagentSessions } from '../runtime/harness/subagent-sessions'
import { buildResumedSubagentRuntime } from '../runtime/harness/subagent-resume'
import { teamModeStore } from '../runtime/harness/team-mode'
import { teamStore } from '../runtime/harness/team'
import {
  deleteTeamBoard,
  getTeamBoard,
  upsertTeamBoard
} from '../database/mapper/harness/team-board'
import {
  appendTeamTaskEvent,
  deleteTeamTaskEventsByTopic
} from '../database/mapper/harness/team-task-event'
import { dumpRendererMemory } from '../services/harness/renderer-memory'
import { closeAllMnemon } from '../services/harness/mnemon-singleton'
import { syncWorkspaceWatcher, stopWorkspaceWatcher, isWatchingPath } from '../workspace'
import { registerHarnessIpc } from '../ipc/harness/harness'
import { harnessTopicIpcHandlers } from '../ipc/harness/harness-topic'
import { openInAppIpcHandlers } from '../ipc/harness/open-in-app'
import { chatIpcHandlers } from '../ipc/harness/chat'
import { mnemonIpcHandlers } from '../ipc/harness/mnemon'
import { workspaceIpcHandlers } from '../ipc/harness/workspace'
import { agentIpcHandlers } from '../ipc/harness/agent'
import { workshopIpcHandlers } from '../ipc/harness/workshop'
import { installWorkshopHost, uninstallWorkshopHost } from '../workshop/wiring'
import { configureWorkshopDirReleaseHook } from '../workshop/dir-release'
import { mcpIpcHandlers } from '../ipc/harness/mcp'
import { terminalIpcHandlers } from '../ipc/harness/terminal'
import { ptyTerminalIpcHandlers, wirePtyTerminalEvents } from '../ipc/harness/terminal-pty'
import { ptyTerminals } from '../runtime/harness/pty-terminal'
import {
  configureMcp,
  closeAllMcp,
  currentMcpTools,
  refreshCatalog,
  setMcpModuleBase,
  connectedMcpServerNames,
  resourceCapableMcpServers,
  listMcpResources,
  listMcpResourceTemplates,
  readMcpResource
} from '../runtime/harness/mcp'
import { readMcpServers } from '../runtime/harness/mcp-store'
import { setMcpResourceOps, setMcpToolProvider } from '../tools/harness/builders'
import { setWebSearchImplementation } from '../tools/harness/web'
import { searchWeb } from '../search/registry'
import { EffectScope, registerIpcHandlers } from '../ipc/register'

/**
 * Main-process assembly for the AI assistant (system-level feature, no longer a plugin).
 *
 * Six responsibilities:
 * - **Channel table**: one file per domain (assistant core / topic conversations / chat-mode
 *   directories and sessions / Mnemon memory / workspace files and change review / agent
 *   configuration / plugin workshop / open in app), all ordinary `harness:*` channels;
 * - **Event channels**: pushes from the main process to the renderer (stream chunks, queues,
 *   goals, background jobs, subagents, questions, plan lists, workspace disk changes, change
 *   records, document rewrites, workshop status changes and load probes); channel names start
 *   with `harness:` and the preload system bridge allows them by prefix, so no manifest is
 *   needed;
 * - **Startup wiring**: file change snapshot directory, tool result directory, plugin workshop
 *   host, MCP client, workspace watcher;
 * - **Lifecycle hooks**: loading-page prefetch, renderer memory snapshot, release before quit
 *   (the three exported functions are called directly by core at fixed points — no longer routed
 *   through a contribution point);
 * - **Tool registry**: local time/weather/workshop tools + third-party `harness.tool`
 *   contributions;
 * - **Third-party plugin collaboration**: `harness.tool` is still contributed by third-party
 *   plugins through the plugin registry; this module only consumes it.
 *
 * Assembly is idempotent: core calls `startHarness()` once at startup and `stopHarness()` at quit.
 */
let started = false
let disposers: Array<() => void> = []
let scope: EffectScope | null = null

export function startHarness(): void {
  if (started) return
  started = true

  // Cold resume wiring: a restored inactive session rebuilds its runtime from the topic/config
  // on the first send
  subagentSessions.setRuntimeFactory(buildResumedSubagentRuntime)

  // Task board persistence wiring: the runtime depends only on the TeamBoardPersistence
  // interface; the DB implementation is assembled here. A whole-board JSON snapshot (including
  // deleted tombstones) plus revision/counter is restored lazily after a restart.
  teamStore.setPersistence({
    load: async (topicId) => {
      const row = await getTeamBoard(topicId)
      if (!row) return null
      try {
        const tasks = JSON.parse(row.tasks) as unknown
        if (!Array.isArray(tasks)) return null
        return { revision: row.revision, counter: row.counter, tasks }
      } catch {
        return null
      }
    },
    save: (topicId, snapshot) =>
      upsertTeamBoard({
        topic_id: topicId,
        revision: snapshot.revision,
        counter: snapshot.counter,
        tasks: JSON.stringify(snapshot.tasks)
      }),
    remove: (topicId) => deleteTeamBoard(topicId),
    appendEvent: (event) =>
      appendTeamTaskEvent({
        topic_id: event.topicId,
        task_id: event.taskId,
        action: event.action,
        actor_id: event.actorId,
        actor_name: event.actorName,
        subject: event.subject,
        task_revision: event.taskRevision
      }),
    removeEvents: (topicId) => deleteTeamTaskEventsByTopic(topicId)
  })

  const effects = new EffectScope()
  scope = effects

  // ── Channel table (7 domains) ─────────────────────────────────────────────
  disposers = [
    registerHarnessIpc(effects),
    registerIpcHandlers(harnessTopicIpcHandlers()),
    registerIpcHandlers(openInAppIpcHandlers()),
    registerIpcHandlers(chatIpcHandlers()),
    registerIpcHandlers(mnemonIpcHandlers()),
    registerIpcHandlers(workspaceIpcHandlers()),
    registerIpcHandlers(agentIpcHandlers()),
    registerIpcHandlers(workshopIpcHandlers()),
    registerIpcHandlers(mcpIpcHandlers()),
    // User-side panel for persistent terminals (shares one session manager with the model's
    // terminal_* tools)
    registerIpcHandlers(terminalIpcHandlers()),
    // User-side real terminal (node-pty + xterm.js, human-driven; independent of the model's
    // line-mode terminal)
    registerIpcHandlers(ptyTerminalIpcHandlers())
  ]

  // ── Startup wiring: directories, workshop, MCP, file watcher ──────────────
  effects.effect(() => {
    // PTY terminal output/exit events → renderer xterm (pushed after batching)
    const unwirePtyTerminalEvents = wirePtyTerminalEvents()
    // File change snapshot directory: keep it in userData, not in the workspace — the workspace
    // is mounted as a virtual '/', so writing there would pollute the user's project and show up
    // in the model's own ls/glob results
    configureFileHistory(join(app.getPath('userData'), 'file-history'))

    // Tool result detail storage directory (built-in tool results are no longer streamed or
    // persisted; they are read on demand when a card is opened)
    configureToolOutputStore(join(app.getPath('userData'), 'tool-output'))

    // ── Plugin workshop wiring ──────────────────────────────────────────────
    // The workshop does no IO conventions itself: the host runtime table, plugin load/unload,
    // the module loader and the renderer probe are all injected once in wiring.ts (which is
    // deliberately the only place that imports electron/core).
    installWorkshopHost()
    /**
     * When the workshop deletes/rebuilds a draft while the directory is being watched by the
     * workspace watcher (i.e. plugin mode has its sources open), Windows returns EPERM. Inject
     * a "drop the watcher first, restore it afterwards" implementation into the workshop
     * service: the service layer stays electron-free (offline tooling still runs) and the main
     * process owns the real watcher.
     */
    configureWorkshopDirReleaseHook(
      (dir) => {
        if (!isWatchingPath(dir)) return null
        stopWorkspaceWatcher()
        return () => {
          try {
            syncWorkspaceWatcher()
          } catch (err) {
            logger.warn(
              '[Harness] Failed to restore the workspace watcher after a workshop action:',
              err
            )
          }
        }
      },
      () => {
        try {
          syncWorkspaceWatcher()
        } catch (err) {
          logger.warn(
            '[Harness] Failed to resync the workspace watcher after a workshop action:',
            err
          )
        }
      }
    )

    // ── MCP client wiring ────────────────────────────────────────────────────
    // The config reader is injected here (the manager itself does not import electron, so it can
    // be regression-tested offline); the app root is injected too: the MCP SDK is ESM-only while
    // the main-process build is CJS, so it can only be loaded lazily via createRequire(app root)
    // (rationale in the header comment of runtime/harness/mcp.ts).
    configureMcp(readMcpServers)
    setMcpModuleBase(app.getAppPath())
    setMcpToolProvider(currentMcpTools)
    // Data source for the three MCP resource tools: same wiring as the tool provider.
    // `resourceCapableServers` decides whether anything is attached: only servers declaring the
    // resources capability are attached; with none of them these three tools do not enter the
    // round's tool set at all (so they take no context).
    setMcpResourceOps({
      servers: connectedMcpServerNames,
      resourceCapableServers: resourceCapableMcpServers,
      listResources: listMcpResources,
      listTemplates: listMcpResourceTemplates,
      read: readMcpResource
    })

    // Scheduled tasks: stored in the backend database (PGlite tables), the execution entry point
    // is injected by the IPC layer; timers only run while the app is running, and missed
    // triggers are not replayed (see the design notes in schedule-runner). Once the database is
    // ready, wire the storage backend, import legacy JSON tasks, then start the timers (see the
    // awaitInitialized block).

    // Workspace file watcher: starts for the current workspace after database initialization
    // (settings loaded).
    let stopped = false
    void awaitInitialized().then(async () => {
      if (stopped) return
      // Scheduled task assembly: storage backend + legacy JSON import + timers
      try {
        configureScheduleStoreBackend(new DbScheduleStore())
        // Schedule tools need "where does this conversation live" to implement the page's
        // "open a new conversation on every run" target (mode / workspace / memory scope); the
        // tool layer stays storage-agnostic, so the lookup is injected here.
        configureScheduleConversationResolver(async (topicId) => {
          const topic = (await getTopicById(topicId))[0]
          if (!topic) return null
          const workspaceId = topic.workspace_id ?? null
          const workspace = workspaceId ? await getWorkspaceById(workspaceId) : null
          return {
            topicId,
            workspaceId,
            workspaceKind: workspace?.kind ?? null,
            memoryScope: topic.memory_scope ?? null
          }
        })
        const migrated = await migrateLegacySchedules(join(app.getPath('userData'), 'schedules'))
        if (!migrated.skipped) {
          logger.info(`[Harness] Legacy scheduled tasks imported: ${migrated.imported}`)
        }
        scheduleRunner.start()
      } catch (err) {
        logger.warn('[Harness] Failed to initialize scheduled tasks:', err)
      }
      // Web search: the web_search tool goes through a unified entry point (the default
      // service/key come from the settings page; the built-in search is the fallback when
      // unconfigured)
      try {
        setWebSearchImplementation((query, maxResults) =>
          searchWeb({ query, maxResults })
        )
      } catch (err) {
        logger.warn('[Harness] Failed to wire web search:', err)
      }
      try {
        syncWorkspaceWatcher()
      } catch (err) {
        logger.warn('[Harness] Failed to start workspace file watcher:', err)
      }
      // MCP server warm-up: connections and tool discovery run in the background (spawning
      // subprocesses / reaching the network can take seconds) so startup is not blocked; a
      // server that fails to connect only shows up in the settings page and logs, and does not
      // affect the other tools.
      void refreshCatalog().catch((err) => logger.warn('[Harness] MCP warm-up failed:', err))
    })

    // Switching/rebuilding the workspace in system settings (core emits
    // `app.workspace-changed`) → the watcher switches root
    const offWorkspaceChanged = onAppEvent(APP_EVENT_WORKSPACE_CHANGED, () => {
      try {
        syncWorkspaceWatcher()
      } catch (err) {
        logger.warn('[Harness] Failed to restart watcher after workspace switch:', err)
      }
    })

    return () => {
      stopped = true
      offWorkspaceChanged()
      stopWorkspaceWatcher()
      configureFileHistory('')
      configureToolOutputStore('')
      configureWorkshopDirReleaseHook(null)
      uninstallWorkshopHost()
      setMcpToolProvider(undefined)
      setMcpResourceOps(undefined)
      scheduleRunner.stop()
      configureScheduleStoreBackend(undefined)
      configureScheduleConversationResolver(undefined)
      setWebSearchImplementation(undefined)
      // Close all persistent terminals before quit (kill the whole tree, leaving no orphan shells)
      terminalSessions.closeAll()
      // The user-side real terminals (PTY) must be closed cleanly too
      unwirePtyTerminalEvents()
      ptyTerminals.closeAll()
      configureMcp(undefined)
      setMcpModuleBase(undefined)
      void closeAllMcp()
    }
  })
}

/** Tear down the assembly (app quit or test cleanup): drop channels and all effects, rolling back LIFO */
export function stopHarness(): void {
  if (!started) return
  started = false
  for (const dispose of disposers.reverse()) {
    try {
      dispose()
    } catch (err) {
      logger.warn('[Harness] Failed to unregister channel:', err)
    }
  }
  disposers = []
  scope?.dispose()
  scope = null
}

// ── App lifecycle hooks (called directly by core at fixed points) ──────────

/** Loading-page prefetch: after initialization and before the main window takes over, read common data into cache and restore subagent session history */
export function preloadHarness(): Promise<void> {
  return Promise.all([
    preloadHarnessData(),
    // Restore historical sessions (inactive): read-only viewing first; the runtime is
    // cold-restored from the snapshot on the first continued chat
    subagentSessions.restorePersistedSessions()
  ]).then(() => undefined)
}

/**
 * Drop all in-memory state cached **per account's data** (called when switching the account data
 * space at runtime).
 *
 * Why it must be cleared: these singletons are indexed by **database auto-increment ids** such as
 * `topicId` / `workspaceId`, and each account has its own database — after a switch the same id
 * may point at another account's data. If not cleared, "the new account's topic shows the previous
 * account's todos / goals / queued messages", i.e. id bleed-through (only in memory, though).
 *
 * Cache only, nothing written to disk: the real data lives in each account's database, so it is
 * re-read on demand after clearing. The memory component (Mnemon) and MCP subprocesses are not
 * part of these caches; the switch flow (`profiles/live.ts`) closes them separately and reloads
 * them against the new database.
 */
export function resetHarnessAccountState(): void {
  clearSubAgentCache()
  clearProviderCache()
  todoStore.reset()
  goalStore.reset()
  teamModeStore.reset()
  harnessQueue.reset()
  goalRoundDriver.reset()
  // Background commands belong to a topicId; after an account switch the same id may belong to
  // another session: if not cleared, "the new account's top bar still shows the previous
  // account's dev server"
  jobsRegistry.clearAll()
  // Background subagent sessions are indexed by topicId too (including the session event stream):
  // they must be cleared after an account switch, otherwise ids bleed through
  subagentSessions.clearAll()
  // Restore subagent session history from the new account's database (old database data is kept;
  // only memory is cleared)
  void subagentSessions.restorePersistedSessions()
  // The shared task board is indexed by topicId as well and must be cleared on an account switch
  teamStore.clearAll()
  logger.info('[Harness] Account-scoped in-memory state cleared for profile switch')
}

/** Write a diagnostic snapshot when the renderer crashes (silent when not started / no dump directory) */
export function dumpHarnessMemory(reason: string, exitCode: number): void {
  dumpRendererMemory(reason, exitCode)
}

/** Release before quit: neither Mnemon sessions nor MCP stdio subprocesses may be left in the system */
export function closeHarnessResources(): void {
  // Background execute runs real system processes (dev server / watcher): not cancelling them at
  // quit would leave orphan processes
  jobsRegistry.clearAll()
  // Background subagent sessions: abort in-flight runs at quit so closures stop writing to
  // destroyed windows/tasks
  subagentSessions.clearAll()
  teamStore.clearAll()
  closeAllMnemon()
  void closeAllMcp()
}
