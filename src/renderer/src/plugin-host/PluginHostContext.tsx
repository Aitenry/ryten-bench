import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from 'react'
import { i18n } from '@renderer/i18n'
import { PluginHost } from './host'
import { declaredMenuIcon } from './declared-icons'
import type {
  AppProviderRegistration,
  BottomBarItemRegistration,
  GlobalComponentRegistration,
  Plugin,
  PluginDeclaration,
  RegisteredMenuItem,
  RegisteredRoute,
  SettingsSectionRegistration
} from './types'
import type { PluginDescriptor, PluginListEntry } from '@shared/plugin/types'

const PluginHostCtx = createContext<PluginHost | null>(null)

interface PluginHostProviderProps {
  plugins: Plugin[]
  /** 启用态覆写：id → 是否启用；缺省 = 停用（应用不分发插件，装进来不等于让它跑） */
  enabledOverride?: Record<string, boolean>
  /**
   * 主进程**同步**插件清单（`api.plugin.listSync()`）。
   * 首帧声明式预注册的元数据来源（`routes`/`menu`），见 `declarationsFromEntries`。
   */
  entries?: PluginListEntry[]
  /** 外部插件 vendor 模块（react/antd 等宿主唯一实例） */
  vendorModules?: Record<string, unknown>
  children: React.ReactNode
}

/**
 * 主进程清单 → 声明式预注册项（只取 `enabled` 的条目）。
 *
 * 为什么：磁盘包插件的渲染模块要 `fetch` + `import` 之后才 `install(ctx)`，首帧侧栏与
 * 路由表里没有它（实测 music 菜单要等几百毫秒才「弹出来」）。清单里的元数据足够先把
 * 菜单/骨架路由放上去，插件模块加载完成后的真实注册按 `key`/`path` 覆盖（见 host 的
 * `declare()`）。
 *
 * 三道过滤，都是为了「只占位、不添乱」：
 * - 只处理 `enabled` 条目（停用插件不该有菜单）；
 * - 字段形状校验：plugin.json 来自磁盘，运行期没有类型校验，脏数据不许进注册表；
 * - `labelKey` 必须**现在就能译出来**（`i18n.exists`）：词条由插件自己在 install 里注册的
 *   外部插件（如某个插件包里的 `demo.menu.title`）此刻还没有词条，声明出去
 *   只会先闪一串原始键名——这类条目等真实注册，不损失什么。
 */
function declarationsFromEntries(
  entries: PluginListEntry[] | undefined
): Array<{ id: string; declaration: PluginDeclaration }> {
  if (!entries || entries.length === 0) return []
  const out: Array<{ id: string; declaration: PluginDeclaration }> = []
  for (const entry of entries) {
    if (!entry.enabled) continue
    const declaration: PluginDeclaration = {}

    const menu = entry.menu
    if (
      menu &&
      typeof menu.key === 'string' &&
      menu.key.length > 0 &&
      typeof menu.labelKey === 'string' &&
      i18n.exists(menu.labelKey)
    ) {
      declaration.menu = {
        key: menu.key,
        labelKey: menu.labelKey,
        icon: declaredMenuIcon(menu.icon),
        order: typeof menu.order === 'number' ? menu.order : undefined
      }
    }

    const routes = (entry.routes ?? []).filter(
      (r) => r && typeof r.path === 'string' && r.path.startsWith('/')
    )
    if (routes.length > 0) {
      declaration.routes = routes.map((r) => ({
        path: r.path,
        skeleton: typeof r.skeleton === 'string' ? r.skeleton : undefined
      }))
    }

    if (declaration.menu || declaration.routes) out.push({ id: entry.id, declaration })
  }
  return out
}

/**
 * 插件宿主根 Provider：
 * - 创建 PluginHost 单例；
 * - 按 enabledOverride 装载插件（未指定 = 停用）；
 * - 用同步清单里的元数据做**首帧声明式预注册**（构造期，早于任何子组件渲染）；
 * - enabledOverride 变化时 diff 式重放（启停即时生效）。
 */
export const PluginHostProvider: React.FC<PluginHostProviderProps> = ({
  plugins,
  enabledOverride,
  entries,
  vendorModules,
  children
}) => {
  // 显式覆写之外的默认值：一律停用
  const enabledMap = useMemo<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {}
    for (const p of plugins) {
      map[p.manifest.id] =
        enabledOverride && p.manifest.id in enabledOverride
          ? Boolean(enabledOverride[p.manifest.id])
          : false
    }
    return map
  }, [plugins, enabledOverride])

  // 宿主随构造期同步预装载默认启用的插件（首帧即注册路由/菜单）
  const hostRef = useRef<PluginHost | null>(null)
  if (!hostRef.current) {
    hostRef.current = new PluginHost(plugins, enabledMap)
    // 首帧声明式预注册（必须在任何子组件渲染之前）：插件渲染模块还在异步加载，
    // 靠这份声明，首帧侧栏/路由表就是完整的。
    for (const d of declarationsFromEntries(entries)) hostRef.current.declare(d.id, d.declaration)
  }
  const host = hostRef.current
  if (vendorModules) host.setVendorModules(vendorModules)

  const enabledJson = JSON.stringify(enabledMap)

  const applyRef = useRef<string>('')
  useEffect(() => {
    // 构造期已同步装载的内置插件在此为 no-op（diff 跳过）；外部插件与
    // 运行期启停（桥重放）走异步 enable/disable
    if (applyRef.current === enabledJson) return
    applyRef.current = enabledJson
    // 应用结果经宿主版本号（useSyncExternalStore 订阅）驱动重渲染，无需额外本地状态
    void host.applyEnabled(enabledMap)
  }, [host, enabledMap, enabledJson])

  return <PluginHostCtx.Provider value={host}>{children}</PluginHostCtx.Provider>
}

export function usePluginHost(): PluginHost {
  const host = useContext(PluginHostCtx)
  if (!host) throw new Error('usePluginHost 必须在 PluginHostProvider 内使用')
  return host
}

/**
 * 订阅宿主版本号：任何注册表变更（启用/停用/注册/注销）都会触发订阅组件重渲染。
 * 各 usePlugin* 钩子读取的注册表数据与版本号在同一渲染周期内一致。
 */
function useHostVersion(): number {
  const host = usePluginHost()
  return useSyncExternalStore(
    (cb) => host.subscribe(cb),
    () => host.version
  )
}

export function usePlugins(): PluginDescriptor[] {
  const host = usePluginHost()
  useHostVersion()
  return host.getDescriptors()
}

export function usePluginRoutes(): RegisteredRoute[] {
  const host = usePluginHost()
  useHostVersion()
  return host.getRoutes()
}

export function usePluginMenus(): RegisteredMenuItem[] {
  const host = usePluginHost()
  useHostVersion()
  return host.getMenus()
}

/** 侧栏合法菜单键集合（AppContent 高亮白名单的注册表驱动版本） */
export function usePluginMenuKeys(): string[] {
  const host = usePluginHost()
  useHostVersion()
  return host.getMenuKeys()
}

export function usePluginSettingsSections(): SettingsSectionRegistration[] {
  const host = usePluginHost()
  useHostVersion()
  return host.getSettingsSections()
}

export function usePluginProviders(): AppProviderRegistration[] {
  const host = usePluginHost()
  useHostVersion()
  return host.getProviders()
}

export function useGlobalComponents(slot: string): GlobalComponentRegistration[] {
  const host = usePluginHost()
  useHostVersion()
  return host.getGlobalComponents(slot)
}

/**
 * 底栏插槽条目（按 order 排序）。
 * 可见性不进注册表：宿主每次渲染读各条目的 `isVisible()`，插件用 `subscribe` 触发重渲染。
 */
export function useBottomBarItems(): BottomBarItemRegistration[] {
  const host = usePluginHost()
  useHostVersion()
  return host.getBottomBarItems()
}

export function useIsPluginEnabled(): (id: string) => boolean {
  const host = usePluginHost()
  useHostVersion()
  return (id: string) => host.isEnabled(id)
}
