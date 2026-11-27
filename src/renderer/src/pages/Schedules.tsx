/**
 * 定时任务独立页（侧边栏「插件仓库」下方）——取代原先藏在设置里的「定时任务」页。
 *
 * 版式对齐设计稿：页头（标题/说明/刷新/新建）→ 分段筛选 + 搜索 → 汇总行 →
 * 卡片网格（操作图标全部在右上角 `⋯` 之前）。数据来自主进程数据库（新表
 * `scheduled_tasks` / `scheduled_task_runs`），与模型工具 `schedule_*` 共用同一存储。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Empty, Input, Segmented, Spin, theme } from 'antd'
import { RiAddLine, RiRefreshLine, RiSearchLine, RiTimeLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import {
  harnessApi,
  type ScheduleView,
  type ScheduleWhenView
} from '../api/harness'
import ScheduleCard from '../components/harness/schedules/ScheduleCard'
import ScheduleEditorModal, {
  type ScheduleTopicOption
} from '../components/harness/schedules/ScheduleEditorModal'
import ScheduleRunsModal from '../components/harness/schedules/ScheduleRunsModal'
import { formatRelativeDay } from '../utils/schedules/format'

type Filter = 'all' | 'enabled' | 'paused'

const Schedules: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message, modal } = App.useApp()

  const [tasks, setTasks] = useState<ScheduleView[]>([])
  const [topics, setTopics] = useState<ScheduleTopicOption[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<ScheduleView | null>(null)
  const [runsTask, setRunsTask] = useState<ScheduleView | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const settings = await window.api.systemSettings.getAll()
      const workspaceId = settings.harness?.activeWorkspaceId ?? 0
      const [scheduleRows, topicRows] = await Promise.all([
        harnessApi.harness.listSchedules(),
        workspaceId > 0 ? harnessApi.harness.getAllTopics(workspaceId) : Promise.resolve([])
      ])
      setTasks(scheduleRows)
      setTopics(
        topicRows.map((row) => ({
          id: row.id,
          title: row.title ?? ''
        }))
      )
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
      const topic = topics.find((item) => item.id === topicId)
      return topic ? topic.title || `#${topic.id}` : undefined
    },
    [topics]
  )

  /** 筛选 + 搜索，并让启用中的任务按下次触发排前 */
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
        <Input
          allowClear
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          prefix={<RiSearchLine size={13} style={{ color: token.colorTextTertiary }} />}
          placeholder={t('schedulesPage.searchPlaceholder')}
          style={{ width: 260, marginLeft: 'auto' }}
        />
      </div>

      <div style={{ marginTop: 14, fontSize: 12, color: token.colorTextTertiary }}>{summary}</div>

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
              topicTitle={topicTitle(task.topicId)}
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

      {tasks.length > 0 && !loading && (
        <div
          style={{
            marginTop: 18,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11.5,
            color: token.colorTextTertiary
          }}
        >
          <RiTimeLine size={12} />
          {t('schedulesPage.runsDesc')}
        </div>
      )}

      <ScheduleEditorModal
        open={editorOpen}
        task={editingTask}
        topics={topics}
        onClose={() => setEditorOpen(false)}
        onSaved={() => void load()}
      />
      <ScheduleRunsModal
        open={runsTask !== null}
        task={runsTask}
        onClose={() => setRunsTask(null)}
      />
    </div>
  )
}

export default Schedules
