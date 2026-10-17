import React, { useEffect, useMemo, useRef } from 'react'
import { HashRouter } from 'react-router-dom'
import { MessageContext } from '@renderer/contexts/MessageContext'
import { NotificationProvider } from '@renderer/contexts/NotificationContext'
import { composeProviders } from '@renderer/utils/composeProviders'
import AppContent from '@renderer/components/system/AppContent'
import AppErrorBoundary from '@renderer/components/system/AppErrorBoundary'
import SettingsHost from '@renderer/components/system/settings/SettingsHost'
import {
  PluginHostProvider,
  usePluginHost,
  usePluginProviders
} from '@renderer/plugin-host/PluginHostContext'
import type { Plugin } from '@renderer/plugin-host/types'
import type { PluginListEntry } from '@shared/plugin/types'
import { vendorModules } from '@renderer/plugin-host/host-ui'
import { loadExternalPlugin } from '@renderer/plugin-host/external-loader'
import { PluginBoundary } from '@renderer/plugin-host/PluginBoundary'

// shell 常驻 Provider（插件系统之外的应用骨架层）。
// 插件自己的 Provider（如音乐播放器的 AudioProvider、首页的图谱构建进度）随插件注册，
// 见 PluginProvidersShell：停用插件 = 连它的状态一起卸载，外壳组件不再持有任何插件状态。
const CoreProviders = composeProviders(
  [
    MessageContext.Provider,
    {
      value: {
        viewMessage: () => {}
      }
    }
  ],
  [NotificationProvider]
)

// 插件 Provider 层：模块级稳定组件，直接内联嵌套渲染插件注册的 Provider。
// 关键约束：绝不能动态组合出新组件类型——此前 useMemo(composeProviders(...)) 在宿主
// 每次状态 bump 时生成新组件类型，导致 AppContent/CustomFrame 整棵子树卸载重挂，
// settingsOpen/currentKey 等本地状态被清空，表现为「设置/菜单点击失效」。
// 这里 p.Provider 是插件导出的稳定组件引用，宿主版本变化只触发重渲染（同类型调和），
// 不重挂载；启用/停用插件时 Provider 增删本身即期望的重构。
const PluginProvidersShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const pluginProviders = usePluginProviders()
  // 每个 Provider 各自一层边界：某个插件的 Provider 在渲染期抛错时，只跳过它自己，
  // 它包着的子树（fallback = 同一棵子树）照常渲染——不能因为一个 Provider 坏掉就让
  // 整个 AppContent 变成一张错误卡片。三者的组合顺序与嵌套关系保持不变。
  const nested = pluginProviders.reduceRight(
    (acc, p) => (
      <PluginBoundary
        key={p.pluginId}
        pluginId={p.pluginId}
        surface="provider"
        quiet
        fallback={acc}
      >
        <p.Provider>{acc}</p.Provider>
      </PluginBoundary>
    ),
    children
  )
  return <>{nested}</>
}

// 启用态同步桥：主进程 plugins-list 是持久化真源；
// 桥负责三件事：移除已消失/停用的插件（含「被物理卸载」）→ 加载已启用的插件渲染模块 →
// 把清单 diff 应用到宿主（装载/卸载），并订阅启停广播即时重放。
const PluginStateBridge: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const host = usePluginHost()
  /**
   * 已装载插件各自的**包内容戳**（`PluginListEntry.stamp`）。
   *
   * 为什么需要它：主进程换了磁盘上的包（升级/重装/重新安装）后，渲染层必须重新
   * `fetch('plugin://<id>/renderer.mjs')` 并重新注入 `plugin.css`；只看「id 已登记」
   * 会跳过重载，用户看到的还是旧界面（2026-09-26 实测：升级后样式与界面都不更新）。
   */
  const loadedStamps = useRef(new Map<string, string>())
  useEffect(() => {
    let disposed = false
    const sync = async (): Promise<void> => {
      try {
        const list = await window.api.plugin.list()
        if (disposed) return

        // 1) 处置：① 主进程清单里已不在（第三方被卸载 / 目录被删）或已不是「已安装」状态
        //    （内置插件物理卸载）→ forgetPlugin；② **只是被停用** → disable（保留登记）。
        //
        //    ①为什么不能用 host.removeExternal：它对 builtin 插件直接 return，而被卸载的
        //    内置插件（例如 music）仍带着 builtin=true 留在静态注册表里，不移除就会留下
        //    一个「菜单/路由还在、主进程通道已没了」的僵尸插件。
        //
        //    ②为什么不能也用 forgetPlugin（2026-09-26 实测）：停用**静态回退**的内置插件
        //    （P4 之后只剩「dev 没跑打包脚本」这一种情况）一旦把登记摘掉，重新启用时第 2 步
        //    会去 `plugin://<id>/renderer.js` 取渲染模块——那个文件根本不存在，于是插件永远回不来
        //    （现象：工装「重新启用 notes」等到超时，菜单不再出现）。停用是可逆的，登记必须留着，
        //    重启用走宿主的 enable() 重新 install。
        const liveIds = new Set(list.map((e) => e.id))
        for (const descriptor of host.getDescriptors()) {
          const id = descriptor.manifest.id
          const entry = list.find((e) => e.id === id)
          if (!liveIds.has(id) || !entry || entry.installed === false) {
            await host
              .forgetPlugin(id)
              .catch((err) => console.error(`[plugins] 插件移除失败: ${id}`, err))
            continue
          }
          // ③ 包换了（升级 / 重装 / 面板里的「重新安装」）：内容戳或版本与登记里的不一致
          //    → 摘掉登记，下面的加载循环会用**磁盘上新的包**重新 fetch + install
          //    （新 renderer.mjs、新 plugin.css；不这么做用户升完级看到的还是旧界面）。
          const stamp = entry.stamp ?? ''
          const loadedStamp = loadedStamps.current.get(id)
          if (
            (loadedStamp !== undefined && loadedStamp !== stamp) ||
            (entry.version && descriptor.manifest.version !== entry.version)
          ) {
            loadedStamps.current.delete(id)
            await host
              .forgetPlugin(id)
              .catch((err) => console.error(`[plugins] 插件重新装载失败: ${id}`, err))
            continue
          }
          if (!entry.enabled) {
            await host
              .disable(id)
              .catch((err) => console.error(`[plugins] 插件停用失败: ${id}`, err))
          }
        }

        // 2) 加载：清单里启用但尚未登记的插件渲染模块。
        //    注意条件里没有 `e.builtin` ——P1 起内置插件也是磁盘包（`plugin://<id>/renderer.mjs`
        //    + 宿主 UI 桥），与第三方插件走完全相同的加载路径；尚未搬走、仍靠静态回退的插件
        //    已经在静态注册表里登记过，会因 `getDescriptor` 命中而被跳过。
        for (const e of list) {
          if (!e.enabled) continue
          if (host.getDescriptor(e.id)) continue
          try {
            const plugin = await loadExternalPlugin({
              id: e.id,
              name: e.name,
              version: e.version,
              description: e.description,
              icon: e.icon,
              builtin: Boolean(e.builtin),
              entry: e.entry
            })
            if (!disposed) host.addExternal(plugin)
            if (!disposed) loadedStamps.current.set(e.id, e.stamp ?? '')
          } catch (err) {
            console.error(`[plugins] 插件 '${e.id}' 渲染模块加载失败:`, err)
          }
        }

        // 3) 统一应用启用态（已登记的全部插件；未登记的 id 由宿主跳过）
        const map: Record<string, boolean> = {}
        for (const entry of list) map[entry.id] = entry.enabled
        await host.applyEnabled(map)
      } catch (err) {
        console.error('[plugins] 启用态同步失败:', err)
      }
    }
    void sync()
    const unsub = window.api.plugin.onStateChanged(() => {
      void sync()
    })
    return () => {
      disposed = true
      unsub()
    }
  }, [host])
  return <>{children}</>
}

const App: React.FC = () => {
  /**
   * 首帧权威清单：P5 起应用里没有静态插件，四个内置插件与第三方插件一样要等渲染模块
   * 从 `plugin://<id>/renderer.mjs` 加载完才真实注册。因此必须在**构造宿主的同一时机**
   * 拿到主进程的权威启用态与元数据：
   * - 启用态：只声明/装载用户启用的插件，避免「先按默认值全装一遍再异步卸载」——
   *   那样被停用插件的 Provider 会短暂挂载并订阅事件通道，而主进程并没有它的通道
   *   （2026-09-26 事故：整页 RUNTIME ERROR / 插件通道未启用: plugin:music:play-track）。
   * - 元数据（`routes`/`menu`）：宿主据此**首帧声明式预注册**菜单与路由，否则首帧侧栏
   *   空着、点菜单还会导航到空路由（见 plugin-host/host.ts 的 declare()）。
   * 取不到时返回 null，各消费点退回「无声明、无初始插件」（随后仍由异步清单装载）。
   */
  const syncEntries = useMemo<PluginListEntry[] | null>(() => {
    try {
      const list = window.api.plugin.listSync()
      return Array.isArray(list) ? list : null
    } catch (err) {
      console.warn('[plugins] 同步插件清单失败，按默认启用态装载:', err)
      return null
    }
  }, [])

  const initialEnabled = useMemo<Record<string, boolean> | undefined>(() => {
    if (!syncEntries || syncEntries.length === 0) return undefined
    const map: Record<string, boolean> = {}
    for (const entry of syncEntries) {
      if (entry.builtin) map[entry.id] = entry.enabled
    }
    return Object.keys(map).length > 0 ? map : undefined
  }, [syncEntries])

  /**
   * 交给宿主的**初始**插件集合：P5 起是空数组。
   *
   * 以前这里是应用内静态 import 的四个内置插件（`@plugins/<id>/renderer/plugin`），
   * 磁盘包那条链路只负责「排除已被包接管的」。现在应用里没有任何插件代码的静态 import，
   * 四个内置插件与第三方插件一样，全部由下面的 PluginStateBridge 从
   * `plugin://<id>/renderer.mjs` 加载；首帧的菜单/路由由清单元数据的**声明式预注册**撑住
   * （见 plugin-host/host.ts 的 declare 与 App 下面第一段 useMemo）。
   */
  const initialPlugins = useMemo<Plugin[]>(() => [], [])

  return (
    <HashRouter>
      {/* 全局错误边界：渲染错误不再让整个应用白屏死掉，而是给出可恢复的提示卡 */}
      <AppErrorBoundary>
        {/* 插件宿主根：插件按启用态装载，路由/菜单/设置页/Provider 全部注册表驱动 */}
        <PluginHostProvider
          plugins={initialPlugins}
          entries={syncEntries ?? undefined}
          vendorModules={vendorModules}
          enabledOverride={initialEnabled}
        >
          <PluginStateBridge>
            <CoreProviders>
              <PluginProvidersShell>
                <AppContent />
              </PluginProvidersShell>
              {/* 设置弹窗挂在插件 Provider 链之外：插件启停不会重建它（详见 SettingsHost.tsx） */}
              <SettingsHost />
            </CoreProviders>
          </PluginStateBridge>
        </PluginHostProvider>
      </AppErrorBoundary>
    </HashRouter>
  )
}

export default App
