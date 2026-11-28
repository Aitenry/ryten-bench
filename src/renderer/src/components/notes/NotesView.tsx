import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { theme, App } from 'antd'
import type { Editor } from '@tiptap/react'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import { notesApi } from '../../api/notes'
import type { DocListItem, TodoItemRow, WikiRow } from '../../../../shared/notes/types'
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
// Load the knowledge graph on demand (echarts is large; avoid slowing the first paint)
const GraphView = lazy(() => import('./graph/GraphView'))
import type { Selection } from '../../types/notes'
import { OPEN_WIKI_GRAPH_EVENT } from '../../providers/notes/build-progress'

const NotesView: React.FC = () => {
  const { token } = theme.useToken()
  const { viewMessage } = useMessage()
  const { modal } = App.useApp()
  const { t } = useTranslation()

  /* ── Data ── */
  /** All docs (used for in-tree title resolution and search) */
  const [allDocs, setAllDocs] = useState<DocListItem[]>([])
  /** Unarchived docs (the doc-library section only shows these) */
  const [standaloneDocs, setStandaloneDocs] = useState<DocListItem[]>([])
  const [todos, setTodos] = useState<TodoItemRow[]>([])
  const [wikis, setWikis] = useState<WikiRow[]>([])
  const [loading, setLoading] = useState(true)
  const [treeRefreshKey, setTreeRefreshKey] = useState(0)

  /* ── Selection state ── */
  const [selection, setSelection] = useState<Selection>(null)

  /* ── Todos: editing/status transitions driven by the tree row "⋯" menu, plus the page data refresh token ── */
  const [editTodo, setEditTodo] = useState<TodoItemRow | null>(null)
  const [todoRefreshKey, setTodoRefreshKey] = useState(0)

  /* ── Right panel wiring ── */
  const [docEditor, setDocEditor] = useState<Editor | null>(null)
  const [docMeta, setDocMeta] = useState<DocMeta | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  /* ── Panel widths (draggable) ── */
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

  /* ── Focus the title after creating a doc ── */
  const [focusTitleDocId, setFocusTitleDocId] = useState<number | null>(null)
  useEffect(() => {
    if (selection?.kind !== 'doc') setFocusTitleDocId(null)
  }, [selection])

  /* ── Modal state ── */
  const [newWikiOpen, setNewWikiOpen] = useState(false)
  const [newTodoOpen, setNewTodoOpen] = useState(false)
  const [editWiki, setEditWiki] = useState<WikiRow | null>(null)
  const [archiveDoc, setArchiveDoc] = useState<DocListItem | null>(null)

  /* ── Load data ── */
  const loadAll = useCallback(async (): Promise<void> => {
    try {
      // During main-window warm-up the renderer may start before database initialization finishes:
      // wait for settings to be ready first (the active workspace has been migrated back), then query docs/wikis/todos.
      await window.api.systemSettings.getAll()

      // Page through everything (fix: a hardcoded 300-item cap left the rest unreachable in the tree/search/dashboard, with no entry point)
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
        /* All docs: in-tree title resolution and search */
        fetchAllDocs(),
        /* exclude=-1: only docs that are not archived (not linked to any wiki directory) */
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

  /* ── Graph build completed notification → jump to that wiki's graph view (dispatched by BuildProgressProvider) ── */
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

  /* ── New doc: create it and open the editor directly (no dialog) ── */
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

  /* ── Create a doc inside a wiki directory (opens the editor directly) ── */
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

  /* ── Import a doc from a local file into a wiki directory ── */
  const handleImportDocToDirectory = useCallback(
    async (directoryId: number, context?: { wikiId: number; dirName: string }): Promise<void> => {
      const messageKey = 'notes-import-doc'
      try {
        const imported = await notesApi.docs.importDocument()
        if (!imported) return // user cancelled the file picker
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

  /* ── New todo ── */
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
          /* Body content shares its source with docs: leave it empty on creation and write it in the inline editor once the page is open */
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

  /* ── Todo actions (all launched from the tree row "⋯" menu; the todo page only keeps content editing) ── */
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
        // Re-read from the DB in the open todo page (body editing is unaffected: the page flushes unsaved content first)
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

  /* Title edits on the todo page: update the list in place (tree row + breadcrumb) instead of running a full refresh for a single title input */
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

  /* ── Create / edit wiki ── */
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

  /* Delete a wiki (from the tree ⋯ menu) */
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
            /* If this wiki's graph view is open (whole wiki or doc subgraph), go back to the dashboard after deletion */
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

  /* ── Doc save / delete / archive ── */
  const handleDocSaved = useCallback((docId: number, title: string): void => {
    const patch = (d: DocListItem): DocListItem =>
      d.id === docId ? { ...d, title, updated_at: new Date().toISOString() } : d
    setAllDocs((prev) => prev.map(patch))
    setStandaloneDocs((prev) => prev.map(patch))
  }, [])

  /* Delete a doc (from the tree ⋯ menu) */
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
    // Fix: after archiving the doc being edited, it disappears from the "doc library" section but the editor
    // stayed open, with no selection in the tree and no visible owner — close the editor and return to the dashboard
    if (selection?.kind === 'doc') {
      setSelection(null)
    }
  }, [loadAll, selection])

  /* Tree actions changed the doc-to-directory links (directory deleted / doc removed from directory) → refresh the doc list */
  const handleTreeDocsChanged = useCallback((): void => {
    loadAll().then()
  }, [loadAll])

  /* ── Breadcrumb (path display only; clicking the root returns to the notes home) ── */
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

  /* ── Center main-area content ── */
  const renderCenter = (): React.ReactNode => {
    if (loading) {
      /* First paint (docs / todos / wikis not loaded yet) uses the dashboard skeleton, matching EmptyDashboard's structure */
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
      /* Doc-level subgraph: pass initialDocFilter and key by docId so the filter is rebuilt when switching docs */
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
        /* Transparent: the notes page container supplies the base color, avoiding two sets of shades in blank areas and panels */
        background: 'transparent',
        boxSizing: 'border-box',
        minHeight: 0
      }}
    >
      {/* Left doc tree (drag to resize) */}
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

      {/* Center main area: one card overall (breadcrumb + content), mirroring the main-area structure.
          The home dashboard and graph view have no card shell (no border, no rounded corners) and blend with the side panels;
          concrete content such as docs/todos is a separate card (bordered and rounded) */}
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

      {/* Right outline / properties (mounted only once the editor is ready; the key rebuilds subscriptions on every doc switch) */}
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

      {/* ── Modals ── */}
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
