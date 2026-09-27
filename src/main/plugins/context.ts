import { ipcMain } from 'electron'
import logger from 'electron-log'
import { addContribution, listContributions, removeContributions } from './contributions'

/**
 * 主进程插件上下文（与渲染层 `plugin-host/context.ts` 对称的轻量实现）。
 *
 * 契约（内置插件与外部插件**完全相同**，见 src/plugins/README.md）：
 * - `install(ctx)` 是可逆装配：注册的 IPC 通道与 `ctx.effect` 里登记的效果，
 *   在插件停用/卸载时由宿主一次性回滚（效果 LIFO）；
 * - IPC 通道必须落在本插件命名空间 `plugin:<命名空间>:` 内，宿主权威校验，
 *   防止插件互相顶掉通道（与 preload 的通道白名单同一套规则）；
 * - 主进程 → 渲染层的事件通道（只 send、无 handler）用 `registerEvent` 声明：
 *   preload 的插件通道白名单只收录「本插件声明过的通道」，未声明的事件通道
 *   `window.api.plugin.on(...)` 会被拒绝（内置插件的订阅同样受白名单门控）；
 * - 插件业务代码可以照常 import 核心模块（orm / settings / workspace 等），
 *   但**不得**在 core 的 ipc 分组表里登记通道——归属与生命周期都由本契约表达；
 * - `contribute(key, value)` 挂载的多值贡献（例如 AI 工具）也是可逆装配的一部分：
 *   停用/卸载时随 `dispose()` 摘除，消费方（harness 工具注册表）下一次拉取即生效。
 */

/** 通道命名空间：插件 id 去掉开头的 `plugin.` 段（plugin.demo → demo） */
export function channelNamespace(id: string): string {
  return id.startsWith('plugin.') ? id.slice('plugin.'.length) : id
}

/**
 * 命名空间占用表：内置 `music` 与外部 `plugin.music` 会映射到同一个 `plugin:music:`，
 * 必须挡住（否则两者互相顶掉通道）。占用在构造时声明、dispose 时释放。
 */
const namespaceOwners = new Map<string, string>()

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

/** IPC 处理器表：通道名 → 处理函数（参数由渲染层经通用桥传入） */
export type MainIpcHandlers = Record<string, (...args: never[]) => unknown>

export interface MainPluginContext {
  /** 插件 id（manifest.id） */
  readonly id: string
  /** 本插件的通道命名空间（`plugin:<namespace>:` 里的 `<namespace>`） */
  readonly namespace: string

  /** 注册 IPC 处理器；返回只注销本次注册通道的逆操作 */
  registerIpc(handlers: MainIpcHandlers): () => void

  /**
   * 声明本插件「主进程 → 渲染层」的事件通道（没有 ipcMain 处理器，只有发送方）。
   *
   * 这些通道与 `registerIpc` 注册的通道一起进入 `activePluginChannels()`，
   * 由 `pushPluginChannels()` 推给 preload 的白名单缓存；不声明就等于渲染层
   * 订阅不到（preload 只会在订阅时告警，主进程侧根本没有人往该通道发送）。
   * 通道同样必须落在 `plugin:<命名空间>:` 内。
   */
  registerEvent(...channels: string[]): void

  /** 注册可逆效果（例如一个后台服务/定时器），停用时 LIFO 回滚 */
  effect(register: () => void | (() => void)): void

  /**
   * 挂载一个**多值贡献**（同一个键可由多个插件分别贡献；同一插件也可贡献多项）。
   *
   * 语义（与 `contributions` 成对）：
   * - **拉取**：贡献不派发、不通知，消费方在自己需要时调 `contributions(key)` 取当前全量；
   * - **顺序无关**：谁的 install 先跑都能被取到，同 key 内按装载顺序排列；
   * - **随插件停用移除**：宿主按 pluginId 记账，停用/卸载时 `dispose()` 一并摘除，
   *   下一次拉取就看不到（例如 harness 组装的 AI 工具集里不再出现该插件的工具）。
   *
   * key 为空的贡献没有意义，直接抛错（装配期失败会连累插件装载，早暴露早修）。
   */
  contribute<T>(key: string, value: T): void

  /** 读取某贡献点的全部贡献（宿主/注册表所有者用，例如 harness 读 'harness.tool'） */
  contributions<T>(key: string): T[]
}

export class MainPluginContextImpl implements MainPluginContext {
  readonly namespace: string

  private readonly effects: Array<() => void> = []
  private readonly ownedChannels = new Set<string>()
  /** 仅有发送方的事件通道（无 ipcMain 处理器，只参与 preload 白名单） */
  private readonly eventChannels = new Set<string>()
  private disposed = false

  constructor(readonly id: string) {
    this.namespace = channelNamespace(id)
    claimNamespace(id, this.namespace)
  }

  /** 当前占用的通道（IPC 处理器 + 事件通道；用于日志/白名单推送） */
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

  registerIpc(handlers: MainIpcHandlers): () => void {
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
        ipcMain.handle(channel, async (_event, ...args: unknown[]) => handler(...(args as never[])))
        this.ownedChannels.add(channel)
        registered.push(channel)
      }
    } catch (err) {
      // 半途失败：已注册的先摘掉，避免留下半个插件
      for (const channel of registered) {
        try {
          ipcMain.removeHandler(channel)
        } catch {
          // 忽略
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
          // 忽略
        }
        this.ownedChannels.delete(channel)
      }
    }
  }

  effect(register: () => void | (() => void)): void {
    let undo: void | (() => void)
    try {
      undo = register()
    } catch (err) {
      logger.warn(`[Plugins] ${this.id} effect 注册失败:`, err)
      return
    }
    if (typeof undo === 'function') this.effects.push(undo)
  }

  contribute<T>(key: string, value: T): void {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error(`贡献点 key 不能为空（插件 '${this.id}'）`)
    }
    // 已停用的上下文再贡献会挂进注册表却永不被回收，直接挡住
    if (this.disposed) {
      throw new Error(`插件 '${this.id}' 已停用，不能再贡献 '${key}'`)
    }
    addContribution(this.id, key, value)
  }

  contributions<T>(key: string): T[] {
    return listContributions<T>(key)
  }

  /** 回滚本插件全部效果与通道（幂等） */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    while (this.effects.length > 0) {
      const undo = this.effects.pop()!
      try {
        undo()
      } catch (err) {
        logger.warn(`[Plugins] ${this.id} effect 回滚失败:`, err)
      }
    }
    for (const channel of [...this.ownedChannels]) {
      try {
        ipcMain.removeHandler(channel)
      } catch {
        // 忽略
      }
    }
    this.ownedChannels.clear()
    this.eventChannels.clear()
    // 贡献点随插件停用一并摘除（拉取语义：下一次消费就看不到本插件的贡献）
    removeContributions(this.id)
    releaseNamespace(this.id, this.namespace)
  }
}
