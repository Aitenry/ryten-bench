import { ipcMain } from 'electron'
import logger from 'electron-log'
import { addContribution, listContributions, removeContributions } from './contributions'
import { withPluginScope } from './plugin-guard'

/**
 * Main-process plugin context (a lightweight counterpart of the renderer `plugin-host/context.ts`).
 *
 * Contract:
 * - `install(ctx)` is reversible assembly: registered IPC channels and effects registered through
 *   `ctx.effect` are rolled back at once by the host when the plugin is disabled/uninstalled (effects
 *   in LIFO order);
 * - IPC channels must stay inside the plugin's own namespace `plugin:<namespace>:`; the host
 *   validates authoritatively to prevent plugins from taking each other's channels over (the same
 *   rules as the preload channel whitelist);
 * - main → renderer event channels (send only, no handler) are declared with `registerEvent`: the
 *   preload plugin channel whitelist only includes "channels this plugin declared", and event
 *   channels that were not declared are rejected by `window.api.plugin.on(...)` (subscribing from
 *   built-in plugins is gated by the same whitelist);
 * - plugin business code may import core modules (orm / settings / workspace, etc.) as usual, but
 *   **must not** register channels in core's IPC group table — ownership and lifecycle are expressed
 *   by this contract;
 * - multi-value contributions mounted with `contribute(key, value)` (e.g. AI tools) are part of the
 *   reversible assembly too: they are removed with `dispose()` on disable/uninstall, and consumers
 *   (the harness tool registry) see the change on their next pull.
 */

/** Channel namespace: the plugin id without the leading `plugin.` segment (plugin.demo → demo) */
export function channelNamespace(id: string): string {
  return id.startsWith('plugin.') ? id.slice('plugin.'.length) : id
}

/**
 * Namespace ownership table: the built-in `music` and the external `plugin.music` both map to
 * `plugin:music:`, which must be blocked (otherwise they take each other's channels over).
 * Ownership is declared at construction and released on dispose.
 */
const namespaceOwners = new Map<string, string>()

/**
 * Host wiring for "request a cloud sync" (`lattice/index.ts` injects `scheduleLatticePush`).
 *
 * Injected instead of importing `lattice/sync` directly: sync → plugins/host → this file, and static
 * imports would form a cycle (under the CJS bundle the side evaluated first gets half-initialized
 * exports). When not wired (unit tests, plugin hub not enabled) it is silently ignored and plugin
 * writes are unaffected.
 */
let syncRequester: ((pluginId: string) => void) | null = null

/** Wired by `lattice/index.ts` at startup (pass null to unbind) */
export function setPluginSyncRequester(fn: ((pluginId: string) => void) | null): void {
  syncRequester = fn
}

function claimNamespace(id: string, namespace: string): void {
  const owner = namespaceOwners.get(namespace)
  if (owner && owner !== id) {
    throw new Error(`通道命名空间 'plugin:${namespace}:' 已被插件 '${owner}' 占用`)
  }
  namespaceOwners.set(namespace, id)
}

function releaseNamespace(id: string, namespace: string): void {
  if (namespaceOwners.get(namespace) === id) namespaceOwners.delete(namespace)
}

/** IPC handler table: channel name → handler (arguments come in from the renderer through the generic bridge) */
export type IpcHandlerMap = Record<string, (...args: never[]) => unknown>

export interface MainPluginContext {
  /** Plugin id (manifest.id) */
  readonly id: string
  /** This plugin's channel namespace (the `<namespace>` in `plugin:<namespace>:`) */
  readonly namespace: string

  /** Registers IPC handlers; returns an undo action that removes only the channels registered by this call */
  registerIpc(handlers: IpcHandlerMap): () => void

  /**
   * Declares this plugin's "main → renderer" event channels (no ipcMain handler, only a sender).
   *
   * These channels enter `activePluginChannels()` together with the channels registered by
   * `registerIpc` and are pushed to the preload whitelist cache by `pushPluginChannels()`; without
   * the declaration the renderer cannot subscribe (preload only warns on subscribe, and nobody in
   * the main process ever sends on that channel) — and the channel must also stay inside
   * `plugin:<namespace>:`.
   */
  registerEvent(...channels: string[]): void

  /** Registers a reversible effect (e.g. a background service/timer); rolled back in LIFO order on disable */
  effect(register: () => void | (() => void)): void

  /**
   * Mounts a **multi-value contribution** (the same key may be contributed by several plugins; one
   * plugin may also contribute several entries).
   *
   * Semantics (pairing with `contributions`):
   * - **pull**: contributions are not dispatched or notified; consumers call `contributions(key)`
   *   whenever they need the current full set;
   * - **order-independent**: it can be read no matter whose install ran first; within the same key,
   *   entries are ordered by load order;
   * - **removed with the plugin**: the host tracks contributions by pluginId and removes them in
   *   `dispose()` on disable/uninstall, so the next pull no longer sees them (e.g. the plugin's tools
   *   no longer appear in the AI tool set assembled by harness).
   *
   * A contribution with an empty key is meaningless and throws directly (a failure during assembly
   * affects plugin loading — expose it early and fix it early).
   */
  contribute<T>(key: string, value: T): void

  /** Reads all contributions for a contribution point (for the host / registry owner, e.g. harness reading 'harness.tool') */
  contributions<T>(key: string): T[]

  /**
   * Asks the host to schedule a cloud sync (this plugin's data has been persisted).
   *
   * The host merges requests into one push with a **5-second debounce**; silently ignored when not
   * signed in to the plugin hub / not wired. Typical usage: call once after writing business tables,
   * not inside every loop iteration (the debounce only absorbs duplicate requests within a short
   * window).
   */
  requestSync(): void
}

export class MainPluginContextImpl implements MainPluginContext {
  readonly namespace: string

  private readonly effects: Array<() => void> = []
  private readonly ownedChannels = new Set<string>()
  /** Event channels with only a sender (no ipcMain handler; they only take part in the preload whitelist) */
  private readonly eventChannels = new Set<string>()
  private disposed = false

  constructor(readonly id: string) {
    this.namespace = channelNamespace(id)
    claimNamespace(id, this.namespace)
  }

  /** Channels currently owned (IPC handlers + event channels; used for logging/whitelist push) */
  get channels(): string[] {
    return [...this.ownedChannels, ...this.eventChannels]
  }

  registerEvent(...channels: string[]): void {
    const prefix = `plugin:${this.namespace}:`
    for (const channel of channels) {
      if (typeof channel !== 'string' || !channel.startsWith(prefix)) {
        throw new Error(`事件通道 '${String(channel)}' 必须以 ${prefix} 开头`)
      }
      this.eventChannels.add(channel)
    }
  }

  registerIpc(handlers: IpcHandlerMap): () => void {
    const prefix = `plugin:${this.namespace}:`
    const registered: string[] = []
    try {
      for (const [channel, handler] of Object.entries(handlers)) {
        if (!channel.startsWith(prefix)) {
          throw new Error(`通道 '${channel}' 必须以 ${prefix} 开头`)
        }
        if (typeof handler !== 'function') {
          throw new Error(`通道 '${channel}' 缺少处理函数`)
        }
        ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
          // Every call enters the plugin context: 1) so things like a plugin's `process.exit` are
          // attributed and blocked; 2) so exceptions in the handler are logged with the plugin id
          // (otherwise only a context-free "Error invoking remote method" remains).
          return await withPluginScope({ id: this.id, surface: 'ipc', channel }, async () => {
            try {
              return await handler(...(args as never[]))
            } catch (err) {
              logger.error(`[Plugins] ${this.id} failed to handle channel ${channel}:`, err)
              throw err
            }
          })
        })
        this.ownedChannels.add(channel)
        registered.push(channel)
      }
    } catch (err) {
      // Partial failure: remove what was already registered so no half-registered plugin remains
      for (const channel of registered) {
        try {
          ipcMain.removeHandler(channel)
        } catch {
          // Ignore
        }
        this.ownedChannels.delete(channel)
      }
      throw err
    }

    return () => {
      for (const channel of registered) {
        try {
          ipcMain.removeHandler(channel)
        } catch {
          // Ignore
        }
        this.ownedChannels.delete(channel)
      }
    }
  }

  effect(register: () => void | (() => void)): void {
    let undo: void | (() => void)
    try {
      // Registration itself happens inside install's plugin context; rollback happens on disable
      // (when the context is gone), so wrap it too so that "cleanup code on disable" cannot take the
      // app down with process.exit either.
      undo = withPluginScope({ id: this.id, surface: 'effect' }, register)
    } catch (err) {
      logger.warn(`[Plugins] ${this.id} failed to register effect:`, err)
      return
    }
    if (typeof undo === 'function') {
      this.effects.push(() => withPluginScope({ id: this.id, surface: 'effect:undo' }, undo!))
    }
  }

  contribute<T>(key: string, value: T): void {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error(`贡献点 key 不能为空（插件 '${this.id}'）`)
    }
    // Contributing from an already-disposed context would land in the registry and never be reclaimed, so block it
    if (this.disposed) {
      throw new Error(`插件 '${this.id}' 已停用，不能再贡献 '${key}'`)
    }
    addContribution(this.id, key, value)
  }

  contributions<T>(key: string): T[] {
    return listContributions<T>(key)
  }

  requestSync(): void {
    if (this.disposed) return
    try {
      syncRequester?.(this.id)
    } catch (err) {
      // A failed sync request must never affect the plugin's write result
      logger.warn(`[Plugins] ${this.id} requestSync failed:`, err)
    }
  }

  /** Rolls back all of this plugin's effects and channels (idempotent) */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    while (this.effects.length > 0) {
      const undo = this.effects.pop()!
      try {
        undo()
      } catch (err) {
        logger.warn(`[Plugins] ${this.id} failed to roll back effect:`, err)
      }
    }
    for (const channel of [...this.ownedChannels]) {
      try {
        ipcMain.removeHandler(channel)
      } catch {
        // Ignore
      }
    }
    this.ownedChannels.clear()
    this.eventChannels.clear()
    // Contributions are removed with the plugin on disable (pull semantics: the next consumption no longer sees this plugin's contributions)
    removeContributions(this.id)
    releaseNamespace(this.id, this.namespace)
  }
}
