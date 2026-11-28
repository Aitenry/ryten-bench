/**
 * Standalone scheduled-tasks page (below "Plugin repository" in the sidebar) — replaces the old "Scheduled tasks" page hidden in settings.
 *
 * Layout follows the mockup: page header (title/description/refresh/new) → segmented filter + search → summary row →
 * card grid (all action icons before the `⋯` in the top-right corner). Data comes from the main-process database (tables
 * `scheduled_tasks` / `scheduled_task_runs`) and shares the same storage with the `schedule_*` model tools.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Empty, Input, Segmented, Spin, theme } from 'antd'
import { RiAddLine, RiRefreshLine, RiSearchLine } from '@remixicon/react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from '@renderer/i18n'
import {
  harnessApi,
  type ScheduleRunView,
  type ScheduleView,
  type ScheduleWhenView
} from '../api/harness'
import ScheduleCard from '../components/harness/schedules/ScheduleCard'
import ScheduleEditorModal from '../components/harness/schedules/ScheduleEditorModal'
import ScheduleRunPanel from '../components/harness/schedules/ScheduleRunPanel'
import ScheduleRunsModal from '../components/harness/schedules/ScheduleRunsModal'
import { formatRelativeDay } from '../utils/schedules/format'
import { requestOpenFile } from '../utils/harness/pending-file'
import { useHarness } from '../contexts/harness/HarnessContextCore'
import type { HarnessTopicRow } from '../../../shared/harness/types'

type Filter = 'all' | 'enabled' | 'paused'

const Schedules: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message, modal } = App.useApp()
  const navigate = useNavigate()
  /** Conversation selection lives in the app-level harness context (shared with the shell sidebar) */
  const { handleSelectTopic } = useHarness()

  const [tasks, setTasks] = useState<ScheduleView[]>([])
  const [topicTitles, setTopicTitles] = useState<Record<number, string>>({})
  /** Full topic rows: needed by the run panel's "open conversation" (it needs the real row) */
  const [topicRows, setTopicRows] = useState<Map<number, HarnessTopicRow>>(new Map())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<ScheduleView | null>(null)
  const [runsTask, setRunsTask] = useState<ScheduleView | null>(null)
  /** Floating run-detail panel (opened from one row of the run history) */
  const [runPanel, setRunPanel] = useState<{ task: ScheduleView; run: ScheduleRunView } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      // Tasks may point at sessions in any mode/workspace, so the title map must cover every workspace (including chat mode)
      const [scheduleRows, allWorkspaces, chatResult] = await Promise.all([
        harnessApi.harness.listSchedules(),
        harnessApi.harness.getAllWorkspaces().catch(() => []),
        harnessApi.harness.chatWorkspaces().catch(() => null)
      ])
      const workspaceIds = new Set<number>(allWorkspaces.map((row) => row.id))
      if (chatResult?.ok && chatResult.data) {
        for (const id of chatResult.data.ids) workspaceIds.add(id)
      }
      const topicLists = await Promise.all(
        Array.from(workspaceIds).map((id) =>
          harnessApi.harness.getAllTopics(id).catch(() => [])
        )
      )
      const titles: Record<number, string> = {}
      const rowsById = new Map<number, HarnessTopicRow>()
      for (const rows of topicLists) {
        for (const row of rows) {
          titles[row.id] = row.title ?? ''
          rowsById.set(row.id, row)
        }
      }
      setTasks(scheduleRows)
      setTopicTitles(titles)
      setTopicRows(rowsById)
    } catch (error) {
      message.error(t('schedulesPage.loadFailed', { reason: String(error) }))
      setTasks([])
    } finally {
      setLoading(false)
    }
  }, [message, t])

  useEffect(() => {
    void load()
  }, [load])

  const topicTitle = useCallback(
    (topicId: number): string | undefined => {
      const title = topicTitles[topicId]
      return title ? title : undefined
    },
    [topicTitles]
  )

  /** Run panel → select the conversation that run executed in, then show it */
  const openConversation = useCallback(
    (topicId: number): void => {
      const row = topicRows.get(topicId)
      if (!row) return
      // Selection lives in the app-level harness context, so it can be triggered from this page
      void handleSelectTopic(row).catch(() => undefined)
      navigate('/harness')
    },
    [handleSelectTopic, navigate, topicRows]
  )

  /** Run panel → open one artifact: select the run's conversation, then open the file there */
  const openArtifact = useCallback(
    (path: string): void => {
      const topicId = runPanel?.run?.topicId ?? 0
      const row = topicId ? topicRows.get(topicId) : undefined
      if (row) void handleSelectTopic(row).catch(() => undefined)
      requestOpenFile(path)
      navigate('/harness')
    },
    [handleSelectTopic, navigate, runPanel, topicRows]
  )

  /** Filter + search, with enabled tasks sorted first by next run */
  const visibleTasks = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return tasks
      .filter((task) => {
        if (filter === 'enabled' && !task.enabled) return false
        if (filter === 'paused' && task.enabled) return false
        if (!keyword) return true
        return (
          task.title.toLowerCase().includes(keyword) || task.prompt.toLowerCase().includes(keyword)
        )
      })
      .sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
        if (a.enabled && b.enabled) {
          return Date.parse(a.nextRunAt ?? '9') - Date.parse(b.nextRunAt ?? '9')
        }
        return 0
      })
  }, [tasks, filter, query])

  const enabledCount = tasks.filter((task) => task.enabled).length
  const nextTask = useMemo(() => {
    const candidates = tasks
      .filter((task) => task.enabled && task.nextRunAt)
      .sort((a, b) => Date.parse(a.nextRunAt ?? '') - Date.parse(b.nextRunAt ?? ''))
    return candidates[0]
  }, [tasks])

  const notifyFailure = (): void => {
    message.error(t('schedulesPage.actionFailed'))
  }

  const handleToggle = useCallback(
    async (task: ScheduleView): Promise<void> => {
      setBusy(true)
      try {
        const result = await harnessApi.harness.updateSchedule({
          id: task.id,
          action: task.enabled ? 'pause' : 'resume'
        })
        if (!result.ok) notifyFailure()
        else await load()
      } catch {
        notifyFailure()
      } finally {
        setBusy(false)
      }
    },
    [load, message, t]
  )

  const handleDelete = useCallback(
    (task: ScheduleView): void => {
      modal.confirm({
        title: t('schedulesPage.deleteTitle', { title: task.title }),
        content: t('schedulesPage.deleteBody'),
        okText: t('schedulesPage.deleteConfirm'),
        okButtonProps: { danger: true },
        cancelText: t('schedulesPage.cancel'),
        onOk: async () => {
          try {
            const result = await harnessApi.harness.updateSchedule({
              id: task.id,
              action: 'delete'
            })
            if (!result.ok) notifyFailure()
            else await load()
          } catch {
            notifyFailure()
          }
        }
      })
    },
    [load, message, modal, t]
  )

  const handleDuplicate = useCallback(
    async (task: ScheduleView): Promise<void> => {
      try {
        const result = await harnessApi.harness.createSchedule({
          topicId: task.topicId,
          targetMode: task.targetMode,
          targetWorkspaceId: task.targetWorkspaceId,
          targetMemoryScope: task.targetMemoryScope,
          agentConfig: task.agentConfig,
          title: `${task.title} 副本`,
          prompt: task.prompt,
          when: task.when as ScheduleWhenView
        })
        if (!result.ok) notifyFailure()
        else await load()
      } catch {
        notifyFailure()
      }
    },
    [load, message, t]
  )

  const openNew = (): void => {
    setEditingTask(null)
    setEditorOpen(true)
  }

  const openEdit = (task: ScheduleView): void => {
    setEditingTask(task)
    setEditorOpen(true)
  }

  const summary = nextTask?.nextRunAt
    ? t('schedulesPage.summary', {
        count: String(tasks.length),
        next: `${formatRelativeDay(nextTask.nextRunAt)}（${nextTask.title}）`
      })
    : t('schedulesPage.summaryNoNext', { count: String(tasks.length) })

  return (
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        padding: '24px 32px 28px',
        background: token.colorBgContainer
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 650, color: token.colorText }}>
            {t('schedulesPage.title')}
          </div>
          <div
            style={{
              marginTop: 6,
              fontSize: 12.8,
              lineHeight: 1.6,
              color: token.colorTextSecondary,
              maxWidth: 640
            }}
          >
            {t('schedulesPage.description')}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button icon={<RiRefreshLine size={14} />} onClick={() => void load()} disabled={loading}>
            {t('schedulesPage.refresh')}
          </Button>
          <Button type="primary" icon={<RiAddLine size={14} />} onClick={openNew}>
            {t('schedulesPage.newTask')}
          </Button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20 }}>
        <Segmented
          value={filter}
          onChange={(value) => setFilter(value as Filter)}
          options={[
            { value: 'all', label: `${t('schedulesPage.filterAll')} ${tasks.length}` },
            { value: 'enabled', label: `${t('schedulesPage.filterEnabled')} ${enabledCount}` },
            {
              value: 'paused',
              label: `${t('schedulesPage.filterPaused')} ${tasks.length - enabledCount}`
            }
          ]}
        />
        {/* Summary sits right after the tabs (same row as the search box): it belongs to the
            filter context, not to the card list. */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 11.5,
            color: token.colorTextTertiary,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
          title={summary}
        >
          {summary}
        </div>
        <Input
          allowClear
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          prefix={<RiSearchLine size={13} style={{ color: token.colorTextTertiary }} />}
          placeholder={t('schedulesPage.searchPlaceholder')}
          style={{ width: 240, flex: '0 0 auto' }}
        />
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
          <Spin />
        </div>
      ) : visibleTasks.length === 0 ? (
        <div
          style={{
            marginTop: 18,
            padding: '48px 24px',
            border: `1px dashed ${token.colorBorderSecondary}`,
            borderRadius: 16,
            background: token.colorFillQuaternary
          }}
        >
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div style={{ color: token.colorTextSecondary, fontSize: 12.8 }}>
                <div style={{ color: token.colorText, fontSize: 13.5, marginBottom: 6 }}>
                  {t('schedulesPage.empty')}
                </div>
                {t('schedulesPage.emptyHint')}
              </div>
            }
          >
            <Button type="primary" icon={<RiAddLine size={14} />} onClick={openNew}>
              {t('schedulesPage.newTask')}
            </Button>
          </Empty>
        </div>
      ) : (
        <div
          style={{
            marginTop: 12,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))',
            gap: 14
          }}
        >
          {visibleTasks.map((task) => (
            <ScheduleCard
              key={task.id}
              task={task}
              topicTitle={task.topicId != null ? topicTitle(task.topicId) : undefined}
              busy={busy}
              onPause={(target) => void handleToggle(target)}
              onResume={(target) => void handleToggle(target)}
              onEdit={openEdit}
              onDelete={handleDelete}
              onViewRuns={setRunsTask}
              onDuplicate={(target) => void handleDuplicate(target)}
            />
          ))}
        </div>
      )}

      <ScheduleEditorModal
        open={editorOpen}
        task={editingTask}
        onClose={() => setEditorOpen(false)}
        onSaved={() => void load()}
      />
      <ScheduleRunsModal
        open={runsTask !== null}
        task={runsTask}
        onClose={() => setRunsTask(null)}
        onOpenRun={(run) => {
          // One click from the history list straight into the floating detail panel: the list
          // closes so the two layers never stack.
          if (!runsTask) return
          setRunPanel({ task: runsTask, run })
          setRunsTask(null)
        }}
      />
      <ScheduleRunPanel
        open={runPanel !== null}
        task={runPanel?.task ?? null}
        run={runPanel?.run ?? null}
        onClose={() => setRunPanel(null)}
        onOpenConversation={openConversation}
        onSelectRun={(next) => {
          // Keep the panel open and swap the record; the history list stays closed
          setRunPanel((prev) => (prev ? { ...prev, run: next } : prev))
        }}
        onOpenArtifact={openArtifact}
      />
    </div>
  )
}

export default Schedules
