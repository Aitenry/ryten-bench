import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { theme, Tooltip, App } from 'antd'
import {
  RiFileCopyLine,
  RiCheckLine,
  RiThumbUpLine,
  RiThumbDownLine,
  RiBrainLine,
  RiGitBranchLine,
  RiTimerLine,
  RiDatabase2Line,
  RiDeleteBin6Line
} from '@remixicon/react'
import dayjs from 'dayjs'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'

import UsagePanel from './UsagePanel'
import { buildUsageDetails } from '../../utils/usage'
import type { HarnessDialogueUsageRow } from '../../../shared/types'
import type { Message } from '../../types'
import { harnessApi } from '../../api'

type Feedback = 'up' | 'down' | null

interface MessageActionsProps {
  message: Message
  /** 消息在列表中的下标（删除本轮 / 分支截取用） */
  index: number
  /** 本轮提问的时间戳：与回答时间戳相减得到「用时」 */
  turnStartedAt?: number
  /** 当前话题（评价落本地索引用） */
  topicId: number | null
  /** 该条回复的真实用量（harness_dialogue_usage 行）；无回传时为 undefined，不显示用量 */
  usage?: HarnessDialogueUsageRow
  /** 分支：交给 hooks 处理（它才知道话题列表与切换流程） */
  onBranch: (upToIndex: number) => Promise<void>
  /** 复制文本按需生成：流式期间每批都把所有块正文拼一遍太贵，只在点击复制时算 */
  getCopyText: () => string
  isCopied: boolean
  onCopy: (text: string, id: string) => void
  onDelete: (index: number) => void
}

/** 评价的本地索引键前缀（暂无 feedback 列，先按 话题+时间戳 存本地） */
const FEEDBACK_KEY = 'rytenbench:message-feedback:'

function readFeedback(key: string): Feedback {
  try {
    const raw = localStorage.getItem(FEEDBACK_KEY + key)
    return raw === 'up' || raw === 'down' ? raw : null
  } catch {
    return null
  }
}

/* ──────────── 「本轮用量」面板的自适应定位 ──────────── */

/** 面板默认宽度（放得下就用它）与距裁剪容器边缘的留白 */
const USAGE_PANEL_W = 300
const USAGE_EDGE_GAP = 12

/** 裁剪容器的四边（视口坐标） */
interface Bounds {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * 用量面板可用的范围（视口坐标）。
 *
 * 面板是绝对定位挂在用量徽标上的（见下方悬停块）。它一旦探出**裁剪容器**的边缘，消息区
 * 就会被顶出滚动条——滚动容器是 `overflow-y-scroll`，而按规范另一轴的 visible 会被
 * 计算成 auto，窗口一窄横向滚动条就冒出来（用户 2026-09-24 报的现象），纵向则是面板
 * 被裁掉半截。
 *
 * 所以这里向上找最近的裁剪祖先，取它的**内容盒**当边界：`clientLeft / clientWidth /
 * clientHeight` 已经扣掉边框和滚动条，不必再去猜滚动条占多宽。找不到（异常路径）退回窗口。
 */
const clipBounds = (el: HTMLElement): Bounds => {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = window.getComputedStyle(node)
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      const rect = node.getBoundingClientRect()
      return {
        left: rect.left + node.clientLeft,
        right: rect.left + node.clientLeft + node.clientWidth,
        top: rect.top + node.clientTop,
        bottom: rect.top + node.clientTop + node.clientHeight
      }
    }
  }
  return {
    left: 0,
    right: document.documentElement.clientWidth,
    top: 0,
    bottom: document.documentElement.clientHeight
  }
}

/**
 * 助手消息操作栏：复制 / 评价 / 存入记忆 / 分支到新对话 / 用量 / 用时 / 时间。
 *
 * - 复制沿用父级已有实现（同一套「已复制」态）；
 * - 评价暂存 localStorage（按 topicId + 消息时间戳定位，重载后仍在）；
 *   要进库需要给 harness_dialogue 加 feedback 列；
 * - 存入记忆 = 起一个后台「记忆整理」子代理，由它读这一轮问答、自己判断该记什么并写入
 *   Mnemon（进度在顶部栏后台代理入口看），渲染层不直接写热记忆；
 * - 分支 = 新建同工作区话题 + 把这条之前的消息逐条复制过去；
 * - 用量显示模型真实回传的 token（harness_dialogue_usage）；没有回传就不显示，不做估算。
 */
const MessageActions: React.FC<MessageActionsProps> = ({
  message,
  index,
  turnStartedAt,
  topicId,
  usage,
  onBranch,
  getCopyText,
  isCopied,
  onCopy,
  onDelete
}) => {
  const { token } = theme.useToken()
  const api = harnessApi
  const { viewMessage } = useMessage()
  const { modal } = App.useApp()
  const { t } = useTranslation()

  const feedbackKey = `${topicId ?? 0}:${message.timestamp}`
  const [feedback, setFeedback] = useState<Feedback>(() => readFeedback(feedbackKey))
  const [savingMemory, setSavingMemory] = useState(false)
  const [branching, setBranching] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  /** 用量面板的实测布局：宽度按可用空间收窄，水平偏移 + 上下翻转保证不越出裁剪容器 */
  const [usageLayout, setUsageLayout] = useState({ width: USAGE_PANEL_W, offset: 0, above: true })
  const usageAnchorRef = useRef<HTMLSpanElement>(null)
  const usagePanelRef = useRef<HTMLSpanElement>(null)

  /**
   * 量一次用量面板的布局：
   * - 宽度 = min(默认宽, 可用宽)；
   * - 横向默认左缘对齐徽标，右侧放不下就往左挪、挪到边界为止；
   * - 纵向默认挂上方（用户 2026-09-19 的要求），上方放不下才翻到下方。
   * 目标是整块面板落在裁剪容器里：既不把消息区顶出滚动条，也不被裁掉半截。
   */
  const measureUsagePanel = useCallback((): void => {
    const anchorEl = usageAnchorRef.current
    if (!anchorEl) return
    const anchor = anchorEl.getBoundingClientRect()
    const { left, right, top, bottom } = clipBounds(anchorEl)
    const width = Math.min(USAGE_PANEL_W, Math.max(0, right - left - USAGE_EDGE_GAP * 2))
    const preferred = Math.min(anchor.left, right - USAGE_EDGE_GAP - width)
    const offset = Math.max(left + USAGE_EDGE_GAP, preferred) - anchor.left
    /**
     * 上下翻转：面板还没挂上时高度量不到（0），此时保持「挂上方」——
     * 挂上后的那一趟 layout effect 会带着真实高度重来一次。
     * 两边的余量都比面板矮时选余量大的那边（总会被裁，至少裁得少）。
     */
    const height = usagePanelRef.current?.offsetHeight ?? 0
    const roomAbove = anchor.top - top - USAGE_EDGE_GAP
    const roomBelow = bottom - anchor.bottom - USAGE_EDGE_GAP
    const above = height <= roomAbove || roomBelow <= roomAbove
    setUsageLayout((prev) =>
      prev.width === width && prev.offset === offset && prev.above === above
        ? prev
        : { width, offset, above }
    )
  }, [])

  /**
   * 面板挂上后量一次（layout 阶段，早于绘制）：翻面/收窄都发生在首帧之前，不会闪。
   * 依赖 width 是因为收窄会改变折行、进而改变高度——换宽后要按新高度重判上下。
   */
  useLayoutEffect(() => {
    if (usageOpen) measureUsagePanel()
  }, [usageOpen, usageLayout.width, measureUsagePanel])

  /* 面板开着时窗口尺寸变化（拖动窗口）→ 重量一次，别又探出边界 */
  useEffect(() => {
    if (!usageOpen) return
    const onResize = (): void => measureUsagePanel()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [usageOpen, measureUsagePanel])

  useEffect(() => {
    setFeedback(readFeedback(feedbackKey))
  }, [feedbackKey])

  const handleFeedback = useCallback(
    (next: Exclude<Feedback, null>) => {
      const value: Feedback = feedback === next ? null : next
      setFeedback(value)
      try {
        if (value) localStorage.setItem(FEEDBACK_KEY + feedbackKey, value)
        else localStorage.removeItem(FEEDBACK_KEY + feedbackKey)
      } catch {
        /* 本地存储不可用时只保留内存态 */
      }
      viewMessage(
        'msg-feedback',
        'success',
        value === 'up'
          ? t('harness.messageActions.feedbackUpRecorded')
          : value === 'down'
            ? t('harness.messageActions.feedbackDownRecorded')
            : t('harness.messageActions.feedbackCanceled'),
        1.5
      )
    },
    [feedback, feedbackKey, viewMessage, t]
  )

  /**
   * 存入记忆 = 交给后台「记忆整理」子代理。
   *
   * 渲染层不再把正文截断后直接写热记忆：一条回复动辄几千字，直接塞进去只会把热记忆
   * 撑满、还把一次性进度写成了长期事实。改由子代理读这一轮问答，自己判断哪些是可复用
   * 事实、该落哪一层（热记忆 / 项目文档 / 长期记忆空间）再写入；进度在顶部栏后台代理入口看。
   */
  const handleSaveToMemory = useCallback(async (): Promise<void> => {
    const text = (message.content ?? '').trim()
    if (!text) {
      viewMessage('msg-memory', 'warning', t('harness.messageActions.saveToMemoryEmpty'), 2)
      return
    }
    if (topicId == null) {
      viewMessage('msg-memory', 'warning', t('harness.messageActions.saveToMemoryNoTopic'), 2)
      return
    }
    setSavingMemory(true)
    try {
      const result = await api.harness.startMemoryAgent({
        topicId,
        answer: text,
        dialogueId: message.dialogueId,
        // 这条回复自己用的供应商（用量行快照）：让整理跟着同一条模型走；
        // 没有用量行时主进程回退到默认供应商
        providerId: usage?.provider_id ?? undefined
      })
      if (result.ok) {
        viewMessage('msg-memory', 'success', t('harness.messageActions.saveToMemoryStarted'), 3)
      } else if (result.reason === 'memory-disabled') {
        viewMessage('msg-memory', 'warning', t('harness.messageActions.saveToMemoryDisabled'), 3)
      } else if (result.reason === 'no-model') {
        viewMessage('msg-memory', 'warning', t('harness.messageActions.saveToMemoryNoModel'), 3)
      } else {
        viewMessage('msg-memory', 'error', t('harness.messageActions.saveToMemoryFailed'), 2)
      }
    } catch (error) {
      console.error('Failed to hand the answer to the memory agent:', error)
      viewMessage('msg-memory', 'error', t('harness.messageActions.saveToMemoryFailed'), 2)
    } finally {
      setSavingMemory(false)
    }
  }, [api, message.content, message.dialogueId, topicId, usage, viewMessage, t])

  /** 分支：建话题、复制消息、刷新列表、切换视图都在 hooks 里，这里只负责按钮态 */
  const handleBranch = useCallback(async (): Promise<void> => {
    setBranching(true)
    try {
      await onBranch(index)
    } catch (error) {
      console.error('Failed to branch conversation:', error)
    } finally {
      setBranching(false)
    }
  }, [index, onBranch])

  /* 用时：本轮提问时间 → 回答结束时间（流式中取最后 chunk，落库消息取自己的时间戳） */
  const elapsedMs = ((): number => {
    if (message.loading) return 0
    const started = turnStartedAt ?? message.timestamp
    const ended = message.lastChunkAt ?? message.timestamp
    return Math.max(0, ended - started)
  })()

  /** 用时文案：秒级以下给一位小数，分钟级给「x分y秒」 */
  const elapsedText = ((): string => {
    if (elapsedMs <= 0) return ''
    if (elapsedMs < 60_000) {
      return t('harness.messageActions.elapsedSeconds', {
        seconds: (elapsedMs / 1000).toFixed(1)
      })
    }
    const minutes = Math.floor(elapsedMs / 60_000)
    const seconds = Math.round((elapsedMs % 60_000) / 1000)
    return t('harness.messageActions.elapsedMinutes', { minutes, seconds })
  })()

  /** 用量：只显示模型真实回传的 token（没回传就不显示，绝不估算） */
  const formatTokens = (value: number): string =>
    value >= 10_000
      ? `${Math.round(value / 1000)}k`
      : value >= 1000
        ? `${(value / 1000).toFixed(1)}k`
        : String(value)
  const usageText =
    usage?.total_tokens != null
      ? t('harness.usagePanel.tokensValue', { value: formatTokens(usage.total_tokens) })
      : ''
  /** 悬停用量徽标时弹出的「本轮用量」面板（缓存命中/推理等明细在 usage_metadata 里） */
  const usageDetails = useMemo(() => buildUsageDetails(usage), [usage])

  /**
   * 这一排按钮的提示统一放**下方**（用户 2026-09-19：「这些按键的提示内容，需要在底部，像『在新对话中分支』
   * 这种提示组件」——那条当时是 antd 自动翻转刚好落到下面）。原因也顺手记下：操作栏紧贴在正文下方，
   * 提示放到上方会盖住用户正在读的那段文字；固定 bottom 之后行为一致，不再随位置翻来翻去。
   *
   * 后续两条（同一天）：**不要箭头**（arrow: false）+ **贴近内容**（align.offset 压到 4px）。
   * antd 的默认间距是 `halfArrowWidth + marginXXS(8)`（带箭头时约 12px）；关掉箭头后 arrowWidth=0，
   * 再显式给 offset 才能压到 4px。
   */
  const tooltipCommon = {
    placement: 'bottom' as const,
    arrow: false,
    align: { offset: [0, 4] }
  }

  const iconButton = (
    icon: React.ReactNode,
    title: string,
    onClick: () => void,
    options?: { active?: boolean; danger?: boolean; disabled?: boolean }
  ): React.ReactNode => (
    <Tooltip title={title} {...tooltipCommon}>
      <button
        type="button"
        aria-label={title}
        aria-pressed={options?.active}
        disabled={options?.disabled}
        onClick={onClick}
        className="p-1.5 rounded-lg transition-colors"
        style={{
          color: options?.active
            ? token.colorPrimary
            : options?.danger
              ? token.colorTextTertiary
              : token.colorTextTertiary,
          background: options?.active ? token.colorPrimaryBg : 'transparent',
          opacity: options?.disabled ? 0.5 : 1,
          cursor: options?.disabled ? 'default' : 'pointer'
        }}
        onMouseEnter={(e) => {
          if (options?.disabled) return
          e.currentTarget.style.background = options?.active
            ? token.colorPrimaryBg
            : token.colorFillTertiary
          e.currentTarget.style.color = options?.danger
            ? token.colorError
            : options?.active
              ? token.colorPrimary
              : token.colorTextSecondary
        }}
        onMouseLeave={(e) => {
          if (options?.disabled) return
          e.currentTarget.style.background = options?.active ? token.colorPrimaryBg : 'transparent'
          e.currentTarget.style.color = options?.danger
            ? token.colorTextTertiary
            : token.colorTextTertiary
        }}
      >
        {icon}
      </button>
    </Tooltip>
  )

  /**
   * 徽标：图标 + 文本。
   *
   * 只读元信息（时间 / 用时 / 用量）本身没有可点的动作，所以提示是可选的：给了 title
   * 才挂一行提示。用量徽标不挂——它的悬停已经弹出「本轮用量」明细面板，再叠一个黑框提示
   * 只是重复（用户 2026-09-24：「移除『本轮用量』这个东西」，指的正是那个 antd 提示框）。
   */
  const chip = (icon: React.ReactNode, text: string, title?: string): React.ReactNode => {
    const pill = (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          height: 22,
          padding: '0 8px',
          borderRadius: 11,
          background: token.colorFillTertiary,
          color: token.colorTextTertiary,
          fontSize: 11,
          whiteSpace: 'nowrap'
        }}
      >
        {icon}
        {text}
      </span>
    )
    return title ? (
      <Tooltip title={title} {...tooltipCommon}>
        {pill}
      </Tooltip>
    ) : (
      pill
    )
  }

  return (
    <div className="flex items-center gap-1 mt-2 flex-wrap">
      {iconButton(
        isCopied ? <RiCheckLine size={16} /> : <RiFileCopyLine size={16} />,
        isCopied ? t('harness.messageActions.copied') : t('harness.messageActions.copy'),
        () => onCopy(getCopyText(), message.id)
      )}
      {iconButton(
        <RiThumbUpLine size={16} />,
        feedback === 'up'
          ? t('harness.messageActions.feedbackUpMarked')
          : t('harness.messageActions.feedbackUp'),
        () => handleFeedback('up'),
        { active: feedback === 'up' }
      )}
      {iconButton(
        <RiThumbDownLine size={16} />,
        feedback === 'down'
          ? t('harness.messageActions.feedbackDownMarked')
          : t('harness.messageActions.feedbackDown'),
        () => handleFeedback('down'),
        { active: feedback === 'down' }
      )}
      {iconButton(
        <RiBrainLine size={16} />,
        savingMemory
          ? t('harness.messageActions.savingToMemory')
          : t('harness.messageActions.saveToMemory'),
        () => {
          void handleSaveToMemory()
        },
        { disabled: savingMemory }
      )}
      {iconButton(
        <RiGitBranchLine size={16} />,
        branching ? t('harness.messageActions.branching') : t('harness.messageActions.branch'),
        () => {
          void handleBranch()
        },
        { disabled: branching }
      )}
      {iconButton(
        <RiDeleteBin6Line size={16} />,
        t('harness.messageActions.deleteTurn'),
        () =>
          modal.confirm({
            title: t('harness.messageActions.deleteConfirmTitle'),
            content: t('harness.messageActions.deleteConfirmContent'),
            okText: t('common.action.delete'),
            cancelText: t('common.action.cancel'),
            okButtonProps: { danger: true },
            onOk: () => onDelete(index)
          }),
        { danger: true }
      )}

      {/* 分割线：左边是可交互操作，右边是只读元信息 */}
      <span
        style={{
          width: 1,
          height: 14,
          margin: '0 4px',
          background: token.colorBorderSecondary,
          flexShrink: 0
        }}
      />

      {usageText && usageDetails && (
        /* 悬停出「本轮用量」面板：结构与 DSH 一致——标题（左标签 / 右总量）+ 发丝线 + dt/dd 明细 */
        <span
          ref={usageAnchorRef}
          style={{ position: 'relative', display: 'inline-flex' }}
          onMouseEnter={() => setUsageOpen(true)}
          onMouseLeave={() => setUsageOpen(false)}
        >
          {/* 用量徽标不挂 antd 提示：悬停直接出「本轮用量」明细面板（见下方），提示框是多余的重复 */}
          {chip(<RiDatabase2Line size={12} />, usageText)}
          {usageOpen && (
            <span
              ref={usagePanelRef}
              style={{
                position: 'absolute',
                // 用量面板**默认挂上方**（用户 2026-09-19：「这个提示内容不需要放在下面啊」）：
                // 它有 7 行明细，挂下面会压住下一条消息；上方余量不够时按量好的结果翻到下方。
                ...(usageLayout.above
                  ? { bottom: 'calc(100% + 4px)' }
                  : { top: 'calc(100% + 4px)' }),
                // 左缘默认对齐徽标；右侧放不下就按量好的偏移往左挪（宽度同步收窄，见 measureUsagePanel）
                left: usageLayout.offset,
                zIndex: 30,
                display: 'block'
              }}
            >
              <UsagePanel details={usageDetails} width={usageLayout.width} />
            </span>
          )}
        </span>
      )}
      {elapsedText &&
        chip(
          <RiTimerLine size={12} />,
          t('harness.messageActions.elapsed', { elapsed: elapsedText }),
          t('harness.messageActions.elapsedTooltip')
        )}

      <span style={{ flex: 1 }} />

      <span style={{ fontSize: 11, color: token.colorTextQuaternary }}>
        {dayjs(message.timestamp).format('HH:mm')}
      </span>
    </div>
  )
}

export default MessageActions
