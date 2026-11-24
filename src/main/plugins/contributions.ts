/**
 * 主进程插件**多值贡献点**注册表（core 侧，插件之间经宿主交换而不互相 import）。
 *
 * 语义：
 * - **多值**：同一个 key 可以由多个插件分别贡献（例如 `harness.tool` 由
 *   planner / notes / music 各贡献自己的工具），同一个插件也可以贡献多项；
 * - **拉取（pull）**：注册表不通知、不派发。消费方（例如 harness 组装工具集时）
 *   在**需要的那一刻**调 `listContributions(key)` 取当前全部贡献，
 *   **顺序无关**——谁的 install 先跑都能拿到全部；
 * - **随插件停用移除**：贡献以 pluginId 记账，插件停用时宿主调
 *   `removeContributions(pluginId)` 一次性清掉自己的全部贡献；
 *   下一次拉取就看不到它了（消费方无需感知「插件没了」这件事）；
 * - **按插件装载顺序保存**：值是数组，同 key 内保持贡献先后（消费方若要稳定输出
 *   应自己按 name 排序，不要依赖装载顺序）。
 *
 * 与渲染层 `plugin-host` 的插槽是同一套思路（多值、可回滚），只是主进程侧
 * 目前只有「贡献 → 宿主消费」这一种关系，因此不做单值 provide/use。
 */

/** 一条已挂载的贡献：谁的、值是什么 */
interface ContributionEntry {
  pluginId: string
  value: unknown
}

/** key → 按装载顺序排列的贡献列表 */
const registry = new Map<string, ContributionEntry[]>()

/** 挂载一条贡献（同一插件同一 key 可多次调用，各自入列） */
export function addContribution(pluginId: string, key: string, value: unknown): void {
  const list = registry.get(key)
  if (list) list.push({ pluginId, value })
  else registry.set(key, [{ pluginId, value }])
}

/**
 * 摘除某插件的**全部**贡献（停用/卸载时调用；幂等）。
 * 空 key 的列表一并删掉，避免注册表里留下无人消费的空槽。
 */
export function removeContributions(pluginId: string): void {
  for (const [key, list] of [...registry]) {
    const kept = list.filter((entry) => entry.pluginId !== pluginId)
    if (kept.length === 0) registry.delete(key)
    else if (kept.length !== list.length) registry.set(key, kept)
  }
}

/**
 * 读取某贡献点的全部贡献（拉取语义：调用时的快照，之后插件启停不会改写已取出的数组）。
 * 未注册的 key 返回空数组，**不抛错**——「没人贡献」是正常状态。
 */
export function listContributions<T>(key: string): T[] {
  return (registry.get(key) ?? []).map((entry) => entry.value as T)
}

/** 当前注册表里的贡献点 key（仅供日志/诊断，不含值） */
export function contributionKeys(): string[] {
  return [...registry.keys()]
}

/**
 * 贡献点键：**插件自清数据**（`plugin.purge`）。
 *
 * 用途：卸载插件时，用户勾了「同时删除该插件的全部数据」才真正卸载它的数据，此时宿主
 * 调这里的贡献，让**插件自己**删自己的数据——表在 core 的 schema 里、行在同一个 PGlite 库里，
 * 但「哪些表 / 哪些托管目录属于我」只有插件自己知道，core 不该硬编码任何插件表名。
 *
 * 契约（与 `app-hooks.ts` 的钩子同构，只是单值语义更贴切——一个插件只有一份清理逻辑）：
 * - 插件在 `install(ctx)` 里 `ctx.contribute(PLUGIN_PURGE, { run, label })`；
 * - 宿主在**插件仍处于装载状态**时调用 `run()`（要读自己的 mapper / 托管目录），
 *   因此 `run` 可以放心 import 自己插件的模块（不会拿到已 dispose 的上下文）；
 * - `run` 只删**数据**：不删表结构（迁移不动，避免出现「卸载后迁移对不上」的库），
 *   也不碰用户自己的原始文件（例如 music 只删应用托管的歌单目录，不删用户音乐）；
 * - `label` 会经 `PluginListEntry.purgeLabel` 显示在卸载确认框的勾选项里（「包含：……」），
 *   所以要写成用户看得懂的短语。
 */
export const PLUGIN_PURGE = 'plugin.purge'

/** `plugin.purge` 贡献的值：`label` 只用于日志/确认框，`run` 是插件自己的清数据动作 */
export interface PluginPurgeContribution {
  run: () => void | Promise<void>
  label: string
}

/**
 * 取某插件的清数据动作（未贡献返回 null）。
 *
 * 用**末项**：同一插件重复贡献时后写的生效；不同插件之间互不影响
 * （贡献注册表按 pluginId 记账，停用时只摘自己的）。
 */
export function pluginPurge(id: string): PluginPurgeContribution | null {
  const all = (registry.get(PLUGIN_PURGE) ?? []).filter((entry) => entry.pluginId === id)
  const value = all[all.length - 1]?.value as Partial<PluginPurgeContribution> | undefined
  if (!value || typeof value.run !== 'function') return null
  return { run: value.run, label: typeof value.label === 'string' ? value.label : id }
}

/**
 * 贡献点键：**云同步快照**（`plugin.sync.snapshot`）。
 *
 * 背景：`lattice/sync` 原先只同步 `userData/plugin-state/<id>.json`，而按宿主约定
 * （见 WORKSHOP「应用数据进表、设置进 JSON」）业务数据在插件自己的表里——于是云端只有设置。
 * 这个贡献点让插件自己决定「同步什么」：
 *
 * 契约：
 * - 插件在 `install(ctx)` 里 `ctx.contribute(PLUGIN_SYNC_SNAPSHOT, { export, import })`；
 * - `export()` 返回**可 JSON 序列化**的对象（平台上限 256KiB，宿主超限时整份跳过、不截断），
 *   内容由插件自己定义：设置 + 业务表的合并快照都行；
 * - `import(data)` 必须是**替换语义、幂等**：重复应用同一份快照不得产生重复行
 *   （宿主在 pull / 冲突选「用云端」时可能多次调用）；抛错即视为失败，宿主不会前移 `data_rev`；
 * - 贡献存在时，宿主**不再**读写 `plugin-state/<id>.json` 作为同步载荷（那个文件只是设置，
 *   拿它当快照会把云端数据覆盖成设置）；插件未装载（停用）时云端数据只保留、不落盘，
 *  待插件重新启用后再应用（`requestSync` 会触发一次同步）；
 * - `label` 只用于日志/排障。
 */
export const PLUGIN_SYNC_SNAPSHOT = 'plugin.sync.snapshot'

/** `plugin.sync.snapshot` 贡献的值 */
export interface PluginSyncSnapshotContribution {
  /** 导出当前可同步数据（设置 + 业务表），宿主序列化后上传 */
  export: () => unknown | Promise<unknown>
  /** 应用云端快照（**替换 + 幂等**；未实现时宿主拒绝把快照写进 plugin-state） */
  import?: (data: unknown) => void | Promise<void>
  /**
   * 合并：把云端快照并入本机（不覆盖本机独有数据，按插件的自然键去重）。
   *
   * 返回摘要文本供界面提示；宿主合并成功后会再把「合并后的本机快照」强制推回云端，
   * 所以插件只需要保证本地是「两边并集」，不必自己调网络。
   */
  merge?: (data: unknown) => void | Promise<{ summary?: string; rows?: number }>
  /**
   * 本机是否已有业务数据（可选；宿主用它判断「还没推过快照、本机又有数据」时
   * 不能直接拿云端覆盖，必须先记冲突让用户选择/合并）。
   */
  hasData?: () => boolean | Promise<boolean>
  /**
   * 统计一份快照里有多少条业务数据（可选；用于同步结果/界面展示「拉取/推送了多少条」）。
   * 返回数字，插件自己决定怎么算（例如十张表行数之和）。
   */
  count?: (data: unknown) => number | Promise<number>
  /** 说明文字，仅用于日志/排障 */
  label?: string
}

/**
 * 取某插件的同步快照贡献（未贡献 / 插件未装载时返回 null）。
 *
 * 与 `pluginPurge` 一样的「末项生效」规则；`export` 必需，`import` 可选。
 */
export function pluginSyncSnapshot(id: string): PluginSyncSnapshotContribution | null {
  const all = (registry.get(PLUGIN_SYNC_SNAPSHOT) ?? []).filter((entry) => entry.pluginId === id)
  const value = all[all.length - 1]?.value as Partial<PluginSyncSnapshotContribution> | undefined
  if (!value || typeof value.export !== 'function') return null
  return {
    export: value.export,
    ...(typeof value.import === 'function' ? { import: value.import } : {}),
    ...(typeof value.merge === 'function' ? { merge: value.merge } : {}),
    ...(typeof value.hasData === 'function' ? { hasData: value.hasData } : {}),
    ...(typeof value.count === 'function' ? { count: value.count } : {}),
    ...(typeof value.label === 'string' ? { label: value.label } : {})
  }
}
