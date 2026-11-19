import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Dropdown, Tooltip } from 'antd'
import dayjs from 'dayjs'
import {
  RiArrowDownLine,
  RiArrowUpLine,
  RiCheckLine,
  RiCloseLine,
  RiHistoryLine,
  RiAlertLine,
  RiArrowGoBackLine
} from '@remixicon/react'
import { type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  acceptChunk,
  goToNextChunk,
  goToPreviousChunk,
  rejectChunk,
  unifiedMergeView
} from '@codemirror/merge'
import CodeEditor from './CodeEditor'
import { chunkActionGutter } from '../utils/cmChunkActions'
import { computeMergeStats } from '../utils/mergeStats'
import type { EditorPaletteInput } from '../utils/cmTheme'
import type { FileChangeView } from '../types/file-change'
import { useTranslation } from '@renderer/i18n'
import { harnessApi } from '../api'

/** 工具条按钮：**只有图标**（文案退到 Tooltip/aria-label），尺寸随内容收缩 */
interface DiffToolbarButtonProps {
  title: string
  icon: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  /** 语义色（保留 = 绿、撤销 = 红） */
  tone?: 'default' | 'accept' | 'reject'
  colorText: string
  colorTextSecondary: string
  colorBorderSecondary: string
  isDarkMode: boolean
  /** 尾部额外样式（间隔线之后的一组用它把按钮推开） */
  style?: React.CSSProperties
  testId?: string
}

const DiffToolbarButton: React.FC<DiffToolbarButtonProps> = ({
  title,
  icon,
  onClick,
  disabled,
  tone = 'default',
  colorText,
  colorTextSecondary,
  colorBorderSecondary,
  isDarkMode,
  style,
  testId
}) => {
  const toneStyle: React.CSSProperties =
    tone === 'accept'
      ? {
          borderColor: 'transparent',
          background: isDarkMode ? 'rgba(120,190,140,0.16)' : 'rgba(70,150,100,0.12)',
          color: isDarkMode ? '#9ecf8a' : '#2f6b4f'
        }
      : tone === 'reject'
        ? {
            borderColor: 'transparent',
            background: isDarkMode ? 'rgba(220,120,100,0.16)' : 'rgba(180,70,50,0.10)',
            color: isDarkMode ? '#e08a70' : '#a8442a'
          }
        : {}
  const baseColor = toneStyle.color ?? colorTextSecondary
  return (
    /* 这几个按钮只在差异视图的**顶部操作行**里用（保留/撤销/上一处/下一处），
       提示朝下弹：朝上会盖住编辑器工具条与页签栏（用户 2026-09-26 统一工具条方向）。 */
    <Tooltip title={title} placement="bottom">
      <button
        type="button"
        data-diff-btn={testId}
        aria-label={title}
        title={title}
        disabled={disabled}
        onClick={onClick}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          width: 24,
          height: 22,
          padding: 0,
          borderRadius: 4,
          border: `1px solid ${colorBorderSecondary}`,
          background: 'transparent',
          color: colorTextSecondary,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.45 : 1,
          ...toneStyle,
          ...style
        }}
        onMouseEnter={(e) => {
          if (disabled) return
          if (tone === 'default') {
            e.currentTarget.style.borderColor = colorText
            e.currentTarget.style.color = colorText
          } else {
            // 语义色按钮本来就是满底色：悬停只提亮边框，别把文字色改掉再改不回来
            e.currentTarget.style.borderColor = baseColor
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor =
            tone === 'default' ? colorBorderSecondary : 'transparent'
          e.currentTarget.style.color = baseColor
        }}
      >
        {icon}
      </button>
    </Tooltip>
  )
}

interface FileDiffViewProps {
  /** 真实文件路径（语言高亮 + 历史查询） */
  filePath: string
  /** 当前展示的改动 */
  change: FileChangeView
  /** 该文件所有待审查的改动（正序：最早在前） */
  pending: FileChangeView[]
  /** 差异编辑器的当前文档（= 页签内容；逐处取舍会改它） */
  value: string
  isDarkMode: boolean
  palette: EditorPaletteInput
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  colorBorderSecondary: string
  isDirty: boolean
  /** 逐处取舍 / 直接编辑差异文档 */
  onChange: (value: string) => void
  /** Ctrl+S：落盘审查结果（写文件 + 标记已保留） */
  onApplyReview: (content: string) => void
  /** 保留（清除待审查标记） */
  onKeep: (ids: number[]) => void
  /** 撤销到某次改动之前 */
  onRevert: (id: number) => void
  /** 在历史里切换查看某次改动 */
  onSelectChange: (id: number) => void
}

/**
 * 改动来源 / 审查状态的文案。
 * 用 switch 而不是拼字符串键：i18n 的键是字面量联合类型，模板字符串拼出来的键过不了类型检查。
 * 定义在组件内以闭包捕获 t（i18next 的 t 类型带重载，抽成独立函数的形参注解会把类型推爆）。
 */
function useChangeLabels(): {
  sourceLabel: (source: FileChangeView['source']) => string
  statusLabel: (status: FileChangeView['status']) => string
} {
  const { t } = useTranslation()
  const sourceLabel = (source: FileChangeView['source']): string => {
    switch (source) {
      case 'write_file':
        return t('harness.fileDiff.sourceWrite')
      case 'edit_file':
        return t('harness.fileDiff.sourceEdit')
      case 'execute':
        return t('harness.fileDiff.sourceExecute')
      case 'external':
        return t('harness.fileDiff.sourceExternal')
      default:
        return t('harness.fileDiff.sourceReview')
    }
  }
  const statusLabel = (status: FileChangeView['status']): string => {
    switch (status) {
      case 'pending':
        return t('harness.fileDiff.statusPending')
      case 'kept':
        return t('harness.fileDiff.statusKept')
      case 'reverted':
        return t('harness.fileDiff.statusReverted')
      default:
        return t('harness.fileDiff.statusObsolete')
    }
  }
  return { sourceLabel, statusLabel }
}

/**
 * 文件差异视图（模型改动的审查面板）。
 *
 * 用 @codemirror/merge 的统一合并视图：当前文档 = 文件现状（可编辑），
 * 改动前内容作为 original 内联展示（删除行以块内联、新增行高亮）。
 *
 * 三层审查粒度：
 * 1. **整次改动**：工具条的「全部保留 / 撤销全部改动」（走主进程，写回改动前快照）；
 * 2. **单处差异**：光标定位到某处后「保留此处 / 撤销此处」（CodeMirror 的 acceptChunk/rejectChunk）；
 * 3. **自由编辑**：直接在差异里改，Ctrl+S 落盘为「审查结果」（自动标记已保留）。
 */
const FileDiffView: React.FC<FileDiffViewProps> = ({
  filePath,
  change,
  pending,
  value,
  isDarkMode,
  palette,
  colorText,
  colorTextSecondary,
  colorTextTertiary,
  colorBorderSecondary,
  isDirty,
  onChange,
  onApplyReview,
  onKeep,
  onRevert,
  onSelectChange
}) => {
  const { t } = useTranslation()
  const { sourceLabel, statusLabel } = useChangeLabels()
  const viewRef = useRef<EditorView | null>(null)
  /**
   * 按位置取舍（改动槽按钮用）。
   *
   * 用 ref 而不是把回调塞进扩展：chunkActionGutter 的扩展在 useMemo 里构建，
   * 回调身份一变就整编辑器重配（撤销历史、滚动位置全丢）。这里让扩展始终调用同一个
   * 函数，函数内部再读最新的 view。
   */
  const acceptAtRef = useRef<(pos: number) => void>(() => {})
  const rejectAtRef = useRef<(pos: number) => void>(() => {})
  acceptAtRef.current = (pos: number): void => {
    const view = viewRef.current
    if (!view) return
    acceptChunk(view, pos)
    view.focus()
  }
  rejectAtRef.current = (pos: number): void => {
    const view = viewRef.current
    if (!view) return
    rejectChunk(view, pos)
    view.focus()
  }
  const [original, setOriginal] = useState<string | null>(null)
  /** 模型写入后的内容（= 磁盘现值）：用来判断用户在差异里是否又取舍过 */
  const [modelContent, setModelContent] = useState<string | null>(null)
  const [stats, setStats] = useState<{ chunks: number; added: number; removed: number } | null>(
    null
  )
  const [history, setHistory] = useState<FileChangeView[]>([])

  /** 统计文案（工具条左侧）：随 diff 结果变化，工具条自适应用它算让位 */
  const statsText = stats
    ? t('harness.fileDiff.stats', {
        count: stats.chunks,
        added: stats.added,
        removed: stats.removed
      })
    : ''

  const isPending = change.status === 'pending'
  const latestPendingId = pending.length > 0 ? pending[pending.length - 1].id : null
  // 只有「最新一次待审查改动」才允许在差异里编辑取舍：
  // 对更早的改动做取舍会把文件拉回旧状态，等于隐式撤销了后面的改动
  const canEdit = isPending && change.id === latestPendingId && change.hasBefore
  /** 差异里的文档与磁盘完全一致（用户还没取舍过任何一处） */
  const docMatchesDisk = modelContent === null || value === modelContent

  // 载入改动前正文（差异的左侧/上方内容）+ 改动后正文（判断是否已取舍）
  useEffect(() => {
    let cancelled = false
    setOriginal(null)
    setModelContent(null)
    if (!change.hasBefore) {
      setOriginal('')
      return
    }
    const api = harnessApi
    void api.workspace.changeContent(change.id).then((content) => {
      if (cancelled) return
      setOriginal(content?.before ?? '')
      setModelContent(content?.after ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [change.id, change.hasBefore])

  const refreshHistory = useCallback(() => {
    const api = harnessApi
    void api.workspace.fileChanges(filePath).then(setHistory)
  }, [filePath])

  useEffect(() => {
    refreshHistory()
  }, [refreshHistory, change.id, pending.length])

  /**
   * 工具条自适应：**按钮只有图标**（用户 2026-09-22：「上面的所有按钮不要显示文字，只要图标即可」），
   * 面板变窄时再按优先级整段让位，绝不把按钮挤到看不见。
   *
   * 踩过的两种坏结局：
   * ① 带文字时 6 个按钮 ≈ 460px，450px 的面板直接横向溢出（实测 scrollWidth/clientWidth
   *    差 231px），图标退到面板外面点不到；
   * ② 外层 `overflow-hidden` 会把溢出裁掉，`scrollWidth-clientWidth` 因此**测不准**
   *    （裁掉后只剩 9px），所以这里按「内容自然宽度之和 vs 容器宽度」自己算，不靠 scrollWidth。
   *
   * 让位顺序（先丢最不关键的）：来源说明 → 统计文字 → 未保存提示 → 历史入口。
   * 保留 / 撤销 / 上一处 / 下一处 始终留在工具条上——它们是这个面板的主操作。
   */
  const toolbarRef = useRef<HTMLDivElement>(null)
  const groupRef = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState<{ source: boolean; history: boolean; stats: boolean }>({
    source: true,
    history: true,
    stats: true
  })

  useLayoutEffect(() => {
    const bar = toolbarRef.current
    if (!bar) return

    const recompute = (): void => {
      const available = bar.clientWidth
      if (available <= 0) return
      // 按钮组（含分隔线）的自然宽度：flexShrink 已设为 0，量到的是真实需求
      const groupWidth = groupRef.current ? groupRef.current.scrollWidth : 0
      // 尾部留白 + 组间距：宁可算多几像素，也不要在临界宽度上来回抖
      const reserved = 24 + 8
      const slack = available - groupWidth - reserved
      setCompact((prev) => {
        const next = {
          // 来源文字（edit_file 之类）最不关键：先丢
          source: slack >= 64,
          stats: slack >= 120,
          history: slack >= 96
        }
        if (
          prev.source === next.source &&
          prev.stats === next.stats &&
          prev.history === next.history
        ) {
          return prev
        }
        return next
      })
    }

    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [history.length, isDirty, statsText, canEdit, isPending])

  /**
   * 统计差异规模（处数 / 新增行 / 删除行）。
   *
   * 有合并视图时由 CodeMirror 自己的 chunk 结果换算；没有可比对的正文
   * （新建文件、命令执行期间被捕获的写入）时回落到**改动记录自带的统计**——
   * 算法与边界见 utils/mergeStats.ts（那两种「算不出 diff」的返回是真编辑器上量出来的）。
   */
  const refreshStats = useCallback(
    (view: EditorView) => {
      const next = computeMergeStats(view.state, original, change)
      setStats((prev) =>
        prev &&
        prev.chunks === next.chunks &&
        prev.added === next.added &&
        prev.removed === next.removed
          ? prev
          : next
      )
    },
    [original, change]
  )

  useEffect(() => {
    if (viewRef.current) refreshStats(viewRef.current)
  }, [refreshStats, value])

  /** 合并视图扩展（original 变化 / 可编辑性变化时重建） */
  const mergeExtensions = useMemo<Extension[] | undefined>(() => {
    if (original === null || !change.hasBefore) return undefined
    return [
      unifiedMergeView({
        original,
        highlightChanges: true,
        gutter: true,
        syntaxHighlightDeletions: true,
        allowInlineDiffs: true,
        collapseUnchanged: { margin: 4, minSize: 8 },
        /**
         * 自带的 mergeControls 会往删除块内部塞两个**文字**按钮（「保留 / 撤销」），
         * 随块一起滚、还压在正文右端。改成 false：取舍按钮由 chunkActionGutter 画在
         * 改动槽里（图标 + 「一处差异一组」，见 utils/cmChunkActions.ts）。
         */
        mergeControls: false
      }),
      // 行号槽里的逐处取舍按钮：只有最新一次待审查改动允许取舍，其余（历史改动）只读
      ...(canEdit
        ? [
            chunkActionGutter({
              acceptLabel: t('harness.fileDiff.acceptChunkTip'),
              rejectLabel: t('harness.fileDiff.rejectChunkTip'),
              onAccept: (pos) => acceptAtRef.current(pos),
              onReject: (pos) => rejectAtRef.current(pos)
            })
          ]
        : [])
    ]
  }, [original, change.hasBefore, canEdit, t])

  const runChunkCommand = useCallback((command: 'accept' | 'reject' | 'next' | 'prev') => {
    const view = viewRef.current
    if (!view) return
    if (command === 'accept') acceptChunk(view)
    else if (command === 'reject') rejectChunk(view)
    else if (command === 'next') goToNextChunk(view)
    else goToPreviousChunk(view)
    view.focus()
  }, [])

  const handleViewReady = useCallback(
    (view: EditorView) => {
      viewRef.current = view
      refreshStats(view)
    },
    [refreshStats]
  )

  const pendingIds = pending.map((item) => item.id)

  /**
   * 「全部保留」：保留的到底是哪一份内容？
   * - 用户没在差异里取舍过 → 磁盘上的就是最终内容，只需清掉待审查标记；
   * - 用户逐处取舍/手改过 → 先把眼前这份内容落盘（applyReview），否则那些取舍会被丢掉。
   */
  const handleKeepAll = useCallback(() => {
    if (canEdit && !docMatchesDisk) {
      onApplyReview(value)
      return
    }
    onKeep(pendingIds)
  }, [canEdit, docMatchesDisk, onApplyReview, onKeep, pendingIds, value])

  const historyPanel = (
    <div
      className="rounded-lg overflow-hidden shadow-lg"
      style={{
        width: 320,
        background: isDarkMode ? '#252526' : '#ffffff',
        border: `1px solid ${colorBorderSecondary}`
      }}
    >
      <div
        className="px-3 py-2 text-[11px] tracking-wide"
        style={{ color: colorTextTertiary, borderBottom: `1px solid ${colorBorderSecondary}` }}
      >
        {t('harness.fileDiff.historyTitle')}
      </div>
      <div className="max-h-[280px] overflow-y-auto history-scrollbar">
        {history.length === 0 ? (
          <div className="px-3 py-4 text-xs" style={{ color: colorTextTertiary }}>
            {t('harness.fileDiff.historyEmpty')}
          </div>
        ) : (
          history.map((item) => {
            const active = item.id === change.id
            return (
              <div
                key={item.id}
                className="px-3 py-2 cursor-pointer"
                style={{
                  background: active
                    ? isDarkMode
                      ? 'rgba(255,255,255,0.06)'
                      : 'rgba(0,0,0,0.04)'
                    : 'transparent'
                }}
                onClick={() => onSelectChange(item.id)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: colorText }}>
                    {sourceLabel(item.source)}
                  </span>
                  <span
                    className="text-[11px] tabular-nums"
                    style={{ color: colorTextTertiary, marginLeft: 'auto' }}
                  >
                    {item.createdAt ? dayjs(item.createdAt).format('MM-DD HH:mm:ss') : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[11px] tabular-nums" style={{ color: '#4a8f5b' }}>
                    +{item.added}
                  </span>
                  <span className="text-[11px] tabular-nums" style={{ color: '#b3452f' }}>
                    −{item.removed}
                  </span>
                  <span className="text-[11px]" style={{ color: colorTextTertiary }}>
                    {statusLabel(item.status)}
                  </span>
                  {item.status === 'pending' && item.id !== change.id && (
                    <span
                      className="text-[11px] cursor-pointer"
                      style={{ color: colorTextTertiary, marginLeft: 'auto' }}
                      onClick={(e) => {
                        e.stopPropagation()
                        onKeep([item.id])
                      }}
                    >
                      {t('harness.fileDiff.keepOne')}
                    </span>
                  )}
                  {item.hasBefore && (item.status === 'pending' || item.status === 'kept') && (
                    <span
                      className="text-[11px] cursor-pointer"
                      style={{
                        color: colorTextTertiary,
                        marginLeft: item.status === 'pending' && item.id !== change.id ? 8 : 'auto'
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        onRevert(item.id)
                      }}
                    >
                      {t('harness.fileDiff.revertToHere')}
                    </span>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )

  /** 语义色按钮的公共入参（图标按钮组件需要的调色板与主题） */
  const buttonProps = {
    colorText,
    colorTextSecondary,
    colorBorderSecondary,
    isDarkMode
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 审查工具条：**只有图标**（用户 2026-09-22 要求），文案一律退到 Tooltip；
          面板变窄时按优先级丢掉文字分段（见上方 compact 的说明），按钮组永不压缩。 */}
      <div
        ref={toolbarRef}
        data-testid="file-diff-toolbar"
        className="flex items-center gap-2 px-3 shrink-0 overflow-hidden whitespace-nowrap"
        style={{ height: 32, borderBottom: `1px solid ${colorBorderSecondary}` }}
      >
        {compact.stats && (
          <span
            data-diff-stats
            className="text-[11.5px] tabular-nums shrink-0"
            style={{ color: colorTextSecondary }}
          >
            {statsText}
          </span>
        )}
        {compact.source && (
          <span className="text-[11.5px] shrink-0" style={{ color: colorTextTertiary }}>
            {sourceLabel(change.source)}
          </span>
        )}
        {isDirty && (
          <span className="text-[11.5px] shrink-0" style={{ color: '#c98a2b' }}>
            {t('harness.fileDiff.unsaved')}
          </span>
        )}
        <div className="flex-1" />

        {/* 按钮组：flexShrink=0 且整体量过一次自然宽度（toolbarRef 的自适应按它算） */}
        <div ref={groupRef} className="flex items-center gap-1.5 shrink-0">
          <DiffToolbarButton
            {...buttonProps}
            testId="prev"
            title={t('harness.fileDiff.prevChunk')}
            icon={<RiArrowUpLine size={13} />}
            onClick={() => runChunkCommand('prev')}
          />
          <DiffToolbarButton
            {...buttonProps}
            testId="next"
            title={t('harness.fileDiff.nextChunk')}
            icon={<RiArrowDownLine size={13} />}
            onClick={() => runChunkCommand('next')}
          />
          {canEdit && (
            <>
              <DiffToolbarButton
                {...buttonProps}
                testId="accept"
                title={t('harness.fileDiff.acceptChunkTip')}
                icon={<RiCheckLine size={13} />}
                onClick={() => runChunkCommand('accept')}
              />
              <DiffToolbarButton
                {...buttonProps}
                testId="reject"
                title={t('harness.fileDiff.rejectChunkTip')}
                icon={<RiCloseLine size={13} />}
                onClick={() => runChunkCommand('reject')}
              />
            </>
          )}

          <span style={{ width: 1, height: 16, background: colorBorderSecondary, flexShrink: 0 }} />

          {isPending && (
            <>
              <DiffToolbarButton
                {...buttonProps}
                testId="keep-all"
                tone="accept"
                title={
                  docMatchesDisk
                    ? t('harness.fileDiff.keepAllTip')
                    : t('harness.fileDiff.keepMixedTip')
                }
                icon={<RiCheckLine size={13} />}
                onClick={handleKeepAll}
              />
              <DiffToolbarButton
                {...buttonProps}
                testId="revert-all"
                tone="reject"
                title={t('harness.fileDiff.revertAllTip')}
                icon={<RiArrowGoBackLine size={13} />}
                disabled={!pending[0]?.hasBefore}
                onClick={() => pending.length > 0 && onRevert(pending[0].id)}
              />
            </>
          )}

          {compact.history && (
            <Dropdown
              dropdownRender={() => historyPanel}
              trigger={['click']}
              placement="bottomRight"
            >
              <span style={{ display: 'inline-flex' }}>
                <DiffToolbarButton
                  {...buttonProps}
                  testId="history"
                  title={t('harness.fileDiff.history', { count: history.length })}
                  icon={<RiHistoryLine size={13} />}
                />
              </span>
            </Dropdown>
          )}
        </div>
      </div>

      {/* 无快照（命令执行 / 外部改动）：如实说明不可回溯 */}
      {!change.hasBefore && (
        <div
          className="flex items-center gap-2 px-3 shrink-0 text-[11.5px]"
          style={{
            height: 28,
            color: colorTextSecondary,
            background: isDarkMode ? 'rgba(220,160,80,0.10)' : 'rgba(210,150,60,0.10)',
            borderBottom: `1px solid ${colorBorderSecondary}`
          }}
        >
          <RiAlertLine size={13} style={{ color: isDarkMode ? '#d9b06a' : '#8a5a1e' }} />
          {t('harness.fileDiff.noSnapshot')}
        </div>
      )}

      {isPending && change.id !== latestPendingId && (
        <div
          className="flex items-center gap-2 px-3 shrink-0 text-[11.5px]"
          style={{
            height: 28,
            color: colorTextSecondary,
            background: isDarkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
            borderBottom: `1px solid ${colorBorderSecondary}`
          }}
        >
          {t('harness.fileDiff.historicalHint')}
        </div>
      )}

      <div className="flex-1 min-h-0">
        {original === null ? (
          <div
            className="flex items-center justify-center h-full text-xs"
            style={{ color: colorTextTertiary }}
          >
            {t('harness.fileEditor.loading')}
          </div>
        ) : (
          <CodeEditor
            key={`${change.id}:${change.hasBefore ? 'snap' : 'nosnap'}`}
            filePath={filePath}
            value={value}
            palette={palette}
            readOnly={!canEdit}
            wrap={false}
            extraExtensions={mergeExtensions}
            onChange={onChange}
            onSave={() => canEdit && onApplyReview(value)}
            onViewReady={handleViewReady}
            onUpdate={(update) => {
              if (update.docChanged || update.selectionSet) refreshStats(update.view)
            }}
          />
        )}
      </div>
    </div>
  )
}

export default FileDiffView
