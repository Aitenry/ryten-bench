import type { ComponentType, ReactNode } from 'react'
import type { PluginManifest } from '@shared/plugin/types'
import type { PluginContext } from './context'

/**
 * 渲染层插件宿主类型系统。
 *
 * 上下文键（ContextKeys）对应论文「把路由/菜单/设置页/Provider/全局组件等挂载点
 * 收编为共享上下文中的键」：插件通过键声明依赖（inject），宿主通过注册表消费。
 */

/** 懒加载工厂：返回 default 导出的页面组件（内置插件为 vite 动态 import chunk） */
export type LazyLoader = () => Promise<{ default: ComponentType }>

export interface RegisteredRoute {
  pluginId: string
  path: string
  /** 骨架屏 variant（字符串，未知值走通用骨架） */
  skeleton?: string
  /** 懒加载；与 Component 二选一 */
  load?: LazyLoader
  /** 立即渲染（如首屏即用的内置页），与 load 二选一 */
  Component?: ComponentType
}

export interface RegisteredMenuItem {
  pluginId: string
  key: string
  labelKey: string
  icon: ReactNode
  order: number
}

/**
 * **声明式预注册项**：来自主进程清单（`PluginListEntry.routes/menu`）的纯元数据，
 * 没有任何组件与加载器。
 *
 * 与真实注册的区别：真实注册由插件 `install(ctx)` 给出（带 `Component`/`load` 与
 * 组件形态的 `icon`），是权威；声明只是首帧占位，同 `key`/`path` 时被真实注册覆盖
 * （见 `host.ts` 的 `declare()` 与 `getMenus`/`getRoutes`）。
 */
export interface PluginDeclaration {
  /** 侧栏菜单（`icon` 已由 `declaredMenuIcon()` 按清单里的名字解析成节点） */
  menu?: { key: string; labelKey: string; icon: ReactNode; order?: number }
  /** 路由（无 `load`/`Component` → `MainRoutes` 渲染 `RouteSkeleton` 骨架） */
  routes?: { path: string; skeleton?: string }[]
}

export interface SettingsSectionRegistration {
  pluginId: string
  tabKey: string
  labelKey: string
  icon: ReactNode
  group: string
  order: number
  Component: ComponentType
}

export type ProviderComponent = ComponentType<{ children: ReactNode }>

export interface AppProviderRegistration {
  pluginId: string
  Provider: ProviderComponent
  order: number
}

export interface GlobalComponentRegistration {
  pluginId: string
  id: string
  slot: string
  Component: ComponentType
}

/**
 * 底栏（外壳槽位 `bottomBar`）条目注册项。
 *
 * 为什么不是普通的 globalComponent：底栏是**轮播**（音乐 ⇄ 天气），宿主需要知道
 * 「这一项现在该不该参与轮播」，并且要在可见性变化时知道该重渲染——所以注册项
 * 带 `isVisible()`（宿主每次渲染读取）与 `subscribe()`（插件侧订阅可见性变化）。
 * 外壳只认这个注册表，不 import 任何插件模块。
 */
export interface BottomBarItemRegistration {
  pluginId: string
  id: string
  /** 轮播次序：数值小的在前（音乐 10 在天气之前） */
  order: number
  /** 当前是否参与轮播（宿主每次渲染读取；插件用订阅触发重渲染） */
  isVisible: () => boolean
  /** 订阅可见性变化（可选） */
  subscribe?: (onChange: () => void) => () => void
  /** 底栏那一行（带图标的标题） */
  Tab: ComponentType
  /** 悬停弹层内容 */
  Popup: ComponentType
}

/** 注册表服务：register 返回注销函数（可逆效果），宿主在插件卸载时整组清空 */
export interface RegistryService<T extends { pluginId: string }> {
  register(item: Omit<T, 'pluginId'>): () => void

  getAll(): T[]
}

/** 宿主内置的固定服务键（不可被插件提供） */
export interface HostServices {
  route: RegistryService<RegisteredRoute>
  menu: RegistryService<RegisteredMenuItem>
  settingsSection: RegistryService<SettingsSectionRegistration>
  appProvider: RegistryService<AppProviderRegistration>
  globalComponent: RegistryService<GlobalComponentRegistration>
  /** 底栏插槽：外壳按 order 轮播可见条目（音乐条目由 music 插件填） */
  bottomBar: RegistryService<BottomBarItemRegistration>
  api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> }
  i18n: { addResources: (ns: string, resources: Record<string, unknown>) => void }
  events: {
    on: (channel: string, cb: (data?: unknown) => void) => () => void
    emit: (channel: string, data?: unknown) => void
  }
  /** 插件私有持久化（按插件 id 隔离命名空间） */
  storage: {
    get<T>(key: string): T | null
    set(key: string, value: unknown): void
    remove(key: string): void
  }
}

export type HostServiceKey = keyof HostServices

/** 插件：manifest + install（Cordis 组件三元组在实现层的入口） */
export interface Plugin {
  manifest: PluginManifest

  /** 可逆安装：注册的逆操作进入 ctx.effect 回滚栈；返回值 dispose 最后执行 */
  install(ctx: PluginContext): void | (() => void) | Promise<void | (() => void)>
}
