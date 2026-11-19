import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { theme, App } from 'antd'
import type { Editor } from '@tiptap/react'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import { notesApi } from '../api'
import type { DocListItem, TodoItemRow, WikiRow } from '../../shared/types'
import WikiEditModal from './wiki/WikiEditModal'
import TodoEditModal, { type TodoFormValues } from './todo/TodoEditModal'
import DocTreePanel from './DocTreePanel'
import BreadcrumbBar, { type BreadcrumbItem } from './BreadcrumbBar'
import DocEditorPane, { type DocMeta } from './DocEditorPane'
import TodoPane from './TodoPane'
import EmptyDashboard from './EmptyDashboard'
import { SkeletonDashboard, SkeletonGraph } from '@renderer/components/system/Skeleton'
import OutlinePanel from './OutlinePanel'
import ArchiveDocModal from './ArchiveDocModal'
// 知识图谱按需加载（echarts 体积较大，避免拖慢首屏）
const GraphView = lazy(() => import('./graph/GraphView'))
import type { Selection } from '../types'
import { OPEN_WIKI_GRAPH_EVENT } from '../providers/build-progress'

const NotesView: React.FC = () => {
  const { token } = theme.useToken()
  const { viewMessage } = useMessage()
  const { modal } = App.useApp()
  const { t } = useTranslation()

  /* ── 数据 ── */
  /** 全部文档（用于树内标题解析与搜索） */
  const [allDocs, setAllDocs] = useState<DocListItem[]>([])
  /** 未归档文档（文档库分区只显示这些） */
  const [standaloneDocs, setStandaloneDocs] = useState<DocListItem[]>([])
  const [todos, setTodos] = useState<TodoItemRow[]>([])
  const [wikis, setWikis] = useState<WikiRow[]>([])
  const [loading, setLoading] = useState(true)
  const [treeRefreshKey, setTreeRefreshKey] = useState(0)

  /* ── 选中状态 ── */
  const [selection, setSelection] = useState<Selection>(null)

  /* ── 待办：树行「⋯」菜单驱动的编辑/状态流转，以及页面数据刷新令牌 ── */
  const [editTodo, setEditTodo] = useState<TodoItemRow | null>(null)
  const [todoRefreshKey, setTodoRefreshKey] = useState(0)

  /* ── 右侧面板联动 ── */
  const [docEditor, setDocEditor] = useState<Editor | null>(null)
  const [docMeta, setDocMeta] = useState<DocMeta | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  /* ── 面板宽度（可拖拽） ── */
  const [treeWidth, setTreeWidth] = useState(252)
  const [outlineWidth, setOutlineWidth] = useState(236)
  const dragRef = useRef<{ type: 'tree' | 'outline'; startX: number; startW: number } | null>(null)

  const handleDragStart = useCallback(
    (type: 'tree' | 'outline') =>
      (e: React.MouseEvent): void => {
        e.preventDefault()
        dragRef.current = {
          type,
          startX: e.clientX,
          startW: type === 'tree' ? treeWidth : outlineWidth
        }
        document.body.classList.add('notes-resizing')
        const onMove = (ev: MouseEvent): void => {
          const drag = dragRef.current
          if (!drag) return
          const delta = ev.clientX - drag.startX
          if (drag.type === 'tree') {
            setTreeWidth(Math.min(420, Math.max(200, drag.startW + delta)))
          } else {
            setOutlineWidth(Math.min(420, Math.max(180, drag.startW - delta)))
          }
        }
        const onUp = (): void => {
          dragRef.current = null
          document.body.classList.remove('notes-resizing')
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      },
    [treeWidth, outlineWidth]
  )

  /* ── 新建文档后标题聚焦 ── */
  const [focusTitleDocId, setFocusTitleDocId] = useState<number | null>(null)
  useEffect(() => {
    if (selection?.kind !== 'doc') setFocusTitleDocId(null)
  }, [selection])

  /* ── 弹窗状态 ── */
  const [newWikiOpen, setNewWikiOpen] = useState(false)
  const [newTodoOpen, setNewTodoOpen] = useState(false)
  const [editWiki, setEditWiki] = useState<WikiRow | null>(null)
  const [archiveDoc, setArchiveDoc] = useState<DocListItem | null>(null)

  /* ── 加载数据 ── */
  const loadAll = useCallback(async (): Promise<void> => {
    try {
      // 主窗口预热时渲染进程可能早于数据库初始化完成：
      // 先等设置就绪（活动工作区已迁移写回），再查询文档/知识库/待办。
      await window.api.systemSettings.getAll()

      // 分页拉全量（修复：此前硬编码 300 条截断,超出部分在树/搜索/仪表盘不可达且无入口）
      const fetchAllDocs = async (excludeWikiId?: number): Promise<DocListItem[]> => {
        const items: DocListItem[] = []
        let page = 1
        for (;;) {
          const result = await notesApi.docs.getAll(page, 500, excludeWikiId)
          items.push(...result.items)
          if (!result.hasMore || page > 200) break
          page += 1
        }
        return items
      }
      const fetchAllWikis = async (): Promise<WikiRow[]> => {
        const items: WikiRow[] = []
        let page = 1
        for (;;) {
          const result = await notesApi.wikis.getAll(page, 500)
          items.push(...result.items)
          if (!result.hasMore || page > 200) break
          page += 1
        }
        return items
      }
      const [allResult, standaloneResult, todoResult, wikiResult] = await Promise.all([
        /* 全部文档：树内标题解析与搜索 */
        fetchAllDocs(),
        /* exclude=-1：只取未归档（未关联任何知识库目录）的文档 */
        fetchAllDocs(-1),
        notesApi.todoItems.getAll(),
        fetchAllWikis()
      ])
      setAllDocs(allResult)
      setStandaloneDocs(standaloneResult)
      setTodos(todoResult)
      setWikis(wikiResult)
    } catch (error) {
      console.error('Failed to load notes data:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadAll().then()
  }, [loadAll])

  /* ── 图谱构建完成通知 → 直达该知识库的图谱视图（BuildProgressProvider 派发） ── */
  useEffect(() => {
    const handleOpenGraph = (e: Event): void => {
      const detail = (e as CustomEvent<{ wikiId: number }>).detail
      if (detail && typeof detail.wikiId === 'number') {
        setSelection({ kind: 'wiki-graph', wikiId: detail.wikiId })
      }
    }
    window.addEventListener(OPEN_WIKI_GRAPH_EVENT, handleOpenGraph)
    return () => window.removeEventListener(OPEN_WIKI_GRAPH_EVENT, handleOpenGraph)
  }, [])

  /* ── 新建文档：直接创建并打开编辑器（无弹窗，Notion 式交互） ── */
  const handleCreateDoc = useCallback(async (): Promise<void> => {
    const messageKey = 'notes-new-doc'
    try {
      viewMessage(messageKey, 'loading', t('notes.doc.creating'))
      const docId = await notesApi.docs.add({
        title: t('notes.doc.untitled'),
        image: null,
        summary: null,
        content: '',
        tags: null
      })
      viewMessage(messageKey, 'success', t('notes.doc.createSuccess'), 1)
      await loadAll()
      setSelection({ kind: 'doc', docId })
      setFocusTitleDocId(docId)
    } catch (error) {
      console.error('Failed to create doc:', error)
      viewMessage(messageKey, 'error', t('notes.doc.createFailed'))
    }
  }, [viewMessage, loadAll, t])

  /* ── 在知识库目录中新建文档（直接打开编辑器） ── */
  const handleCreateDocInDirectory = useCallback(
    async (directoryId: number, context?: { wikiId: number; dirName: string }): Promise<void> => {
      const messageKey = 'notes-new-doc-dir'
      try {
        viewMessage(messageKey, 'loading', t('notes.doc.creating'))
        const docId = await notesApi.docs.add({
          title: t('notes.doc.untitled'),
          image: null,
          summary: null,
          content: '',
          tags: null
        })
        await notesApi.wikis.addNoteToDirectory(directoryId, docId)
        viewMessage(messageKey, 'success', t('notes.doc.createSuccess'), 1)
        await loadAll()
        setTreeRefreshKey((k) => k + 1)
        setSelection({
          kind: 'doc',
          docId,
          source: context
            ? {
                wikiId: context.wikiId,
                dirId: directoryId,
                dirName: context.dirName,
                wikiTitle: wikis.find((w) => w.id === context.wikiId)?.title
              }
            : undefined
        })
        setFocusTitleDocId(docId)
      } catch (error) {
        console.error('Failed to create doc in directory:', error)
        viewMessage(messageKey, 'error', t('notes.doc.createFailed'))
      }
    },
    [viewMessage, loadAll, wikis, t]
  )

  /* ── 从本地文件导入文档到知识库目录 ── */
  const handleImportDocToDirectory = useCallback(
    async (directoryId: number, context?: { wikiId: number; dirName: string }): Promise<void> => {
      const messageKey = 'notes-import-doc'
      try {
        const imported = await notesApi.docs.importDocument()
        if (!imported) return // 用户取消文件选择
        viewMessage(messageKey, 'loading', t('notes.doc.importing'))
        const docId = await notesApi.docs.add({
          title: imported.title,
          image: null,
          summary: null,
          content: imported.content,
          tags: null
        })
        await notesApi.wikis.addNoteToDirectory(directoryId, docId)
        viewMessage(messageKey, 'success', t('notes.doc.importSuccess'), 2)
        await loadAll()
        setTreeRefreshKey((k) => k + 1)
        setSelection({
          kind: 'doc',
          docId,
          source: context
            ? {
                wikiId: context.wikiId,
                dirId: directoryId,
                dirName: context.dirName,
                wikiTitle: wikis.find((w) => w.id === context.wikiId)?.title
              }
            : undefined
        })
      } catch (error) {
        console.error('Failed to import doc to directory:', error)
        viewMessage(messageKey, 'error', t('notes.doc.importFailed'))
      }
    },
    [viewMessage, loadAll, wikis, t]
  )

  /* ── 新建待办 ── */
  const handleNewTodoSave = useCallback(
    async (values: {
      title: string
      due_date: string | null
      priority: number
      category: string | null
    }): Promise<void> => {
      const messageKey = 'notes-new-todo'
      try {
        viewMessage(messageKey, 'loading', t('notes.todo.creating'))
        const todoId = await notesApi.todoItems.add({
          ...values,
          /* 正文内容与文档同源，创建时留空，进页面后在内联编辑器里写 */
          content: '',
          status: 0,
          due_date: values.due_date ?? null
        })
        viewMessage(messageKey, 'success', t('notes.todo.createSuccess'), 2)
        setNewTodoOpen(false)
        await loadAll()
        setSelection({ kind: 'todo', todoId })
      } catch (error) {
        console.error('Failed to create todo:', error)
        viewMessage(messageKey, 'error', t('notes.todo.createFailed'))
      }
    },
    [viewMessage, loadAll, t]
  )

  /* ── 待办操作（都从树行「⋯」菜单发起；待办页内只留内容编辑） ── */
  const handleSetTodoStatus = useCallback(
    async (todo: TodoItemRow, status: number): Promise<void> => {
      const messageKey = 'notes-todo-status'
      try {
        viewMessage(messageKey, 'loading', t('notes.todo.updatingStatus'))
        await notesApi.todoItems.update(todo.id, { status })
        viewMessage(
          messageKey,
          'success',
          status === 2
            ? t('notes.status.done')
            : status === 1
              ? t('notes.todo.markedDoing')
              : t('notes.todo.reactivated'),
          2
        )
        await loadAll()
        // 让正在打开的待办页重新读库（正文编辑不受影响：页面会先冲刷未保存内容）
        setTodoRefreshKey((key) => key + 1)
      } catch (error) {
        console.error('Failed to update todo status:', error)
        viewMessage(messageKey, 'error', t('notes.todo.statusUpdateFailed'))
      }
    },
    [viewMessage, loadAll, t]
  )

  const handleEditTodoSave = useCallback(
    async (values: TodoFormValues): Promise<void> => {
      if (!editTodo) return
      const messageKey = 'notes-edit-todo'
      try {
        viewMessage(messageKey, 'loading', t('notes.todo.saving'))
        await notesApi.todoItems.update(editTodo.id, {
          title: values.title,
          due_date: values.due_date,
          priority: values.priority,
          status: values.status,
          category: values.category
        })
        viewMessage(messageKey, 'success', t('notes.todo.updated'), 2)
        setEditTodo(null)
        await loadAll()
        setTodoRefreshKey((key) => key + 1)
      } catch (error) {
        console.error('Failed to update todo:', error)
        viewMessage(messageKey, 'error', t('notes.todo.saveFailed'))
      }
    },
    [editTodo, viewMessage, loadAll, t]
  )

  /* 待办页里改标题：就地更新列表（树行 + 面包屑），不再为一次标题输入跑全量刷新 */
  const handleTodoTitleSaved = useCallback((todoId: number, title: string): void => {
    setTodos((prev) => prev.map((t) => (t.id === todoId ? { ...t, title } : t)))
  }, [])

  const handleDeleteTodo = useCallback(
    (todo: TodoItemRow): void => {
      modal.confirm({
        title: t('notes.todo.deleteTitle'),
        content: t('common.message.irreversible'),
        okText: t('common.action.delete'),
        okButtonProps: { danger: true },
        cancelText: t('common.action.cancel'),
        onOk: async () => {
          const messageKey = 'notes-delete-todo'
          try {
            viewMessage(messageKey, 'loading', t('common.action.deleting'))
            await notesApi.todoItems.delete(todo.id)
            viewMessage(messageKey, 'success', t('common.action.deleteSuccess'), 2)
            if (selection?.kind === 'todo' && selection.todoId === todo.id) setSelection(null)
            await loadAll()
          } catch (error) {
            console.error('Failed to delete todo:', error)
            viewMessage(messageKey, 'error', t('common.action.deleteFailed'))
          }
        }
      })
    },
    [viewMessage, loadAll, modal, selection, t]
  )

  /* ── 新建 / 编辑知识库 ── */
  const handleNewWikiSave = useCallback(
    async (data: {
      title: string
      summary: string | null
      tags: string | null
      image: string | null
    }): Promise<void> => {
      const messageKey = 'notes-new-wiki'
      try {
        viewMessage(messageKey, 'loading', t('notes.wiki.creating'))
        await notesApi.wikis.add(data)
        viewMessage(messageKey, 'success', t('notes.wiki.createSuccess'), 2)
        setNewWikiOpen(false)
        await loadAll()
      } catch (error) {
        console.error('Failed to create wiki:', error)
        viewMessage(messageKey, 'error', t('notes.wiki.createFailed'))
      }
    },
    [viewMessage, loadAll, t]
  )

  const handleEditWikiSave = useCallback(
    async (data: {
      title: string
      summary: string | null
      tags: string | null
      image: string | null
    }): Promise<void> => {
      if (!editWiki) return
      const messageKey = 'notes-edit-wiki'
      try {
        viewMessage(messageKey, 'loading', t('notes.wiki.saving'))
        await notesApi.wikis.update(editWiki.id, data)
        viewMessage(messageKey, 'success', t('notes.wiki.updated'), 2)
        setEditWiki(null)
        await loadAll()
        setTreeRefreshKey((k) => k + 1)
      } catch (error) {
        console.error('Failed to update wiki:', error)
        viewMessage(messageKey, 'error', t('notes.wiki.saveFailed'))
      }
    },
    [viewMessage, loadAll, editWiki, t]
  )

  /* 删除知识库（来自树 ⋯ 菜单） */
  const handleDeleteWiki = useCallback(
    (wiki: WikiRow): void => {
      modal.confirm({
        title: t('notes.wiki.deleteTitle', { name: wiki.title }),
        content: t('notes.wiki.deleteContent'),
        okText: t('common.action.delete'),
        okButtonProps: { danger: true },
        cancelText: t('common.action.cancel'),
        onOk: async () => {
          const messageKey = 'notes-delete-wiki'
          try {
            viewMessage(messageKey, 'loading', t('notes.wiki.deleting'))
            await notesApi.wikis.delete(wiki.id)
            viewMessage(messageKey, 'success', t('notes.wiki.deleted'), 2)
            /* 若正在查看该知识库的图谱视图（整库或文档子图），删除后回到仪表盘 */
            setSelection((sel) =>
              sel?.kind === 'wiki-graph' && sel.wikiId === wiki.id
                ? null
                : sel?.kind === 'doc-graph' && sel.wikiId === wiki.id
                  ? null
                  : sel
            )
            await loadAll()
            setTreeRefreshKey((k) => k + 1)
          } catch (error) {
            console.error('Failed to delete wiki:', error)
            viewMessage(messageKey, 'error', t('notes.wiki.deleteFailed'))
          }
        }
      })
    },
    [viewMessage, loadAll, modal, t]
  )

  /* ── 文档保存 / 删除 / 归档 ── */
  const handleDocSaved = useCallback((docId: number, title: string): void => {
    const patch = (d: DocListItem): DocListItem =>
      d.id === docId ? { ...d, title, updated_at: new Date().toISOString() } : d
    setAllDocs((prev) => prev.map(patch))
    setStandaloneDocs((prev) => prev.map(patch))
  }, [])

  /* 删除文档（来自树 ⋯ 菜单） */
  const handleDeleteDoc = useCallback(
    (doc: DocListItem): void => {
      modal.confirm({
        title: t('notes.doc.deleteTitle', { name: doc.title }),
        content: t('common.message.irreversible'),
        okText: t('common.action.delete'),
        okButtonProps: { danger: true },
        cancelText: t('common.action.cancel'),
        onOk: async () => {
          const messageKey = 'notes-delete-doc'
          try {
            viewMessage(messageKey, 'loading', t('notes.doc.deleting'))
            await notesApi.docs.delete(doc.id)
            viewMessage(messageKey, 'success', t('notes.doc.deleteSuccess'), 2)
            setSelection((sel) =>
              sel?.kind === 'doc' && sel.docId === doc.id
                ? null
                : sel?.kind === 'doc-graph' && sel.docId === doc.id
                  ? null
                  : sel
            )
            await loadAll()
            setTreeRefreshKey((k) => k + 1)
          } catch (error) {
            console.error('Failed to delete doc:', error)
            viewMessage(messageKey, 'error', t('notes.doc.deleteFailed'))
          }
        }
      })
    },
    [viewMessage, loadAll, modal, t]
  )

  const handleArchived = useCallback(async (): Promise<void> => {
    await loadAll()
    setTreeRefreshKey((k) => k + 1)
    // 修复：归档正在编辑的文档后,文档从「文档库」分区消失但编辑器仍停留,树中无选中态
    // 且看不到归属——关闭编辑器回到仪表盘
    if (selection?.kind === 'doc') {
      setSelection(null)
    }
  }, [loadAll, selection])

  /* 树内操作改变了文档与目录的关联（删除目录/从目录移除）→ 刷新文档列表 */
  const handleTreeDocsChanged = useCallback((): void => {
    loadAll().then()
  }, [loadAll])

  /* ── 面包屑（仅展示路径，点击根节点可回到笔记首页） ── */
  const breadcrumbItems = useMemo((): BreadcrumbItem[] => {
    const items: BreadcrumbItem[] = [
      { label: t('notes.breadcrumb.root'), onClick: () => setSelection(null) }
    ]
    if (!selection) return items
    if (selection.kind === 'doc') {
      const doc = allDocs.find((d) => d.id === selection.docId)
      if (selection.source) {
        const wiki = wikis.find((w) => w.id === selection.source?.wikiId)
        items.push({ label: wiki?.title ?? t('notes.term.wiki') })
        if (selection.source.dirId != null) {
          items.push({ label: selection.source.dirName ?? t('notes.term.directory') })
        }
      } else {
        items.push({ label: t('notes.term.docLibrary') })
      }
      items.push({ label: doc?.title ?? t('notes.breadcrumb.docWithId', { id: selection.docId }) })
    } else if (selection.kind === 'wiki-graph') {
      const wiki = wikis.find((w) => w.id === selection.wikiId)
      items.push({ label: wiki?.title ?? t('notes.term.wiki') })
      items.push({ label: t('notes.term.graph') })
    } else if (selection.kind === 'doc-graph') {
      const wiki = wikis.find((w) => w.id === selection.wikiId)
      const doc = allDocs.find((d) => d.id === selection.docId)
      items.push({ label: wiki?.title ?? t('notes.term.wiki') })
      items.push({ label: doc?.title ?? t('notes.breadcrumb.docWithId', { id: selection.docId }) })
      items.push({ label: t('notes.term.graph') })
    } else {
      const todo = todos.find((t) => t.id === selection.todoId)
      items.push({ label: t('notes.term.todo') })
      items.push({
        label: todo?.title ?? t('notes.breadcrumb.todoWithId', { id: selection.todoId })
      })
    }
    return items
  }, [selection, allDocs, todos, wikis, t])

  /* ── 中间主区内容 ── */
  const renderCenter = (): React.ReactNode => {
    if (loading) {
      /* 首屏（文档 / 待办 / 知识库都还没到位）走仪表盘骨架，结构与 EmptyDashboard 对齐 */
      return <SkeletonDashboard />
    }
    if (!selection) {
      return (
        <EmptyDashboard
          docs={standaloneDocs}
          todos={todos}
          wikis={wikis}
          onOpenDoc={(docId) => setSelection({ kind: 'doc', docId })}
          onOpenTodo={(todoId) => setSelection({ kind: 'todo', todoId })}
          onCreateDoc={handleCreateDoc}
          onCreateTodo={() => setNewTodoOpen(true)}
          onCreateWiki={() => setNewWikiOpen(true)}
        />
      )
    }
    if (selection.kind === 'doc') {
      return (
        <DocEditorPane
          key={selection.docId}
          docId={selection.docId}
          onSaved={handleDocSaved}
          onMetaChange={setDocMeta}
          onEditorReady={setDocEditor}
          scrollRef={scrollRef}
          autofocusTitle={focusTitleDocId === selection.docId}
        />
      )
    }
    if (selection.kind === 'wiki-graph' || selection.kind === 'doc-graph') {
      const wiki = wikis.find((w) => w.id === selection.wikiId)
      if (!wiki) {
        return (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <span style={{ color: token.colorTextTertiary, fontSize: 13 }}>
              {t('notes.wiki.notFound')}
            </span>
          </div>
        )
      }
      /* 文档级子图：带 initialDocFilter，key 用 docId 保证切换文档时重建筛选 */
      return (
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <Suspense fallback={<SkeletonGraph />}>
            <GraphView
              key={
                selection.kind === 'doc-graph'
                  ? `doc-graph-${selection.docId}`
                  : `wiki-graph-${selection.wikiId}`
              }
              selectedWiki={wiki}
              initialDocFilter={selection.kind === 'doc-graph' ? [selection.docId] : undefined}
              onOpenDocInEditor={(docId) =>
                setSelection({
                  kind: 'doc',
                  docId,
                  source: { wikiId: wiki.id, wikiTitle: wiki.title }
                })
              }
            />
          </Suspense>
        </div>
      )
    }
    return (
      <TodoPane
        key={selection.todoId}
        todoId={selection.todoId}
        reloadToken={todoRefreshKey}
        onSetStatus={handleSetTodoStatus}
        onOpenProperties={setEditTodo}
        onTitleSaved={handleTodoTitleSaved}
      />
    )
  }

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        background: token.colorBgLayout,
        boxSizing: 'border-box',
        minHeight: 0
      }}
    >
      {/* 左侧文档树（可拖拽调宽） */}
      <DocTreePanel
        width={treeWidth}
        docs={standaloneDocs}
        allDocs={allDocs}
        todos={todos}
        wikis={wikis}
        selection={selection}
        onSelect={setSelection}
        onCreateDoc={handleCreateDoc}
        onCreateTodo={() => setNewTodoOpen(true)}
        onCreateWiki={() => setNewWikiOpen(true)}
        onEditWiki={setEditWiki}
        onDeleteWiki={handleDeleteWiki}
        onOpenGraph={(wiki) => setSelection({ kind: 'wiki-graph', wikiId: wiki.id })}
        onOpenDocGraph={(wikiId, docId) => setSelection({ kind: 'doc-graph', wikiId, docId })}
        onDeleteDoc={handleDeleteDoc}
        onEditTodo={setEditTodo}
        onDeleteTodo={handleDeleteTodo}
        onSetTodoStatus={handleSetTodoStatus}
        onArchiveDoc={setArchiveDoc}
        onCreateDocInDirectory={handleCreateDocInDirectory}
        onImportDocToDirectory={handleImportDocToDirectory}
        onDocsChanged={handleTreeDocsChanged}
        refreshKey={treeRefreshKey}
      />
      <div className="notes-col-resizer" onMouseDown={handleDragStart('tree')} />

      {/* 中间主区：整体一张卡片（面包屑 + 内容），参考 Harness 主区结构。
          首页仪表盘与知识图谱视图无卡片外壳（无边框、无圆角），与左右侧栏融为一体；
          文档/待办等具体内容才是独立卡片（有边框、有圆角） */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          background: token.colorBgContainer,
          overflow: 'hidden'
        }}
      >
        <BreadcrumbBar items={breadcrumbItems} />
        {renderCenter()}
      </div>

      {/* 右侧大纲 / 属性（编辑器就绪后才挂载，key 保证每次切换文档重建订阅） */}
      {selection?.kind === 'doc' && docEditor && (
        <>
          <div className="notes-col-resizer" onMouseDown={handleDragStart('outline')} />
          <OutlinePanel
            key={selection.docId}
            width={outlineWidth}
            editor={docEditor}
            scrollRef={scrollRef}
            meta={docMeta ?? undefined}
          />
        </>
      )}

      {/* ── 弹窗 ── */}
      <WikiEditModal
        open={newWikiOpen}
        isNew={true}
        onSave={handleNewWikiSave}
        onCancel={() => setNewWikiOpen(false)}
      />

      <WikiEditModal
        open={editWiki !== null}
        isNew={false}
        initialTitle={editWiki?.title ?? ''}
        initialSummary={editWiki?.summary ?? ''}
        initialTags={editWiki?.tags ?? ''}
        initialImage={editWiki?.image ?? null}
        onSave={handleEditWikiSave}
        onCancel={() => setEditWiki(null)}
      />

      <TodoEditModal
        editModalOpen={editTodo !== null}
        currentTodo={editTodo}
        onEditClose={() => setEditTodo(null)}
        onEditSave={handleEditTodoSave}
        addModalOpen={newTodoOpen}
        onAddClose={() => setNewTodoOpen(false)}
        onAddSave={handleNewTodoSave}
      />

      <ArchiveDocModal
        open={archiveDoc !== null}
        doc={archiveDoc}
        wikis={wikis}
        onArchived={handleArchived}
        onClose={() => setArchiveDoc(null)}
      />
    </div>
  )
}

export default NotesView
