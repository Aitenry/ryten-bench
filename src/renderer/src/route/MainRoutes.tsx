import React, { Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import RouteSkeleton from './RouteSkeleton'
import { lazyViewFor } from './lazyViewCache'
import { usePluginRoutes } from '@renderer/plugin-host/PluginHostContext'
import { PluginBoundary } from '@renderer/plugin-host/PluginBoundary'
import { systemRouteViews } from '@renderer/system'
import PluginRepository from '@renderer/pages/PluginRepository'
import PluginDetail from '@renderer/pages/PluginDetail'
import type { RegisteredRoute } from '@renderer/plugin-host/types'

// 路由级代码分割：Harness（含代码编辑器、差异视图等重型依赖）等页面按需加载，
// 首屏只加载首页所需模块，显著缩短主窗口 ready-to-show 时间。
// 各 chunk 会在启动空闲期由 viewPreload 提前加载，切页无需等待。
// 路由表由插件注册表驱动（插件停用 = 路由即时消失），插件的 lazy/Component 二选一。

const PluginRouteView: React.FC<{ route: RegisteredRoute }> = ({ route }) => {
  // lazy 实例必须来自模块级缓存（见 lazyViewCache.ts）：在渲染期新建 lazy 会让
  // 「切到尚未加载的路由」陷入 Suspense 重试死循环，视图永远停在上一页。
  const View = route.load ? lazyViewFor(route.load) : null
  if (View) {
    // 边界放在 Suspense **外面**：chunk 加载失败（文件被删/包没打全）时 Promise 会 reject，
    // Suspense 不接错误，只有错误边界能把「白屏」换成一张可读的卡片 + 停用按钮。
    return (
      <PluginBoundary pluginId={route.pluginId} surface="route">
        <Suspense fallback={<RouteSkeleton variant={route.skeleton ?? 'generic'} />}>
          <View />
        </Suspense>
      </PluginBoundary>
    )
  }
  const Eager = route.Component
  // 既无 load 也无 Component 的分支有两个来源：
  // ① 插件的真实注册没给组件（异常产物）；
  // ② **首帧声明式预注册**的占位路由（宿主按清单 `routes` 元数据登记，等插件渲染模块
  //    加载完成后由真实注册按 path 覆盖，见 plugin-host/host.ts 的 declare()）。
  // ②是常规路径，这里渲染骨架屏而不是空白，正好衔接到真实路由。
  if (!Eager) return <RouteSkeleton variant={route.skeleton ?? 'generic'} />
  return (
    <PluginBoundary pluginId={route.pluginId} surface="route">
      <Eager />
    </PluginBoundary>
  )
}

const MainRoutes: React.FC = () => {
  const routes = usePluginRoutes()

  return (
    <Routes>
      {/* 系统级页面：对话（默认）/ 资料库。harness/notes 已移出插件系统 */}
      <Route path="/" element={<Navigate to="/harness" replace />} />
      {systemRouteViews.map((r) => (
        <Route
          key={r.path}
          path={r.path}
          element={
            <Suspense fallback={<RouteSkeleton variant="generic" />}>
              <r.Component />
            </Suspense>
          }
        />
      ))}
      {/* 系统级插件仓库 */}
      <Route path="/plugins" element={<PluginRepository />} />
      <Route path="/plugins/:pluginId" element={<PluginDetail />} />
      {/* 第三方插件路由（仍由插件宿主注册；不再进入左侧系统导航） */}
      {routes.map((r) => (
        <Route key={r.path} path={r.path} element={<PluginRouteView route={r} />} />
      ))}
      <Route path="*" element={<Navigate to="/harness" replace />} />
    </Routes>
  )
}

export default MainRoutes
