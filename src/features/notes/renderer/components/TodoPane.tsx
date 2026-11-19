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
import { notesApi } from '../api'
import type { TodoItem } from '../types'

interface TodoPaneProps {
  todoId: number
  /** 父级令牌：树行「⋯」改了状态/元信息后自增，页面据此重新读库 */
  reloadToken?: number
  /** 状态流转：与树行「⋯」共用同一套逻辑（写库 + 刷新树 + 让本页重新读库） */
  onSetStatus: (todo: TodoItem, status: number) => void | Promise<void>
  /** 打开属性弹窗（标题 / 截止日期 / 优先级 / 状态 / 分类） */
  onOpenProperties: (todo: TodoItem) => void
  /** 标题保存成功后回传，用于就地更新树行与面包屑（省一次全量刷新） */
  onTitleSaved: (todoId: number, title: string) => void
}

/** 状态 → 词条键 / 配色（词条键在组件内 t() 求值，模块级常量表不调 hook） */
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

/** 标题 / 正文自动保存延迟（与文档编辑器同款节奏） */
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

  /* ── 标题 + 正文（Markdown）：与文档页同源，都在这页里内联编辑 ── */
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  const titleRef = useRef('')
  const contentRef = useRef('')
  const lastSavedRef = useRef<{ title: string; content: string }>({ title: '', content: '' })
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savingRef = useRef(false)

  /* 父级回调走 ref，避免保存闭包过期 */
  const onTitleSavedRef = useRef(onTitleSaved)
  onTitleSavedRef.current = onTitleSaved

  /**
   * 立即落库（标题 + 正文一起写）。仅在确有改动时写；保存期间产生的新编辑在结束后补排一次
   * （照搬文档编辑器的修复：否则这批编辑会被静默吞掉，界面还显示「已保存」）
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
      // 标题变了才回传（正文每次自动保存都刷父级没必要）
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

  /** 有未落库编辑时先冲刷：状态流转 / 打开属性 / 重新加载前调用，避免本地编辑被库里的旧值覆盖 */
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

  /* 卸载（切换待办 / 离开页面）时冲刷未保存的标题与正文 */
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

  /* 树行「⋯」改了状态 / 元信息后由父级令牌触发重新读库：
   *  先冲刷未保存编辑（避免用库里的旧值覆盖本地编辑），静默刷新不闪 loading */
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
        {/* 勾选位 / 标题 / 字段胶囊 / 正文先铺出来，待办到位后原地替换 */}
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

  // status/priority 库列为可空（DEFAULT 0），null 按默认值处理
  const status = STATUS_META[todo.status ?? 0] ?? STATUS_META[0]
  const priorityColor = PRIORITY_COLORS[todo.priority ?? 0] ?? token.colorTextTertiary
  const overdue =
    todo.status !== 2 && todo.due_date && dayjs(todo.due_date).isBefore(dayjs(), 'day')

  /** 状态切换（标题行最右，纯图标）：待办 —▶→ 进行中 —✓→ 已完成 —↻→ 待办。
   *  用目标状态的色系做成常驻浅底圆角块——三个状态的图标形状各不相同，
   *  靠这层底把它固定成「同一个按钮」，颜色顺带说明会推进到哪个状态 */
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
    // 带上刚冲刷的标题，弹窗不会显示旧值
    onOpenProperties({ ...todo, title: titleRef.current || todo.title })
  }

  /* 底部状态条右侧的时间轴（原元信息网格：字段不变，压成一行，格式统一为 YYYY-MM-DD HH:mm） */
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
        {/* 固定头部：标题（可编辑）+ 状态切换 + 状态标签 + 属性（不随正文滚动） */}
        <div style={{ padding: '17px 17px 0', flexShrink: 0 }}>
          {/* 标题行：标题直接改，最右是纯图标的状态切换 */}
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
                  // 8 位 hex 末两位是 alpha：悬停把同色底提亮一档
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

          {/* 状态标签行 */}
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
            {/* 属性：标题 / 截止日期 / 优先级 / 状态 / 分类（与文档页的「属性」同位）。
                做成描边小胶囊：同排的标签是信息（实底），它是入口（描边） */}
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

        {/* 正文内容：与文档同款 TipTap Markdown 编辑器，占满剩余高度并自带滚动 */}
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

        {/* 底部状态条：保存状态 + 时间信息 */}
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

/* ──────────── 通用 ──────────── */

const PaneShell: React.FC<{
  children: React.ReactNode
}> = ({ children }) => (
  <div
    style={{
      flex: 1,
      minWidth: 0,
      minHeight: 0,
      display: 'flex',
      /* 卡片外壳已由中间主区容器提供，这里只承担布局 */
      overflow: 'hidden'
    }}
  >
    {children}
  </div>
)

export default TodoPane
