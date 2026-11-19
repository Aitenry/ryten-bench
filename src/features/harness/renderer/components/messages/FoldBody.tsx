import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { theme } from 'antd'
import { RiArrowDownWideLine, RiArrowUpWideLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

/**
 * 折叠内容框：**固定高度（超出内滚）+ 可选的展开全部 + 可打断的贴底跟随**。
 *
 * 用户 2026-09-19 要求（原话）：「默认固定高度，可以展开全部。在流式的时候可以滚动到底部流式加载，
 * 可以打断滚动底部，当在底部时，可以继续加载。需要确保固定的高度不能遮挡思考内容。」
 * 随后补充：「这个（折叠段的内容）也要这样」——所以这不是思考专属：思考过程、
 * 任务段、工具输出、子代理输出都走同一个框，行为完全一致。
 * （前期探索段 2026-09-25 起不再折叠，也就不再用这个框：只有任务段折叠。）
 *
 * 「展开全部」现在**按用途显式开关**（用户 2026-09-23：「思考内容不需要，下方的展开全部内容，
 * 就是不需要这个按钮了」）：思考框（`thinking` / `thinking-nested`，以及已有各自展开入口的工具、
 * 子代理输出）传 `expandable={false}`，框下不摆任何按钮，长内容就在固定高度里内滚；只有任务段
 * 内容仍默认带这个控件。开关一律写在调用点：一个框要不要按钮是它的语义，不靠外面记。
 *
 * 改造前是两处各自为政的实现，正是那几句话指向的毛病：
 *  - 内容框写死 `max-h-64 overflow-y-auto`，长内容只能在 256px 的窗口里来回滚，没有「一次看全」；
 *  - 贴底跟随是 AssistantMessage 里一个**无差别**的 effect：流式中每来一个 chunk 就把所有滚动容器
 *    `scrollTop = scrollHeight`。它不判断用户是不是正在往上读——刚想回看前几行就被拽回底部
 *    （＝用户说的「可以打断」要去掉的行为）；也不判断是否已经在底部，纯靠无脑赋值。
 *
 * 三条要求逐一落实：
 *  1. 固定高度：默认 `maxHeight` 封顶、超出内滚（流式时消息高度不再随内容一路长高）；点展开图标
 *     放开上限，看全文；再点收起图标回到固定高度并钉回最新一行；
 *  2. 贴底跟随：**只在流式时**、且用户**在底部**时才跟（每个 chunk 跟一次）；上滑即打断，滚回底部
 *     自动恢复——不是「关掉了跟随」，而是「以用户的位置为准」；
 *  3. 不遮挡：框里只有内容本身，展开/收起控件放在框**外面**（下方右对齐），任何控件都不压文字。
 */

/** 判定「在底部」的容差（px）：与聊天区的 STICK_THRESHOLD 同量级 */
const NEAR_BOTTOM = 12

/** 展开/收起图标尺寸（px）：与消息区其它小图标同档 */
const TOGGLE_ICON_SIZE = 16

/**
 * 「展开全部 / 收起」的图标（用户 2026-09-19 指定）：
 * **折起 = ri-arrow-down-wide-line，展开 = ri-arrow-up-wide-line，且必须居中**。
 * 用固定尺寸的 flex 盒包住字形，横向纵向都居中（行内 svg 会落在文字基线上、看着偏上）。
 */
const FoldToggleIcon: React.FC<{ expanded: boolean }> = ({ expanded }) => (
  <span
    data-fold-toggle-icon={expanded ? 'up' : 'down'}
    // 居中用内联样式而不是工具类：这是控件自身的几何，不该依赖 Tailwind 是否在场
    // （jsdom 里没有 Tailwind，用 class 的话计算样式是 inline，测不出来也说不准）
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: TOGGLE_ICON_SIZE,
      height: TOGGLE_ICON_SIZE,
      lineHeight: 0
    }}
  >
    {expanded ? (
      <RiArrowUpWideLine size={TOGGLE_ICON_SIZE} />
    ) : (
      <RiArrowDownWideLine size={TOGGLE_ICON_SIZE} />
    )}
  </span>
)

interface FoldBodyProps {
  children: React.ReactNode
  /** 固定高度上限（px）：思考 256、子智能体内层 192、段内容 320 */
  maxHeight?: number
  /**
   * 是否提供「展开全部 / 收起」（默认提供）。
   *
   * **思考框必须传 false**（用户 2026-09-23：「思考内容不需要，下方的展开全部内容，就是不需要
   * 这个按钮了」）；工具/子代理输出早已是 false（它们各有自己的展开入口）；只有任务段内容走默认。
   */
  expandable?: boolean
  /** 是否正在流式：false（历史消息）时完全不接管滚动，打开就从第一行读起 */
  streaming?: boolean
  /** 贴底跟随的触发信号：流式时传 `message.lastChunkAt`（每个 chunk 变一次） */
  followSignal?: number
  /** 额外类名（各处内边距/字号不同：px-1.5、ml-2 pl-2、text-sm/text-xs…） */
  className?: string
  /** 左侧强调线颜色：思考块用它区分「思考 / 正文」；段内容与工具输出不传 */
  borderColor?: string
  /**
   * 用途标记（落在 `data-fold-body` 上）：同一条消息里会同时存在多个内容框
   * （段内容 + 思考 + 工具 + 子代理），回归工装需要稳定锚点区分它们。
   */
  kind?:
    | 'thinking'
    | 'thinking-nested'
    | 'segment'
    /** 同名工具组的组内容（连读十次文件也只在固定高度里滚） */
    | 'tool-run'
    | 'tool'
    | 'tool-nested'
    | 'subagent'
    | 'subagent-nested'
}

const FoldBody: React.FC<FoldBodyProps> = ({
  children,
  maxHeight = 256,
  expandable = true,
  streaming = false,
  followSignal,
  className = '',
  borderColor,
  kind = 'segment'
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const boxRef = useRef<HTMLDivElement>(null)
  /** 是否跟随底部：用户上滑即置 false，滚回底部自动置回 true */
  const stickRef = useRef(true)
  const [expanded, setExpanded] = useState(false)
  /** 内容是否超过固定高度：只有真能展开时才摆控件，不摆没用的控件 */
  const [overflow, setOverflow] = useState(false)

  /**
   * 量一次框高并（贴底时）跟上最新一行。
   *
   * 触发点是「来了新 chunk」与「展开态/上限变化」，**不是每次渲染**：一条上百块的消息里每个框都
   * 逐渲染读 `scrollHeight` 会强制同步布局，是此前明确修过的卡顿来源。流式期间 `followSignal`
   * 与内容同频，足够。
   */
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const over = el.scrollHeight - el.clientHeight > 1
    setOverflow((prev) => (prev === over ? prev : over))
    if (streaming && stickRef.current) el.scrollTop = el.scrollHeight
  }, [followSignal, expanded, maxHeight, streaming])

  /** 用户滚动：到底部恢复跟随、上滑打断（回到底部会再次自动恢复，不需要额外开关） */
  const handleScroll = useCallback(() => {
    const el = boxRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM
  }, [])

  /** 收起回固定高度时钉到最新一行：展开着读完前面再收起，不该只看到开头 */
  const handleToggle = useCallback(() => {
    setExpanded((prev) => {
      if (prev) {
        stickRef.current = true
        const el = boxRef.current
        if (el) el.scrollTop = el.scrollHeight
      }
      return !prev
    })
  }, [])

  const toggleLabel = expanded
    ? t('harness.assistantMessage.foldCollapse')
    : t('harness.assistantMessage.foldExpand')

  return (
    <>
      <div
        ref={boxRef}
        data-fold-body={kind}
        onScroll={handleScroll}
        className={`overflow-y-auto harness-scrollbar ${borderColor ? 'border-l-2 pl-3' : ''} ${className}`}
        style={{ borderColor, maxHeight: expanded ? 'none' : maxHeight }}
      >
        {children}
      </div>
      {/* 控件在框外：固定高度只滚内容，展开/收起的按钮绝不压住内容。
          按钮内容就是图标本身（用户 2026-09-19：「展开全部这个内容要换图标」），
          文字标签退到 title/aria-label 里，可访问性不受影响。
          **水平垂直都居中**（用户 2026-09-19 第二轮：「没有水平垂直居中」）：
          外行、按钮、图标三层各自居中，且都用内联样式——这是控件自身的几何，
          不该依赖 Tailwind 是否在场（jsdom 里没有 Tailwind，用 class 测不出也说不准）。 */}
      {expandable && (overflow || expanded) ? (
        <div
          data-fold-toggle
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <button
            type="button"
            data-fold-toggle-state={expanded ? 'up' : 'down'}
            onClick={handleToggle}
            title={toggleLabel}
            aria-label={toggleLabel}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: token.colorTextSecondary,
              cursor: 'pointer',
              lineHeight: 0
            }}
          >
            <FoldToggleIcon expanded={expanded} />
          </button>
        </div>
      ) : null}
    </>
  )
}

export default FoldBody
