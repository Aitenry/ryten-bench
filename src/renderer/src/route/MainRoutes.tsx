import React, { Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import RouteSkeleton from './RouteSkeleton'
import { lazyViewFor } from './lazyViewCache'
import { usePluginRoutes } from '@renderer/plugin-host/PluginHostContext'
import { PluginBoundary } from '@renderer/plugin-host/PluginBoundary'
import PluginRepository from '@renderer/pages/PluginRepository'
import PluginDetail from '@renderer/pages/PluginDetail'
import Login from '@renderer/pages/Login'
import type { RegisteredRoute } from '@renderer/plugin-host/types'

// Route-level code splitting: the AI assistant (which pulls in heavy deps such as the code
// editor and diff view) and notes load on demand, so the first screen only loads the modules
// the current page needs, noticeably shortening the main window's ready-to-show time.
// System routes are static (they do not change as plugins are enabled or disabled); third-party
// plugin routes are still driven by the plugin registry.

/** System pages (module-level lazy: never create lazy during render or Suspense retries forever) */
const HarnessView = lazy(() => import('@renderer/pages/Harness'))
const NotesView = lazy(() => import('@renderer/pages/Notes'))
const MoreView = lazy(() => import('@renderer/pages/More'))
const SchedulesView = lazy(() => import('@renderer/pages/Schedules'))

const PluginRouteView: React.FC<{ route: RegisteredRoute }> = ({ route }) => {
  // The lazy instance must come from the module-level cache (see lazyViewCache.ts): creating
  // lazy during render traps "navigating to a not-yet-loaded route" in an endless Suspense
  // retry loop, leaving the view stuck on the previous page.
  const View = route.load ? lazyViewFor(route.load) : null
  if (View) {
    // The boundary goes **outside** Suspense: when the chunk fails to load (file deleted /
    // incomplete bundle) the promise rejects, and Suspense does not catch errors — only an
    // error boundary can turn the blank screen into a readable card with a disable button.
    return (
      <PluginBoundary pluginId={route.pluginId} surface="route">
        <Suspense fallback={<RouteSkeleton variant={route.skeleton ?? 'generic'} />}>
          <View />
        </Suspense>
      </PluginBoundary>
    )
  }
  const Eager = route.Component
  // The branch with neither load nor Component has two sources:
  // 1) the plugin's real registration provided no component (an anomaly);
  // 2) a placeholder route from **first-frame declarative pre-registration** (the host registers
  //    it from the manifest's `routes` metadata, and once the plugin's render module loads the
  //    real registration overrides it by path — see declare() in plugin-host/host.ts).
  // Case 2 is the normal path; render a skeleton instead of a blank area so it hands over
  // cleanly to the real route.
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
      {/* System pages: chat (default) / notes. Compiled with the app, unaffected by plugin enable/disable */}
      <Route path="/" element={<Navigate to="/harness" replace />} />
      <Route
        path="/harness"
        element={
          <Suspense fallback={<RouteSkeleton variant="generic" />}>
            <HarnessView />
          </Suspense>
        }
      />
      <Route
        path="/notes"
        element={
          <Suspense fallback={<RouteSkeleton variant="generic" />}>
            <NotesView />
          </Suspense>
        }
      />
      {/* Schedules standalone page (below "Plugin Repository" in the sidebar) */}
      <Route
        path="/schedules"
        element={
          <Suspense fallback={<RouteSkeleton variant="generic" />}>
            <SchedulesView />
          </Suspense>
        }
      />
      {/* Login page: full-window standalone layout (the shell renders /login separately in AppShell without the sidebar) */}
      <Route path="/login" element={<Login />} />
      {/* System-level plugin repository */}
      <Route path="/plugins" element={<PluginRepository />} />
      <Route path="/plugins/:pluginId" element={<PluginDetail />} />
      {/* More (settings page): the sidebar entry is below the plugin repository; /more/:tab lands directly on one page */}
      <Route
        path="/more"
        element={
          <Suspense fallback={<RouteSkeleton variant="generic" />}>
            <MoreView />
          </Suspense>
        }
      />
      <Route
        path="/more/:tab"
        element={
          <Suspense fallback={<RouteSkeleton variant="generic" />}>
            <MoreView />
          </Suspense>
        }
      />
      {/* Third-party plugin routes (still registered by the plugin host; no longer part of the left system navigation) */}
      {routes.map((r) => (
        <Route key={r.path} path={r.path} element={<PluginRouteView route={r} />} />
      ))}
      <Route path="*" element={<Navigate to="/harness" replace />} />
    </Routes>
  )
}

export default MainRoutes
