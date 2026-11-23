/**
 * 插件系统的跨进程共享类型（main / preload / renderer 三端共用）。
 *
 * 设计参照 Cordis 的「组件即插件」模型：
 * - inject  = 依赖声明（coeffect）：插件通过上下文键声明它需要哪些宿主能力；
 * - provide = 供给声明（provision）：插件通过上下文键声明它能提供什么；
 * - install(ctx) => dispose 是可逆效果：注册的逆操作进入回滚栈，卸载时逆序执行。
 *
 * 注意：本文件不得引入 electron / node / react 依赖，两侧构建都要能直接打包。
 */

/** 插件清单（plugin.json；第三方插件，随应用分发的内置插件机制已删除） */
export interface PluginManifest {
  /**
   * 稳定唯一标识（`plugin.<作者>.<名字>`，或不带前缀的中性短名）。
   *
   * 命名空间规则：id 去掉开头的 `plugin.` 段即 IPC 命名空间（`plugin:<命名空间>:*`），
   * 因此 `plugin.demo` 与 `demo` 会撞到同一个命名空间，宿主会拒绝第二个（见 `channelNamespace`）。
   */
  id: string
  /** 展示名 */
  name: string
  /** semver 版本 */
  version: string
  description?: string
  /** 插件图标：plugin://<id>/icon.svg 或 data: URI */
  icon?: string
  /** 入口（必须齐备；构建产物由工坊写入） */
  entry?: {
    /** 渲染层入口（ESM），通常是 `renderer.mjs` */
    renderer?: string
    /** 主进程入口（CJS），通常是 `main.cjs` */
    main?: string
  }
  /** 依赖声明：install 中可访问的上下文键。未声明而访问 → UNDECLARED_ACCESS */
  inject?: string[]
  /** 供给声明：install 中 ctx.set 产出的键。用于依赖图与卸载顺序（withdrawal） */
  provide?: string[]
  /** 路由元数据 */
  routes?: { path: string; skeleton?: string }[]
  /** 侧栏菜单元数据（缺省则不出现菜单项） */
  menu?: { key: string; labelKey: string; icon: string; order?: number }
  /** 能力声明白名单（本版做声明 + 主进程通道校验，强制执行为后续增强） */
  permissions?: string[]
}

/** 插件运行时状态（三端统一的描述符） */
export interface PluginDescriptor {
  manifest: PluginManifest
  source: 'external'
  /** 插件目录绝对路径 */
  dir?: string
  /** 合并持久化覆写后的最终启用态 */
  enabled: boolean
  state: PluginState
  error?: string
}

/** 渲染层 fiber 生命周期状态（论文 Figure 2 的简化两态 + 失败恢复） */
export type PluginState = 'inactive' | 'reloading' | 'active' | 'unloading' | 'error'

/** 插件管理员/渲染层看到的最小清单数据（主进程加工后广播；只含已安装插件） */
export interface PluginListEntry {
  id: string
  name: string
  version: string
  description?: string
  icon?: string
  enabled: boolean
  state: PluginState
  error?: string
  /**
   * 磁盘上这份插件包的**内容戳**（入口文件与 `plugin.css` 的 mtime 最大值）。
   *
   * 为什么不用 `version`：重装/升级本地包时版本号常常不变，而渲染层必须知道「磁盘上的
   * 代码换了，得重新 fetch renderer.mjs 并重新注入 plugin.css」——否则用户升完级看到的
   * 还是旧界面（2026-09-26 实测踩到）。
   */
  stamp?: string
  /** 插件入口（渲染层 loader 与主进程装载依据） */
  entry?: { renderer?: string; main?: string }
  /**
   * 路由元数据（与 `PluginManifest.routes` 同形，直接来自清单）。
   *
   * 用途是**首帧声明式预注册**：磁盘包插件的渲染模块要 fetch + import 之后才 install，
   * 首帧侧栏/路由表会是空的（菜单「晚几百毫秒才弹出来」）。渲染层拿这份元数据在
   * 宿主构造期同步登记一遍，插件模块加载完成后由它自己的真实注册覆盖（见
   * `renderer/src/plugin-host/host.ts` 的 `declare()`）。
   */
  routes?: { path: string; skeleton?: string }[]
  /** 侧栏菜单元数据（同上；`icon` 是 remixicon 名字符串，声明项按名字解析成节点） */
  menu?: { key: string; labelKey: string; icon: string; order?: number }
  /**
   * 该插件 `plugin.purge` 贡献自称「会删什么」的一句话（例如「音乐曲库与托管歌单目录」）。
   *
   * 只用于卸载确认框里把「同时删除的数据」写具体——贡献本身在插件仍装载时才存在，
   * 因此刚启动/插件被停用时可能是 undefined，界面要有兜底文案。
   */
  purgeLabel?: string
}

/** 校验 manifest 最小字段是否齐全（非法插件静默跳过/拒绝安装） */
export function isValidManifest(m: unknown): m is PluginManifest {
  if (typeof m !== 'object' || m === null) return false
  const o = m as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    /^[A-Za-z][A-Za-z0-9._-]*$/.test(o.id) &&
    typeof o.name === 'string' &&
    typeof o.version === 'string' &&
    typeof o.entry === 'object' &&
    o.entry !== null
  )
}
