import { PluginError, PLUGIN_ERROR } from '@shared/plugin/errors'
import type { PluginManifest } from '@shared/plugin/types'
import { HOST_KEYS } from './keys'
import type { HostServiceKey, HostServices } from './types'
import type { PluginHost } from './host'

export type Dispose = () => void | Promise<void>

/**
 * 插件上下文（Cordis PluginContext 的轻量实现）。
 *
 * - use/get：按键取宿主服务；未 use 声明而 get → UNDECLARED_ACCESS（capability 模型）；
 * - set：登记插件提供的自定义键（供其他插件 inject + 卸载顺序推导）；
 * - effect：注册可逆效果，dispose 时 LIFO 逆序回滚（论文 revertible effect + 累积逆）；
 * - require：外部插件向宿主取 vendored 实例（react/antd...），杜绝双重 React；
 * - dispose：install 返回的 dispose + 全部 effect 逆序执行，失败不阻断其他回滚。
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

  /** 声明依赖并取宿主服务 */
  use<K extends HostServiceKey>(key: K): HostServices[K] {
    this.declared.add(key)
    return this.host.serviceFor<K>(key, this.id)
  }

  /** 读取依赖：未声明访问直接拒绝 */
  get<K extends HostServiceKey>(key: K): HostServices[K] {
    if (!this.declared.has(key)) {
      throw new PluginError(
        PLUGIN_ERROR.UNDECLARED_ACCESS,
        `[plugin:${this.id}] 未声明依赖却访问上下文键 '${key}'`
      )
    }
    return this.host.serviceFor<K>(key, this.id)
  }

  /** 提供自定义键（宿主根键不允许被提供） */
  set(key: string, value: unknown): void {
    if ((HOST_KEYS as readonly string[]).includes(key)) {
      console.warn(`[plugin:${this.id}] Host root key '${key}' is not allowed to be provided by a plugin, ignored`)
      return
    }
    this.providedKeys.add(key)
    this.host.registerProvide(this.id, key, value)
  }

  /** 注册可逆效果：register 执行副作用，返回的逆在 dispose 时逆序执行 */
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

  /** install 返回的 dispose（最后注册、最先执行） */
  attachInstallDispose(dispose: void | Dispose | undefined): void {
    if (typeof dispose === 'function') this.installDispose = dispose
  }

  injects(): string[] {
    return [...this.declared]
  }

  provided(): string[] {
    return [...this.providedKeys]
  }

  /** 逆序回滚本插件全部效果（满足 registers 后注册先撤销） */
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

  /** 外部插件取宿主 vendored 实例 */
  require(name: string): unknown {
    return this.host.requireVendor(name)
  }
}
