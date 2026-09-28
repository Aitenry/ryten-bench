import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react'
import { App, Dropdown, Input, Modal, theme } from 'antd'
import { SkeletonListRows, SkeletonTextLines } from '@renderer/components/system/Skeleton'
import type { InputRef } from 'antd'
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiBrain4Line,
  RiCloseLine,
  RiDatabase2Line,
  RiDeleteBin6Line,
  RiEditLine,
  RiEqualizerLine,
  RiFileTextLine,
  RiFolder2Line,
  RiFolderOpenLine,
  RiFoldersLine,
  RiHammerLine,
  RiMoreLine,
  RiPuzzleLine,
  RiSearchLine,
  RiSettings4Line,
  RiShieldCheckLine,
  RiUploadCloud2Line
} from '@remixicon/react'
import ChaseDots from './ChaseDots'
import NewDraftModal from './workshop/NewDraftModal'
import { useDraftActions } from './workshop/useDraftActions'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import type { MenuProps } from 'antd'
import type { TFunction } from 'i18next'
import type { HarnessTopicRow, WorkspaceRow } from '../../shared/types'
import type { WorkshopDraftSummary } from '../../shared/workshop'
import { harnessApi } from '../api'
import { useMemoryScope } from '../memory-scope'

interface HarnessSidebarProps {
  /** 当前工作区的会话列表（实时 + 分页，由 useHarness 维护） */
  topics: HarnessTopicRow[]
  /** 上面这批 topics 属于哪个工作区（null = 尚未加载过） */
  topicsWorkspaceId: number | null
  currentTopicId: number | null
  colorBgContainer: string
  borderRadiusLG: number
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  colorFillAlter: string
  loadingTopicIds: Set<number>
  /** 分页 */
  hasMoreTopics: boolean
  isLoadingMoreTopics: boolean
  /** 整表刷新中（区别于滚动分页） */
  isRefreshingTopics: boolean
  onSelectTopic: (topic: HarnessTopicRow) => void
  onDeleteTopic: (topicId: number, e?: React.MouseEvent) => Promise<void>
  onLoadMoreTopics: () => void
  /** 在当前工作区新建会话 */
  onNewHarness: () => void
}

/** Mnemon 记忆概览快照 */
interface MnemonSidebarSnapshot {
  configured: boolean
  runtime?: {
    entries: { content: string; target: 'user' | 'memory'; importance: string }[]
    targets: Record<'user' | 'memory', { used: number; limit: number; entryCount: number }>
  }
  bodies?: {
    total: number
    activeCount: number
  }
  documents?: {
    total: number
    activeCount: number
  }
}

/** 会话分页大小（与 useHarnessHandlers 的 TOPICS_PAGE_SIZE 保持一致） */
const TOPICS_PAGE_SIZE = 20

/** 胶囊开关的单档宽度（两档等宽，滑块才能用固定位移滑过去） */
const MODE_SEGMENT_WIDTH = 44
/** 滑块位移的缓动：末端轻微回弹，切换有手感但不夸张 */
const MODE_THUMB_EASE = 'cubic-bezier(0.32, 1.35, 0.5, 1)'

/**
 * 侧栏模式：`chat`（工作区 → 会话）/ `plugin`（插件）。
 *
 * **不持久化**（用户口径 2026-09-27「一进来，默认不能选中插件这个栏，要看当前是在工作的
 * 选中内容还是插件的选中内容」）：这个开关表达的是**此刻面板在看哪一类内容**，
 * 不是用户偏好——每次进入应用都从「工作」开始，随后跟随内容走：
 * 选会话 → 工作；点开插件 / 进工坊页 → 插件（见下面的 `WORKSHOP_FOCUS_EVENT` 与 onSelectTopic）。
 */
type SidebarMode = 'chat' | 'plugin'

/** 工坊页/插件详情被打开时派发：侧栏据此把开关切到「插件」 */
const WORKSHOP_FOCUS_EVENT = 'harness-workshop-focus'

/**
 * 侧栏模式开关（胶囊 + 滑块）。
 *
 * 为什么不用「两个按钮各自换背景色」：那样切换是**瞬间跳变**，眼睛得重新找位置；
 * 滑块滑过去时「现在在哪一档」是位置本身在说，来回切也不会有两个亮块打架。
 * 颜色全部走 antd token（跟随主题），尺寸写死只为滑块位移好算——两档文字都是两个汉字。
 */
const SidebarModeSwitch: React.FC<{
  mode: SidebarMode
  onChange: (next: SidebarMode) => void
  track: string
  thumb: string
  active: string
  inactive: string
  hairline: string
  t: TFunction
}> = ({ mode, onChange, track, thumb, active, inactive, hairline, t }) => {
  const items: SidebarMode[] = ['chat', 'plugin']
  const index = Math.max(0, items.indexOf(mode))
  return (
    <div
      role="tablist"
      className="relative flex items-center select-none"
      style={{ padding: 2, height: 24, borderRadius: 999, background: track }}
    >
      {/* 滑块：绝对定位 + transform（不动布局、不重排文字），切换时滑到另一档 */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 2,
          left: 2,
          width: MODE_SEGMENT_WIDTH,
          height: 20,
          borderRadius: 999,
          background: thumb,
          border: `1px solid ${hairline}`,
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.28)',
          transform: `translateX(${index * MODE_SEGMENT_WIDTH}px)`,
          transition: `transform 240ms ${MODE_THUMB_EASE}`
        }}
      />
      {items.map((item) => (
        <button
          key={item}
          type="button"
          role="tab"
          aria-selected={mode === item}
          onClick={() => onChange(item)}
          title={t(`harness.sidebar.mode.${item}Hint` as never)}
          style={{
            position: 'relative',
            width: MODE_SEGMENT_WIDTH,
            height: 20,
            padding: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: 12,
            lineHeight: '20px',
            color: mode === item ? active : inactive,
            fontWeight: mode === item ? 500 : 400,
            transition: 'color 180ms ease'
          }}
        >
          {t(`harness.sidebar.mode.${item}` as never)}
        </button>
      ))}
    </div>
  )
}

/** 会话相对时间：刚刚 / 12分钟 / 3小时 / 1天 / 09月10日（值为 null 时不着色显示）
 *  非组件函数：译文由调用方传入 t */
function formatRelativeTime(t: TFunction, value: string | null): string {
  if (!value) return ''
  const then = new Date(value).getTime()
  if (!Number.isFinite(then)) return ''
  const now = Date.now()
  const diff = Math.max(0, now - then)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return t('harness.sidebar.timeJustNow')
  if (diff < hour) return t('harness.sidebar.timeMinutes', { count: Math.floor(diff / minute) })
  if (diff < day) return t('harness.sidebar.timeHours', { count: Math.floor(diff / hour) })
  if (diff < 7 * day) return t('harness.sidebar.timeDays', { count: Math.floor(diff / day) })

  const d = new Date(then)
  const nowDate = new Date(now)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() === nowDate.getFullYear()
    ? t('harness.sidebar.timeDate', { month: mm, day: dd })
    : t('harness.sidebar.timeFullDate', { year: d.getFullYear(), month: mm, day: dd })
}

const HarnessSidebar: React.FC<HarnessSidebarProps> = ({
  topics,
  topicsWorkspaceId,
  currentTopicId,
  colorBgContainer,
  borderRadiusLG,
  colorText,
  colorTextSecondary,
  colorTextTertiary,
  colorFillAlter,
  loadingTopicIds,
  hasMoreTopics,
  isLoadingMoreTopics,
  isRefreshingTopics,
  onSelectTopic,
  onDeleteTopic,
  onLoadMoreTopics,
  onNewHarness
}) => {
  const { token } = theme.useToken()
  const { viewMessage } = useMessage()
  const { modal, message } = App.useApp()
  const { t } = useTranslation()

  const scrollRef = useRef<HTMLDivElement>(null)

  /* ── 模式（工作 / 插件）与插件 ── */
  /** 每次进入应用都从「工作」开始（不读任何持久化偏好） */
  const [mode, setMode] = useState<SidebarMode>('chat')
  const [drafts, setDrafts] = useState<WorkshopDraftSummary[]>([])
  const [draftsLoading, setDraftsLoading] = useState(false)
  /** 「新建草稿」弹窗（与设置页共用组件；建完直接进下面的列表，不跳别处） */
  const [newDraftOpen, setNewDraftOpen] = useState(false)
  /** 用户配置的插件存放路径（空 = 还没配置：列表位置显示一行灰字，配置入口是右上角 ＋） */
  const [pluginsPath, setPluginsPath] = useState('')
  /** 插件工作区清单（插件 id → 它的工作区行；主进程按「插件目录」判定，见 workshop-state） */
  const [pluginWorkspaces, setPluginWorkspaces] = useState<
    { draftId: string; workspaceId: number; path: string }[]
  >([])
  /* 重命名插件弹窗（与工作区重命名同一套交互：一行输入 + 保存） */
  const [draftRenameTarget, setDraftRenameTarget] = useState<WorkshopDraftSummary | null>(null)
  const [draftRenameName, setDraftRenameName] = useState('')
  const [draftRenameSaving, setDraftRenameSaving] = useState(false)

  /**
   * 两个模式各自「当前那一条内容」：切模式时切回去（用户口径 2026-09-28「切换工作模式或者
   * 插件模式下，就默认切换到当前模式下的默认选中项的内容」）。
   *
   * 记的是「话题 id + 它所在的工作区」（话题可能还没建 = null，那就是这个工作区里的空白会话）；
   * 切回去时按 id 重新读一次话题行——标题可能被改过，不能拿旧快照渲染。
   * 用 ref 而不是 state：它只影响「下次切模式切到哪」，不参与渲染。
   */
  const workContentRef = useRef<{ workspaceId: number; topicId: number | null } | null>(null)
  const pluginContentRef = useRef<{
    pluginId: string
    workspaceId: number
    topicId: number | null
  } | null>(null)
  /** 工作模式最后待过的用户工作区（切回工作模式时优先回到它） */
  const lastWorkWorkspaceIdRef = useRef<number | null>(null)

  /** 拉插件草稿清单 + 插件工作区清单（两个模式都拉，工作模式靠后者滤掉插件目录行） */
  const loadDrafts = useCallback(async (): Promise<void> => {
    setDraftsLoading(true)
    try {
      const state = await harnessApi.workshop.state()
      setPluginsPath(state.pluginsPath ?? '')
      setPluginWorkspaces(state.pluginWorkspaces ?? [])
      setDrafts(await harnessApi.workshop.list())
    } catch {
      // 工坊没接线（AI 助手刚停用/重载）时保持空列表：面板本来就只在插件模式用
      setDrafts([])
      setPluginWorkspaces([])
    } finally {
      setDraftsLoading(false)
    }
  }, [])

  useEffect(() => {
    // 两个模式都拉：插件模式要列表，工作模式要靠草稿目录把「插件工作区」从工作列表里滤掉
    void loadDrafts()
    return harnessApi.workshop.onChanged(() => void loadDrafts())
  }, [loadDrafts])

  /**
   * 开关跟随内容：工坊页/插件详情一被打开，就切到「插件」
   * （详见文件头的说明——这个开关表达的是「面板此刻在看哪一类内容」）。
   */
  useEffect(() => {
    const handler = (): void => setMode('plugin')
    window.addEventListener(WORKSHOP_FOCUS_EVENT, handler)
    return () => window.removeEventListener(WORKSHOP_FOCUS_EVENT, handler)
  }, [])

  /** 选一个插件存放路径（只有 ＋ 这一个入口：没配路径时它先走这里） */
  const pickPluginsRoot = useCallback(async (): Promise<boolean> => {
    try {
      const result = await harnessApi.workshop.pickRoot()
      if (!result.ok) {
        viewMessage('workshop-root', 'error', result.error ?? '')
        return false
      }
      const data = result.data
      if (!data || data.canceled) return false
      setPluginsPath(data.dir ?? '')
      await loadDrafts()
      return true
    } catch (error) {
      viewMessage('workshop-root', 'error', String(error))
      return false
    }
  }, [loadDrafts, viewMessage])

  /** ＋：没配存放路径时**先**让用户选文件夹，选好再弹新建框（弹窗里不再放选择器） */
  const handleNewDraft = useCallback(async (): Promise<void> => {
    if (!pluginsPath) {
      const picked = await pickPluginsRoot()
      if (!picked) return
    }
    setNewDraftOpen(true)
  }, [pickPluginsRoot, pluginsPath])

  /**
   * 插件行上的动作（构建 / 验收 / 安装）走与设置页同一个 hook——提示与忙碌态口径一致。
   * 行内还能重命名与删除（对齐工作区行的「⋯ + ＋」，用户口径 2026-09-27）。
   */
  const {
    busyId: draftBusyId,
    build: buildDraft,
    verify: verifyDraft,
    publish: publishDraft
  } = useDraftActions({ onChanged: async () => await loadDrafts() })

  /** 删除插件（只删它的源码目录 + 产物；已装进应用的插件不受影响，与设置页同一套文案） */
  const handleRemoveDraft = useCallback(
    (draft: WorkshopDraftSummary): void => {
      modal.confirm({
        title: t('harness.sidebar.pluginDeleteTitle', { name: draft.title }),
        content: t('workshopSettings.remove.body'),
        okText: t('common.action.delete'),
        okButtonProps: { danger: true },
        cancelText: t('common.action.cancel'),
        onOk: async () => {
          const result = await harnessApi.workshop.remove(draft.id)
          if (!result.ok) {
            viewMessage(`workshop-remove-${draft.id}`, 'error', result.error ?? '', 6)
          }
          await loadDrafts()
        }
      })
    },
    [modal, t, viewMessage, loadDrafts]
  )

  /** 打开重命名插件弹窗 */
  const openDraftRename = useCallback((draft: WorkshopDraftSummary): void => {
    setDraftRenameTarget(draft)
    setDraftRenameName(draft.title)
  }, [])

  /** 保存插件名（改的是展示名：草稿 title + 清单 name；目录名/id 不动） */
  const handleDraftRenameSave = useCallback(async (): Promise<void> => {
    const name = draftRenameName.trim()
    if (!name || !draftRenameTarget) {
      viewMessage('draft-rename-validate', 'warning', t('harness.sidebar.pluginNameRequired'))
      return
    }
    try {
      setDraftRenameSaving(true)
      const result = await harnessApi.workshop.rename(draftRenameTarget.id, name)
      if (!result.ok) {
        viewMessage('draft-rename-error', 'error', result.error ?? '', 6)
        return
      }
      setDraftRenameTarget(null)
      await loadDrafts()
      viewMessage('draft-rename-done', 'success', t('harness.sidebar.renameSuccess'), 2)
    } catch (error) {
      viewMessage('draft-rename-error', 'error', String(error))
    } finally {
      setDraftRenameSaving(false)
    }
  }, [draftRenameName, draftRenameTarget, viewMessage, loadDrafts, t])

  /** 插件行的「⋯」：构建 / 验收 / 安装（与设置页同一个菜单口径）+ 重命名 / 删除 */
  const draftMenuFor = useCallback(
    (draft: WorkshopDraftSummary): MenuProps['items'] => [
      { key: 'build', icon: <RiHammerLine size={14} />, label: t('workshopSettings.action.build') },
      {
        key: 'verify',
        icon: <RiShieldCheckLine size={14} />,
        label: t('workshopSettings.action.verify')
      },
      {
        key: 'publish',
        icon: <RiUploadCloud2Line size={14} />,
        label: draft.installed
          ? t('workshopSettings.action.update')
          : t('workshopSettings.action.publish')
      },
      { type: 'divider' },
      { key: 'rename', icon: <RiEditLine size={14} />, label: t('harness.sidebar.pluginRename') },
      { type: 'divider' },
      {
        key: 'remove',
        danger: true,
        icon: <RiDeleteBin6Line size={14} />,
        label: t('harness.sidebar.pluginDelete')
      }
    ],
    [t]
  )

  const onDraftMenuClick = useCallback(
    (draft: WorkshopDraftSummary, key: string): void => {
      switch (key) {
        case 'build':
          void buildDraft(draft.id)
          break
        case 'verify':
          void verifyDraft(draft.id)
          break
        case 'publish':
          void publishDraft(draft.id, () => {
            void message.success(t('workshopSettings.publish.done'))
          })
          break
        case 'rename':
          openDraftRename(draft)
          break
        case 'remove':
          handleRemoveDraft(draft)
          break
        default:
          break
      }
    },
    [buildDraft, verifyDraft, publishDraft, openDraftRename, handleRemoveDraft, message, t]
  )

  /** 打开工坊里某份插件的详情（设置弹窗 → 插件工坊 → 该插件抽屉） */
  const openDraft = useCallback((id: string): void => {
    // 点插件 = 当前内容切到插件这一侧（开关跟着内容走）
    window.dispatchEvent(new CustomEvent(WORKSHOP_FOCUS_EVENT))
    window.dispatchEvent(
      new CustomEvent('open-system-settings', {
        detail: { tab: 'workshop', scope: 'assistant' }
      })
    )
    // 抽屉要等设置弹窗与工坊页挂载后再展开，因此下一个宏任务里再派发
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('workshop-open-draft', { detail: { id } }))
    }, 0)
  }, [])

  /* ── 工作区状态 ── */
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([])
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<number | null>(null)
  const [expandedWorkspaceId, setExpandedWorkspaceId] = useState<number | null>(null)
  const [hoveredWorkspaceId, setHoveredWorkspaceId] = useState<number | null>(null)
  /** 非当前工作区的会话缓存（展开时按需拉取；当前工作区始终用 topics 属性保证实时） */
  const [workspaceTopics, setWorkspaceTopics] = useState<Record<number, HarnessTopicRow[]>>({})
  const [workspaceTopicsLoading, setWorkspaceTopicsLoading] = useState<Record<number, boolean>>({})

  /* 搜索 */
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<InputRef | null>(null)
  useEffect(() => {
    if (searchMode) searchInputRef.current?.focus()
  }, [searchMode])

  /* 重命名弹窗 */
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<WorkspaceRow | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)

  // Mnemon 记忆概览状态
  const [memoryExpanded, setMemoryExpanded] = useState(false)
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memorySnap, setMemorySnap] = useState<MnemonSidebarSnapshot | null>(null)
  /**
   * 记忆跟着**当前会话**走（用户口径 2026-09-28「插件的记忆，并没有像工作里面的记忆一样
   * 显示在侧边栏」）：插件会话 → 这份插件自己的记忆；工作会话 / 空白会话 → 当前工作区。
   * 值由 useHarnessHandlers 在切会话时写（见 renderer/memory-scope.ts）。
   *
   * 标题**只写「记忆」**，不缀作用域名（用户口径 2026-09-28「不需要（记忆 · 个人记账台账）
   * 这个内容」）：这一行本来就在会话侧，读哪一套由当前会话决定，不必再复述一遍。
   * 设置 → 记忆页那边不一样——那一页脱离了会话上下文，仍然标出管的是哪份插件。
   */
  const memoryScope = useMemoryScope()

  const loadMnemonSnapshot = useCallback(async () => {
    setMemoryLoading(true)
    try {
      const snap = await harnessApi.harness.mnemonSnapshot(memoryScope)
      if (!snap.configured) {
        setMemorySnap({ configured: false })
      } else {
        setMemorySnap({
          configured: true,
          runtime: snap.runtime
            ? {
                entries: snap.runtime.entries,
                targets: snap.runtime.targets
              }
            : undefined,
          bodies: snap.bodies
            ? { total: snap.bodies.total, activeCount: snap.bodies.activeCount }
            : undefined,
          documents: snap.documents
            ? { total: snap.documents.total, activeCount: snap.documents.activeCount }
            : undefined
        })
      }
    } catch {
      setMemorySnap({ configured: false })
    } finally {
      setMemoryLoading(false)
    }
  }, [memoryScope])

  // 展开记忆面板时加载概览
  const handleToggleMemory = useCallback(async () => {
    const next = !memoryExpanded
    setMemoryExpanded(next)
    if (next) {
      await loadMnemonSnapshot()
    }
  }, [memoryExpanded, loadMnemonSnapshot])

  /**
   * 作用域一变（切到别的插件会话／回到工作会话）就重载。
   * 展开态先清空再拉：那是**另一个目录**的记忆，留着上一个作用域的条目会看成串了记忆。
   */
  const scopeRef = useRef<string | null>(null)
  useEffect(() => {
    if (scopeRef.current === memoryScope) return
    scopeRef.current = memoryScope
    if (!memoryExpanded) return
    setMemorySnap(null)
    void loadMnemonSnapshot()
  }, [memoryScope, memoryExpanded, loadMnemonSnapshot])

  // 打开系统设置记忆页
  const handleOpenMemorySettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent('open-system-settings', { detail: { tab: 'memory' } }))
  }, [])

  // 监听记忆变更事件（对话中模型写记忆后刷新概览）
  useEffect(() => {
    const handleRefresh = (): void => {
      if (memoryExpanded) {
        loadMnemonSnapshot()
      }
    }
    window.addEventListener('memory-tree-refresh', handleRefresh)
    return () => window.removeEventListener('memory-tree-refresh', handleRefresh)
  }, [memoryExpanded, loadMnemonSnapshot])

  /* ── 工作区与会话 ── */

  const loadWorkspaces = useCallback(async (): Promise<{
    list: WorkspaceRow[]
    activeId: number | null
  }> => {
    try {
      const [list, settings] = await Promise.all([
        harnessApi.harness.getAllWorkspaces(),
        window.api.systemSettings.getAll()
      ])
      const activeId = settings.harness.activeWorkspaceId ?? null
      setWorkspaces(list)
      setActiveWorkspaceId(activeId)
      return { list, activeId }
    } catch (err) {
      console.error('Failed to load workspaces:', err)
      return { list: [], activeId: null }
    }
  }, [])

  /** 非当前工作区的会话按需拉取；取第一页（与 useHarness 的分页口径一致，切换时列表长度不跳变） */
  const loadWorkspaceTopics = useCallback(async (workspaceId: number): Promise<void> => {
    setWorkspaceTopicsLoading((prev) => ({ ...prev, [workspaceId]: true }))
    try {
      const result = await harnessApi.harness.getAllTopicsPaginated(
        workspaceId,
        0,
        TOPICS_PAGE_SIZE
      )
      setWorkspaceTopics((prev) => ({ ...prev, [workspaceId]: result.items }))
    } catch (err) {
      console.error('Failed to load workspace topics:', err)
    } finally {
      setWorkspaceTopicsLoading((prev) => ({ ...prev, [workspaceId]: false }))
    }
  }, [])

  /**
   * 单一数据源：列表一律渲染 workspaceTopics 缓存。
   * useHarness 的 topics 属性只负责把它所属工作区的缓存「刷新成最新」——
   * 切换工作区的瞬间 topics 仍属于旧工作区，绝不能直接拿来渲染新工作区（列表会闪成旧数据）。
   */
  useEffect(() => {
    if (topicsWorkspaceId == null) return
    setWorkspaceTopics((prev) => ({ ...prev, [topicsWorkspaceId]: topics }))
  }, [topicsWorkspaceId, topics])

  // 首次进入：载入工作区列表并展开当前工作区
  useEffect(() => {
    loadWorkspaces().then(({ list, activeId }) => {
      setExpandedWorkspaceId(activeId ?? list[0]?.id ?? null)
    })
  }, [loadWorkspaces])

  // 切换工作区（含子代理等外部入口）：同步激活态、展开态与记忆概览
  useEffect(() => {
    const handleWorkspaceChanged = (e: Event): void => {
      const detail = (e as CustomEvent<{ workspaceId?: number }>).detail
      const nextId = detail?.workspaceId ?? null
      if (memoryExpanded) {
        // 展开态：先清空旧工作区快照再重载（记忆按工作区隔离，不能残留旧内容）
        setMemorySnap(null)
        loadMnemonSnapshot()
      } else {
        // 折叠态：只刷新数字，不清空，避免「记忆」这一行跟着闪一下
        loadMnemonSnapshot()
      }
      if (nextId != null) {
        setActiveWorkspaceId(nextId)
        setExpandedWorkspaceId(nextId)
      }
      loadWorkspaces().then()
    }
    window.addEventListener('workspace-changed', handleWorkspaceChanged)
    return () => window.removeEventListener('workspace-changed', handleWorkspaceChanged)
  }, [memoryExpanded, loadMnemonSnapshot, loadWorkspaces])

  /** 切换工作区：写设置 + 派发事件（Index 负责清空当前会话并刷新会话列表） */
  const switchWorkspace = useCallback(async (ws: WorkspaceRow): Promise<void> => {
    try {
      await window.api.systemSettings.update({
        harness: {
          workspacePath: ws.path,
          activeWorkspaceId: ws.id
        } as Parameters<typeof window.api.systemSettings.update>[0]['harness']
      })
      setActiveWorkspaceId(ws.id)
      window.dispatchEvent(new CustomEvent('workspace-changed', { detail: { workspaceId: ws.id } }))
    } catch (err) {
      console.error('Failed to switch workspace:', err)
    }
  }, [])

  /** 展开/收起工作区；展开时按需拉取该工作区的会话 */
  const handleToggleWorkspace = useCallback(
    (workspaceId: number): void => {
      const next = expandedWorkspaceId === workspaceId ? null : workspaceId
      setExpandedWorkspaceId(next)
      if (next != null && next !== activeWorkspaceId) {
        loadWorkspaceTopics(next).then()
      }
    },
    [expandedWorkspaceId, activeWorkspaceId, loadWorkspaceTopics]
  )

  /**
   * 草稿 → 它的「插件工作区」id（插件会话的工作目录 = 插件源码目录，见 main/workshop/workspace.ts）。
   * 还没给这份插件开过会话时没有这一行（返回 null，插件行也就没有可展开的会话）。
   * 清单由主进程给（`workshop-state.pluginWorkspaces`）：渲染层不自己拼路径，
   * 免得两边对「什么算插件目录」有两套说法。
   */
  const pluginWorkspaceIdOf = useCallback(
    (draft: WorkshopDraftSummary): number | null =>
      pluginWorkspaces.find((item) => item.draftId === draft.id)?.workspaceId ?? null,
    [pluginWorkspaces]
  )

  /** 插件工作区集合（工作列表要把这些行滤掉：它们只属于那份插件，不进「工作」模式） */
  const pluginWorkspaceIds = useMemo(
    () => new Set(pluginWorkspaces.map((item) => item.workspaceId)),
    [pluginWorkspaces]
  )

  /**
   * 打开某个工作区下的会话：跨工作区时先切换工作区。
   *
   * 模式开关跟着内容走：插件工作区里的会话 = 插件内容 → 停在「插件」；
   * 普通工作区的会话 → 「工作」（用户口径 2026-09-27「要看当前是在工作的选中内容
   * 还是插件的选中内容」）。
   */
  const handleOpenTopic = useCallback(
    async (workspaceId: number, topic: HarnessTopicRow): Promise<void> => {
      const isPluginSession = pluginWorkspaceIds.has(workspaceId)
      setMode(isPluginSession ? 'plugin' : 'chat')
      if (workspaceId !== activeWorkspaceId) {
        const ws = workspaces.find((w) => w.id === workspaceId)
        if (ws) await switchWorkspace(ws)
      }
      if (isPluginSession) setExpandedWorkspaceId(workspaceId)
      await onSelectTopic(topic)
    },
    [activeWorkspaceId, workspaces, switchWorkspace, onSelectTopic, pluginWorkspaceIds]
  )

  /** 在指定工作区新建会话：跨工作区时先切换工作区 */
  const handleCreateSession = useCallback(
    async (ws: WorkspaceRow): Promise<void> => {
      setExpandedWorkspaceId(ws.id)
      // 该工作区会话尚未加载过时先补一次，避免切换瞬间出现空列表
      if (!Object.prototype.hasOwnProperty.call(workspaceTopics, ws.id)) {
        loadWorkspaceTopics(ws.id).then()
      }
      if (ws.id !== activeWorkspaceId) {
        await switchWorkspace(ws)
      }
      onNewHarness()
    },
    [activeWorkspaceId, workspaceTopics, loadWorkspaceTopics, switchWorkspace, onNewHarness]
  )

  /**
   * 插件行的 ＋：针对这个插件开一个新会话（对齐工作区行的「＋ 新建会话」）。
   *
   * **工作目录是这份插件自己的源码目录**（`<插件存放路径>/<插件 id>/`）：先让主进程取
   * （必要时创建）它的「插件工作区」，再像切换普通工作区一样切过去——AI 工作目录、
   * 资源管理器、文件边界、文件改动审查全都跟着它走。用户口径 2026-09-28「在插件模式下新建会话，
   * 其工作区还是之前工作模式下选中的工作区，资源管理器也一样」＝这就是要修的那件事。
   *
   * **不往输入框写任何东西**（用户口径 2026-09-28「我需要的是不要显示：给插件「个人记账台账」
   * （id: personal-ledger）这个玩意」）：新会话就是干净的空白会话，只把光标放进输入框，
   * 要做什么由用户自己打。
   *
   * **带上插件 id**：这条会话的记忆用**这份插件自己的**（`<memoryPath>/plugin-<id>/`），
   * 与工作记忆零交叉（用户口径 2026-09-28「插件里面的记忆应该是独立的，现在是直接使用工作里面
   * 之前选中的记忆上下文，会导致有问题」）。id 由输入框那边在**建话题**时写进
   * `harness_topic.memory_scope`（见 useHarnessHandlers 的 harness-focus-input 监听）。
   *
   * 也**刻意不切模式**（用户口径 2026-09-27「为什么我在插件里面点击新建会话，会切换到工作」）：
   * 人还在挑插件，面板就别自己跳走，开关仍停在「插件」。
   *
   * @param options.topic 直接打开这条会话（切模式回来时用：那条会话还在，只是接着看）
   * @param options.focus 是否把光标送进输入框（点 ＋ 时为 true；切模式自动进入时为 false——
   *   用户只是想看插件这一侧的内容，不该顺手抢走焦点）
   */
  const handlePluginSession = useCallback(
    async (
      draft: { id: string },
      options?: { topic?: HarnessTopicRow; focus?: boolean }
    ): Promise<void> => {
      // ① 插件工作区（= 插件源码目录）：没有就建，有就直接用
      const ensured = await harnessApi.workshop.ensureWorkspace(draft.id)
      if (!ensured.ok || !ensured.data) {
        viewMessage('plugin-session-ws', 'error', ensured.error ?? '', 6)
        return
      }
      const target = ensured.data
      // ② 切过去（写设置 + 派发事件：Index 据此换资源管理器根并清空当前会话）
      try {
        await window.api.systemSettings.update({
          harness: {
            workspacePath: target.path,
            activeWorkspaceId: target.id
          } as Parameters<typeof window.api.systemSettings.update>[0]['harness']
        })
      } catch (err) {
        console.error('Failed to switch to plugin workspace:', err)
        viewMessage('plugin-session-ws', 'error', String(err), 6)
        return
      }
      setActiveWorkspaceId(target.id)
      setExpandedWorkspaceId(target.id)
      window.dispatchEvent(
        new CustomEvent('workspace-changed', { detail: { workspaceId: target.id } })
      )
      // 刚建出来的插件工作区要立刻进本地清单（草稿行才能展开、工作列表才能滤掉它）
      await Promise.all([loadWorkspaces(), loadDrafts()])
      // 记下「插件模式当前那一条内容」：切模式回来时接着看它（见 enterPluginModeContent）
      pluginContentRef.current = {
        pluginId: draft.id,
        workspaceId: target.id,
        topicId: options?.topic?.id ?? null
      }
      // ③ 有指定会话就直接打开它；否则开一条空白新会话 + 把「这条会话属于哪份插件」带过去
      //    （决定用哪套记忆）；只聚焦，不写内容
      if (options?.topic) {
        await onSelectTopic(options.topic)
      } else {
        onNewHarness()
      }
      if (options?.focus !== false) {
        window.dispatchEvent(
          new CustomEvent('harness-focus-input', { detail: { pluginId: draft.id, focus: true } })
        )
      } else {
        // 不抢光标，但**作用域还是要带过去**：这条空白会话属于这份插件（决定它用哪套记忆）
        window.dispatchEvent(
          new CustomEvent('harness-focus-input', { detail: { pluginId: draft.id, focus: false } })
        )
      }
    },
    [loadDrafts, loadWorkspaces, onNewHarness, onSelectTopic, viewMessage]
  )

  /** 选择文件夹后直接创建并激活工作区（名称取目录名，之后可重命名） */
  const handleBrowseFolder = useCallback(async (): Promise<void> => {
    try {
      const dir = await harnessApi.harness.selectWorkspace()
      if (!dir) return
      const name =
        dir
          .replace(/[/\\]$/, '')
          .split(/[/\\]/)
          .pop() || t('harness.sidebar.defaultWorkspaceName')
      const id = await harnessApi.harness.createWorkspace(name, dir)
      await window.api.systemSettings.update({
        harness: {
          workspacePath: dir,
          activeWorkspaceId: id
        } as Parameters<typeof window.api.systemSettings.update>[0]['harness']
      })
      setActiveWorkspaceId(id)
      setExpandedWorkspaceId(id)
      window.dispatchEvent(new CustomEvent('workspace-changed', { detail: { workspaceId: id } }))
      onNewHarness()
      await loadWorkspaces()
    } catch (err) {
      console.error('Failed to create workspace:', err)
    }
  }, [loadWorkspaces, onNewHarness, t])

  const handleDeleteWorkspace = useCallback(
    (ws: WorkspaceRow): void => {
      modal.confirm({
        title: t('harness.sidebar.workspaceDeleteConfirmTitle'),
        content: t('harness.sidebar.workspaceDeleteConfirmContent', { name: ws.name }),
        okText: t('common.action.delete'),
        okType: 'danger',
        cancelText: t('common.action.cancel'),
        onOk: async () => {
          try {
            await harnessApi.harness.deleteWorkspace(ws.id)
            if (activeWorkspaceId === ws.id) {
              // 删除的是当前工作区：自动切到剩余的用户工作区；一个都不剩则回到「未配置」状态。
              // 插件工作区不算「用户的」——切过去的话用户会莫名其妙落到某个插件目录上
              const remaining = (await harnessApi.harness.getAllWorkspaces()).filter(
                (candidate) => !pluginWorkspaceIds.has(candidate.id)
              )
              if (remaining.length > 0) {
                const next = remaining[0]
                await window.api.systemSettings.update({
                  harness: {
                    workspacePath: next.path,
                    activeWorkspaceId: next.id
                  } as Parameters<typeof window.api.systemSettings.update>[0]['harness']
                })
                setActiveWorkspaceId(next.id)
                setExpandedWorkspaceId(next.id)
                window.dispatchEvent(
                  new CustomEvent('workspace-changed', { detail: { workspaceId: next.id } })
                )
              } else {
                await window.api.systemSettings.update({
                  harness: {
                    workspacePath: '',
                    activeWorkspaceId: undefined
                  } as Parameters<typeof window.api.systemSettings.update>[0]['harness']
                })
                setActiveWorkspaceId(null)
                setExpandedWorkspaceId(null)
                setWorkspaceTopics({})
                window.dispatchEvent(new CustomEvent('workspace-changed', { detail: {} }))
              }
              // 原会话已随工作区删除，回到空白欢迎态
              onNewHarness()
            }
            await loadWorkspaces()
          } catch (err) {
            console.error('Failed to delete workspace:', err)
          }
        }
      })
    },
    [activeWorkspaceId, modal, loadWorkspaces, onNewHarness, t, pluginWorkspaceIds]
  )

  /* 打开重命名弹窗 */
  const openRename = useCallback((ws: WorkspaceRow): void => {
    setRenameTarget(ws)
    setRenameName(ws.name)
    setRenameOpen(true)
  }, [])

  /* 保存重命名 */
  const handleRenameSave = useCallback(async (): Promise<void> => {
    const name = renameName.trim()
    if (!name || !renameTarget) {
      viewMessage('ws-rename-validate', 'warning', t('harness.sidebar.workspaceNameRequired'))
      return
    }
    try {
      setRenameSaving(true)
      await harnessApi.harness.updateWorkspace(renameTarget.id, { name })
      setRenameOpen(false)
      await loadWorkspaces()
      viewMessage('ws-rename-done', 'success', t('harness.sidebar.renameSuccess'), 2)
    } catch (err) {
      console.error('Failed to rename workspace:', err)
      viewMessage('ws-rename-error', 'error', t('harness.sidebar.renameFailed'))
    } finally {
      setRenameSaving(false)
    }
  }, [renameName, renameTarget, viewMessage, loadWorkspaces, t])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el || isLoadingMoreTopics || !hasMoreTopics) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      onLoadMoreTopics()
    }
  }, [isLoadingMoreTopics, hasMoreTopics, onLoadMoreTopics])

  /* 某个工作区当前的会话列表：统一取缓存（由 topics 属性按所属工作区刷新） */
  const topicsOf = useCallback(
    (workspaceId: number): HarnessTopicRow[] => workspaceTopics[workspaceId] ?? [],
    [workspaceTopics]
  )
  /** 该工作区的会话是否已加载过（未加载过才显示 spinner，避免空列表闪一下） */
  const hasTopicsLoaded = useCallback(
    (workspaceId: number): boolean =>
      Object.prototype.hasOwnProperty.call(workspaceTopics, workspaceId),
    [workspaceTopics]
  )

  const query = searchQuery.trim().toLowerCase()

  /** 真正属于用户的工作区（插件工作区不进这个列表，用户口径 2026-09-28「只属于那份插件」） */
  const userWorkspaces = workspaces.filter((ws) => !pluginWorkspaceIds.has(ws.id))
  const visibleWorkspaces = query
    ? userWorkspaces.filter(
        (ws) =>
          ws.name.toLowerCase().includes(query) ||
          topicsOf(ws.id).some((t) => t.title.toLowerCase().includes(query))
      )
    : userWorkspaces
  const visibleTopicsOf = (workspaceId: number): HarnessTopicRow[] => {
    const list = topicsOf(workspaceId)
    return query ? list.filter((t) => t.title.toLowerCase().includes(query)) : list
  }
  /** 插件模式下的草稿清单（搜索框在两种模式里共用：按名字/id/它自己的会话标题过滤） */
  const visibleDrafts = query
    ? drafts.filter((draft) => {
        if (draft.title.toLowerCase().includes(query) || draft.id.toLowerCase().includes(query)) {
          return true
        }
        const wsId = pluginWorkspaceIdOf(draft)
        return wsId != null && topicsOf(wsId).some((t) => t.title.toLowerCase().includes(query))
      })
    : drafts

  /** 草稿状态行：构建 / 验收 / 安装三件事各自的最新结果 */
  const draftStateOf = (draft: WorkshopDraftSummary): { text: string; color: string } => {
    if (draft.installed) {
      return {
        text: draft.enabled
          ? t('harness.sidebar.pluginState.enabled')
          : t('harness.sidebar.pluginState.disabled'),
        color: draft.enabled ? token.colorSuccess : colorTextTertiary
      }
    }
    if (draft.lastReport) {
      return draft.lastReport.ok
        ? { text: t('harness.sidebar.pluginState.verified'), color: token.colorSuccess }
        : {
            text: t('harness.sidebar.pluginState.verifyFailed', {
              failed: draft.lastReport.failed
            }),
            color: token.colorError
          }
    }
    if (draft.built)
      return { text: t('harness.sidebar.pluginState.built'), color: colorTextTertiary }
    return { text: t('harness.sidebar.pluginState.draft'), color: colorTextTertiary }
  }

  /**
   * 插件行：点一行 = 打开它的工坊详情；悬停出现「⋯（构建/验收/安装/重命名/删除）」与
   * 「＋（针对这个插件新建会话）」——与工作区行的两个行内动作一一对应
   * （用户口径 2026-09-27「插件没有像工作区那样的功能」）。
   *
   * 这份插件开过会话之后，标题右边多一个折叠箭头：展开就是**它自己的会话**
   * （会话挂在「插件工作区」下 = 插件源码目录，见 main/workshop/workspace.ts）。
   * 与工作区行的差别只在触发方式——那一行整行可点（点行 = 展开），
   * 这一行整行是「打开工坊详情」，所以折叠要单独给一个箭头，不抢既有的点击语义。
   * 用户口径 2026-09-28「插件目录不进『工作』列表，只属于那份插件」。
   */
  const renderDraft = (draft: WorkshopDraftSummary): React.ReactNode => {
    const state = draftStateOf(draft)
    /** 这一行正跑着构建/验收/安装：行内动作先收起来，避免重复点 */
    const busy = draftBusyId === draft.id
    /** 这份插件的「插件工作区」（会话的工作目录）；没开过会话就还没有这一行 */
    const pluginWsId = pluginWorkspaceIdOf(draft)
    const expanded = pluginWsId != null && expandedWorkspaceId === pluginWsId
    return (
      <div key={draft.id} className="mb-0.5">
        <div
          className="group flex items-center gap-2 mx-2 my-0.5 rounded-md cursor-pointer transition-colors"
          style={{
            paddingLeft: 6,
            paddingRight: 8,
            height: 32,
            color: colorText,
            background: expanded ? token.colorFillTertiary : 'transparent'
          }}
          onClick={() => openDraft(draft.id)}
          onMouseEnter={(e) => {
            if (!expanded) e.currentTarget.style.background = colorFillAlter
          }}
          onMouseLeave={(e) => {
            if (!expanded) e.currentTarget.style.background = 'transparent'
          }}
        >
          <span
            className="flex items-center justify-center shrink-0"
            style={{ width: 16, color: colorTextSecondary }}
          >
            {busy ? <ChaseDots size={14} color={colorTextTertiary} /> : <RiPuzzleLine size={15} />}
          </span>
          <span className="flex-1 min-w-0 truncate" style={{ fontSize: 13 }}>
            {draft.title}
          </span>
          {pluginWsId != null && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                handleToggleWorkspace(pluginWsId)
              }}
              title={
                expanded
                  ? t('harness.sidebar.pluginSessionsCollapse')
                  : t('harness.sidebar.pluginSessionsExpand')
              }
              className="flex items-center justify-center shrink-0 rounded"
              style={{
                width: 20,
                height: 20,
                color: colorTextTertiary,
                background: 'transparent'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = token.colorFillSecondary)}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              {expanded ? <RiArrowDownSLine size={15} /> : <RiArrowRightSLine size={15} />}
            </button>
          )}
          {!busy && (
            <span
              className="shrink-0 group-hover:hidden"
              style={{ fontSize: 11, color: state.color }}
            >
              {state.text}
            </span>
          )}
          {!busy && (
            <span className="hidden group-hover:flex items-center gap-0.5 shrink-0">
              <Dropdown
                menu={{
                  items: draftMenuFor(draft),
                  onClick: ({ key, domEvent }) => {
                    domEvent.stopPropagation()
                    onDraftMenuClick(draft, key)
                  }
                }}
                trigger={['click']}
                placement="bottomRight"
              >
                <button
                  onClick={(e) => e.stopPropagation()}
                  title={t('harness.sidebar.pluginActions')}
                  className="flex items-center justify-center rounded"
                  style={{
                    width: 22,
                    height: 22,
                    color: colorTextSecondary,
                    background: 'transparent'
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = token.colorFillSecondary)
                  }
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <RiMoreLine size={15} />
                </button>
              </Dropdown>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void handlePluginSession(draft)
                }}
                title={t('harness.sidebar.pluginNewSession')}
                className="flex items-center justify-center rounded"
                style={{
                  width: 22,
                  height: 22,
                  color: colorTextSecondary,
                  background: 'transparent'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = token.colorFillSecondary)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <RiAddLine size={16} />
              </button>
            </span>
          )}
        </div>

        {/* 展开 = 这份插件自己的会话（挂在插件工作区下，与其他工作区的会话同一套渲染） */}
        {expanded && pluginWsId != null && renderTopicList(pluginWsId)}
      </div>
    )
  }

  /* 按目标分组的热记忆数量 */
  const userEntries = memorySnap?.runtime?.entries.filter((e) => e.target === 'user') ?? []
  const memoryEntries = memorySnap?.runtime?.entries.filter((e) => e.target === 'memory') ?? []

  /* 头部小图标按钮 */
  const iconBtn = (title: string, onClick: () => void, icon: React.ReactNode): React.ReactNode => (
    <button
      title={title}
      onClick={onClick}
      className="flex items-center justify-center rounded transition-colors"
      style={{
        width: 26,
        height: 26,
        border: 'none',
        background: 'transparent',
        color: colorTextSecondary,
        cursor: 'pointer'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = colorFillAlter
        e.currentTarget.style.color = colorText
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = colorTextSecondary
      }}
    >
      {icon}
    </button>
  )

  /** 会话行 */
  const renderTopicRow = (workspaceId: number, topic: HarnessTopicRow): React.ReactNode => {
    const isTopicLoading = loadingTopicIds.has(topic.id)
    const selected = workspaceId === activeWorkspaceId && currentTopicId === topic.id
    return (
      <div
        key={topic.id}
        onClick={() => handleOpenTopic(workspaceId, topic)}
        /* 稳定钩子：工装靠它判断「现在是哪一条会话」（切模式后内容有没有跟着切） */
        data-topic-id={topic.id}
        data-topic-selected={selected ? '1' : '0'}
        className="group flex items-center gap-2 mx-2 my-0.5 rounded-md cursor-pointer transition-colors"
        style={{
          // 左内边距 6 + 行首 16px 指示槽 = 与工作区行图标列（14~30px）对齐；
          // 槽位 + gap(8) 后标题落在 38px，与工作区名称同列
          paddingLeft: 6,
          paddingRight: 8,
          height: 30,
          color: selected ? colorText : colorTextSecondary,
          background: selected ? token.colorFill : 'transparent'
        }}
        onMouseEnter={(e) => {
          if (!selected) e.currentTarget.style.background = token.colorFillQuaternary
        }}
        onMouseLeave={(e) => {
          if (!selected) e.currentTarget.style.background = 'transparent'
        }}
      >
        {/* 行首指示槽：固定 16px（平时留空，生成中显示追逐点），保证与工作区图标同列且标题不位移 */}
        <span
          className="flex items-center justify-center shrink-0"
          style={{ width: 16, height: 16 }}
        >
          {isTopicLoading && <ChaseDots size={14} color={colorTextTertiary} />}
        </span>
        <span className="flex-1 min-w-0 truncate" style={{ fontSize: 13 }}>
          {topic.title}
        </span>
        {!isTopicLoading && (
          <span
            className="shrink-0 group-hover:hidden"
            style={{ fontSize: 11, color: colorTextTertiary }}
          >
            {formatRelativeTime(t, topic.updated_at)}
          </span>
        )}
        <Dropdown
          menu={{
            items: [
              {
                key: 'delete',
                // 会话生成中禁止删除（含后台仍在流式输出的话题）
                label: isTopicLoading
                  ? t('harness.sidebar.topicDeleteBlocked')
                  : t('harness.sidebar.topicDelete'),
                danger: true,
                disabled: isTopicLoading,
                icon: <RiDeleteBin6Line size={14} />,
                // 删除非当前工作区的会话：useHarness 只刷新当前工作区列表，这里补刷本地缓存
                onClick: async () => {
                  if (isTopicLoading) return
                  await onDeleteTopic(topic.id)
                  if (workspaceId !== activeWorkspaceId) {
                    await loadWorkspaceTopics(workspaceId)
                  }
                }
              }
            ]
          }}
          trigger={['click']}
          placement="bottomRight"
        >
          <button
            onClick={(e) => e.stopPropagation()}
            title={
              isTopicLoading ? t('harness.sidebar.topicRunning') : t('harness.sidebar.topicActions')
            }
            className="hidden group-hover:flex items-center justify-center shrink-0 rounded"
            style={{ width: 20, height: 20, color: colorTextTertiary, background: 'transparent' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = token.colorFillSecondary)}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <RiMoreLine size={15} />
          </button>
        </Dropdown>
      </div>
    )
  }

  /** 工作区行 + 其下会话 */
  const renderWorkspace = (ws: WorkspaceRow): React.ReactNode => {
    const expanded = expandedWorkspaceId === ws.id
    const active = activeWorkspaceId === ws.id
    // 该工作区下是否有会话正在生成（用未过滤的完整列表判断，避免搜索时漏判）：
    // 有则禁止删除该工作区，否则会连坐删掉进行中的会话
    const hasRunningTopic = topicsOf(ws.id).some((t) => loadingTopicIds.has(t.id))
    const hovered = hoveredWorkspaceId === ws.id
    const showControls = hovered || active

    return (
      <div key={ws.id} className="mb-0.5">
        <div
          onClick={() => handleToggleWorkspace(ws.id)}
          className="flex items-center gap-2 mx-2 rounded-md cursor-pointer transition-colors"
          style={{
            padding: '0 6px',
            height: 32,
            background: expanded ? token.colorFillTertiary : 'transparent'
          }}
          onMouseEnter={(e) => {
            setHoveredWorkspaceId(ws.id)
            if (!expanded) e.currentTarget.style.background = token.colorFillQuaternary
          }}
          onMouseLeave={(e) => {
            setHoveredWorkspaceId(null)
            if (!expanded) e.currentTarget.style.background = 'transparent'
          }}
        >
          <span
            className="flex items-center justify-center shrink-0"
            style={{ width: 16, color: expanded ? colorTextSecondary : colorTextTertiary }}
          >
            {expanded ? <RiFolderOpenLine size={15} /> : <RiFolder2Line size={15} />}
          </span>
          <span
            className="flex-1 min-w-0 truncate"
            style={{ fontSize: 13, color: colorText, fontWeight: 500 }}
          >
            {ws.name}
          </span>

          {/* 悬停/激活时显示：重命名删除菜单 + 新建会话 */}
          <span className="flex items-center gap-0.5 shrink-0">
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'rename',
                    label: t('common.action.rename'),
                    icon: <RiEditLine size={14} />,
                    onClick: () => openRename(ws)
                  },
                  {
                    key: 'delete',
                    // 该工作区下有会话正在生成时禁止删除（避免连坐删掉进行中的会话）
                    label: hasRunningTopic
                      ? t('harness.sidebar.workspaceHasRunning')
                      : t('harness.sidebar.workspaceDelete'),
                    danger: true as const,
                    disabled: hasRunningTopic,
                    icon: <RiDeleteBin6Line size={14} />,
                    onClick: () => {
                      if (hasRunningTopic) return
                      handleDeleteWorkspace(ws)
                    }
                  }
                ]
              }}
              trigger={['click']}
              placement="bottomRight"
            >
              <button
                onClick={(e) => e.stopPropagation()}
                title={
                  hasRunningTopic
                    ? t('harness.sidebar.workspaceHasRunning')
                    : t('harness.sidebar.workspaceActions')
                }
                className="flex items-center justify-center rounded transition-opacity"
                style={{
                  width: 22,
                  height: 22,
                  color: colorTextSecondary,
                  background: 'transparent',
                  opacity: showControls ? 1 : 0,
                  pointerEvents: showControls ? 'auto' : 'none'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = token.colorFillSecondary)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <RiMoreLine size={15} />
              </button>
            </Dropdown>
            <button
              onClick={(e) => {
                e.stopPropagation()
                handleCreateSession(ws)
              }}
              title={t('harness.sidebar.newSession')}
              className="flex items-center justify-center rounded transition-opacity"
              style={{
                width: 22,
                height: 22,
                color: colorTextSecondary,
                background: 'transparent',
                opacity: showControls ? 1 : 0,
                pointerEvents: showControls ? 'auto' : 'none'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = token.colorFillSecondary)}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <RiAddLine size={16} />
            </button>
          </span>
        </div>

        {expanded && renderTopicList(ws.id)}
      </div>
    )
  }

  /**
   * 某个工作区展开后的会话列表。
   *
   * 工作区行与插件行共用同一套（插件会话就挂在它的「插件工作区」下）：加载骨架 / 空态 /
   * 会话行 / 滚动分页的落点全部一致，免得两处各写一份、日子久了两边长得不一样。
   *
   * 空态与 loading 一样在整栏居中：不能再加左侧缩进，否则 text-center 只在「缩进剩下的」
   * 区域里居中，看起来整体偏右。
   */
  const renderTopicList = (workspaceId: number): React.ReactNode => {
    const list = visibleTopicsOf(workspaceId)
    // 只有「该工作区会话从未加载过」才算加载中：缓存已有内容时直接无缝渲染
    const loading =
      !hasTopicsLoaded(workspaceId) &&
      (workspaceId === activeWorkspaceId || workspaceTopicsLoading[workspaceId] === true)
    return (
      <div className="pb-1">
        {loading && list.length === 0 ? (
          <div className="py-1">
            <SkeletonListRows rows={5} variant="stacked" />
          </div>
        ) : list.length === 0 ? (
          <p className="text-center py-3" style={{ fontSize: 12, color: colorTextTertiary }}>
            {query ? t('harness.sidebar.noMatchTopic') : t('harness.sidebar.emptyTopics')}
          </p>
        ) : (
          <>
            {list.map((topic) => renderTopicRow(workspaceId, topic))}
            {/* 仅当前工作区的「滚动分页」显示底部 spinner；整表刷新（切换工作区）不显示，避免闪动 */}
            {workspaceId === activeWorkspaceId &&
              isLoadingMoreTopics &&
              !isRefreshingTopics &&
              hasMoreTopics && (
                /* 滚动分页的落点是「下面还会长出话题」，所以铺两行话题骨架而不是居中转圈 */
                <div className="py-1">
                  <SkeletonListRows rows={2} variant="stacked" />
                </div>
              )}
          </>
        )}
      </div>
    )
  }

  /* ── 切换模式 = 同时切到那个模式「当前那一条内容」 ───────────────────────────
   * 用户口径 2026-09-28「切换工作模式或者插件模式下，就默认切换到当前模式下的默认选中项的内容」：
   * 面板在看哪一类内容，主区域就跟着显示那一类内容里当前选中的那一条——
   * 否则会出现「侧栏列着工作区、主区域还停在一段插件会话上」这种开关与内容打架的状态。
   */

  /** 当前内容是不是插件那一侧的（活动工作区是插件工作区）——两个 enter* 都按它判要不要动 */
  const inPluginContent = activeWorkspaceId != null && pluginWorkspaceIds.has(activeWorkspaceId)

  // 记下工作模式最后待过的用户工作区（切回工作模式时优先回到它，而不是永远回到第一个）
  useEffect(() => {
    if (activeWorkspaceId != null && !pluginWorkspaceIds.has(activeWorkspaceId)) {
      lastWorkWorkspaceIdRef.current = activeWorkspaceId
    }
  }, [activeWorkspaceId, pluginWorkspaceIds])

  // 记下两个模式各自当前那一条内容（切模式时切回去）
  // 话题可能是刚从「空白会话」发出来的：那时 currentTopicId 才第一次有值，也在这里记上。
  // **只在话题列表已属于活动工作区时记**（topicsWorkspaceId === activeWorkspaceId）：
  // 跨工作区选会话时 topics 还是旧工作区的，那时记会把话题挂到错的工作区上。
  useEffect(() => {
    if (currentTopicId == null || topicsWorkspaceId == null) return
    if (topicsWorkspaceId !== activeWorkspaceId) return
    const pluginId =
      pluginWorkspaces.find((item) => item.workspaceId === topicsWorkspaceId)?.draftId ?? null
    if (pluginId) {
      if (pluginContentRef.current?.topicId !== currentTopicId) {
        pluginContentRef.current = {
          pluginId,
          workspaceId: topicsWorkspaceId,
          topicId: currentTopicId
        }
      }
    } else if (workContentRef.current?.topicId !== currentTopicId) {
      workContentRef.current = { workspaceId: topicsWorkspaceId, topicId: currentTopicId }
    }
  }, [currentTopicId, topicsWorkspaceId, activeWorkspaceId, pluginWorkspaces])

  /** 按 id 重新读一条话题行（记的是 id，标题可能已经改过，不能拿旧快照渲染） */
  const fetchTopicRow = useCallback(async (topicId: number): Promise<HarnessTopicRow | null> => {
    try {
      const rows = await harnessApi.harness.getTopicById(topicId)
      return rows[0] ?? null
    } catch {
      return null
    }
  }, [])

  /** 切到「工作」那一侧的内容：上次那条工作会话；没有就回到用户工作区的空白会话 */
  const enterWorkModeContent = useCallback(async (): Promise<void> => {
    if (!inPluginContent) return
    // 现取一份工作区列表（本地那份可能刚被刷新过）：切模式是靠它找「上次那个用户工作区」的
    const { list } = await loadWorkspaces()
    const userList = list.filter((ws) => !pluginWorkspaceIds.has(ws.id))
    const remembered = workContentRef.current
    if (remembered?.topicId != null) {
      const ws = userList.find((w) => w.id === remembered.workspaceId)
      const topic = ws ? await fetchTopicRow(remembered.topicId) : null
      if (ws && topic) {
        if (activeWorkspaceId !== ws.id) await switchWorkspace(ws)
        setExpandedWorkspaceId(ws.id)
        await onSelectTopic(topic)
        return
      }
      // 会话已经被删了：退回「这个工作区的空白会话」
      workContentRef.current = { workspaceId: remembered.workspaceId, topicId: null }
    }
    const target =
      userList.find((w) => w.id === lastWorkWorkspaceIdRef.current) ?? userList[0] ?? null
    if (!target) {
      // 一个用户工作区都没有（只剩插件工作区）：回到「尚未配置工作区」的空白态
      try {
        await window.api.systemSettings.update({
          harness: {
            workspacePath: '',
            activeWorkspaceId: undefined
          } as Parameters<typeof window.api.systemSettings.update>[0]['harness']
        })
      } catch (err) {
        console.error('Failed to clear active workspace:', err)
      }
      setActiveWorkspaceId(null)
      setExpandedWorkspaceId(null)
      window.dispatchEvent(new CustomEvent('workspace-changed', { detail: {} }))
      onNewHarness()
      return
    }
    if (activeWorkspaceId !== target.id) await switchWorkspace(target)
    setExpandedWorkspaceId(target.id)
    onNewHarness()
  }, [
    inPluginContent,
    activeWorkspaceId,
    pluginWorkspaceIds,
    loadWorkspaces,
    fetchTopicRow,
    switchWorkspace,
    onSelectTopic,
    onNewHarness
  ])

  /**
   * 切到「插件」那一侧的内容：上次那条插件会话；这份插件还没开过会话时走「＋」那套
   * （取插件工作区 + 空白会话 + 记忆作用域）——那就是插件模式里的默认选中项。
   *
   * 刻意**只依赖记住的那条记录**（插件 id + 话题 id），不去查本地缓存里的草稿/工作区列表：
   * 那两份缓存可能刚被刷新过（工作区行是刚建的、草稿在重载），拿它们当门槛会让「切回来」
   * 偶发退化成空白会话。工作区由主进程按插件 id 现取（`handlePluginSession` 里的
   * `ensureWorkspace`），话题按 id 现读——主进程才是真源，这样切回来稳定命中同一条会话。
   */
  const enterPluginModeContent = useCallback(async (): Promise<void> => {
    if (inPluginContent) return
    const remembered = pluginContentRef.current
    if (remembered) {
      const topic = remembered.topicId != null ? await fetchTopicRow(remembered.topicId) : undefined
      if (topic || remembered.topicId == null) {
        await handlePluginSession(
          { id: remembered.pluginId },
          { focus: false, topic: topic ?? undefined }
        )
        return
      }
      // 那条会话已经被删了：退回「这份插件的空白会话」
      pluginContentRef.current = null
    }
    const fallback = visibleDrafts[0] ?? drafts[0] ?? null
    if (!fallback) return
    await handlePluginSession(fallback, { focus: false })
  }, [inPluginContent, drafts, visibleDrafts, fetchTopicRow, handlePluginSession])

  /** 模式开关：切模式 = 同时把内容切到那一侧（用户口径 2026-09-28） */
  const switchMode = useCallback(
    (next: SidebarMode): void => {
      if (next === mode) return
      setMode(next)
      if (next === 'plugin') void enterPluginModeContent()
      else void enterWorkModeContent()
    },
    [mode, enterWorkModeContent, enterPluginModeContent]
  )

  return (
    <div
      /* 稳定钩子：这块面板没有 class 名（宽度是内联样式、用户可以拖），
         工装（test/probe-plugin-workshop-live.mjs）靠它定位侧栏 */
      data-harness-sidebar="1"
      className="flex flex-col overflow-hidden h-full"
      style={{
        background: colorBgContainer,
        borderRadius: borderRadiusLG
      }}
    >
      {/* 头部：模式开关（普通 / 插件）+ 搜索 / 设置 / 新建 */}
      <div className="flex items-center px-2" style={{ minHeight: 38 }}>
        {searchMode ? (
          <div className="flex items-center gap-1 flex-1">
            <Input
              ref={searchInputRef}
              size="small"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                mode === 'plugin'
                  ? t('harness.sidebar.searchDraftPlaceholder')
                  : t('harness.sidebar.searchPlaceholder')
              }
              allowClear
              variant="borderless"
              prefix={<RiSearchLine size={14} style={{ color: colorTextTertiary }} />}
              style={{ flex: 1, background: 'transparent', padding: '0 3px' }}
            />
            {iconBtn(
              t('harness.sidebar.exitSearch'),
              () => {
                setSearchMode(false)
                setSearchQuery('')
              },
              <RiCloseLine size={16} />
            )}
          </div>
        ) : (
          <>
            {/*
              模式切换：这块面板装两套内容——「工作」是工作区 → 会话，「插件」是插件草稿。
              胶囊样式 + 一枚滑块（transform 过渡）而不是两个按钮换背景色：
              切换时滑块滑过去，位置本身就在说「现在在哪一档」。
            */}
            <SidebarModeSwitch
              mode={mode}
              onChange={switchMode}
              track={colorFillAlter}
              thumb={token.colorBgElevated}
              active={colorText}
              inactive={colorTextTertiary}
              hairline={token.colorBorderSecondary}
              t={t}
            />
            <span className="flex-1" />
            {iconBtn(
              t('harness.sidebar.searchTooltip'),
              () => setSearchMode(true),
              <RiSearchLine size={16} />
            )}
            {mode === 'plugin'
              ? /* 新建插件：没配存放路径时先弹文件夹选择，再弹「新建草稿」（弹窗里不含路径选择器）。
                   图标与工作模式的「新建工作区」用同一个（RiFoldersLine）——两个模式的头部同构，
                   用户口径 2026-09-27「这个按键的 icon 要和工作的 icon 保持一致」 */
                iconBtn(
                  t('harness.sidebar.newDraft'),
                  () => void handleNewDraft(),
                  <RiFoldersLine size={16} />
                )
              : [
                  iconBtn(
                    t('harness.sidebar.assistantSettings'),
                    // 聚焦模式：设置弹窗只显示助手相关页签（智能体 / 模型 / 技能 / 记忆）
                    () =>
                      window.dispatchEvent(
                        new CustomEvent('open-system-settings', {
                          detail: { tab: 'agents', scope: 'assistant' }
                        })
                      ),
                    <RiEqualizerLine size={16} />
                  ),
                  iconBtn(
                    t('harness.sidebar.newWorkspace'),
                    handleBrowseFolder,
                    <RiFoldersLine size={16} />
                  )
                ]}
          </>
        )}
      </div>

      {/* 工作区 → 会话树 ／ 插件草稿清单 */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto py-1 history-scrollbar"
        onScroll={handleScroll}
      >
        {mode === 'plugin' ? (
          draftsLoading && drafts.length === 0 ? (
            <SkeletonListRows rows={3} />
          ) : visibleDrafts.length === 0 ? (
            query ? (
              <p className="text-xs text-center py-8 px-3" style={{ color: colorTextTertiary }}>
                {t('harness.sidebar.noMatchResult')}
              </p>
            ) : pluginsPath ? (
              <p className="text-xs text-center py-8 px-3" style={{ color: colorTextTertiary }}>
                {t('harness.sidebar.noDraft')}
              </p>
            ) : (
              /*
               * 还没配插件存放路径：**与「尚未配置工作区」逐字同一副样子**——一行居中的灰字，
               * 不写说明段落（用户口径 2026-09-27「不要这种描述…要像没有设置任何工作区时
               * 显示的样式保持一致」）。选文件夹的入口就是右上角的 ＋（没配路径时它先弹
               * 文件夹选择，见 handleNewDraft）。
               */
              <p className="text-xs text-center py-8" style={{ color: colorTextTertiary }}>
                {t('harness.sidebar.needPluginsPath')}
              </p>
            )
          ) : (
            visibleDrafts.map((draft) => renderDraft(draft))
          )
        ) : visibleWorkspaces.length === 0 ? (
          <p className="text-xs text-center py-8" style={{ color: colorTextTertiary }}>
            {query ? t('harness.sidebar.noMatchResult') : t('harness.sidebar.noWorkspace')}
          </p>
        ) : (
          visibleWorkspaces.map((ws) => renderWorkspace(ws))
        )}
      </div>

      {/*
        Mnemon 记忆概览：两个模式都常驻（用户口径 2026-09-28「插件的记忆，并没有像工作里面的
        记忆一样显示在侧边栏」）——它显示的是**当前会话**那套记忆，插件会话就是这份插件自己的
        （`<memoryPath>/plugin-<id>/`）。标题只写「记忆」，不缀作用域名（同一天的「不需要
        （记忆 · 个人记账台账）这个内容」）。
      */}
      <div
        data-harness-memory-block="1"
        className="border-t flex-shrink-0"
        style={{ borderColor: colorFillAlter }}
      >
        <button
          onClick={handleToggleMemory}
          className="flex items-center justify-between w-full px-4 py-2 text-left transition-colors"
          style={{ color: colorTextSecondary }}
          onMouseEnter={(e) => (e.currentTarget.style.background = colorFillAlter)}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <RiBrain4Line size={16} />
            {t('harness.sidebar.memory')}
          </span>
          <span className="flex items-center gap-2">
            {memoryExpanded ? <RiArrowDownSLine size={16} /> : <RiArrowRightSLine size={16} />}
          </span>
        </button>

        {memoryExpanded && (
          <div className="overflow-y-auto history-scrollbar px-3 pb-3" style={{ maxHeight: 300 }}>
            {memoryLoading ? (
              <div className="px-1 py-2">
                <SkeletonTextLines lines={5} />
              </div>
            ) : !memorySnap?.configured ? (
              <div className="pt-2">
                <p className="text-xs text-center py-3" style={{ color: colorTextTertiary }}>
                  {t('harness.sidebar.memoryNotConfigured')}
                </p>
                <button
                  onClick={handleOpenMemorySettings}
                  className="flex items-center justify-center gap-1 w-full py-2 rounded text-xs transition-colors"
                  style={{ color: '#1677ff', background: colorFillAlter }}
                >
                  <RiSettings4Line size={13} />
                  {t('harness.sidebar.memoryGoSettings')}
                </button>
              </div>
            ) : (
              <div className="pt-1">
                {/* 用户画像（USER）——仅显示数量，不展示内容 */}
                {memorySnap.runtime && userEntries.length > 0 && (
                  <div className="mb-2">
                    <div
                      className="flex items-center justify-between gap-1.5 mb-1.5 text-xs font-medium"
                      style={{ color: colorTextSecondary }}
                    >
                      <span className="flex items-center gap-1.5">
                        <span
                          className="rounded-sm"
                          style={{ width: 3, height: 12, background: '#1677ff' }}
                        />
                        {t('harness.sidebar.memoryUserProfile')}
                      </span>
                      <span style={{ color: colorTextTertiary, fontWeight: 400 }}>
                        {t('harness.sidebar.memoryCount', { count: userEntries.length })}
                      </span>
                    </div>
                  </div>
                )}

                {/* 项目记忆（MEMORY）——仅显示数量，不展示内容 */}
                {memorySnap.runtime && memoryEntries.length > 0 && (
                  <div className="mb-2">
                    <div
                      className="flex items-center justify-between gap-1.5 mb-1.5 text-xs font-medium"
                      style={{ color: colorTextSecondary }}
                    >
                      <span className="flex items-center gap-1.5">
                        <span
                          className="rounded-sm"
                          style={{ width: 3, height: 12, background: '#52c41a' }}
                        />
                        {t('harness.sidebar.memoryProject')}
                      </span>
                      <span style={{ color: colorTextTertiary, fontWeight: 400 }}>
                        {t('harness.sidebar.memoryCount', { count: memoryEntries.length })}
                      </span>
                    </div>
                  </div>
                )}

                {!memorySnap.runtime ||
                  (memorySnap.runtime.entries.length === 0 && (
                    <p className="text-xs text-center py-3" style={{ color: colorTextTertiary }}>
                      {t('harness.sidebar.memoryEmpty')}
                    </p>
                  ))}

                {/* 统计行（换行排列，不挤压） */}
                <div
                  className="flex flex-wrap gap-x-4 gap-y-1 mt-1 pt-2 text-xs"
                  style={{
                    color: colorTextTertiary,
                    borderTop: `1px solid ${colorFillAlter}`
                  }}
                >
                  <span className="flex items-center gap-1.5">
                    <RiBrain4Line size={13} />
                    {memorySnap.runtime
                      ? t('harness.sidebar.memoryHotCount', {
                          count: memorySnap.runtime.entries.length
                        })
                      : t('harness.sidebar.memoryHotEmpty')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <RiDatabase2Line size={13} />
                    {t('harness.sidebar.memorySpaces', {
                      active: memorySnap.bodies?.activeCount ?? 0,
                      total: memorySnap.bodies?.total ?? 0
                    })}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <RiFileTextLine size={13} />
                    {t('harness.sidebar.memoryDocuments', {
                      count: memorySnap.documents?.total ?? 0
                    })}
                  </span>
                </div>

                {/* 管理入口 */}
                <button
                  onClick={handleOpenMemorySettings}
                  className="flex items-center justify-center gap-1.5 w-full py-2 mt-2.5 rounded text-xs transition-colors"
                  style={{ color: '#1677ff', background: colorFillAlter }}
                >
                  <RiSettings4Line size={13} />
                  {t('harness.sidebar.memoryManage')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 新建草稿弹窗（插件模式的 ＋；与设置页工坊共用同一个组件） */}
      <NewDraftModal
        open={newDraftOpen}
        onClose={() => setNewDraftOpen(false)}
        onCreated={() => void loadDrafts()}
      />

      {/* 重命名工作区弹窗 */}
      <Modal
        title={t('harness.sidebar.renameWorkspace')}
        open={renameOpen}
        onCancel={() => {
          setRenameOpen(false)
          setRenameTarget(null)
        }}
        onOk={handleRenameSave}
        okText={t('common.action.save')}
        cancelText={t('common.action.cancel')}
        confirmLoading={renameSaving}
        width={380}
      >
        <Input
          autoFocus
          placeholder={t('harness.sidebar.workspaceNamePlaceholder')}
          value={renameName}
          onChange={(e) => setRenameName(e.target.value)}
          onPressEnter={handleRenameSave}
        />
      </Modal>

      {/* 重命名插件弹窗（与工作区重命名同一套交互；只改展示名，目录名/id 不动） */}
      <Modal
        title={t('harness.sidebar.pluginRename')}
        open={draftRenameTarget !== null}
        onCancel={() => setDraftRenameTarget(null)}
        onOk={handleDraftRenameSave}
        okText={t('common.action.save')}
        cancelText={t('common.action.cancel')}
        confirmLoading={draftRenameSaving}
        width={380}
      >
        <Input
          autoFocus
          data-workshop-field="rename"
          placeholder={t('harness.sidebar.pluginNamePlaceholder')}
          value={draftRenameName}
          onChange={(e) => setDraftRenameName(e.target.value)}
          onPressEnter={handleDraftRenameSave}
        />
        <div style={{ marginTop: 8, fontSize: 12, color: colorTextTertiary }}>
          {t('harness.sidebar.pluginRenameNote', { id: draftRenameTarget?.id ?? '' })}
        </div>
      </Modal>
    </div>
  )
}

// memo：聊天区流式输出时父级会高频重渲染，侧边栏（含搜索框）props 全部稳定引用，
// 不应跟着重渲染
export default React.memo(HarnessSidebar)
