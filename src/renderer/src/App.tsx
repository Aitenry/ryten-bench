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
import { HarnessProvider } from '@renderer/contexts/harness/HarnessContext'
import BuildProgressProvider from '@renderer/providers/notes/BuildProgressProvider'
import SystemEffects from '@renderer/components/system/SystemEffects'
import { LatticeProvider } from '@renderer/lattice/LatticeContext'

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

/**
 * 系统功能 Provider 层（AI 助手 / 资料库）。
 *
 * 它们不是插件、没有启用态，必须常驻包裹外壳与页面：
 * HarnessProvider 在外层（会话/话题状态），BuildProgressProvider 在内层（图谱构建进度）。
 * 顺序写死在这里，因为这是壳的装配顺序，不再是可注册的运行时表。
 */
const SystemProvidersShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <HarnessProvider>
    <BuildProgressProvider>{children}</BuildProgressProvider>
  </HarnessProvider>
)

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

        // 1) 处置：① 主进程清单里已不在（卸载 / 目录被删）→ forgetPlugin；
        //    ② **只是被停用** → disable（保留登记，重启用走宿主的 enable() 重新 install）。
        //
        //    ①为什么必须用 forgetPlugin：把登记摘掉，第 2 步才会用**磁盘上的新包**重新
        //    fetch + install；光靠 applyEnabled 的 diff 做不到（它只处理清单里出现过的 id）。
        const liveIds = new Set(list.map((e) => e.id))
        for (const descriptor of host.getDescriptors()) {
          const id = descriptor.manifest.id
          const entry = list.find((e) => e.id === id)
          if (!liveIds.has(id) || !entry) {
            await host
              .forgetPlugin(id)
              .catch((err) => console.error(`[plugins] Failed to remove plugin: ${id}`, err))
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
              .catch((err) => console.error(`[plugins] Failed to reload plugin: ${id}`, err))
            continue
          }
          if (!entry.enabled) {
            await host
              .disable(id)
              .catch((err) => console.error(`[plugins] Failed to disable plugin: ${id}`, err))
          }
        }

        // 2) 加载：清单里启用但尚未登记的插件渲染模块。
        //    磁盘包插件的渲染入口一律是 `plugin://<id>/renderer.mjs`（+ 宿主 UI 桥）。
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
              entry: e.entry
            })
            if (!disposed) host.addExternal(plugin)
            if (!disposed) loadedStamps.current.set(e.id, e.stamp ?? '')
          } catch (err) {
            console.error(`[plugins] Plugin '${e.id}' failed to load renderer module:`, err)
          }
        }

        // 3) 统一应用启用态（已登记的全部插件；未登记的 id 由宿主跳过）
        const map: Record<string, boolean> = {}
        for (const entry of list) map[entry.id] = entry.enabled
        await host.applyEnabled(map)
      } catch (err) {
        console.error('[plugins] Failed to sync enabled state:', err)
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
   * 首帧权威清单：应用里没有静态插件，插件都要等渲染模块从 `plugin://<id>/renderer.mjs`
   * 加载完才真实注册。因此必须在**构造宿主的同一时机**拿到主进程的清单：
   * - 元数据（`routes`/`menu`）：宿主据此**首帧声明式预注册**菜单与路由，否则首帧侧栏
   *   空着、点菜单还会导航到空路由（见 plugin-host/host.ts 的 declare()）；
   * - 启用态由 `PluginStateBridge` 在渲染模块加载完成后统一应用。
   * 取不到时返回 null，各消费点退回「无声明、无初始插件」（随后仍由异步清单装载）。
   */
  const syncEntries = useMemo<PluginListEntry[] | null>(() => {
    try {
      const list = window.api.plugin.listSync()
      return Array.isArray(list) ? list : null
    } catch (err) {
      console.warn('[plugins] Failed to sync plugin manifest, loading with default enabled state:', err)
      return null
    }
  }, [])

  /**
   * 交给宿主的**初始**插件集合：恒为空数组。
   *
   * 应用里没有任何插件代码的静态 import：全部由下面的 PluginStateBridge 从
   * `plugin://<id>/renderer.mjs` 加载；首帧的菜单/路由由清单元数据的**声明式预注册**撑住
   * （见 plugin-host/host.ts 的 declare 与上面的 syncEntries）。
   */
  const initialPlugins = useMemo<Plugin[]>(() => [], [])

  return (
    <HashRouter>
      {/* 全局错误边界：渲染错误不再让整个应用白屏死掉，而是给出可恢复的提示卡 */}
      <AppErrorBoundary>
        {/*
          插件中心（Lattice）状态挂在外壳之上：侧栏账号区、登录页、插件仓库页与插件详情页
          共享同一份 status / 同步状态 / 上传进度。主进程通道缺失时 Provider 自身安全降级，
          不会阻塞应用其余部分。
        */}
        <LatticeProvider>
          {/* 插件宿主根：插件按启用态装载，路由/菜单/设置页/Provider 全部注册表驱动 */}
          <PluginHostProvider
            plugins={initialPlugins}
            entries={syncEntries ?? undefined}
            vendorModules={vendorModules}
          >
            <PluginStateBridge>
              <CoreProviders>
                <SystemProvidersShell>
                  <SystemEffects />
                  <PluginProvidersShell>
                    <AppContent />
                  </PluginProvidersShell>
                  {/* 设置弹窗挂在插件 Provider 链之外：插件启停不会重建它（详见 SettingsHost.tsx） */}
                  <SettingsHost />
                </SystemProvidersShell>
              </CoreProviders>
            </PluginStateBridge>
          </PluginHostProvider>
        </LatticeProvider>
      </AppErrorBoundary>
    </HashRouter>
  )
}

export default App
