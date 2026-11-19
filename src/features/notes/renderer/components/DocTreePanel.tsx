import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { theme, Tooltip, Empty, Dropdown, Modal, Input, App } from 'antd'
import { SkeletonBlock } from '@renderer/components/system/Skeleton'
import type { MenuProps } from 'antd'
import {
  RiFileTextLine,
  RiCheckboxCircleLine,
  RiBook2Line,
  RiArchiveStackLine,
  RiFolder2Line,
  RiAddLine,
  RiSearchLine,
  RiArrowRightSLine,
  RiTodoLine,
  RiPlayCircleLine,
  RiCheckboxBlankCircleLine,
  RiPlayLine,
  RiCheckLine,
  RiRefreshLine,
  RiMore2Line,
  RiDeleteBinLine,
  RiEditLine,
  RiInboxArchiveLine,
  RiFolderAddLine,
  RiFileAddLine,
  RiFolderTransferLine,
  RiExternalLinkLine,
  RiUpload2Line,
  RiMindMap
} from '@remixicon/react'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import { notesApi } from '../api'
import type { DocListItem, TodoItemRow, WikiDirectoryRow, WikiRow } from '../../shared/types'
import type { Selection } from '../types'

/* ──────────── 内部类型 ──────────── */

interface WikiTreeData {
  dirs: WikiDirectoryRow[]
  /** 目录下的文档 id 列表（标题渲染时从 docs 实时取，保存后自动更新） */
  notesByDir: Map<number, number[]>
}

/** 待办状态只用于取色；展示名走词条（notes.status.*） */
const TODO_STATUS_META: Record<number, { color: string }> = {
  0: { color: '#1677ff' },
  1: { color: '#fa8c16' },
  2: { color: '#52c41a' }
}

/* ──────────── 缩进网格 ──────────── */

/** 每级缩进（px） */
const INDENT_STEP = 16
/** 行首箭头列宽 18 + 行内间距 6：有箭头（或箭头占位）的行，图标都落在「行左内边距 + 24」这一列 */
const LEAD_SLOT = 24

/* ──────────── Props ──────────── */

export interface DocTreePanelProps {
  /** 未归档文档（文档库分区展示） */
  docs: DocListItem[]
  /** 全部文档（树内标题解析与搜索） */
  allDocs: DocListItem[]
  todos: TodoItemRow[]
  wikis: WikiRow[]
  selection: Selection
  onSelect: (selection: Selection) => void
  onCreateDoc: () => void
  onCreateTodo: () => void
  onCreateWiki: () => void
  /** 编辑知识库（⋯ 菜单） */
  onEditWiki: (wiki: WikiRow) => void
  /** 删除知识库（⋯ 菜单） */
  onDeleteWiki: (wiki: WikiRow) => void
  /** 打开知识库图谱视图（⋯ 菜单） */
  onOpenGraph: (wiki: WikiRow) => void
  /** 打开单篇文档的图谱子图（⋯ 菜单） */
  onOpenDocGraph: (wikiId: number, docId: number) => void
  /** 删除文档（⋯ 菜单） */
  onDeleteDoc: (doc: DocListItem) => void
  /** 编辑待办元信息（待办行 ⋯ 菜单 → 弹窗） */
  onEditTodo: (todo: TodoItemRow) => void
  /** 删除待办（待办行 ⋯ 菜单） */
  onDeleteTodo: (todo: TodoItemRow) => void
  /** 待办状态流转（待办行 ⋯ 菜单：开始 / 完成 / 重新激活） */
  onSetTodoStatus: (todo: TodoItemRow, status: number) => void
  /** 归档文档（⋯ 菜单） */
  onArchiveDoc: (doc: DocListItem) => void
  /** 在目录中新建文档（⋯ 菜单） */
  onCreateDocInDirectory: (
    directoryId: number,
    context?: { wikiId: number; dirName: string }
  ) => void
  /** 从本地文件导入文档到目录（⋯ 菜单） */
  onImportDocToDirectory?: (
    directoryId: number,
    context?: { wikiId: number; dirName: string }
  ) => void
  /** 目录/文档关联关系变化（删除目录、从目录移除）后通知父级刷新文档列表 */
  onDocsChanged?: () => void
  /** 数据变更后自增，用于刷新已展开知识库的树（保留展开状态） */
  refreshKey?: number
  /** 面板宽度（可拖拽调整） */
  width?: number
}

/* ──────────── 组件 ──────────── */

const DocTreePanel: React.FC<DocTreePanelProps> = ({
  docs,
  allDocs,
  todos,
  wikis,
  selection,
  onSelect,
  onCreateDoc,
  onCreateTodo,
  onCreateWiki,
  onEditWiki,
  onDeleteWiki,
  onOpenGraph,
  onOpenDocGraph,
  onDeleteDoc,
  onEditTodo,
  onDeleteTodo,
  onSetTodoStatus,
  onArchiveDoc,
  onCreateDocInDirectory,
  onImportDocToDirectory,
  onDocsChanged,
  refreshKey = 0,
  width = 252
}) => {
  const { token } = theme.useToken()
  const { viewMessage } = useMessage()
  const { modal } = App.useApp()
  const { t } = useTranslation()

  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [sectionOpen, setSectionOpen] = useState<Record<string, boolean>>({
    docs: true,
    todos: true,
    wikis: true
  })
  const [expandedWikis, setExpandedWikis] = useState<Set<number>>(new Set())
  const [expandedDirs, setExpandedDirs] = useState<Set<number>>(new Set())
  const [treeCache, setTreeCache] = useState<Record<number, WikiTreeData>>({})
  const [loadingWikis, setLoadingWikis] = useState<Set<number>>(new Set())

  /* ── 目录编辑弹窗 ── */
  const [dirModalOpen, setDirModalOpen] = useState(false)
  const [dirModalTitle, setDirModalTitle] = useState(t('notes.dir.create'))
  const [dirName, setDirName] = useState(t('notes.dir.defaultName'))
  const [dirTarget, setDirTarget] = useState<{
    wikiId: number
    parent: WikiDirectoryRow | null
  } | null>(null)
  const [editingDir, setEditingDir] = useState<WikiDirectoryRow | null>(null)
  const [dirSaving, setDirSaving] = useState(false)

  const docTitle = useCallback(
    (docId: number): string =>
      allDocs.find((d) => d.id === docId)?.title ?? t('notes.doc.titleWithId', { id: docId }),
    [allDocs, t]
  )

  /* ── 加载 / 刷新知识库目录树 ── */
  const treeCacheRef = useRef(treeCache)
  treeCacheRef.current = treeCache
  /** 加载中收到的 force 刷新请求（当前加载完成后自动补发,防被 loading 守卫静默吞掉） */
  const pendingForceRef = useRef(new Set<number>())
  const loadWikiTree = useCallback(
    async (wikiId: number, force = false) => {
      if (treeCache[wikiId] && !force) return
      if (loadingWikis.has(wikiId)) {
        // 修复：加载中收到 force 刷新（新建/重命名目录后）被静默丢弃——记录待重试
        if (force) pendingForceRef.current.add(wikiId)
        return
      }
      setLoadingWikis((prev) => new Set(prev).add(wikiId))
      try {
        const dirs = await notesApi.wikis.getDirectories(wikiId)
        const notesByDir = new Map<number, number[]>()
        for (const dir of dirs) {
          const notes = await notesApi.wikis.getNotesByDirectory(dir.id)
          notesByDir.set(
            dir.id,
            notes.map((n) => n.doc_id)
          )
        }
        /* 首次加载：展开全部目录；刷新：仅展开新增目录，保留用户折叠状态 */
        const oldIds = new Set((treeCacheRef.current[wikiId]?.dirs ?? []).map((d) => d.id))
        const newIds = dirs.filter((d) => !oldIds.has(d.id)).map((d) => d.id)
        setTreeCache((prev) => ({ ...prev, [wikiId]: { dirs, notesByDir } }))
        if (newIds.length > 0) {
          setExpandedDirs((p) => {
            const next = new Set(p)
            newIds.forEach((id) => next.add(id))
            return next
          })
        }
      } catch (error) {
        console.error('Failed to load wiki tree:', error)
      } finally {
        setLoadingWikis((prev) => {
          const next = new Set(prev)
          next.delete(wikiId)
          return next
        })
        if (pendingForceRef.current.delete(wikiId)) {
          loadWikiTreeRef.current(wikiId, true).then()
        }
      }
    },
    [treeCache, loadingWikis]
  )

  /* 数据变更：仅重载仍然存在的已展开知识库。
     注意：effect 只依赖 refreshKey，绝不可依赖 loadWikiTree——
     否则 treeCache 每次更新都会重建 loadWikiTree 导致 effect 反复触发，
     与 force 重载形成无限请求循环，把界面卡死。 */
  const loadWikiTreeRef = useRef(loadWikiTree)
  loadWikiTreeRef.current = loadWikiTree
  const expandedWikisRef = useRef<Set<number>>(new Set())
  expandedWikisRef.current = expandedWikis
  useEffect(() => {
    if (refreshKey <= 0) return
    const aliveIds = new Set(wikis.map((w) => w.id))
    /* 清掉已删除知识库的残留展开状态 */
    setExpandedWikis((prev) => {
      const next = new Set([...prev].filter((id) => aliveIds.has(id)))
      return next.size === prev.size ? prev : next
    })
    ;[...expandedWikisRef.current].forEach((wikiId) => {
      if (aliveIds.has(wikiId)) {
        loadWikiTreeRef.current(wikiId, true).then()
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  const toggleWiki = useCallback(
    (wikiId: number) => {
      // 修复：网络加载移出 setState updater（updater 应保持纯函数,
      // StrictMode 双调用会触发两次 loadWikiTree 造成重复请求）
      const willExpand = !expandedWikisRef.current.has(wikiId)
      setExpandedWikis((prev) => {
        const next = new Set(prev)
        if (next.has(wikiId)) {
          next.delete(wikiId)
        } else {
          next.add(wikiId)
        }
        return next
      })
      if (willExpand) {
        loadWikiTree(wikiId).then()
      }
    },
    [loadWikiTree]
  )

  const toggleDir = useCallback((dirId: number) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirId)) next.delete(dirId)
      else next.add(dirId)
      return next
    })
  }, [])

  /* ── 目录 CRUD ── */
  const openCreateDir = useCallback(
    (wikiId: number, parent: WikiDirectoryRow | null) => {
      setEditingDir(null)
      setDirTarget({ wikiId, parent })
      setDirName(t('notes.dir.defaultName'))
      setDirModalTitle(
        parent ? t('notes.dir.createSubTitle', { name: parent.name }) : t('notes.dir.create')
      )
      setDirModalOpen(true)
    },
    [t]
  )

  const openRenameDir = useCallback(
    (dir: WikiDirectoryRow) => {
      setEditingDir(dir)
      setDirTarget({ wikiId: dir.wiki_id, parent: null })
      setDirName(dir.name)
      setDirModalTitle(t('notes.dir.renameTitle'))
      setDirModalOpen(true)
    },
    [t]
  )

  const handleDirModalOk = useCallback(async (): Promise<void> => {
    const messageKey = 'dir-save'
    setDirSaving(true)
    try {
      if (editingDir) {
        viewMessage(messageKey, 'loading', t('notes.dir.saving'))
        await notesApi.wikis.updateDirectory(editingDir.id, { name: dirName })
        viewMessage(messageKey, 'success', t('notes.dir.saved'), 2)
        await loadWikiTree(editingDir.wiki_id, true)
      } else if (dirTarget) {
        viewMessage(messageKey, 'loading', t('notes.dir.creating'))
        await notesApi.wikis.addDirectory({
          wiki_id: dirTarget.wikiId,
          parent_id: dirTarget.parent?.id ?? null,
          name: dirName,
          sort_order: 0,
          // level 库列为可空（DEFAULT 0），null 按 0 处理
          level: dirTarget.parent ? (dirTarget.parent.level ?? 0) + 1 : 0
        })
        viewMessage(messageKey, 'success', t('notes.dir.createSuccess'), 2)
        await loadWikiTree(dirTarget.wikiId, true)
      }
      setDirModalOpen(false)
    } catch (error) {
      console.error('Failed to save directory:', error)
      viewMessage(messageKey, 'error', t('notes.dir.saveFailed'))
    } finally {
      setDirSaving(false)
    }
  }, [viewMessage, loadWikiTree, editingDir, dirTarget, dirName, t])

  const handleDeleteDir = useCallback(
    (dir: WikiDirectoryRow) => {
      modal.confirm({
        title: t('notes.dir.deleteTitle', { name: dir.name }),
        content: t('notes.dir.deleteContent'),
        okText: t('common.action.delete'),
        okButtonProps: { danger: true },
        cancelText: t('common.action.cancel'),
        onOk: async () => {
          const messageKey = 'dir-delete'
          try {
            viewMessage(messageKey, 'loading', t('notes.dir.deleting'))
            await notesApi.wikis.deleteDirectory(dir.id)
            viewMessage(messageKey, 'success', t('notes.dir.deleteSuccess'), 2)
            await loadWikiTree(dir.wiki_id, true)
            /* 目录删除后其中的文档解除关联回到文档库，通知父级刷新列表 */
            onDocsChanged?.()
          } catch (error) {
            console.error('Failed to delete directory:', error)
            viewMessage(messageKey, 'error', t('notes.dir.deleteFailed'))
          }
        }
      })
    },
    [viewMessage, loadWikiTree, onDocsChanged, modal, t]
  )

  const handleRemoveDocFromDir = useCallback(
    (wikiId: number, dir: WikiDirectoryRow, docId: number, docName: string) => {
      modal.confirm({
        title: t('notes.dir.removeDocTitle', { dir: dir.name, name: docName }),
        content: t('notes.dir.removeDocContent'),
        okText: t('common.action.remove'),
        cancelText: t('common.action.cancel'),
        onOk: async () => {
          const messageKey = 'remove-doc'
          try {
            viewMessage(messageKey, 'loading', t('notes.dir.removing'))
            await notesApi.wikis.removeNoteFromDirectory(dir.id, docId)
            viewMessage(messageKey, 'success', t('notes.dir.removed'), 2)
            await loadWikiTree(wikiId, true)
            /* 文档解除关联后回到文档库，通知父级刷新列表 */
            onDocsChanged?.()
          } catch (error) {
            console.error('Failed to remove doc from directory:', error)
            viewMessage(messageKey, 'error', t('notes.dir.removeFailed'))
          }
        }
      })
    },
    [viewMessage, loadWikiTree, onDocsChanged, modal, t]
  )

  /* ── 数据分组（时间字段运行时可能是 Date/number，统一转字符串比较） ── */
  const sortedDocs = useMemo(
    () =>
      [...docs].sort((a, b) =>
        String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''))
      ),
    [docs]
  )
  const todoGroups = useMemo(() => {
    const pending = todos.filter((t) => t.status === 0)
    const doing = todos.filter((t) => t.status === 1)
    const done = todos.filter((t) => t.status === 2)
    const byDue = (a: TodoItemRow, b: TodoItemRow): number =>
      String(a.due_date ?? '9999').localeCompare(String(b.due_date ?? '9999'))
    return {
      pending: pending.sort(byDue),
      doing: doing.sort(byDue),
      done: done.sort(byDue)
    }
  }, [todos])

  const searchLower = search.trim().toLowerCase()

  /* ── 行样式 ── */
  const rowStyle = (selected: boolean, indent = 0, isDoc = false): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: isDoc ? 6.5 : 6,
    height: 28,
    padding: `0 7px 0 ${8 + indent * INDENT_STEP}px`,
    borderRadius: 6,
    cursor: 'pointer',
    /* 面板统一字号：分区标题 / 分组标题 / 树行同为 12.5，层级靠字重与颜色拉开 */
    fontSize: 12.5,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    color: selected ? token.colorPrimary : token.colorText,
    background: selected ? token.colorPrimaryBg : 'transparent',
    position: 'relative'
  })

  const accentBar = (visible: boolean): React.ReactNode =>
    visible ? (
      <span
        style={{
          position: 'absolute',
          left: 0,
          top: 6,
          bottom: 6,
          width: 2.5,
          borderRadius: 2,
          background: token.colorPrimary
        }}
      />
    ) : null

  /* ── 折叠箭头（行首，独立点击区） ── */
  const toggleArrow = (open: boolean, onToggle: () => void): React.ReactNode => (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        flexShrink: 0,
        borderRadius: 4,
        color: token.colorTextTertiary,
        cursor: 'pointer'
      }}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = token.colorFillTertiary
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <RiArrowRightSLine
        size={14}
        style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
      />
    </span>
  )

  /** 占位（文档行无箭头，保持图标对齐） */
  const arrowPlaceholder = <span style={{ width: 18, height: 18, flexShrink: 0 }} aria-hidden />

  /** 待办行：待办分区里没有箭头列，用内边距把状态图标直接落在次级图标列
   *  （8 + 16 缩进 + 24 箭头列 = 48px）。此前靠 18px 空占位 span 撑位，
   *  等于多出一个死节点，行首还会和分组标签的左边界错开 */
  const todoRowStyle = (selected: boolean): React.CSSProperties => ({
    ...rowStyle(selected, 1),
    padding: `0 7px 0 ${8 + INDENT_STEP + LEAD_SLOT}px`
  })

  /** 该待办是否正是当前选中项（树内高亮 + 左侧强调条，与文档行一致） */
  const isTodoSelected = (todoId: number): boolean =>
    selection?.kind === 'todo' && selection.todoId === todoId

  /* ── 分组标题 ──
   *  横向网格与分区标题共用：左侧 14px 起放 6px 状态圆点（圆心 17px = 折叠箭头列中心），
   *  圆点后接状态图标 + 组名（图标列 32px / 文字列 50px，与分区标题的图标、文字同列）；
   *  右侧发丝线把整组横向划开，计数以浅底小胶囊靠右收口 */
  const renderGroupHeader = (
    color: string,
    icon: React.ReactNode,
    label: string,
    count: number
  ): React.ReactNode => (
    <div
      style={{
        padding: '0 8px 0 14px',
        userSelect: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 22
      }}
    >
      <span
        style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: color }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5 }}>
        {icon}
        <span style={{ letterSpacing: '0.04em', color: token.colorTextTertiary }}>{label}</span>
      </div>
      <span style={{ flex: 1, height: 1, background: token.colorBorderSecondary }} />
      <span
        style={{
          fontSize: 10,
          lineHeight: '14px',
          padding: '0 5px',
          borderRadius: 4,
          color: token.colorTextTertiary,
          background: token.colorFillTertiary
        }}
      >
        {count}
      </span>
    </div>
  )

  /* ── 待办行尾「⋯」：待办的全部操作都收在这里，
   *   页面里只保留内容编辑，不再摆一排按钮 ── */
  const todoMenu = (todo: TodoItemRow): React.ReactNode => {
    const status = todo.status ?? 0
    /** 状态动作一步一格，同一时刻只出现一个：
     *  待办 —开始任务→ 进行中 —标记完成→ 已完成 —重新激活→ 待办 */
    const step =
      status === 0
        ? {
            key: 'start',
            label: t('notes.todo.actionStart'),
            icon: <RiPlayLine size={14} />,
            next: 1
          }
        : status === 1
          ? {
              key: 'done',
              label: t('notes.todo.actionComplete'),
              icon: <RiCheckLine size={14} />,
              next: 2
            }
          : {
              key: 'reactivate',
              label: t('notes.todo.actionReactivate'),
              icon: <RiRefreshLine size={14} />,
              next: 0
            }

    const items: MenuProps['items'] = [
      {
        key: step.key,
        label: step.label,
        icon: step.icon,
        onClick: () => onSetTodoStatus(todo, step.next)
      },
      { type: 'divider' },
      {
        key: 'edit',
        label: t('common.action.edit'),
        icon: <RiEditLine size={14} />,
        onClick: () => onEditTodo(todo)
      },
      {
        key: 'delete',
        label: t('common.action.delete'),
        icon: <RiDeleteBinLine size={14} />,
        danger: true,
        onClick: () => onDeleteTodo(todo)
      }
    ]
    return rowMenu(items)
  }

  /* ── 行尾「⋯」操作菜单 ── */
  const rowMenu = (items: MenuProps['items']): React.ReactNode => (
    <Dropdown
      trigger={['click']}
      placement="bottomRight"
      menu={{
        items,
        onClick: ({ domEvent }) => {
          domEvent.stopPropagation()
        }
      }}
    >
      <span
        className="tree-more-btn"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          flexShrink: 0,
          borderRadius: 4,
          color: token.colorTextTertiary,
          cursor: 'pointer'
        }}
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = token.colorFillTertiary
          e.currentTarget.style.color = token.colorText
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = token.colorTextTertiary
        }}
      >
        <RiMore2Line size={14} />
      </span>
    </Dropdown>
  )

  /* ── 分区标题 ── */
  const renderSectionHeader = (
    key: string,
    icon: React.ReactNode,
    label: string,
    count: number,
    onCreate: () => void
  ): React.ReactNode => {
    const open = sectionOpen[key]
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 30,
          /* 与树行 rowStyle(indent=0) 的左侧内边距一致，保证箭头/图标/文字水平对齐 */
          padding: '0 6px 0 8px',
          cursor: 'pointer',
          userSelect: 'none'
        }}
        onClick={() => setSectionOpen((prev) => ({ ...prev, [key]: !prev[key] }))}
      >
        {/* 复用树行同款折叠箭头（18px 容器），对齐下方行首箭头 */}
        {toggleArrow(open, () => setSectionOpen((prev) => ({ ...prev, [key]: !prev[key] })))}
        <span
          style={{
            color: token.colorTextSecondary,
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 12.5,
            fontWeight: 600
          }}
        >
          {icon}
          {label}
        </span>
        <span style={{ marginLeft: 2, fontSize: 11, color: token.colorTextTertiary }}>{count}</span>
        <span style={{ flex: 1 }} />
        {/* 提示朝右弹（用户 2026-09-26）：这个 + 在左栏树里，朝上会压住同一栏上一行的
            分区标题/计数，朝右则落在右侧主区上，不遮本栏内容 */}
        <Tooltip title={t('notes.tree.createNamed', { name: label })} placement="right">
          <button
            style={{
              width: 20,
              height: 20,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              borderRadius: 5,
              background: 'transparent',
              color: token.colorTextTertiary,
              cursor: 'pointer'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = token.colorFillTertiary
              e.currentTarget.style.color = token.colorText
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.color = token.colorTextTertiary
            }}
            onClick={(e) => {
              e.stopPropagation()
              onCreate()
            }}
          >
            <RiAddLine size={14} />
          </button>
        </Tooltip>
      </div>
    )
  }

  /* ── 知识库子树 ── */
  const renderWikiChildren = (wikiId: number, tree: WikiTreeData): React.ReactNode => {
    const wikiTitle = wikis.find((w) => w.id === wikiId)?.title
    const dirsByParent = new Map<number | null, WikiDirectoryRow[]>()
    tree.dirs.forEach((d) => {
      const list = dirsByParent.get(d.parent_id) ?? []
      list.push(d)
      dirsByParent.set(d.parent_id, list)
    })
    const renderDirs = (parentId: number | null, depth: number): React.ReactNode[] => {
      // sort_order 库列为可空（DEFAULT 0），null 按默认值参与排序
      const dirs = (dirsByParent.get(parentId) ?? []).sort(
        (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
      )
      return dirs.flatMap((dir) => {
        const dirOpen = expandedDirs.has(dir.id)
        const noteIds = tree.notesByDir.get(dir.id) ?? []
        const dirRow = (
          <div key={`dir-${dir.id}`} style={rowStyle(false, 1 + depth)}>
            {depth > 0 && (
              <span
                style={{
                  position: 'absolute',
                  left: 8 + (1 + depth - 1) * 16 + 9,
                  top: 0,
                  bottom: 0,
                  borderLeft: `1px dashed ${token.colorBorderSecondary}`
                }}
              />
            )}
            {toggleArrow(dirOpen, () => toggleDir(dir.id))}
            <RiFolder2Line size={14} style={{ color: token.colorWarning, flexShrink: 0 }} />
            <span
              style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
              onClick={() => toggleDir(dir.id)}
            >
              {dir.name}
            </span>
            {noteIds.length > 0 && (
              <span
                style={{
                  fontSize: 10,
                  color: token.colorTextTertiary,
                  background: token.colorFillTertiary,
                  borderRadius: 8,
                  padding: '0 5px',
                  lineHeight: '15px',
                  flexShrink: 0
                }}
              >
                {noteIds.length}
              </span>
            )}
            {rowMenu([
              {
                key: 'new-doc',
                label: t('notes.doc.create'),
                icon: <RiFileAddLine size={14} />,
                onClick: () => onCreateDocInDirectory(dir.id, { wikiId, dirName: dir.name })
              },
              ...(onImportDocToDirectory
                ? [
                    {
                      key: 'import-doc',
                      label: t('notes.doc.import'),
                      icon: <RiUpload2Line size={14} />,
                      onClick: () => onImportDocToDirectory(dir.id, { wikiId, dirName: dir.name })
                    }
                  ]
                : []),
              {
                key: 'new-subdir',
                label: t('notes.dir.createChild'),
                icon: <RiFolderAddLine size={14} />,
                onClick: () => openCreateDir(wikiId, dir)
              },
              { type: 'divider' },
              {
                key: 'rename',
                label: t('common.action.rename'),
                icon: <RiEditLine size={14} />,
                onClick: () => openRenameDir(dir)
              },
              {
                key: 'delete',
                label: t('notes.dir.delete'),
                danger: true,
                icon: <RiDeleteBinLine size={14} />,
                onClick: () => handleDeleteDir(dir)
              }
            ])}
          </div>
        )
        const children: React.ReactNode[] = [dirRow]
        if (dirOpen) {
          children.push(...renderDirs(dir.id, depth + 1))
          noteIds.forEach((noteId) => {
            const isSel = selection?.kind === 'doc' && selection.docId === noteId
            const title = docTitle(noteId)
            children.push(
              <div key={`doc-${noteId}`} style={rowStyle(isSel, 1 + depth, true)}>
                {accentBar(isSel)}
                <span
                  style={{
                    position: 'absolute',
                    left: 8 + (1 + depth - 1) * 16 + 9,
                    top: 0,
                    bottom: 0,
                    borderLeft: `1px dashed ${token.colorBorderSecondary}`
                  }}
                />
                {arrowPlaceholder}
                <RiFileTextLine
                  size={13}
                  style={{ color: token.colorTextTertiary, flexShrink: 0 }}
                />
                <span
                  style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  onClick={() =>
                    onSelect({
                      kind: 'doc',
                      docId: noteId,
                      source: { wikiId, dirId: dir.id, dirName: dir.name, wikiTitle }
                    })
                  }
                >
                  {title}
                </span>
                {rowMenu([
                  {
                    key: 'open',
                    label: t('common.action.open'),
                    icon: <RiExternalLinkLine size={14} />,
                    onClick: () =>
                      onSelect({
                        kind: 'doc',
                        docId: noteId,
                        source: { wikiId, dirId: dir.id, dirName: dir.name, wikiTitle }
                      })
                  },
                  {
                    key: 'doc-graph',
                    label: t('notes.graph.view'),
                    icon: <RiMindMap size={14} />,
                    onClick: () => onOpenDocGraph(wikiId, noteId)
                  },
                  {
                    key: 'remove',
                    label: t('notes.dir.removeDoc'),
                    icon: <RiFolderTransferLine size={14} />,
                    onClick: () => handleRemoveDocFromDir(wikiId, dir, noteId, title)
                  },
                  {
                    key: 'archive',
                    label: t('notes.doc.archiveToOtherDir'),
                    icon: <RiInboxArchiveLine size={14} />,
                    onClick: () => {
                      /* 目录内文档不在 docs（未归档列表）里，必须从 allDocs 查 */
                      const doc = allDocs.find((d) => d.id === noteId)
                      if (doc) onArchiveDoc(doc)
                    }
                  },
                  { type: 'divider' },
                  {
                    key: 'delete',
                    label: t('notes.doc.deleteHard'),
                    danger: true,
                    icon: <RiDeleteBinLine size={14} />,
                    onClick: () => {
                      /* 目录内文档不在 docs（未归档列表）里，必须从 allDocs 查 */
                      const doc = allDocs.find((d) => d.id === noteId)
                      if (doc) onDeleteDoc(doc)
                    }
                  }
                ])}
              </div>
            )
          })
        }
        return children
      })
    }
    return renderDirs(null, 0)
  }

  /* ── 搜索模式 ── */
  const renderSearchResults = (): React.ReactNode => {
    const matchedDocs = [...allDocs]
      .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
      .filter((d) => d.title.toLowerCase().includes(searchLower))
    const matchedTodos = todos.filter((t) => t.title.toLowerCase().includes(searchLower))
    const matchedWikis = wikis.filter((w) => w.title.toLowerCase().includes(searchLower))
    const total = matchedDocs.length + matchedTodos.length + matchedWikis.length
    if (total === 0) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t('notes.search.noResults')}
          style={{ marginTop: 32 }}
        />
      )
    }
    return (
      <>
        {matchedDocs.length > 0 && (
          <>
            {renderGroupHeader(
              token.colorTextQuaternary,
              <RiFileTextLine size={13} />,
              t('notes.term.doc'),
              matchedDocs.length
            )}
            {matchedDocs.map((d) => {
              const isSel = selection?.kind === 'doc' && selection.docId === d.id
              return (
                <div
                  key={`doc-${d.id}`}
                  style={rowStyle(isSel, 1)}
                  onClick={() => onSelect({ kind: 'doc', docId: d.id })}
                  onMouseEnter={(e) => {
                    if (!isSel) e.currentTarget.style.background = token.colorFillQuaternary
                  }}
                  onMouseLeave={(e) => {
                    if (!isSel) e.currentTarget.style.background = 'transparent'
                  }}
                >
                  {accentBar(isSel)}
                  {arrowPlaceholder}
                  <RiFileTextLine
                    size={13}
                    style={{ color: token.colorTextTertiary, flexShrink: 0 }}
                  />
                  <span
                    style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  >
                    {d.title}
                  </span>
                  {rowMenu([
                    {
                      key: 'open',
                      label: t('common.action.open'),
                      onClick: () => onSelect({ kind: 'doc', docId: d.id })
                    },
                    {
                      key: 'archive',
                      label: t('notes.doc.archiveToWiki'),
                      onClick: () => onArchiveDoc(d)
                    },
                    { type: 'divider' },
                    {
                      key: 'delete',
                      label: t('notes.doc.delete'),
                      danger: true,
                      onClick: () => onDeleteDoc(d)
                    }
                  ])}
                </div>
              )
            })}
          </>
        )}
        {matchedTodos.length > 0 && (
          <>
            {renderGroupHeader(
              token.colorTextQuaternary,
              <RiTodoLine size={13} />,
              t('notes.term.todo'),
              matchedTodos.length
            )}
            {matchedTodos.map((t) => (
              <div
                key={`todo-${t.id}`}
                style={rowStyle(false, 1)}
                onClick={() => onSelect({ kind: 'todo', todoId: t.id })}
              >
                {arrowPlaceholder}
                <RiTodoLine
                  size={13}
                  style={{ color: TODO_STATUS_META[t.status ?? 0]?.color, flexShrink: 0 }}
                />
                <span
                  style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {t.title}
                </span>
                {todoMenu(t)}
              </div>
            ))}
          </>
        )}
        {matchedWikis.length > 0 && (
          <>
            {renderGroupHeader(
              token.colorTextQuaternary,
              <RiBook2Line size={13} />,
              t('notes.term.wiki'),
              matchedWikis.length
            )}
            {matchedWikis.map((w) => {
              // 修复：搜索视图不渲染知识库子树,点行/箭头只有状态翻转与网络请求而无任何
              // 可见反馈——改为退出搜索并展开该知识库（正常树中可见）
              const openWikiFromSearch = (): void => {
                setSearch('')
                if (!expandedWikis.has(w.id)) {
                  toggleWiki(w.id)
                }
              }
              return (
                <div key={`wiki-${w.id}`} style={rowStyle(false, 1)} onClick={openWikiFromSearch}>
                  {toggleArrow(expandedWikis.has(w.id), openWikiFromSearch)}
                  <RiBook2Line size={13} style={{ color: token.colorWarning, flexShrink: 0 }} />
                  <span
                    style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  >
                    {w.title}
                  </span>
                  {rowMenu([
                    {
                      key: 'graph',
                      label: t('notes.graph.view'),
                      icon: <RiMindMap size={14} />,
                      onClick: () => onOpenGraph(w)
                    },
                    { key: 'edit', label: t('notes.wiki.edit'), onClick: () => onEditWiki(w) },
                    {
                      key: 'delete',
                      label: t('notes.wiki.delete'),
                      danger: true,
                      onClick: () => onDeleteWiki(w)
                    }
                  ])}
                </div>
              )
            })}
          </>
        )}
      </>
    )
  }

  return (
    <aside
      style={{
        width,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: token.colorBgContainer,
        /* 贴边面板：左上/左下直角，右缘保留圆角与中间主区呼应（参考 Harness 侧边栏） */
        borderRadius: '12px 0 0 12px',
        overflow: 'hidden'
      }}
    >
      {/* 搜索 */}
      <div style={{ padding: '6px 6px 8px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 32,
            padding: '0 10px',
            borderRadius: 8,
            background: token.colorFillTertiary,
            border: `1px solid ${searchFocused ? token.colorPrimary : 'transparent'}`,
            boxShadow: searchFocused ? `0 0 0 2px ${token.colorPrimaryBg}` : 'none',
            transition: 'border-color 0.15s, box-shadow 0.15s'
          }}
        >
          <RiSearchLine size={14} style={{ color: token.colorTextTertiary }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder={t('notes.search.placeholder')}
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 12.5,
              color: token.colorText
            }}
          />
        </div>
      </div>

      {/* 树区域 */}
      <div
        className="custom-scrollbar"
        style={{ flex: 1, overflowY: 'auto', padding: '0 8px 12px' }}
      >
        {searchLower ? (
          renderSearchResults()
        ) : (
          <>
            {renderSectionHeader(
              'docs',
              <RiFileTextLine size={13} />,
              t('notes.term.docLibrary'),
              docs.length,
              onCreateDoc
            )}
            {sectionOpen.docs &&
              (sortedDocs.length === 0 ? (
                <div
                  style={{
                    padding: '4px 12px',
                    fontSize: 12,
                    color: token.colorTextTertiary,
                    textAlign: 'center',
                    userSelect: 'none'
                  }}
                >
                  {t('notes.doc.empty')}
                </div>
              ) : (
                sortedDocs.map((d) => {
                  const isSel = selection?.kind === 'doc' && selection.docId === d.id
                  return (
                    <div
                      key={`doc-${d.id}`}
                      style={rowStyle(isSel, 0)}
                      onClick={() => onSelect({ kind: 'doc', docId: d.id })}
                      onMouseEnter={(e) => {
                        if (!isSel) e.currentTarget.style.background = token.colorFillQuaternary
                      }}
                      onMouseLeave={(e) => {
                        if (!isSel) e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      {accentBar(isSel)}
                      {arrowPlaceholder}
                      <RiFileTextLine
                        size={13}
                        style={{ color: token.colorTextTertiary, flexShrink: 0 }}
                      />
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }}
                      >
                        {d.title}
                      </span>
                      {rowMenu([
                        {
                          key: 'open',
                          label: t('common.action.open'),
                          onClick: () => onSelect({ kind: 'doc', docId: d.id })
                        },
                        {
                          key: 'archive',
                          label: t('notes.doc.archiveToWiki'),
                          onClick: () => onArchiveDoc(d)
                        },
                        { type: 'divider' },
                        {
                          key: 'delete',
                          label: t('notes.doc.delete'),
                          danger: true,
                          onClick: () => onDeleteDoc(d)
                        }
                      ])}
                    </div>
                  )
                })
              ))}

            {renderSectionHeader(
              'todos',
              <RiCheckboxCircleLine size={13} />,
              t('notes.term.todo'),
              todos.length,
              onCreateTodo
            )}
            {sectionOpen.todos &&
              (todos.length === 0 ? (
                <div
                  style={{
                    padding: '4px 12px',
                    fontSize: 12,
                    color: token.colorTextTertiary,
                    textAlign: 'center',
                    userSelect: 'none'
                  }}
                >
                  {t('notes.todo.empty')}
                </div>
              ) : (
                (
                  [
                    {
                      key: 'pending',
                      label: t('notes.status.pending'),
                      items: todoGroups.pending,
                      icon: RiCheckboxBlankCircleLine,
                      color: TODO_STATUS_META[0].color
                    },
                    {
                      key: 'doing',
                      label: t('notes.status.doing'),
                      items: todoGroups.doing,
                      icon: RiPlayCircleLine,
                      color: TODO_STATUS_META[1].color
                    },
                    {
                      key: 'done',
                      label: t('notes.status.done'),
                      items: todoGroups.done,
                      icon: RiCheckboxCircleLine,
                      color: TODO_STATUS_META[2].color
                    }
                  ] as const
                ).map((group) =>
                  group.items.length === 0 ? null : (
                    <div key={group.key}>
                      {renderGroupHeader(
                        group.color,
                        <group.icon size={13} />,
                        group.label,
                        group.items.length
                      )}
                      {group.items.map((t) => (
                        <div
                          key={`todo-${t.id}`}
                          style={todoRowStyle(isTodoSelected(t.id))}
                          onClick={() => onSelect({ kind: 'todo', todoId: t.id })}
                          onMouseEnter={(e) => {
                            if (!isTodoSelected(t.id)) {
                              e.currentTarget.style.background = token.colorFillQuaternary
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!isTodoSelected(t.id)) {
                              e.currentTarget.style.background = 'transparent'
                            }
                          }}
                        >
                          {accentBar(isTodoSelected(t.id))}
                          <group.icon
                            size={13}
                            style={{ color: TODO_STATUS_META[t.status ?? 0]?.color, flexShrink: 0 }}
                          />
                          <span
                            style={{
                              flex: 1,
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              /* 已完成置灰：状态已由分组说明，行内不再加删除线，只降一档亮度 */
                              color:
                                t.status === 2 && !isTodoSelected(t.id)
                                  ? token.colorTextTertiary
                                  : undefined
                            }}
                          >
                            {t.title}
                          </span>
                          {t.status !== 2 && t.due_date ? (
                            <span
                              style={{
                                fontSize: 10,
                                color: token.colorTextTertiary,
                                flexShrink: 0,
                                background: token.colorFillTertiary,
                                borderRadius: 4,
                                padding: '0 5px',
                                lineHeight: '15px'
                              }}
                            >
                              {String(t.due_date).slice(5)}
                            </span>
                          ) : null}
                          {todoMenu(t)}
                        </div>
                      ))}
                    </div>
                  )
                )
              ))}

            {renderSectionHeader(
              'wikis',
              <RiArchiveStackLine size={13} />,
              t('notes.term.wiki'),
              wikis.length,
              onCreateWiki
            )}
            {sectionOpen.wikis &&
              (wikis.length === 0 ? (
                <div
                  style={{
                    padding: '4px 12px',
                    fontSize: 12,
                    color: token.colorTextTertiary,
                    textAlign: 'center',
                    userSelect: 'none'
                  }}
                >
                  {t('notes.wiki.empty')}
                </div>
              ) : (
                wikis.map((w) => {
                  const wikiOpen = expandedWikis.has(w.id)
                  const tree = treeCache[w.id]
                  const isLoading = loadingWikis.has(w.id)
                  return (
                    <div key={w.id}>
                      <div style={rowStyle(false, 0)}>
                        {toggleArrow(wikiOpen, () => toggleWiki(w.id))}
                        <RiBook2Line
                          size={13}
                          style={{ color: token.colorWarning, flexShrink: 0 }}
                        />
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}
                          onClick={() => toggleWiki(w.id)}
                        >
                          {w.title}
                        </span>
                        {isLoading ? (
                          /* 行尾就是「…」菜单的位置：占位块与它同宽同高，树不会因载入而抖 */
                          <SkeletonBlock w={26} h={13} r={4} />
                        ) : (
                          rowMenu([
                            {
                              key: 'graph',
                              label: t('notes.graph.view'),
                              icon: <RiMindMap size={14} />,
                              onClick: () => onOpenGraph(w)
                            },
                            {
                              key: 'new-dir',
                              label: t('notes.dir.create'),
                              icon: <RiFolderAddLine size={14} />,
                              onClick: () => openCreateDir(w.id, null)
                            },
                            { type: 'divider' },
                            {
                              key: 'edit',
                              label: t('notes.wiki.edit'),
                              icon: <RiEditLine size={14} />,
                              onClick: () => onEditWiki(w)
                            },
                            {
                              key: 'delete',
                              label: t('notes.wiki.delete'),
                              danger: true,
                              icon: <RiDeleteBinLine size={14} />,
                              onClick: () => onDeleteWiki(w)
                            }
                          ])
                        )}
                      </div>
                      {wikiOpen && tree && renderWikiChildren(w.id, tree)}
                    </div>
                  )
                })
              ))}
          </>
        )}
      </div>

      {/* 目录编辑弹窗 */}
      <Modal
        title={dirModalTitle}
        open={dirModalOpen}
        onOk={handleDirModalOk}
        onCancel={() => setDirModalOpen(false)}
        okText={t('common.action.save')}
        cancelText={t('common.action.cancel')}
        confirmLoading={dirSaving}
        width={380}
      >
        <Input
          autoFocus
          placeholder={t('notes.field.directoryName')}
          value={dirName}
          onChange={(e) => setDirName(e.target.value)}
          onPressEnter={handleDirModalOk}
        />
      </Modal>
    </aside>
  )
}

export default React.memo(DocTreePanel)
