import React, { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState } from 'react'
import { SkeletonMessages } from '@renderer/components/system/Skeleton'
import { useTranslation } from '@renderer/i18n'

import UserMessage from './messages/UserMessage'
import AssistantMessage from './messages/AssistantMessage'
import GoalRoundBanner from './messages/GoalRoundBanner'
import ScrollToBottomButton from './ScrollToBottomButton'
import MessageLocator from './MessageLocator'
import WelcomeIntro from './WelcomeIntro'
import type { HarnessDialogueUsageRow } from '../../../../shared/harness/types'
import type { Message } from '../../types/harness/types'
import { harnessApi } from '../../api/harness'

interface HarnessMessageAreaProps {
  messages: Message[]
  isDarkMode: boolean
  /** 当前话题是否正在流式输出（驱动贴底跟随与按钮旋转光圈） */
  streaming: boolean
  /** 当前话题 id：切换话题 / 新建会话时重置为贴底状态 */
  currentTopicId: number | null
  /** 只读（归档会话）：保留复制等查看动作，隐藏编辑 / 删除 / 分支 / 存入记忆 */
  readOnly?: boolean
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  colorFillAlter: string
  colorBorderSecondary: string
  copiedId: string | null
  /** 分页 */
  hasMoreMessages: boolean
  isLoadingMoreMessages: boolean
  onCopy: (text: string, id: string) => Promise<void>
  onDelete: (msgIndex: number) => Promise<void>
  /**
   * 孤立提问（没有回复）的气泡内编辑：进入编辑态 / 回车提交（就地替换并重发）/ 取消。
   * 只有孤立提问才会用到。
   */
  onStartEditMessage: (msgIndex: number) => void
  onSubmitEditMessage: (msgIndex: number, content: string) => Promise<void>
  onCancelEditMessage: () => void
  /** 正在气泡内编辑的提问 id */
  editingMessageId: string | null
  /** 分支：把到该条为止的消息复制到新话题并切过去（由 hooks 统一处理列表与切换） */
  onBranch: (upToIndex: number) => Promise<void>
  onLoadMoreMessages: () => void
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  /**
   * 待审查改动（路径 → 待审查条数）。
   *
   * 用来在**任务段头**上标出「这一段改了哪几个文件、还有几处没审」：段一折起，
   * 段里的编辑卡片就全被卸载了，用户只能看到一行任务名（用户 2026-09-23 报的
   * 「明明编辑了文件，聊天里找不到编辑卡片」正是这个）。有了这个计数，
   * 改动在段头上仍然可见、可点开。
   */
  pendingByPath?: Map<string, number>
  /** 点段头上的改动徽标：打开该文件的差异视图 */
  onOpenChangedFile?: (path: string) => void
}

/** 距离底部小于该值视为「贴底」 */
const STICK_THRESHOLD = 10
/** 点击按钮后平滑滚动期间（ms）：期间的 scroll 事件视为程序滚动，不算用户打断 */
const PROGRAMMATIC_WINDOW = 600
/**
 * 挂载窗口上限（条）：超出时只挂最近这么多条，更早的进「隐藏区」。
 *
 * 背景：用户持续上滑会把分页一页页全加载进来（每页 20 条），历史回复里常有几十上百 KB
 * 的正文与工具输出，全部挂在 DOM 上正是渲染进程 OOM 的主要来源之一。这里不引入虚拟
 * 列表（依赖与回归面都太大），只给「常驻 DOM 的消息数」加一个上限：更早的消息留在
 * 内存里、需要时用顶部提示条一键恢复，滚动手感与定位标尺的行为完全不变。
 */
const HISTORY_RENDER_CAP = 60
/**
 * 流式期间的在屏消息上限（远小于历史态的 60）。
 *
 * 为什么需要单独一个更小的上限：**每次 commit 的成本与「在屏消息数」成正比**，而不是与
 * 变化的那条消息成正比。用真实组件跑仿真（test/sim-renderer-memory.mjs：节点数与内容都
 * 不变，只按批追加流式块、每批后强制 GC 再量堆）实测：
 *   挂载 60 条 → 每批净常驻 1,112 KB ｜ 24 条 → 445 KB ｜ 12 条 → 272 KB（-76%）
 * 流式按 ~30 commit/s 跑，60 条在屏就是 ~33 MB/s 的常驻压力（长任务必然被 OOM 杀）。
 * 所以流式期间只挂最近 12 条；一轮结束回到历史态后不再自动补回（顶部「显示更早」可一键恢复），
 * 避免收尾瞬间又挂一次全量。
 *
 * 只在「用户贴底看最新输出」时收紧；上滑阅读历史时不动窗口，免得把正在读的内容抽走。
 */
const STREAMING_RENDER_CAP = 12
/** 「正文变化前记录视口锚点」的内部事件：见 renderFrom 的滚动补偿 */
const VIEWPORT_SAVED_EVENT = 'harness-viewport-saved'

const HarnessMessageArea: React.FC<HarnessMessageAreaProps> = ({
  messages,
  isDarkMode,
  streaming,
  currentTopicId,
  readOnly = false,
  colorText,
  colorTextSecondary,
  colorTextTertiary,
  colorFillAlter,
  colorBorderSecondary,
  copiedId,
  hasMoreMessages,
  isLoadingMoreMessages,
  onCopy,
  onDelete,
  onStartEditMessage,
  onSubmitEditMessage,
  onCancelEditMessage,
  editingMessageId,
  onBranch,
  onLoadMoreMessages,
  messagesEndRef,
  pendingByPath,
  onOpenChangedFile
}) => {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const prevScrollHeightRef = useRef(0)
  const prevMessagesLengthRef = useRef(0)
  const prevFirstIdRef = useRef<string | null>(null)

  /**
   * 渲染窗口起点（messages 下标）：只挂载 messages.slice(renderFrom)。
   * 上限见 HISTORY_RENDER_CAP；用户可点顶部提示条把隐藏的更早消息放回来。
   */
  const [renderFrom, setRenderFrom] = useState(0)

  // 消息数量增长时维持「常驻条数 <= 上限」：只向前推进窗口起点，
  // 已经展开（renderFrom=0）或本条数不足上限时不动。用函数式更新保证与流式高频
  // 的 messages 变化不打架。
  // 流式期间用更小的 STREAMING_RENDER_CAP（每次 commit 的成本与在屏消息数成正比），
  // 且仅在用户贴底时收紧——上滑读历史时不抽走内容。stickToBottomRef 是 ref，
  // 这里只在 messages.length 变化时读一次，语义足够。
  useEffect(() => {
    const cap = streaming && stickToBottomRef.current ? STREAMING_RENDER_CAP : HISTORY_RENDER_CAP
    const overflow = messages.length - cap
    if (overflow <= 0) return
    setRenderFrom((prev) => (prev < overflow ? overflow : prev))
  }, [messages.length, streaming])

  const visibleMessages = useMemo(
    () => (renderFrom > 0 ? messages.slice(renderFrom) : messages),
    [messages, renderFrom]
  )
  const hiddenCount = Math.min(renderFrom, messages.length)

  /**
   * 滚动锚点：可变对象（不是 ref.current，避免 TS 对 ref.current 的赋值窄化把读取推成
   * never）。字段在 VIEWPORT_SAVED_EVENT 回调里写入、在 layout effect 里读取。
   */
  const viewportAnchor = useRef<{ msgIndex: number; scrollTop: number; offset: number | null }>({
    msgIndex: -1,
    scrollTop: 0,
    offset: null
  })

  /**
   * 正文更新前记录「视口顶部那条消息 + 当时 scrollTop」。挂在 window 上、只注册一次；
   * 由下方 layout effect 在每次提交前派发。用事件而不是直接调用，是为了让「保存」
   * 与「还原」的时机严格分在两个 DOM 状态之间。
   */
  useEffect(() => {
    const onSave = (): void => {
      const el = scrollRef.current
      const inner = contentRef.current
      if (!el || !inner) {
        viewportAnchor.current = { msgIndex: -1, scrollTop: 0, offset: null }
        return
      }
      const innerTop = inner.getBoundingClientRect().top
      const probe = el.scrollTop + STICK_THRESHOLD + 1
      const nodes = inner.querySelectorAll<HTMLElement>('[data-msg-i]')
      let found = -1
      for (const node of nodes) {
        if (node.getBoundingClientRect().top - innerTop >= probe) {
          found = Number(node.getAttribute('data-msg-i'))
          break
        }
      }
      if (found < 0 && nodes.length > 0) {
        found = Number(nodes[nodes.length - 1].getAttribute('data-msg-i'))
      }
      if (found < 0) {
        viewportAnchor.current = { msgIndex: -1, scrollTop: 0, offset: null }
        return
      }
      const anchor = inner.querySelector<HTMLElement>(`[data-msg-i="${found}"]`)
      viewportAnchor.current = {
        msgIndex: found,
        scrollTop: el.scrollTop,
        offset: anchor ? anchor.getBoundingClientRect().top - innerTop : null
      }
    }
    window.addEventListener(VIEWPORT_SAVED_EVENT, onSave)
    return () => window.removeEventListener(VIEWPORT_SAVED_EVENT, onSave)
  }, [])

  // 窗口起点前移会把上方内容摘掉、正文整体上移一截。若不补偿，正在上滑读历史的用户
  // 会被「拽」着往下跑（新消息到达时尤其明显）。
  // 补偿方式不依赖「每条多高」的估算，而是把「视口顶部那条消息」当作锚点：正文变化前
  // 记下它相对内容顶部的偏移与当时的 scrollTop，重排后按锚点的新偏移还原 scrollTop，
  // 读者的视线落点保持不变（点顶部「显示更早」把内容加回来时同理）。
  useLayoutEffect(() => {
    const el = scrollRef.current
    const inner = contentRef.current
    if (!el || !inner) return
    el.dispatchEvent(new CustomEvent(VIEWPORT_SAVED_EVENT))
    const saved = viewportAnchor.current
    if (saved.offset === null || saved.msgIndex < 0) return
    const node = inner.querySelector<HTMLElement>(`[data-msg-i="${saved.msgIndex}"]`)
    if (!node) return
    const innerTop = inner.getBoundingClientRect().top
    const next = Math.max(
      0,
      saved.scrollTop + (node.getBoundingClientRect().top - innerTop - saved.offset)
    )
    if (Math.abs(next - el.scrollTop) > 0.5) el.scrollTop = next
  })

  /** 贴底跟随开关：true 时新内容自动滚到底部；用户上滑阅读历史时关闭，回到底部或点击按钮恢复 */
  const stickToBottomRef = useRef(true)
  /** 按钮平滑滚动的生效窗口：期间产生的 scroll 事件不算用户打断 */
  const programmaticUntilRef = useRef(0)
  const [atBottom, setAtBottom] = useState(true)

  // 切换话题 / 新建会话后，默认回到最新位置
  useEffect(() => {
    stickToBottomRef.current = true
    setAtBottom(true)
    // 重置前插判定基线（话题切换后消息整体替换,不能按「首条 id 变化」判前插）
    prevFirstIdRef.current = null
    // 渲染窗口也要归零：新话题的消息列表是另一份，沿用旧起点会切出一段空窗口
    setRenderFrom(0)
    viewportAnchor.current = { msgIndex: -1, scrollTop: 0, offset: null }
  }, [currentTopicId])

  // 加载更多历史消息后，保持滚动位置不跳动
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const prevLen = prevMessagesLengthRef.current
    const newLen = messages.length
    const prevFirstId = prevFirstIdRef.current
    const firstId = messages[0]?.id ?? null
    // 仅当「头部出现新消息」（加载更早历史前插）时补偿滚动位置。
    // 修复：此前长度增长一律按前插补偿——用户上滑阅读历史时，目标自动续跑向当前话题
    // 尾部追加消息（首条 id 不变）也会强制下移阅读位置
    if (newLen > prevLen && prevLen > 0 && prevFirstId !== null && firstId !== prevFirstId) {
      const newScrollHeight = el.scrollHeight
      const delta = newScrollHeight - prevScrollHeightRef.current
      el.scrollTop += delta
    }
    prevScrollHeightRef.current = el.scrollHeight
    prevMessagesLengthRef.current = messages.length
    prevFirstIdRef.current = firstId
  }, [messages])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const nearBottom = distFromBottom <= STICK_THRESHOLD
    setAtBottom(nearBottom)
    if (nearBottom) {
      // 用户自己滚回底部：恢复贴底跟随
      stickToBottomRef.current = true
    } else if (Date.now() >= programmaticUntilRef.current) {
      // 用户主动上滑阅读：打断持续滚动到底部
      stickToBottomRef.current = false
    }
    if (!isLoadingMoreMessages && hasMoreMessages && el.scrollTop <= 40) {
      onLoadMoreMessages()
    }
  }, [isLoadingMoreMessages, hasMoreMessages, onLoadMoreMessages])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  // 新消息 / 流式 chunk：贴底跟随滚动（用户上滑阅读时 stick=false，不打扰）
  useEffect(() => {
    if (!stickToBottomRef.current) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, renderFrom])

  /* 用户发出提问：无条件回到最新消息处。
   *  发送就代表要接着往下看，不能因为此前上滑读过历史而停在原位；
   *  handleSend 在追加消息之前派发 harness-send-started，这里立刻贴底，
   *  随后 messages 变化会带着恢复的贴底开关再钉一次（覆盖消息尚未渲染的那一帧）。
   *  同时开一个程序滚动窗口：这一跳引发的 scroll 事件不算「用户上滑打断」，
   *  否则消息刚追加、内容变高时会被误判成离开底部而关掉贴底。 */
  useEffect(() => {
    const handleSendStarted = (): void => {
      stickToBottomRef.current = true
      setAtBottom(true)
      programmaticUntilRef.current = Date.now() + PROGRAMMATIC_WINDOW
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
    window.addEventListener('harness-send-started', handleSendStarted)
    return () => window.removeEventListener('harness-send-started', handleSendStarted)
  }, [])

  // 内容异步长高（图片 / mermaid 渲染等）：贴底时保持钉在底部
  useEffect(() => {
    const el = scrollRef.current
    const inner = contentRef.current
    if (!el || !inner) return
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) {
        el.scrollTop = el.scrollHeight
      }
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [])

  /** 每条消息所属轮次的起点（最近一条用户消息的时间戳）：操作栏据此算「用时」 */
  const turnStartByIndex = useMemo(() => {
    const out: number[] = []
    let lastUserAt = 0
    messages.forEach((message, i) => {
      if (message.role === 'user') lastUserAt = message.timestamp
      out[i] = lastUserAt || message.timestamp
    })
    return out
  }, [messages])

  /**
   * 孤立提问：没有对应回复的用户消息（下一条不是助手消息，或它本身就是最后一条）。
   *
   * 典型来源：发送时流失败/被中止、模型报错后放弃重试、或数据库事故后只留下提问。
   * 这类气泡此前没有任何可操作入口，只能干看着——按 id 标记出来给它们补「编辑并重发 / 删除」。
   * 用 id 而不是下标：渲染窗口会切片，下标只保证在这条消息上有效。
   */
  const orphanUserIds = useMemo(() => {
    const ids = new Set<string>()
    messages.forEach((message, i) => {
      if (message.role !== 'user') return
      const next = messages[i + 1]
      if (!next || next.role !== 'assistant') ids.add(message.id)
    })
    return ids
  }, [messages])

  /**
   * 目标续跑批次：把「同一批次的助手回复」合成一行，靠左右切换查看各轮。
   *
   * 背景（用户 2026-09-19）：「我想把同一个批次里面的AI回复这些轮次合并起来，使用左右点击切换，
   * 也可以减少渲染。」
   *
   * 数据形态：目标轮次驱动器（主进程 goal-driver）每轮先下发 `goalRound` 标记 chunk，渲染端把它挂成
   * 一条 user 消息（blocks=[{type:'goalRound',round,objective}]），于是同一批次在列表里是
   * 交替的 [助手][横幅][助手][横幅]……。轮次一多，气泡与挂载的块都线性增长。
   *
   * 归并只认**结构化 goalRound 块**：用户输入什么都不参与判定，普通消息永远是普通气泡。
   *  - 一段连续的「助手 + 横幅 + 助手 + 横幅 + 助手」= 一个批次，**包含开头那条助手**（它是这批
   *    工作的第一轮，自动续跑都建立在它之上）；
   *  - 批次渲染成一行：一个横幅（显示 第 N/M 轮 + 目标 + 左右切换）+ **当前选中那一轮的助手消息**；
   *  - 其余轮次不挂载 —— 这正是「减少渲染」的来源；
   *  - 默认选中最后一轮（最新）；用户手动往前翻过后不再被新轮次抢走，翻回最后一轮则恢复跟随。
   */
  const goalRoundBlockOf = (m: Message | undefined): Message['blocks'][number] | undefined =>
    m?.role === 'user' ? m.blocks.find((b) => b.type === 'goalRound') : undefined

  type RenderRow =
    | { kind: 'single'; index: number }
    | {
        kind: 'batch'
        key: string
        rounds: { index: number; objective: string }[]
      }

  const renderRows = useMemo<RenderRow[]>(() => {
    const rows: RenderRow[] = []
    const total = visibleMessages.length
    const isBanner = (m: Message | undefined): boolean => Boolean(goalRoundBlockOf(m))
    /** 目标原文只从结构化 block 读取，不解析消息正文 */
    const objectiveOf = (m: Message | undefined): string => goalRoundBlockOf(m)?.objective ?? ''

    for (let i = 0; i < total; i += 1) {
      const message = visibleMessages[i]
      const last = rows[rows.length - 1]

      // 横幅 → 助手 = 一轮，接进上一批
      if (isBanner(message)) {
        const assistant = visibleMessages[i + 1]
        if (last && last.kind === 'batch' && assistant?.role === 'assistant') {
          last.rounds.push({ index: i + 1, objective: objectiveOf(message) })
          i += 1
          continue
        }
        rows.push({ kind: 'single', index: i })
        continue
      }

      // 助手 + 后面是横幅 → 开一个新批次（这条助手是该批的第一轮）
      if (message.role === 'assistant' && isBanner(visibleMessages[i + 1])) {
        rows.push({
          kind: 'batch',
          key: message.id,
          rounds: [{ index: i, objective: objectiveOf(visibleMessages[i + 1]) }]
        })
        continue
      }
      rows.push({ kind: 'single', index: i })
    }
    return rows
  }, [visibleMessages])

  /**
   * 手动选中的轮次（批次 key → 轮次下标）。**只记「偏离最新」的选择**：翻到最后一轮就删掉这条记录，
   * 于是新轮次到达时继续跟随；往前翻过则保持不动，不被流式输出抢走视线。
   */
  const [pinnedRound, setPinnedRound] = useState<Record<string, number>>({})
  const gotoRound = useCallback((key: string, target: number, last: number) => {
    setPinnedRound((prev) => {
      const next = { ...prev }
      if (target >= last) delete next[key]
      else next[key] = target
      return next
    })
  }, [])

  /** 对话真实用量（harness_dialogue_usage）：按 dialogue_id 回填到各条助手消息，不用估算值 */
  const [usageByDialogue, setUsageByDialogue] = useState<Record<string, HarnessDialogueUsageRow>>(
    {}
  )
  useEffect(() => {
    const api = harnessApi
    if (currentTopicId === null || streaming) return
    let cancelled = false
    void (async () => {
      try {
        const rows = await api.harness.getUsageByTopic(currentTopicId)
        if (cancelled) return
        setUsageByDialogue(
          Object.fromEntries(rows.map((row) => [String(row.dialogue_id), row])) as Record<
            string,
            HarnessDialogueUsageRow
          >
        )
      } catch (error) {
        console.error('Failed to load dialogue usage:', error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currentTopicId, streaming, messages.length])

  const handleScrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickToBottomRef.current = true
    setAtBottom(true)
    programmaticUntilRef.current = Date.now() + PROGRAMMATIC_WINDOW
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  /** 定位标尺点击：平滑滚到该条消息；跳的是最后一条时恢复贴底跟随 */
  const handleJumpToMessage = useCallback(
    (index: number) => {
      const el = scrollRef.current
      const inner = contentRef.current
      if (!el || !inner) return
      const node = inner.querySelector<HTMLElement>(`[data-msg-i="${index}"]`)
      if (!node) return
      const offset = node.getBoundingClientRect().top - inner.getBoundingClientRect().top
      const isLast = index === messages.length - 1
      stickToBottomRef.current = isLast
      setAtBottom(isLast)
      programmaticUntilRef.current = Date.now() + PROGRAMMATIC_WINDOW
      el.scrollTo({ top: Math.max(0, offset - 12), behavior: 'smooth' })
    },
    [messages.length]
  )

  // 流式输出时按钮常驻（光圈即「生成中」指示）；平时仅在离开底部时出现
  const showScrollButton = messages.length > 0 && (!atBottom || streaming)

  return (
    // harness-message-list：聊天区的样式作用域（折叠头对齐等规则挂在 Index.tsx 的 style 里）
    <div className="harness-message-list relative flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollRef}
        // 底部 pb-14（56px）为悬浮的「回到底部」按钮预留：按钮 30px + 距底 20px + 外圈光弧 4px = 54px，
        // 56px 刚好容得下；比原来的 pb-20 少 24px，按钮不会盖住最后一条消息，也不会空出一大片。
        // endRef 挪到内容容器外面，最后一行才能命中 :last-child 去掉尾部间距。
        className="flex-1 overflow-y-scroll my-1 mr-1 ml-3 px-8 pt-5 pb-14 harness-scrollbar"
      >
        <div ref={contentRef} className={messages.length === 0 ? 'h-full' : 'max-w-4xl mx-auto'}>
          {messages.length === 0 ? (
            <WelcomeIntro colorText={colorText} colorTextSecondary={colorTextSecondary} />
          ) : (
            <>
              {isLoadingMoreMessages && (
                /* 更早的消息在上方，用一个气泡轮廓占位；居中转圈会让人以为「正在发消息」 */
                <div className="py-2">
                  <SkeletonMessages rows={2} />
                </div>
              )}
              {hiddenCount > 0 && (
                /* 隐藏区恢复入口：只影响挂载，消息本身仍在内存里（见 HISTORY_RENDER_CAP） */
                <div className="flex items-center gap-3 pb-3">
                  <span
                    className="flex-1"
                    style={{ height: 1, background: colorBorderSecondary }}
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    onClick={() => setRenderFrom(0)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: '2px 4px',
                      color: colorTextTertiary,
                      fontSize: 12,
                      cursor: 'pointer'
                    }}
                  >
                    {t('harness.messageArea.showEarlier', { count: hiddenCount })}
                  </button>
                  <span
                    className="flex-1"
                    style={{ height: 1, background: colorBorderSecondary }}
                    aria-hidden="true"
                  />
                </div>
              )}
              {renderRows.map((row) => {
                /* idx 是**全局**下标：定位标尺、删除/分支都按完整 messages 数组定位，
                   窗口切片只改变挂载范围，不改变下标语义 */
                if (row.kind === 'batch') {
                  const last = row.rounds.length - 1
                  const active = Math.min(pinnedRound[row.key] ?? last, last)
                  const round = row.rounds[active]
                  const idx = renderFrom + round.index
                  return (
                    /* 批次占一行：横幅（带左右切换）+ 当前轮的助手消息；其余轮次不挂载 */
                    <div
                      key={row.key}
                      data-msg-i={idx}
                      data-goal-batch={row.rounds.length}
                      className="harness-message-row"
                    >
                      <GoalRoundBanner
                        current={active + 1}
                        total={row.rounds.length}
                        objective={round.objective}
                        colorTextSecondary={colorTextSecondary}
                        colorBorderSecondary={colorBorderSecondary}
                        onPrev={() => gotoRound(row.key, active - 1, last)}
                        onNext={() => gotoRound(row.key, active + 1, last)}
                      />
                      <AssistantMessage
                        message={visibleMessages[round.index]}
                        index={idx}
                        readOnly={readOnly}
                        isDarkMode={isDarkMode}
                        copiedId={copiedId}
                        colorText={colorText}
                        colorTextSecondary={colorTextSecondary}
                        colorTextTertiary={colorTextTertiary}
                        colorFillAlter={colorFillAlter}
                        colorBorderSecondary={colorBorderSecondary}
                        topicId={currentTopicId}
                        turnStartedAt={turnStartByIndex[idx]}
                        usage={
                          usageByDialogue[
                            String(
                              visibleMessages[round.index].dialogueId ??
                                visibleMessages[round.index].id
                            )
                          ]
                        }
                        onBranch={onBranch}
                        onCopy={onCopy}
                        onDelete={onDelete}
                        pendingByPath={pendingByPath}
                        onOpenChangedFile={onOpenChangedFile}
                      />
                    </div>
                  )
                }
                const i = row.index
                const message = visibleMessages[i]
                const idx = renderFrom + i
                return (
                  /* data-msg-i：定位标尺按这个索引量每条消息在正文里的位置 */
                  <div key={message.id} data-msg-i={idx} className="harness-message-row">
                    {message.role === 'user' ? (
                      <UserMessage
                        message={message}
                        isDarkMode={isDarkMode}
                        colorText={colorText}
                        colorTextSecondary={colorTextSecondary}
                        colorBorderSecondary={colorBorderSecondary}
                        orphan={orphanUserIds.has(message.id)}
                        editing={editingMessageId === message.id}
                        readOnly={readOnly}
                        onEdit={() => onStartEditMessage(idx)}
                        onEditSubmit={(content) => void onSubmitEditMessage(idx, content)}
                        onEditCancel={onCancelEditMessage}
                        onDelete={() => void onDelete(idx)}
                      />
                    ) : (
                      <AssistantMessage
                        message={message}
                        index={idx}
                        readOnly={readOnly}
                        isDarkMode={isDarkMode}
                        copiedId={copiedId}
                        colorText={colorText}
                        colorTextSecondary={colorTextSecondary}
                        colorTextTertiary={colorTextTertiary}
                        colorFillAlter={colorFillAlter}
                        colorBorderSecondary={colorBorderSecondary}
                        topicId={currentTopicId}
                        turnStartedAt={turnStartByIndex[idx]}
                        usage={usageByDialogue[String(message.dialogueId ?? message.id)]}
                        onBranch={onBranch}
                        onCopy={onCopy}
                        onDelete={onDelete}
                        pendingByPath={pendingByPath}
                        onOpenChangedFile={onOpenChangedFile}
                      />
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>
        {/* 滚动锚点放在内容容器外：它若留在容器内，就永远是最后一个子节点，
            .harness-message-row:last-child 命不中，最后一行会保留 14px 尾距 */}
        <div ref={messagesEndRef} />
      </div>
      <MessageLocator
        messages={messages}
        scrollRef={scrollRef}
        contentRef={contentRef}
        onJumpTo={handleJumpToMessage}
      />
      <ScrollToBottomButton
        visible={showScrollButton}
        streaming={streaming}
        isDarkMode={isDarkMode}
        onClick={handleScrollToBottom}
      />
    </div>
  )
}

export default HarnessMessageArea
