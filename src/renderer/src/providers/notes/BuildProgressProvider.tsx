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
 * 构建进度通知的文案组装：模块级纯函数，`t` 由调用方注入（内部不调 hook、不闭包引用），
 * 因此 startBuild / 同步 effect 的依赖里不需要出现它。
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
 * 图谱构建进度 Provider（notes 插件，经 `ctx.use('appProvider')` 注册）。
 *
 * 职责（core 收尾后本插件自包含）：
 * - 订阅**本插件自己的**三个事件通道（`notesApi.graph.onBuildProgress/Complete/Error`），
 *   持有 buildMap，并把进度写进 core 的通知中心；
 * - 渲染进度浮层（`components/graph/BuildProgress`），并在外层包 `BuildProgressContext`，
 *   供首页的图谱视图（`GraphView`）注册刷新回调与发起构建。
 *
 * 为什么放在这里而不是 shell：这三个 `notes:graph-build-*` 通道属于资料库自己的数据流，
 * 进度浮层是资料库的一部分。外壳只负责把 Provider 挂上（见 App.tsx 的 SystemProvidersShell）。
 *
 * 订阅失败仍要吞掉：渲染层首次订阅可能早于主进程注册（`window.api.system.on` 只做前缀校验，
 * 没有发送方时永远收不到事件），异常若从 useEffect 逃逸会卸载整棵树（白屏）。
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
      /* 原实现 navigate('/knowledge/graph?wikiId=...')，但该路由早已不存在
         （首页重构后图谱改为工作台视图）——改为派发事件，由首页 NotesView 切换选中 */
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
   * 事件回调进 ref：订阅只在挂载时建立一次，不因每次渲染的新函数反复退订重订，
   * 同时避免回调闭包停在首次渲染（语言切换后通知文案仍取最新 `t`）。
   */
  const handlersRef = useRef({ handleProgress, handleComplete, handleError })
  handlersRef.current = { handleProgress, handleComplete, handleError }

  /**
   * 订阅资料库的构建事件（主进程 → 渲染层）。
   *
   * 经 `window.api.system.on('notes:graph-build-*')` 订阅（前缀校验，无白名单）；
   * 仍统一 try/catch 降级为「没有进度事件」，绝不让异常从 useEffect 逃逸
   * （那会卸载整棵树 → 白屏）。
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

  // 同步 buildMap 变更到通知系统
  useEffect(() => {
    buildMap.forEach((state, wikiId) => {
      const notifId = `build-${wikiId}`
      // 修复：已完成的构建通知点击后是「恢复一个不会再渲染的 completed 状态」= 无任何反馈
      // 且通知永不清理——完成态改为直达该知识库图谱（navigateToGraph 会移除通知与状态）
      updateNotification(
        notifId,
        buildStateToNotification(t, notifId, state, () =>
          state.completed ? navigateToGraph(wikiId) : restoreBuild(wikiId)
        )
      )
    })
  }, [buildMap, updateNotification, restoreBuild, navigateToGraph, t])

  /**
   * 卸载即「停用 notes」：把本插件写进通知中心的进度通知摘掉。
   *
   * 通知中心是 core 服务、状态在 core 里；Provider 卸载后没人再更新这些通知，
   * 留着就是一条永远停在旧百分比的死通知。构建状态本身随 Provider 一起消失
   * （停用插件 = 卸载它的内容，这是设计语义）。
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
          // 通知中心已卸载（应用退出）时忽略
        }
      }
      ids.clear()
      callbacks.clear()
    }
    // 仅在卸载时清理：buildMap 变化时重跑会把正在构建的通知误删
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
