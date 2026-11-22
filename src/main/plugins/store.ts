import _Store from 'electron-store'
import logger from 'electron-log'

/**
 * 插件启用态持久化（userData/plugins.json）。
 *
 * 只存「显式覆写」：内置插件默认启用、外部插件默认停用——
 * 未写入的 id 取默认值，避免每次内置插件新增都要迁移存量配置。
 *
 * 同一个文件还存两类**内置插件安装状态**（物理卸载方案见 src/plugins/PACKAGING.md）：
 * - `uninstalled`：用户主动卸载过的内置插件 id（启动时不再自动装回来）；
 * - `seeded`：每个内置插件上次铺包时的应用版本（应用升级后覆盖插件包）。
 */
export const Store = _Store['default'] || _Store

export const pluginsStore = new Store<{
  states?: Record<string, boolean>
  uninstalled?: string[]
  seeded?: Record<string, string>
}>({
  name: 'plugins'
})

/** 读取某插件的显式启用覆写；undefined = 未覆写（取默认值） */
export function getEnabledOverride(id: string): boolean | undefined {
  const states = pluginsStore.get('states') ?? {}
  return states[id]
}

/** 写入显式启用覆写 */
export function setEnabledOverride(id: string, enabled: boolean): void {
  const states = pluginsStore.get('states') ?? {}
  pluginsStore.set('states', { ...states, [id]: enabled })
}

/** 清除显式覆写（回到默认值） */
export function clearEnabledOverride(id: string): void {
  const states = pluginsStore.get('states') ?? {}
  if (!(id in states)) return
  const rest = { ...states }
  delete rest[id]
  pluginsStore.set('states', rest)
  logger.info(`[Plugins] Cleared enabled override for ${id}`)
}

// ---------- 内置插件的安装状态 ----------

/**
 * 用户主动卸载过的内置插件 id。
 *
 * 语义严格限定在「内置」：外部插件（用户自己装的）目录被删掉就没了，不需要这个标记；
 * 内置插件**必须**记一笔，否则下次启动 `ensureBundledPluginsInstalled()` 会把它装回来，
 * 「物理卸载」就退化成了「卸载后自动复活」。
 */
export function getUninstalledBuiltins(): string[] {
  const list = pluginsStore.get('uninstalled') ?? []
  return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []
}

/** 记下「用户卸载了内置插件 id」 */
export function markUninstalled(id: string): void {
  const list = getUninstalledBuiltins()
  if (list.includes(id)) return
  pluginsStore.set('uninstalled', [...list, id])
  logger.info(`[Plugins] Marked ${id} as uninstalled (will not auto-install)`)
}

/** 清掉某内置插件的已卸载记录（重装时调用） */
export function clearUninstalled(id: string): void {
  const list = getUninstalledBuiltins()
  if (!list.includes(id)) return
  pluginsStore.set(
    'uninstalled',
    list.filter((x) => x !== id)
  )
  logger.info(`[Plugins] Cleared uninstalled record for ${id}`)
}

/** 某内置插件上次铺包时的应用版本（未铺过返回 undefined） */
export function getPluginSeeded(id: string): string | undefined {
  const map = pluginsStore.get('seeded') ?? {}
  return map[id]
}

/** 记下某内置插件本次铺包时的应用版本 */
export function setPluginSeeded(id: string, version: string): void {
  const map = pluginsStore.get('seeded') ?? {}
  pluginsStore.set('seeded', { ...map, [id]: version })
}

/**
 * 本应用曾经铺过包的全部 id（`seeded` 的键）。
 *
 * 用途：判断「某个已安装插件是不是本应用铺的」——升级清理要用（见 `installer.ts` 的
 * `removeRetiredBundledPlugins()`）。**不能**用目录扫描代替：目录扫描分不清
 * 「本应用铺的内置包」与「用户自己装的第三方插件」。
 */
export function getSeededPluginIds(): string[] {
  const map = pluginsStore.get('seeded') ?? {}
  return Object.keys(map)
}

/** 清掉某 id 的铺包记录（该 id 不再是内置插件、或用户把它卸载掉时调用） */
export function clearPluginSeeded(id: string): void {
  const map = pluginsStore.get('seeded') ?? {}
  if (!(id in map)) return
  const rest = { ...map }
  delete rest[id]
  pluginsStore.set('seeded', rest)
}
