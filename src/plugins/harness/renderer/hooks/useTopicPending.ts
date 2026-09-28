import { useEffect, useRef, useState } from 'react'
import { harnessApi } from '../api'

/**
 * 「**当前这条会话**此刻挂起的提问 / 审批」的取数逻辑（三个弹窗共用：通用提问、换模型继续、
 * 沙箱审批）。
 *
 * 为什么不能只靠广播（用户口径 2026-09-28「一直卡住，会被其他的会话占用后，授权也一样，
 * 应该是按会话进行隔离，点击不同会话才显示弹出窗口」）：
 * - 广播只发**一次**——提出提问时用户正在别的会话里，这条提问就永远收不到：
 *   主进程还挂着等回答，工具卡片一直「执行中…」，整轮对话卡死；
 * - 反过来，广播不带会话边界地弹出来，人在 A 会话却弹 B 会话的审批，答案就落到别人身上；
 * - 流结束/出错时无差别 `setPending(null)` 也会把**别的话题**挂起的那一条误关掉。
 *
 * 因此这里只做两件事，且都以**话题**为准：
 * 1. 广播只认当前话题（别的会话的提问不弹，等用户点回去时再拉）；
 * 2. **切话题（含首次挂载）时按话题重新拉一次**——主进程是唯一真源（`getPending(topicId)`），
 *    所以「点击不同会话才显示弹出窗口」自然成立，页面重载也不会丢。
 *
 * 返回当前话题挂起的那一条（没有则 null）与一个 `clear()`（用户刚回写答案/决定后立刻收起，
 * 不必再跑一趟 IPC）。
 */
export function useTopicPending<T extends { topicId: number; requestId: string }>(options: {
  /** 当前显示的话题（null = 空白会话，什么都不弹） */
  currentTopicId: number | null
  /** 主进程按话题取挂起项（唯一真源） */
  fetchPending: (topicId: number) => Promise<T | null>
  /** 新挂起项的广播订阅（返回退订函数） */
  subscribe: (listener: (pending: T) => void) => () => void
  /** 额外过滤（例如通用提问弹窗要忽略 kind='model-recovery' 的那条） */
  accept?: (pending: T) => boolean
}): { pending: T | null; clear: () => void } {
  const { currentTopicId, fetchPending, subscribe, accept } = options
  const [pending, setPending] = useState<T | null>(null)

  // 回调放 ref：三个弹窗传的都是内联箭头函数，进依赖数组会每次渲染都退订/重订
  const fetchRef = useRef(fetchPending)
  fetchRef.current = fetchPending
  const acceptRef = useRef(accept)
  acceptRef.current = accept

  const topicRef = useRef(currentTopicId)
  topicRef.current = currentTopicId

  /** 按话题核对一次（切话题、挂载、当前轮结束都走它） */
  const syncForTopic = (topicId: number | null): void => {
    if (topicId == null) {
      setPending(null)
      return
    }
    void fetchRef
      .current(topicId)
      .then((view) => {
        // 异步回来时用户可能已经切走了：只认「还是同一条会话」的结果
        if (topicRef.current !== topicId) return
        // 拉回来的也要过同一道过滤：否则通用提问弹窗会把「换模型继续」那条抢过去
        // （广播路径过滤了、拉取路径没过滤，两边不一致就会出现重复/错位弹窗）
        if (view && acceptRef.current && !acceptRef.current(view)) {
          setPending(null)
          return
        }
        setPending(view ?? null)
      })
      .catch(() => {
        // 通道不可用（插件停用/重载）时保持现状即可
      })
  }

  // 广播：只认当前话题
  useEffect(
    () =>
      subscribe((view) => {
        if (view.topicId !== topicRef.current) return
        if (acceptRef.current && !acceptRef.current(view)) return
        setPending(view)
      }),
    [subscribe]
  )

  // 切话题 / 首次挂载：拉该话题当前挂起的那一条（没有就清空）
  useEffect(() => {
    syncForTopic(currentTopicId)
  }, [currentTopicId, fetchPending])

  // 当前话题这一轮结束 → 重新核对（提问/审批已随本轮结算，弹窗不该留在屏幕上；
  // 别的会话的流结束与当前弹窗无关——此前无差别清空会把当前会话挂起的提问误关掉）
  useEffect(() => {
    const onSettled = (payload?: { topicId?: number }): void => {
      const settled = typeof payload?.topicId === 'number' ? payload.topicId : null
      if (settled != null && settled !== topicRef.current) return
      syncForTopic(topicRef.current)
    }
    const offDone = harnessApi.harness.onStreamDone(onSettled)
    const offError = harnessApi.harness.onStreamError(onSettled)
    return () => {
      offDone()
      offError()
    }
  }, [])

  return { pending, clear: () => setPending(null) }
}
