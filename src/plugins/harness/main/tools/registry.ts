/**
 * AI 工具注册表的**纯逻辑**（零 import，可被 node 直接加载做离线回归）。
 *
 * 为什么从 `builders.ts` 抽出来：注册表要合并三路来源（本地工具 / 插件贡献 / MCP 服务器），
 * 而「同名谁赢、清单顺序、前缀命名」这些规则恰恰是最容易出漂移的地方，必须能离线断言。
 * builders.ts 依赖 langchain/electron 等运行期模块（且是**无扩展名相对导入**，Node 直接加载
 * 不了），所以把规则搬到这里：谁都不 import，测试直接 `import` 本文件即可。
 */

/**
 * 工具在设置页/清单里的展示元数据。
 *
 * 与 core 的 `ToolInfo`（`src/main/plugins/tool-contract.ts`）**结构一致**：这里刻意不 import
 * 那份定义，只为让本模块保持零依赖（见文件头注释）。赋值方向是安全的——结构相同即兼容。
 */
export interface ToolInfoLike {
  name: string
  label: string
  description: string
  icon: string
  color: string
}

/** 一路工具来源：名字 + 展示元数据，以及「拿到可调用实例」的工厂 */
export interface ToolSource<T = unknown> {
  info: ToolInfoLike
  /** 真正构建工具实例（延迟到需要时调用） */
  build: () => T
}

/** 已告警过的重名（同名每轮组装都会撞上，只提示一次，避免刷日志） */
const warnedConflicts = new Set<string>()

/** 记录并提示一次重名冲突（本地工具优先于一切，先到先得） */
export function warnConflict(name: string, onWarn?: (message: string) => void): void {
  if (warnedConflicts.has(name)) return
  warnedConflicts.add(name)
  const message = `[Harness] 工具名冲突：'${name}' 已被更早注册的同名工具占用（本地工具优先），忽略后续贡献`
  if (onWarn) onWarn(message)
  else console.warn(message)
}

/** 合并结果：可调用实例表 + 展示清单（同一个顺序与同一套去重规则） */
export interface MergedTools<T> {
  builders: Record<string, () => T>
  infos: ToolInfoLike[]
}

/**
 * 合并三路工具来源（顺序即优先级）：
 *  1. `local` —— 本地工具（weather / time），永远最先；
 *  2. `contributed` —— 各插件经 `harness.tool` 贡献点注册的工具，**按 name 排序**
 *     （注册表顺序取决于插件装载顺序，不排序的话启停一次插件就会让设置页下拉的顺序变化）；
 *  3. `mcp` —— 外部 MCP 服务器当前暴露的工具，同样按 name 排序
 *     （全名带服务器命名空间前缀，因此同一台服务器的工具自然聚在一起）。
 *
 * 同名先到先得，后来的记一次冲突告警后丢弃——**绝不抛错**：某台服务器/某个插件与内置工具
 * 撞名只该少一个工具，不该让整轮对话起不来。
 */
export function mergeToolSources<T>(sources: {
  local: ToolSource<T>[]
  contributed?: ToolSource<T>[]
  mcp?: ToolSource<T>[]
  onWarn?: (message: string) => void
}): MergedTools<T> {
  const builders: Record<string, () => T> = {}
  const infos: ToolInfoLike[] = []
  const seen = new Set<string>()

  const pushAll = (list: ToolSource<T>[], sort: boolean): void => {
    const accepted: ToolSource<T>[] = []
    for (const source of sort
      ? [...list].sort((a, b) => a.info.name.localeCompare(b.info.name, 'en'))
      : list) {
      const name = source.info.name
      if (seen.has(name)) {
        warnConflict(name, sources.onWarn)
        continue
      }
      seen.add(name)
      builders[name] = source.build
      accepted.push(source)
    }
    for (const source of accepted) infos.push(source.info)
  }

  pushAll(sources.local, false)
  pushAll(sources.contributed ?? [], true)
  pushAll(sources.mcp ?? [], true)

  return { builders, infos }
}
