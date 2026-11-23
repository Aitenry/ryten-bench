import _Store from 'electron-store'
import logger from 'electron-log'

/**
 * 插件启用态持久化（userData/plugins.json）。
 *
 * 只存「显式覆写」：插件默认**停用**（装进来不等于让它开始跑代码），用户启用后写入 true；
 * 未写入的 id 取默认值 false。
 *
 * 同一个文件还存一类**安装状态**：
 * - `removedInstalls`：用户在这台机器上卸载过的插件 id（插件中心换机自动补齐时跳过它）。
 */
export const Store = _Store['default'] || _Store

export const pluginsStore = new Store<{
  states?: Record<string, boolean>
  /**
   * 用户在这台机器上主动卸载过的插件 id。
   *
   * 它防的不是「应用包复活」（应用不分发插件），而是**插件中心的换机自动补齐**——
   * 平台按用户保存安装记录，pull 发现本机缺插件就会自动装回来；如果卸载时不记这一笔，
   * 卸载过的插件会在下次同步时「自己回来」。用户重新安装该插件时清掉
   * （见 package-install 的 installPackageDir）。
   */
  removedInstalls?: string[]
}>({
  name: 'plugins'
})

/** 读取某插件的显式启用覆写；undefined = 未覆写（取默认值 false） */
export function getEnabledOverride(id: string): boolean | undefined {
  const states = pluginsStore.get('states') ?? {}
  return states[id]
}

/** 写入显式启用覆写 */
export function setEnabledOverride(id: string, enabled: boolean): void {
  const states = pluginsStore.get('states') ?? {}
  pluginsStore.set('states', { ...states, [id]: enabled })
}

/** 清除显式覆写（回到默认值：停用） */
export function clearEnabledOverride(id: string): void {
  const states = pluginsStore.get('states') ?? {}
  if (!(id in states)) return
  const rest = { ...states }
  delete rest[id]
  pluginsStore.set('states', rest)
  logger.info(`[Plugins] Cleared enabled override for ${id}`)
}

// ---------- 显式卸载记录（换机自动补齐要跳过） ----------

/**
 * 用户在这台机器上主动卸载过的插件 id。
 *
 * 用途只有一个：**别让插件中心的换机自动补齐把刚卸载的插件装回来**。
 * 平台按用户保存安装记录，pull 时发现「平台有记录、本机没包」会自动安装；
 * 用户显式卸载后必须留一笔本地标记，否则下次同步/重启就复活。
 * 重新安装该插件时清掉（`installPackageDir` → `clearInstallRemoved`）。
 */
export function getRemovedInstalls(): string[] {
  const list = pluginsStore.get('removedInstalls') ?? []
  return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []
}

/** 某插件是否被用户显式卸载过（换机自动补齐要跳过它） */
export function isInstallRemoved(id: string): boolean {
  return getRemovedInstalls().includes(id)
}

/** 记下「用户在这台机器上卸载了插件 id」 */
export function markInstallRemoved(id: string): void {
  const list = getRemovedInstalls()
  if (list.includes(id)) return
  pluginsStore.set('removedInstalls', [...list, id])
  logger.info(`[Plugins] Marked ${id} as explicitly uninstalled (auto-restore will skip it)`)
}

/** 清掉「显式卸载」标记（用户重新安装时调用） */
export function clearInstallRemoved(id: string): void {
  const list = getRemovedInstalls()
  if (!list.includes(id)) return
  pluginsStore.set(
    'removedInstalls',
    list.filter((x) => x !== id)
  )
  logger.info(`[Plugins] Cleared explicit-uninstall mark for ${id}`)
}
