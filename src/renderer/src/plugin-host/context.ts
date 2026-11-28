import { PluginError, PLUGIN_ERROR } from '@shared/plugin/errors'
import type { PluginManifest } from '@shared/plugin/types'
import { HOST_KEYS } from './keys'
import type { HostServiceKey, HostServices } from './types'
import type { PluginHost } from './host'

export type Dispose = () => void | Promise<void>

/**
 * Plugin context (lightweight plugin-context implementation).
 *
 * - use/get: fetch host services by key; get without a use declaration → UNDECLARED_ACCESS (capability model);
 * - set: register custom keys provided by the plugin (used by other plugins' inject + unload-order derivation);
 * - effect: register a revertible effect, rolled back LIFO on dispose (revertible effect + cumulative inverse);
 * - require: external plugins receive vendored instances from the host (react/antd...), preventing a duplicate React;
 * - dispose: the dispose returned by install plus all effects run in reverse order; a failure does not block the other rollbacks.
 */
export class PluginContext {
  private declared = new Set<string>()
  private effects: Dispose[] = []
  private providedKeys = new Set<string>()
  private installDispose: Dispose | undefined

  constructor(
    readonly id: string,
    private readonly host: PluginHost,
    readonly manifest: PluginManifest,
    readonly config?: unknown
  ) {}

  /** Declare a dependency and fetch the host service */
  use<K extends HostServiceKey>(key: K): HostServices[K] {
    this.declared.add(key)
    return this.host.serviceFor<K>(key, this.id)
  }

  /** Read a dependency: undeclared access is rejected */
  get<K extends HostServiceKey>(key: K): HostServices[K] {
    if (!this.declared.has(key)) {
      throw new PluginError(
        PLUGIN_ERROR.UNDECLARED_ACCESS,
        `[plugin:${this.id}] 未声明依赖却访问上下文键 '${key}'`
      )
    }
    return this.host.serviceFor<K>(key, this.id)
  }

  /** Provide a custom key (host root keys cannot be provided) */
  set(key: string, value: unknown): void {
    if ((HOST_KEYS as readonly string[]).includes(key)) {
      console.warn(`[plugin:${this.id}] Host root key '${key}' is not allowed to be provided by a plugin, ignored`)
      return
    }
    this.providedKeys.add(key)
    this.host.registerProvide(this.id, key, value)
  }

  /** Register a revertible effect: register performs the side effect; the returned inverse runs in reverse order on dispose */
  effect(register: () => void | Dispose): void {
    let undo: void | Dispose
    try {
      undo = register()
    } catch (err) {
      console.error(`[plugin:${this.id}] Failed to register effect:`, err)
      return
    }
    if (typeof undo === 'function') this.effects.push(undo)
  }

  /** Dispose returned by install (registered last, executed first) */
  attachInstallDispose(dispose: void | Dispose | undefined): void {
    if (typeof dispose === 'function') this.installDispose = dispose
  }

  injects(): string[] {
    return [...this.declared]
  }

  provided(): string[] {
    return [...this.providedKeys]
  }

  /** Roll back all effects of this plugin in reverse order (later registrations are undone first) */
  async dispose(): Promise<void> {
    if (this.installDispose) {
      const undo = this.installDispose
      this.installDispose = undefined
      try {
        await undo()
      } catch (err) {
        console.error(`[plugin:${this.id}] install dispose failed:`, err)
      }
    }
    while (this.effects.length > 0) {
      const undo = this.effects.pop()!
      try {
        await undo()
      } catch (err) {
        console.error(`[plugin:${this.id}] Failed to roll back effect:`, err)
      }
    }
  }

  /** External plugins fetch vendored instances from the host */
  require(name: string): unknown {
    return this.host.requireVendor(name)
  }
}
