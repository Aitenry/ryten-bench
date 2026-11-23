import { useCallback, useEffect, useRef, useState } from 'react'
import { harnessApi } from '../../api/harness'

/**
 * 会话运行状态（侧栏行首那个 16px 指示槽）里流之外的两端状态。
 *
 * 用户口径 2026-11-23（原话）：「当前这个是在进行中的图标，当需要用户继续确认操作时，
 * 这个图标需要变成黄色的点在呼吸，当用户确认之后，这个图标要变成进行中；当任务完成时，
 * 需要将进行中，变成绿色的点在呼吸，当用户点击这个会话时，这个绿色的点会消失。」
 *
 * 三种状态各自的真源刻意分开：
 * - **进行中**不在这里：那是 `useHarnessHandlers` 的 `loadingTopicIds`（主进程流的生命周期）；
 * - **等待确认**（黄）：主进程在提问 / 审批挂起与结算时各广播一次（`harness-topic-pending`），
 *   本 hook 只记「哪些话题正挂着」；
 * - **刚完成**（绿）：一轮**自然跑完**时点亮（`turnFinal.settled`），用户点开这条会话时熄灭；
 *   **跑完时正显示在对话窗口里的那条不点亮**——用户口径 2026-11-23「如果当前是这个会话窗口，
 *   任务完成后自动移除」，人就在屏幕前看着结果出来，再挂一个绿点只是噪音。
 *
 * 为什么不从 loadingTopicIds 的消失推「完成」：一轮的结束有三种（自然跑完 / 用户停止 /
 * 模型失败），loading 消失时三种长得一模一样；用户要的绿点只属于**真的干完了**那一种，
 * 所以判据用主进程随 done 事件下发的 turnFinal，而不是前端猜。
 *
 * 绿点也**不落盘**：它是「这条会话你还没看过」的临时提示，关掉应用就没有意义；
 * 重启后所有会话都从「没在跑、没等人、没新结果」的安静态开始。
 */

/** 两个标记的集合形态（行首按 topicId 查） */
export interface TopicRunStatusMarks {
  /** 正挂着提问 / 审批、等用户确认的会话 */
  awaitingTopicIds: Set<number>
  /** 刚自然跑完、且跑完时不在对话窗口里的会话（绿点） */
  completedTopicIds: Set<number>
}

export interface TopicRunStatusOptions {
  /**
   * 这条会话此刻是不是就显示在对话窗口里（= 当前会话）。
   *
   * 是的话，它跑完时不点亮绿点（等同「完成后自动移除」）；必须是函数而不是快照值：
   * 一轮可能跑很久，完成那一刻人在哪条会话里由 ref 现取，不能用渲染时捕获的旧值。
   */
  isTopicActive?: (topicId: number) => boolean
}

/** 会话行行首指示器的四种外观（值也写进 DOM 的 data-topic-status，工装按它断言） */
export type TopicRunStatus = 'idle' | 'running' | 'awaiting' | 'completed'

/**
 * 三个来源合成行首的最终状态（优先级就是用户口径里的顺序）：
 *
 * 1. `awaiting`（黄点呼吸）——挂着提问 / 审批时流程是**停**的、等的是人，比「在跑」更该被看见；
 * 2. `running`（追逐点）——主进程的流在跑；
 * 3. `completed`（绿点呼吸）——自然跑完且还没被点开；
 * 4. `idle`——行首 16px 槽位留空。
 */
export function resolveTopicRunStatus(input: {
  awaiting: boolean
  running: boolean
  completed: boolean
}): TopicRunStatus {
  if (input.awaiting) return 'awaiting'
  if (input.running) return 'running'
  if (input.completed) return 'completed'
  return 'idle'
}

export interface TopicRunStatusApi extends TopicRunStatusMarks {
  /** 新一轮开始（用户发送 / 目标续跑）：清掉这条会话的黄点与绿点，回到「进行中」 */
  beginTopicTurn: (topicId: number) => void
  /** 用户点开了这条会话：绿点消失（黄点不动——那是「还在等你」，不该被看一眼就抹掉） */
  acknowledgeTopic: (topicId: number) => void
  /** 会话被删除：两个标记一起清，避免 id 复用时错标到别的会话上 */
  forgetTopic: (topicId: number) => void
}

/**
 * 往 Set 里加/删一个 id，**值没变时返回原集合**。
 *
 * 流式期间 done / error 事件可能重复到达（多监听器、插话切段），每次都 new Set 会让
 * 整个侧栏跟着重渲染；这里用同一个 Set 引用短路掉无变化的更新。
 */
function withFlag(set: Set<number>, topicId: number, present: boolean): Set<number> {
  if (set.has(topicId) === present) return set
  const next = new Set(set)
  if (present) next.add(topicId)
  else next.delete(topicId)
  return next
}

export function useTopicRunStatus(options: TopicRunStatusOptions = {}): TopicRunStatusApi {
  const [awaitingTopicIds, setAwaitingTopicIds] = useState<Set<number>>(() => new Set())
  const [completedTopicIds, setCompletedTopicIds] = useState<Set<number>>(() => new Set())

  // 「当前是哪条会话」放 ref：完成事件到达时要的是**那一刻**的窗口内容，
  // 不能用渲染时捕获的旧值（一轮可能跑几分钟，期间人可能已经切走或切回来）
  const isTopicActiveRef = useRef(options.isTopicActive)
  isTopicActiveRef.current = options.isTopicActive

  // 常驻订阅（不随当前话题变化）：别的会话在挂起 / 跑完时，那一条行首也要跟着变。
  // 三个通道都是 Set 分发，与 useTopicPending 的弹窗订阅、每轮的流订阅互不影响。
  useEffect(() => {
    const api = harnessApi.harness
    const offPending = api.onTopicPending(({ topicId, pending }) => {
      if (!Number.isFinite(topicId) || topicId <= 0) return
      setAwaitingTopicIds((prev) => withFlag(prev, topicId, pending))
      // 又在等人了 = 上一轮的「刚完成」已经被新一轮盖过，绿点不该还亮着
      if (pending) setCompletedTopicIds((prev) => withFlag(prev, topicId, false))
    })

    const offDone = api.onStreamDone((result) => {
      const topicId = result.topicId
      if (!Number.isFinite(topicId) || topicId <= 0) return
      // 本轮已收尾：无论怎么结束，都不可能再挂着等确认的东西
      setAwaitingTopicIds((prev) => withFlag(prev, topicId, false))
      /**
       * 绿点只给「自然跑完」：
       * - `settled=false` = 用户点了停止 / 渲染帧失效中止（错误另有 stream-error）；
       * - `goalWillContinue=true` = 目标还会自动续跑下一轮，这一轮的 done 不是终点
       *   （goal-driver 紧接着就发下一轮的 goalRound chunk，亮了会闪一下）；
       * - **这条会话正显示在对话窗口里** = 人眼看着结果出来，不再点绿点（完成即自动移除，
       *   顺带把可能残留的旧绿点清掉）。
       */
      if (result.turnFinal?.settled && result.turnFinal.goalWillContinue !== true) {
        const activeNow = isTopicActiveRef.current?.(topicId) ?? false
        setCompletedTopicIds((prev) => withFlag(prev, topicId, !activeNow))
      }
    })

    const offError = api.onStreamError(({ topicId }) => {
      if (typeof topicId !== 'number' || !Number.isFinite(topicId) || topicId <= 0) return
      // 出错时主进程可能补发 done（无 turnFinal）：先把「等确认」收掉，绿点不亮
      setAwaitingTopicIds((prev) => withFlag(prev, topicId, false))
    })

    return () => {
      offPending()
      offDone()
      offError()
    }
  }, [])

  const beginTopicTurn = useCallback((topicId: number): void => {
    setAwaitingTopicIds((prev) => withFlag(prev, topicId, false))
    setCompletedTopicIds((prev) => withFlag(prev, topicId, false))
  }, [])

  const acknowledgeTopic = useCallback((topicId: number): void => {
    setCompletedTopicIds((prev) => withFlag(prev, topicId, false))
  }, [])

  const forgetTopic = useCallback((topicId: number): void => {
    setAwaitingTopicIds((prev) => withFlag(prev, topicId, false))
    setCompletedTopicIds((prev) => withFlag(prev, topicId, false))
  }, [])

  return {
    awaitingTopicIds,
    completedTopicIds,
    beginTopicTurn,
    acknowledgeTopic,
    forgetTopic
  }
}
