import React, { useCallback, useEffect, useRef, useState } from 'react'
import { theme, Input, Empty, Tag, Tooltip } from 'antd'
import { SkeletonTodoPane } from '@renderer/components/system/Skeleton'
import {
  RiPlayLine,
  RiCheckLine,
  RiRefreshLine,
  RiSettings3Line,
  RiEditLine,
  RiTimeLine,
  RiFlag2Line,
  RiPriceTag3Line,
  RiLoader2Line,
  RiErrorWarningLine
} from '@remixicon/react'
import dayjs from 'dayjs'
import TipTapMarkdownEditor from '@renderer/components/markdown/TipTapMarkdownEditor'
import { useTranslation } from '@renderer/i18n'
import { notesApi } from '../../api/notes'
import type { TodoItem } from '../../types/notes'

interface TodoPaneProps {
  todoId: number
  /** Parent token: bumped after the tree row "⋯" changes status/metadata, so this page re-reads the store */
  reloadToken?: number
  /** Status transition: shares one implementation with the tree row "⋯" (write to store + refresh tree + make this page re-read) */
  onSetStatus: (todo: TodoItem, status: number) => void | Promise<void>
  /** Open the properties modal (title / due date / priority / status / category) */
  onOpenProperties: (todo: TodoItem) => void
  /** Called back after the title saves, to update the tree row and breadcrumb in place (saves a full refresh) */
  onTitleSaved: (todoId: number, title: string) => void
}

/** Status → i18n key / color (the key is resolved by t() in the component; a module-level table calls no hooks) */
type TodoStatusKey = 'notes.status.pending' | 'notes.status.doing' | 'notes.status.done'

const STATUS_META: Record<number, { labelKey: TodoStatusKey; color: string; bg: string }> = {
  0: { labelKey: 'notes.status.pending', color: '#1677ff', bg: 'rgba(22,119,255,0.1)' },
  1: { labelKey: 'notes.status.doing', color: '#fa8c16', bg: 'rgba(250,140,22,0.12)' },
  2: { labelKey: 'notes.status.done', color: '#52c41a', bg: 'rgba(82,196,26,0.12)' }
}

const PRIORITY_COLORS: Record<number, string> = {
  0: '#f5222d',
  1: '#fa8c16',
  2: '#fadb14',
  3: '#52c41a',
  4: '#13c2c2',
  5: '#1677ff',
  6: '#2f54eb',
  7: '#722ed1'
}

type SaveState = 'saved' | 'saving' | 'dirty' | 'error'

/** Auto-save delay for title / body, matching the document editor's cadence */
const AUTO_SAVE_DELAY = 1500

const TodoPane: React.FC<TodoPaneProps> = ({
  todoId,
  reloadToken = 0,
  onSetStatus,
  onOpenProperties,
  onTitleSaved
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const [todo, setTodo] = useState<TodoItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  /* ── Title + body (Markdown): same source as the document page, both edited inline here ── */
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  const titleRef = useRef('')
  const contentRef = useRef('')
  const lastSavedRef = useRef<{ title: string; content: string }>({ title: '', content: '' })
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savingRef = useRef(false)

  /* Parent callbacks go through a ref so save closures never go stale */
  const onTitleSavedRef = useRef(onTitleSaved)
  onTitleSavedRef.current = onTitleSaved

  /**
   * Persist immediately (title + body written together). Writes only when something actually
   * changed; edits made while a save is in flight are re-scheduled once it finishes
   * (otherwise those edits are silently dropped while the UI still says "saved")
   */
  const saveNow = useCallback(async (): Promise<void> => {
    const nextTitle = titleRef.current
    const nextContent = contentRef.current
    const last = lastSavedRef.current
    const dbTitle = nextTitle.trim() === '' ? t('notes.todo.untitled') : nextTitle
    if (nextTitle === last.title && nextContent === last.content) {
      setSaveState('saved')
      return
    }
    if (savingRef.current) return
    savingRef.current = true
    setSaveState('saving')
    try {
      await notesApi.todoItems.update(todoId, { title: dbTitle, content: nextContent })
      const titleChanged = nextTitle !== last.title
      lastSavedRef.current = { title: nextTitle, content: nextContent }
      setSaveState('saved')
      setLastSavedAt(new Date())
      // Notify only when the title changed (no need to refresh the parent on every body save)
      if (titleChanged) onTitleSavedRef.current(todoId, dbTitle)
    } catch (error) {
      console.error('Failed to save todo:', error)
      setSaveState('error')
    } finally {
      savingRef.current = false
      const cur = lastSavedRef.current
      if (titleRef.current !== cur.title || contentRef.current !== cur.content) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(() => {
          saveNow().then()
        }, AUTO_SAVE_DELAY)
      }
    }
  }, [todoId, t])

  /** Flush unsaved edits first: called before a status transition / opening properties / reloading, so local edits are not overwritten by stale stored values */
  const flushPending = useCallback(async (): Promise<void> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    while (savingRef.current) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const last = lastSavedRef.current
    if (titleRef.current !== last.title || contentRef.current !== last.content) {
      await saveNow()
    }
  }, [saveNow])

  const markChanged = useCallback((): void => {
    const last = lastSavedRef.current
    if (titleRef.current === last.title && contentRef.current === last.content) {
      setSaveState('saved')
      return
    }
    setSaveState('dirty')
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveNow().then()
    }, AUTO_SAVE_DELAY)
  }, [saveNow])

  const load = useCallback(
    async (silent = false): Promise<void> => {
      if (!silent) setLoading(true)
      try {
        const result = await notesApi.todoItems.getById(todoId)
        if (result.length > 0) {
          const row = result[0]
          setTodo(row)
          const rowTitle = row.title ?? ''
          const markdown = row.content ?? ''
          titleRef.current = rowTitle
          contentRef.current = markdown
          lastSavedRef.current = { title: rowTitle, content: markdown }
          setTitle(rowTitle)
          setContent(markdown)
          setSaveState('saved')
        } else {
          setNotFound(true)
        }
      } catch (error) {
        console.error('Failed to load todo:', error)
        setNotFound(true)
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [todoId]
  )

  useEffect(() => {
    setNotFound(false)
    load().then()
  }, [load])

  /* Flush unsaved title and body on unmount (switching todo / leaving the page) */
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      void (async () => {
        while (savingRef.current) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        const last = lastSavedRef.current
        const pendingTitle = titleRef.current
        const pendingContent = contentRef.current
        if (pendingTitle !== last.title || pendingContent !== last.content) {
          try {
            await notesApi.todoItems.update(todoId, {
              title: pendingTitle.trim() === '' ? t('notes.todo.untitled') : pendingTitle,
              content: pendingContent
            })
          } catch (error) {
            console.error('Failed to flush todo on unmount:', error)
          }
        }
      })()
    }
  }, [todoId, t])

  /* After the tree row "⋯" changes status / metadata, the parent token triggers a re-read:
   *  flush unsaved edits first (so stale stored values do not overwrite them), then refresh
   *  silently without flashing the loading state */
  const firstReloadRef = useRef(true)
  useEffect(() => {
    if (firstReloadRef.current) {
      firstReloadRef.current = false
      return
    }
    void (async () => {
      await flushPending()
      await load(true)
    })()
  }, [reloadToken, flushPending, load])

  const handleTitleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      titleRef.current = e.target.value
      setTitle(e.target.value)
      markChanged()
    },
    [markChanged]
  )

  const handleContentChange = useCallback(
    (markdown: string): void => {
      contentRef.current = markdown
      setContent(markdown)
      markChanged()
    },
    [markChanged]
  )

  if (loading) {
    return (
      <PaneShell>
        {/* Lay out the checkbox / title / field pills / body first, then swap them in place once the todo arrives */}
        <SkeletonTodoPane />
      </PaneShell>
    )
  }

  if (notFound || !todo) {
    return (
      <PaneShell>
        <Empty description={t('notes.todo.notFound')} style={{ marginTop: 120 }} />
      </PaneShell>
    )
  }

  // status/priority columns are nullable in the store (DEFAULT 0); null falls back to the default
  const status = STATUS_META[todo.status ?? 0] ?? STATUS_META[0]
  const priorityColor = PRIORITY_COLORS[todo.priority ?? 0] ?? token.colorTextTertiary
  const overdue =
    todo.status !== 2 && todo.due_date && dayjs(todo.due_date).isBefore(dayjs(), 'day')

  /** Status switch (far right of the title row, icon only): pending —▶→ doing —✓→ done —↻→ pending.
   *  A persistent tinted rounded block in the target status's color — the three statuses use
   *  different icon shapes, so this backing fixes them as "one button", and the color also
   *  shows which status it advances to */
  const step =
    (todo.status ?? 0) === 0
      ? {
          label: t('notes.todo.actionStart'),
          icon: RiPlayLine,
          color: STATUS_META[1].color,
          bg: STATUS_META[1].bg,
          next: 1
        }
      : (todo.status ?? 0) === 1
        ? {
            label: t('notes.todo.actionComplete'),
            icon: RiCheckLine,
            color: STATUS_META[2].color,
            bg: STATUS_META[2].bg,
            next: 2
          }
        : {
            label: t('notes.todo.actionReactivate'),
            icon: RiRefreshLine,
            color: STATUS_META[0].color,
            bg: STATUS_META[0].bg,
            next: 0
          }

  const handleAdvanceStatus = async (): Promise<void> => {
    await flushPending()
    await onSetStatus(todo, step.next)
  }

  const handleOpenProperties = async (): Promise<void> => {
    await flushPending()
    // Include the just-flushed title so the modal does not show the old value
    onOpenProperties({ ...todo, title: titleRef.current || todo.title })
  }

  /* Timeline on the right of the bottom status bar (formerly a metadata grid: same fields,
     collapsed into one line, all formatted as YYYY-MM-DD HH:mm) */
  const metaParts: string[] = []
  if (todo.created_at)
    metaParts.push(
      t('notes.todo.metaCreated', { time: dayjs(todo.created_at).format('YYYY-MM-DD HH:mm') })
    )
  if (todo.updated_at)
    metaParts.push(
      t('notes.todo.metaUpdated', { time: dayjs(todo.updated_at).format('YYYY-MM-DD HH:mm') })
    )
  if (todo.started_at)
    metaParts.push(
      t('notes.todo.metaStarted', { time: dayjs(todo.started_at).format('YYYY-MM-DD HH:mm') })
    )
  if (todo.completed_at)
    metaParts.push(
      t('notes.todo.metaCompleted', { time: dayjs(todo.completed_at).format('YYYY-MM-DD HH:mm') })
    )

  const saveIndicator = ((): React.ReactNode => {
    switch (saveState) {
      case 'saving':
        return (
          <>
            <RiLoader2Line size={13} className="spin-anim" style={{ color: token.colorPrimary }} />
            <span style={{ color: token.colorTextSecondary }}>{t('notes.editor.saving')}</span>
          </>
        )
      case 'dirty':
        return (
          <>
            <RiEditLine size={13} style={{ color: token.colorTextTertiary }} />
            <span style={{ color: token.colorTextTertiary }}>{t('notes.editor.unsaved')}</span>
          </>
        )
      case 'error':
        return (
          <>
            <RiErrorWarningLine size={13} style={{ color: token.colorError }} />
            <span style={{ color: token.colorError }}>{t('common.action.saveFailed')}</span>
          </>
        )
      default:
        return (
          <>
            <RiCheckLine size={13} style={{ color: token.colorSuccess }} />
            <span style={{ color: token.colorTextTertiary }}>
              {lastSavedAt
                ? t('notes.editor.savedWithTime', { time: dayjs(lastSavedAt).format('HH:mm:ss') })
                : t('notes.editor.saved')}
            </span>
          </>
        )
    }
  })()

  return (
    <PaneShell>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          height: '100%',
          maxWidth: 876,
          width: '100%',
          margin: '0 auto'
        }}
      >
        {/* Fixed header: title (editable) + status switch + status tags + properties (does not scroll with the body) */}
        <div style={{ padding: '17px 17px 0', flexShrink: 0 }}>
          {/* Title row: the title is edited directly; the far right is the icon-only status switch */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Input
              variant="borderless"
              value={title}
              onChange={handleTitleChange}
              placeholder={t('notes.todo.untitled')}
              maxLength={120}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 24,
                fontWeight: 700,
                padding: 0,
                letterSpacing: -0.01,
                textDecoration: todo.status === 2 ? 'line-through' : 'none',
                textDecorationColor: token.colorTextTertiary
              }}
            />
            <Tooltip title={step.label} placement="bottomRight">
              <button
                onClick={() => {
                  void handleAdvanceStatus()
                }}
                style={{
                  width: 30,
                  height: 30,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: 'none',
                  borderRadius: 8,
                  background: step.bg,
                  color: step.color,
                  cursor: 'pointer',
                  transition: 'background 0.15s'
                }}
                onMouseEnter={(e) => {
                  // The last two digits of an 8-digit hex are alpha: brighten the tinted background on hover
                  e.currentTarget.style.background = `${step.color}2e`
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = step.bg
                }}
              >
                <step.icon size={18} />
              </button>
            </Tooltip>
          </div>

          {/* Status tag row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              marginTop: 8,
              marginBottom: 0
            }}
          >
            <Tag
              variant="filled"
              style={{
                margin: 0,
                color: status.color,
                background: status.bg,
                fontSize: 12,
                padding: '1px 10px',
                borderRadius: 10
              }}
            >
              {t(status.labelKey)}
            </Tag>
            <Tag
              variant="filled"
              style={{
                margin: 0,
                color: priorityColor,
                background: token.colorFillTertiary,
                fontSize: 12,
                padding: '1px 10px',
                borderRadius: 10,
                display: 'flex',
                alignItems: 'center',
                gap: 5
              }}
            >
              <RiFlag2Line size={12} />
              {t('notes.todo.priority', { level: todo.priority })}
            </Tag>
            {todo.category && (
              <Tag
                variant="filled"
                style={{
                  margin: 0,
                  color: token.colorTextSecondary,
                  background: token.colorFillTertiary,
                  fontSize: 12,
                  padding: '1px 10px',
                  borderRadius: 10,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5
                }}
              >
                <RiPriceTag3Line size={12} />
                {todo.category}
              </Tag>
            )}
            {todo.due_date && (
              <Tag
                variant="filled"
                style={{
                  margin: 0,
                  color: overdue ? token.colorError : token.colorTextSecondary,
                  background: overdue ? token.colorErrorBg : token.colorFillTertiary,
                  fontSize: 12,
                  padding: '1px 10px',
                  borderRadius: 10,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5
                }}
              >
                <RiTimeLine size={12} />
                {overdue ? t('notes.todo.overduePrefix') : t('notes.todo.duePrefix')}
                {dayjs(todo.due_date).format('YYYY-MM-DD')}
              </Tag>
            )}
            {/* Properties: title / due date / priority / status / category (same spot as "Properties"
                on the document page). Rendered as an outlined pill: the tags beside it are information
                (solid), this one is an entry point (outlined) */}
            <span
              onClick={() => {
                void handleOpenProperties()
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                cursor: 'pointer',
                fontSize: 12,
                padding: '1px 10px',
                borderRadius: 10,
                border: `1px solid ${token.colorBorderSecondary}`,
                color: token.colorTextTertiary,
                background: 'transparent',
                transition: 'all 0.15s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = token.colorFillTertiary
                e.currentTarget.style.color = token.colorTextSecondary
                e.currentTarget.style.borderColor = token.colorTextTertiary
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = token.colorTextTertiary
                e.currentTarget.style.borderColor = token.colorBorderSecondary
              }}
            >
              <RiSettings3Line size={12} />
              {t('notes.term.properties')}
            </span>
          </div>
        </div>

        {/* Body content: the same TipTap Markdown editor as the document page, filling the remaining
            height and scrolling on its own */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            marginTop: 18,
            ['--ed-body-pad-top' as string]: '8px'
          }}
        >
          <TipTapMarkdownEditor
            key={todoId}
            value={content}
            onChange={handleContentChange}
            onSave={() => {
              void saveNow()
            }}
            placeholder={t('notes.todo.contentPlaceholder')}
          />
        </div>

        {/* Bottom status bar: save state + time info */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 32,
            padding: '0 16px',
            flexShrink: 0,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            fontSize: 12
          }}
        >
          {saveIndicator}
          <span style={{ flex: 1 }} />
          <span
            style={{
              fontSize: 11,
              color: token.colorTextTertiary,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {metaParts.join(' · ')}
          </span>
        </div>
      </div>
    </PaneShell>
  )
}

/* ──────────── Shared ──────────── */

const PaneShell: React.FC<{
  children: React.ReactNode
}> = ({ children }) => (
  <div
    style={{
      flex: 1,
      minWidth: 0,
      minHeight: 0,
      display: 'flex',
      /* The card shell is provided by the central main-area container; this only handles layout */
      overflow: 'hidden'
    }}
  >
    {children}
  </div>
)

export default TodoPane
