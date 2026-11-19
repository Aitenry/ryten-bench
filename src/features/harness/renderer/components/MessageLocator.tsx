import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { theme } from 'antd'
import type { TFunction } from 'i18next'
import { useTranslation } from '@renderer/i18n'
import { tailContentIndices } from '../utils/harnessHelpers'
import type { Message } from '../types'

interface MessageLocatorProps {
  messages: Message[]
  /** 消息滚动容器（量高度、监听滚动） */
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** 滚动容器里的内容容器（量每轮提问在内容中的位置） */
  contentRef: React.RefObject<HTMLDivElement | null>
  /** 点击刻度：跳转到该条消息（是否恢复贴底跟随由父级决定） */
  onJumpTo: (index: number) => void
}

/* ──────────── 视觉规格 ──────────── */

/** 相邻刻度的自然间距（参考实现里 --turn-natural-position 每档 10px） */
const PITCH = 10
/** 刻度宽（普通 / 当前）与高 */
const TICK_W = 8
const TICK_W_ACTIVE = 14
const TICK_H = 2
/** 距容器右边缘：让开 6px 滚动条 + 4px 外边距 */
const RAIL_INSET = 20
/** 轨道上下留白（用于判断可容纳多少刻度） */
const PAD_Y = 8
/** 判定「当前轮次」时向下的容差（px） */
const PROBE_OFFSET = 24
/** 悬停卡：宽度、回答区最多显示的行数与行高 */
const CARD_W = 300
const ANSWER_LINES = 3
const ANSWER_LINE_H = 20
/** 命中区高度（2px 的线太细，指不准） */
const HIT_H = TICK_H + 6

interface Turn {
  /** 该轮提问在 messages 里的下标 */
  index: number
  /** 提问文本（标题） */
  question: string
  /**
   * 该轮**结论**（各助手消息的最终答复，顺序拼接；一段 = 一条助手消息）。
   *
   * 一轮里助手消息不止一条：插话/停止后「继续」会切段，目标自动续跑也各占一条。
   * 每条消息只贡献自己的最终答复——夹在工具调用之间的过程叙述不进卡片。
   */
  answer: string
}

/** Markdown 摘成一行纯文本：预览卡里不需要语法符号（非组件函数：译文由调用方传入 t） */
const plainTextRaw = (t: TFunction, raw: string | null | undefined): string =>
  (raw ?? '')
    .replace(/```[\s\S]*?```/g, t('harness.messageLocator.codePlaceholder'))
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, t('harness.messageLocator.imagePlaceholder'))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * 纯文本转换缓存（渲染进程内存/CPU 保护）。
 *
 * 上面这串正则在长回复上是实打实的开销，而 `turns` 每次 messages 变化都会全量重算——
 * 流式期间每批 chunk 都触发一次，等于每批都把全部历史回复重新正则一遍（历史回复往往是
 * 几十上百 KB）。缓存按「语言 + 原始字符串」记结果：历史消息的 content 字符串是同一份
 * 引用，命中后直接返回；流式中的那条每批都是新字符串，由容量上限按 LRU 淘汰。
 * 键里带语言，切语言后不会命中上一种语言的旧译文。
 */
const PLAIN_TEXT_CACHE_MAX = 80
const plainTextCache = new Map<string, string>()

const plainText = (t: TFunction, lang: string, raw: string | null | undefined): string => {
  const text = raw ?? ''
  if (text.length === 0) return ''
  const key = `${lang}\u0000${text}`
  const cached = plainTextCache.get(key)
  if (cached !== undefined) {
    // 命中即刷新为「最近使用」（Map 保持插入序，配合下方淘汰即 LRU）
    plainTextCache.delete(key)
    plainTextCache.set(key, cached)
    return cached
  }
  const value = plainTextRaw(t, text)
  if (plainTextCache.size >= PLAIN_TEXT_CACHE_MAX) {
    const oldest = plainTextCache.keys().next().value
    if (oldest !== undefined) plainTextCache.delete(oldest)
  }
  plainTextCache.set(key, value)
  return value
}

/**
 * 一条助手消息里的**结论**正文（本轮交付给用户的最终答复）。
 *
 * 为什么不直接用 `message.content`：它是这条消息**全部**正文的累积，夹在工具调用之间的
 * 过程叙述（「让我先看一下…」「现在开始改…」）也在里面，预览卡于是变成一整篇流水账。
 * 边界取协议层真源（见 main/harness/service/answer-boundary.ts）：
 *   - `Set`：这些块是本轮答复（下标就指本条消息的 blocks）；
 *   - `null`：明确没有答复（中止 / 只有工具与思考）；
 *   - `undefined`：主进程没给结论（流式进行中 / 历史消息 / 老版本），退回与聊天区同款的
 *     反向扫描（tailContentIndices：末尾连续的「思考 + 正文」，至少含一段正文才算结论）。
 * 只取 text 块：思考是答复的来源，但不是结论本身，预览卡里不铺开。
 */
const answerTextOf = (t: TFunction, lang: string, message: Message): string => {
  const blocks = message.blocks
  // 无块消息（历史/异常路径）：整条正文就是唯一可用的内容
  if (blocks.length === 0) return plainText(t, lang, message.content)
  if (message.answer === null) return ''
  const indices =
    message.answer instanceof Set
      ? [...message.answer].sort((a, b) => a - b)
      : tailContentIndices(
          blocks,
          blocks.map((_, i) => i)
        )
  const parts: string[] = []
  for (const index of indices) {
    const block = blocks[index]
    if (block?.type === 'text' && block.text) parts.push(block.text)
  }
  return plainText(t, lang, parts.join('\n\n'))
}

/**
 * 轮次导航（对话消息定位）。
 *
 * - 一个刻度 = 一轮提问（**只标用户消息**），等距聚合成一条短列表，整体在消息区里垂直居中；
 * - 刻度多了就地压缩间距，永远不超出可视高度；
 * - 「当前轮次」= 视口顶部往上最近的那条提问，刻度变白加长（滚动时只比偏移，不重量 DOM）；
 * - 悬停出卡片：标题是这一轮的提问，内容是该轮各助手消息的**结论**（最终答复）按顺序
 *   拼起来的正文——过程叙述、工具调用、思考都不进卡片（3 行，超出可滚动；空行分段，
 *   便于看出这轮被切过几次）；
 * - 点击平滑滚到该轮提问处。
 */
const MessageLocator: React.FC<MessageLocatorProps> = ({
  messages,
  scrollRef,
  contentRef,
  onJumpTo
}) => {
  const { token } = theme.useToken()
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const [railHeight, setRailHeight] = useState(0)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [hovered, setHovered] = useState<number | null>(null)
  /** 每轮提问在内容里的绝对偏移，滚动时只做比较 */
  const offsetsRef = useRef<{ index: number; offset: number }[]>([])
  const frameRef = useRef<number | null>(null)
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * 一轮 = 一条用户消息 + 紧随其后、直到下一个提问之前的每一条助手消息。
   *
   * 每条助手消息只贡献自己的**结论**（answerTextOf）：只留过程叙述会变成流水账，
   * 只留最后一条又会把这轮先前的结论丢掉。多条按顺序拼接（不是覆盖）——插话切段、
   * 停止后继续会让一轮里出现多条助手消息，后一条往往是前一条答复的续写。
   * 拼接前逐条走 plainText——按「单条结论」缓存，流式追加新段落时前面的段落仍命中缓存，
   * 不会因为整段字符串变了而把历史长文重新正则一遍。
   */
  const turns = useMemo<Turn[]>(() => {
    const list: Turn[] = []
    messages.forEach((message, index) => {
      if (message.role !== 'user') return
      // 目标自动续跑的横幅不是「提问」（它渲染成批次横幅、由左右切换查看），不占标尺刻度
      if (message.blocks.some((b) => b.type === 'goalRound')) return
      const parts: string[] = []
      for (let i = index + 1; i < messages.length; i++) {
        const next = messages[i]
        if (next.role === 'user') break
        if (next.role !== 'assistant') continue
        const text = answerTextOf(t, lang, next)
        if (text) parts.push(text)
      }
      list.push({
        index,
        question: plainText(t, lang, message.content),
        // 空行分段：悬停卡是 whiteSpace: pre-wrap，段与段之间会断开，不会粘成一句
        answer: parts.join('\n\n')
      })
    })
    return list
  }, [messages, t, lang])

  /** 按滚动位置刷新「当前轮次」 */
  const syncActive = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    const probe = el.scrollTop + PROBE_OFFSET
    const list = offsetsRef.current
    if (list.length === 0) return
    let index = list[0].index
    list.forEach((item) => {
      if (item.offset <= probe) index = item.index
    })
    setActiveIndex((prev) => (prev === index ? prev : index))
  }, [scrollRef])

  /** 量一轮提问的位置（rAF 合并，流式期间每帧最多一次） */
  const measure = useCallback((): void => {
    const el = scrollRef.current
    const inner = contentRef.current
    if (!el || !inner) return
    setRailHeight(Math.max(0, el.clientHeight - PAD_Y * 2))
    const innerTop = inner.getBoundingClientRect().top
    const offsets: { index: number; offset: number }[] = []
    turns.forEach((turn) => {
      const node = inner.querySelector<HTMLElement>(`[data-msg-i="${turn.index}"]`)
      if (!node) return
      offsets.push({ index: turn.index, offset: node.getBoundingClientRect().top - innerTop })
    })
    offsetsRef.current = offsets
    syncActive()
  }, [contentRef, scrollRef, turns, syncActive])

  const scheduleMeasure = useCallback((): void => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      measure()
    })
  }, [measure])

  /* 轮次变化 / 容器或内容尺寸变化（流式长高）→ 重量 */
  useEffect(() => {
    scheduleMeasure()
    const el = scrollRef.current
    const inner = contentRef.current
    const ro = new ResizeObserver(() => scheduleMeasure())
    if (el) ro.observe(el)
    if (inner) ro.observe(inner)
    return () => {
      ro.disconnect()
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [scheduleMeasure, scrollRef, contentRef])

  /* 滚动 → 更新当前刻度 */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => syncActive()
    el.addEventListener('scroll', onScroll, { passive: true })
    syncActive()
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollRef, syncActive])

  /* 悬停卡的延迟关闭：鼠标从刻度移到卡片上时不能立刻消失（卡片里要能滚动回答） */
  const cancelClear = useCallback((): void => {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current)
      clearTimerRef.current = null
    }
  }, [])
  const scheduleClear = useCallback((): void => {
    cancelClear()
    clearTimerRef.current = setTimeout(() => setHovered(null), 140)
  }, [cancelClear])
  useEffect(() => () => cancelClear(), [cancelClear])

  /* 悬停卡高度实测：卡片的纵向中心要对准被悬停的那条刻度 */
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [cardHeight, setCardHeight] = useState(0)
  useLayoutEffect(() => {
    if (hovered === null) return
    const el = cardRef.current
    if (el) setCardHeight(el.offsetHeight)
  }, [hovered, turns.length])

  /* 轮次数量变化时清掉悬停态，避免指向错位的那一轮 */
  useEffect(() => {
    setHovered(null)
  }, [turns.length])

  if (turns.length < 2) return null

  /* 等距堆叠：刻度多到放不下时压缩间距，始终不超出可视高度 */
  const gap =
    turns.length > 1
      ? Math.max(
          2,
          Math.min(PITCH - TICK_H, (railHeight - turns.length * TICK_H) / (turns.length - 1))
        )
      : 0

  const hoveredTurn = hovered === null ? null : (turns[hovered] ?? null)
  const hoveredTop = hovered === null ? 0 : hovered * (HIT_H + gap)
  /* 卡片纵向中心对准刻度（高度实测，未量到之前按 120 估） */
  const cardH = cardHeight || 120
  const cardTop = Math.max(
    0,
    Math.min(hoveredTop + HIT_H / 2 - cardH / 2, Math.max(0, railHeight - cardH))
  )

  return (
    <div
      style={{
        position: 'absolute',
        /* 让开滚动条与容器圆角 */
        right: RAIL_INSET,
        top: '50%',
        transform: 'translateY(-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap,
        zIndex: 12,
        pointerEvents: 'none'
      }}
    >
      {turns.map((turn, i) => {
        const isActive = turn.index === activeIndex
        const isHovered = i === hovered
        return (
          <button
            key={turn.index}
            type="button"
            aria-label={t('harness.messageLocator.jumpToRound', { round: i + 1 })}
            aria-current={isActive ? 'true' : undefined}
            onMouseEnter={() => {
              cancelClear()
              setHovered(i)
            }}
            onMouseLeave={scheduleClear}
            onClick={() => onJumpTo(turn.index)}
            style={{
              width: TICK_W_ACTIVE + 4,
              height: HIT_H,
              padding: 0,
              border: 'none',
              background: 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              cursor: 'pointer',
              pointerEvents: 'auto'
            }}
          >
            <span
              style={{
                height: TICK_H,
                borderRadius: 1,
                transition: 'width 0.12s, background 0.12s',
                width: isActive ? TICK_W_ACTIVE : isHovered ? TICK_W + 2 : TICK_W,
                background: isActive
                  ? token.colorText
                  : isHovered
                    ? token.colorTextSecondary
                    : token.colorTextQuaternary
              }}
            />
          </button>
        )
      })}

      {/* 悬停卡：标题=这一轮的提问，内容=该轮各条助手消息的结论（最终答复）拼起来的正文（3 行，超出滚动） */}
      {hoveredTurn && (
        <div
          ref={cardRef}
          onMouseEnter={cancelClear}
          onMouseLeave={scheduleClear}
          style={{
            position: 'absolute',
            right: TICK_W_ACTIVE + 14,
            top: cardTop,
            width: CARD_W,
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 10,
            padding: '10px 12px',
            boxShadow: token.boxShadowSecondary,
            pointerEvents: 'auto'
          }}
        >
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.5,
              color: token.colorText,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden'
            }}
          >
            {hoveredTurn.question || t('harness.messageLocator.emptyMessage')}
          </div>
          <div style={{ height: 1, background: token.colorBorderSecondary, margin: '8px 0' }} />
          {/* 回答区：固定 3 行高，超出滚动；底部留一层渐隐提示「下面还有」 */}
          <div style={{ position: 'relative' }}>
            <div
              className="custom-scrollbar"
              style={{
                maxHeight: ANSWER_LINES * ANSWER_LINE_H,
                overflowY: 'auto',
                fontSize: 12.5,
                lineHeight: `${ANSWER_LINE_H}px`,
                color: token.colorTextSecondary,
                whiteSpace: 'pre-wrap'
              }}
            >
              {hoveredTurn.answer || t('harness.messageLocator.noAnswer')}
            </div>
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 6,
                bottom: 0,
                height: 14,
                background: `linear-gradient(to bottom, transparent, ${token.colorBgElevated})`,
                pointerEvents: 'none'
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default MessageLocator
