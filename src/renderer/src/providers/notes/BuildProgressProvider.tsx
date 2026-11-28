import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNotification } from '@renderer/hooks/useNotification'
import { useTranslation } from '@renderer/i18n'
import type { TFunction } from 'i18next'
import { notesApi } from '../../api/notes'
import BuildProgress from '../../components/notes/graph/BuildProgress'
import { BuildProgressContext } from './BuildProgressContext'
import {
  OPEN_WIKI_GRAPH_EVENT,
  type BuildProgressNotification,
  type BuildProgressState
} from './build-progress'
import type {
  GraphBuildComplete,
  GraphBuildError,
  GraphBuildProgress
} from '../../../../shared/notes/types'

/**
 * Assembles the build progress notification copy: a module-level pure function that takes `t`
 * from the caller (no hook calls or closure capture inside), so it never needs to appear in the
 * deps of startBuild or the sync effect.
 */
const buildStateToNotification = (
  t: TFunction,
  id: string,
  state: BuildProgressState,
  onClick: () => void
): BuildProgressNotification => ({
  id,
  type: 'build_progress',
  title: state.wikiTitle,
  description: state.completed
    ? t('shell.build.completedSummary', {
        count: state.entityCount,
        entityCount: state.entityCount,
        relationCount: state.relationCount
      })
    : t('shell.build.progressSummary', {
        phase: state.phaseLabel,
        percent: state.overallProgress,
        message: state.message
      }),
  timestamp: Date.now(),
  read: false,
  onClick,
  wikiId: state.wikiId,
  wikiTitle: state.wikiTitle,
  phaseLabel: state.phaseLabel,
  phaseProgress: state.phaseProgress,
  overallProgress: state.overallProgress,
  entityCount: state.entityCount,
  relationCount: state.relationCount,
  message: state.message,
  completed: state.completed,
  minimized: state.minimized
})

/**
 * Graph build progress provider (notes plugin, registered via `ctx.use('appProvider')`).
 *
 * Responsibilities (the plugin is self-contained now that core is finished):
 * - Subscribe to the plugin's **own** three event channels
 *   (`notesApi.graph.onBuildProgress/Complete/Error`), own buildMap, and write progress into
 *   core's notification center;
 * - Render the progress overlay (`components/graph/BuildProgress`) and wrap the subtree in
 *   `BuildProgressContext` so the home page graph view (`GraphView`) can register refresh
 *   callbacks and start builds.
 *
 * Why it lives here and not in the shell: the three `notes:graph-build-*` channels belong to
 * the notes data flow, and the progress overlay is part of notes. The shell only mounts the
 * provider (via SystemProvidersShell in App.tsx).
 *
 * Subscription failures are still swallowed: the renderer may subscribe before the main process
 * registers (`window.api.system.on` only validates the prefix, so with no sender the event never
 * arrives), and an exception escaping useEffect would unmount the whole tree (blank screen).
 */
export const BuildProgressProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [buildMap, setBuildMap] = useState<Map<number, BuildProgressState>>(new Map())
  const refreshCallbacks = useRef<Map<number, Set<() => void>>>(new Map())
  const { addNotification, updateNotification, removeNotification } = useNotification()
  const { t } = useTranslation()

  const subscribeToRefresh = useCallback((wikiId: number, callback: () => void): (() => void) => {
    const callbacks = refreshCallbacks.current.get(wikiId) || new Set()
    callbacks.add(callback)
    refreshCallbacks.current.set(wikiId, callbacks)
    return () => {
      const currentCallbacks = refreshCallbacks.current.get(wikiId)
      if (currentCallbacks) {
        currentCallbacks.delete(callback)
      }
    }
  }, [])

  const restoreBuild = useCallback((wikiId: number): void => {
    setBuildMap((prev) => {
      const next = new Map(prev)
      const state = next.get(wikiId)
      if (state) {
        const updated = { ...state, minimized: false }
        next.set(wikiId, updated)
      }
      return next
    })
  }, [])

  const navigateToGraph = useCallback(
    (wikiId: number): void => {
      /* The original implementation navigated to '/knowledge/graph?wikiId=...', but that route
         no longer exists (after the home page rework the graph became a workspace view) — so
         dispatch an event instead and let the home page NotesView switch the selection */
      window.dispatchEvent(
        new CustomEvent<{ wikiId: number }>(OPEN_WIKI_GRAPH_EVENT, { detail: { wikiId } })
      )
      removeNotification(`build-${wikiId}`)
      setBuildMap((prev) => {
        const next = new Map(prev)
        next.delete(wikiId)
        return next
      })
    },
    [removeNotification]
  )

  const startBuild = useCallback(
    (wikiId: number, wikiTitle: string): void => {
      const state: BuildProgressState = {
        wikiId,
        wikiTitle,
        phase: '',
        phaseLabel: t('shell.build.initializing'),
        phaseProgress: 0,
        overallProgress: 0,
        processedDocs: 0,
        totalDocs: 0,
        processedChunks: 0,
        totalChunks: 0,
        entityCount: 0,
        relationCount: 0,
        message: t('shell.build.initializingMessage'),
        minimized: false,
        completed: false
      }

      setBuildMap((prev) => {
        const next = new Map(prev)
        next.set(wikiId, state)
        return next
      })

      const notifId = `build-${wikiId}`
      addNotification(buildStateToNotification(t, notifId, state, () => restoreBuild(wikiId)))
    },
    [addNotification, restoreBuild, t]
  )

  const handleMinimize = useCallback((wikiId: number): void => {
    setBuildMap((prev) => {
      const next = new Map(prev)
      const state = next.get(wikiId)
      if (state) {
        next.set(wikiId, { ...state, minimized: true })
      }
      return next
    })
  }, [])

  const handleProgress = useCallback(
    (progress: GraphBuildProgress): void => {
      setBuildMap((prev) => {
        const next = new Map(prev)
        const existing = next.get(progress.wikiId)
        const updated: BuildProgressState = {
          wikiId: progress.wikiId,
          wikiTitle: existing?.wikiTitle || t('shell.build.unknownWiki', { id: progress.wikiId }),
          phase: progress.phase,
          phaseLabel: progress.phaseLabel,
          phaseProgress: progress.phaseProgress,
          overallProgress: progress.overallProgress,
          processedDocs: progress.processedDocs,
          totalDocs: progress.totalDocs,
          processedChunks: progress.processedChunks,
          totalChunks: progress.totalChunks,
          entityCount: progress.entityCount,
          relationCount: progress.relationCount,
          message: progress.message,
          minimized: existing?.minimized ?? false,
          completed: existing?.completed ?? false
        }
        next.set(progress.wikiId, updated)
        return next
      })

      if (progress.needsRefresh) {
        const callbacks = refreshCallbacks.current.get(progress.wikiId)
        if (callbacks) {
          callbacks.forEach((callback) => callback())
        }
      }
    },
    [t]
  )

  const handleComplete = useCallback((result: GraphBuildComplete): void => {
    setBuildMap((prev) => {
      const next = new Map(prev)
      const state = next.get(result.wikiId)
      if (state) {
        next.set(result.wikiId, {
          ...state,
          completed: true,
          entityCount: result.entityCount,
          relationCount: result.relationCount,
          overallProgress: 100
        })
      }
      return next
    })
  }, [])

  const handleError = useCallback(
    (error: GraphBuildError): void => {
      removeNotification(`build-${error.wikiId}`)
      setBuildMap((prev) => {
        const next = new Map(prev)
        next.delete(error.wikiId)
        return next
      })
    },
    [removeNotification]
  )

  /**
   * Keep the event callbacks in a ref: subscriptions are established once on mount instead of
   * being torn down and re-created for each render's fresh functions, and the callback closure
   * does not freeze at the first render (notification copy picks up the latest `t` after a
   * language switch).
   */
  const handlersRef = useRef({ handleProgress, handleComplete, handleError })
  handlersRef.current = { handleProgress, handleComplete, handleError }

  /**
   * Subscribe to the notes graph build events (main process -> renderer).
   *
   * Subscribes via `window.api.system.on('notes:graph-build-*')` (prefix validation, no
   * allowlist); still wrapped in try/catch degrading to "no progress events" so an exception
   * never escapes useEffect (that would unmount the whole tree and blank the screen).
   */
  useEffect(() => {
    const subscribeProgress = (): (() => void) => {
      try {
        return notesApi.graph.onBuildProgress((payload) =>
          handlersRef.current.handleProgress(payload)
        )
      } catch (error) {
        console.warn('[BuildProgress] Failed to subscribe to graph-build-progress, degraded to idle:', error)
        return () => {}
      }
    }
    const subscribeComplete = (): (() => void) => {
      try {
        return notesApi.graph.onBuildComplete((payload) =>
          handlersRef.current.handleComplete(payload)
        )
      } catch (error) {
        console.warn('[BuildProgress] Failed to subscribe to graph-build-complete, degraded to idle:', error)
        return () => {}
      }
    }
    const subscribeError = (): (() => void) => {
      try {
        return notesApi.graph.onBuildError((payload) => handlersRef.current.handleError(payload))
      } catch (error) {
        console.warn('[BuildProgress] Failed to subscribe to graph-build-error, degraded to idle:', error)
        return () => {}
      }
    }

    const cleanupProgress = subscribeProgress()
    const cleanupComplete = subscribeComplete()
    const cleanupError = subscribeError()

    return () => {
      cleanupProgress()
      cleanupComplete()
      cleanupError()
    }
  }, [])

  // Sync buildMap changes to the notification system
  useEffect(() => {
    buildMap.forEach((state, wikiId) => {
      const notifId = `build-${wikiId}`
      // Fix: clicking a completed build notification used to "restore" a completed state that
      // would never render again, with no feedback, and the notification was never cleaned up —
      // completed builds now jump straight to that wiki's graph (navigateToGraph removes both
      // the notification and the state)
      updateNotification(
        notifId,
        buildStateToNotification(t, notifId, state, () =>
          state.completed ? navigateToGraph(wikiId) : restoreBuild(wikiId)
        )
      )
    })
  }, [buildMap, updateNotification, restoreBuild, navigateToGraph, t])

  /**
   * Unmounting means "disable notes": remove the progress notifications this plugin wrote into
   * the notification center.
   *
   * The notification center is a core service with its state in core; once the provider
   * unmounts nothing updates these notifications any more, so keeping them would leave a dead
   * entry stuck at the old percentage. The build state itself disappears with the provider
   * (disabling a plugin means unmounting its content, which is the intended semantics).
   */
  const notificationIds = useRef<Set<string>>(new Set())
  useEffect(() => {
    const ids = notificationIds.current
    const callbacks = refreshCallbacks.current
    for (const wikiId of buildMap.keys()) ids.add(`build-${wikiId}`)
    return () => {
      for (const notifId of ids) {
        try {
          removeNotification(notifId)
        } catch {
          // Ignore when the notification center is already unmounted (app quitting)
        }
      }
      ids.clear()
      callbacks.clear()
    }
    // Clean up only on unmount: re-running when buildMap changes would delete in-flight build
    // notifications
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activeBuilds = Array.from(buildMap.values())

  return (
    <BuildProgressContext.Provider
      value={{
        builds: activeBuilds,
        startBuild,
        restoreBuild,
        minimizeBuild: handleMinimize,
        navigateToGraph,
        subscribeToRefresh
      }}
    >
      {children}
      {activeBuilds
        .filter((state) => !state.completed)
        .map((state) => (
          <BuildProgress
            key={state.wikiId}
            open={!state.minimized}
            wikiId={state.wikiId}
            wikiTitle={state.wikiTitle}
            phaseLabel={state.phaseLabel}
            phaseProgress={state.phaseProgress}
            overallProgress={state.overallProgress}
            processedDocs={state.processedDocs}
            totalDocs={state.totalDocs}
            processedChunks={state.processedChunks}
            totalChunks={state.totalChunks}
            entityCount={state.entityCount}
            relationCount={state.relationCount}
            message={state.message}
            onMinimize={() => handleMinimize(state.wikiId)}
          />
        ))}
    </BuildProgressContext.Provider>
  )
}

export default BuildProgressProvider
