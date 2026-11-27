/**
 * 新建 / 编辑定时任务弹窗（侧边栏「定时任务」页）。
 *
 * 只做「固定会话」目标：任务归属所选的当前工作区会话；到点由 runner 在该会话里起一轮。
 * 规则用分段控件表达（每天 / 按间隔 / 一次性），并实时预览下一次触发时间。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { App, DatePicker, Input, InputNumber, Modal, Segmented, Select, TimePicker, theme } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useTranslation } from '@renderer/i18n'
import { harnessApi, type ScheduleView, type ScheduleWhenView } from '../../../api/harness'
import { computeNextRunPreview, deriveTaskTitle, formatRelativeDay } from '../../../utils/schedules/format'

export interface ScheduleTopicOption {
  id: number
  title: string
}

type Mode = 'daily' | 'every' | 'once'

interface Props {
  open: boolean
  /** null = 新建 */
  task: ScheduleView | null
  topics: ScheduleTopicOption[]
  onClose: () => void
  onSaved: () => void
}

const ScheduleEditorModal: React.FC<Props> = ({ open, task, topics, onClose, onSaved }) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()

  const [mode, setMode] = useState<Mode>('daily')
  const [timeText, setTimeText] = useState('09:00')
  const [minutes, setMinutes] = useState<number>(30)
  const [onceAt, setOnceAt] = useState<Dayjs | null>(dayjs().add(1, 'hour').startOf('minute'))
  const [topicId, setTopicId] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [saving, setSaving] = useState(false)

  // 打开时按「新建 / 编辑」初始化表单
  useEffect(() => {
    if (!open) return
    if (task) {
      setMode(task.when.kind as Mode)
      if (task.when.kind === 'daily') setTimeText(task.when.time)
      if (task.when.kind === 'every') setMinutes(task.when.minutes)
      if (task.when.kind === 'once') setOnceAt(dayjs(task.when.at))
      setTopicId(task.topicId)
      setTitle(task.title)
      setPrompt(task.prompt)
    } else {
      setMode('daily')
      setTimeText('09:00')
      setMinutes(30)
      setOnceAt(dayjs().add(1, 'hour').startOf('minute'))
      setTopicId(topics[0]?.id ?? null)
      setTitle('')
      setPrompt('')
    }
  }, [open, task, topics])

  /** 当前表单对应的规则（预览用） */
  const previewWhen = useMemo<ScheduleWhenView | null>(() => {
    if (mode === 'daily') {
      return /^\d{2}:\d{2}$/.test(timeText) ? { kind: 'daily', time: timeText } : null
    }
    if (mode === 'every') {
      return Number.isFinite(minutes) && minutes >= 5 && minutes <= 10_080
        ? { kind: 'every', minutes }
        : null
    }
    return onceAt ? { kind: 'once', at: onceAt.toISOString() } : null
  }, [mode, timeText, minutes, onceAt])

  const nextPreview = previewWhen ? computeNextRunPreview(previewWhen) : null

  const fieldStyle: React.CSSProperties = { marginTop: 16 }
  const labelStyle: React.CSSProperties = { fontSize: 12, color: token.colorTextSecondary, marginBottom: 7 }

  const handleSave = async (): Promise<void> => {
    const trimmedPrompt = prompt.trim()
    if (!topicId) {
      message.error(t('schedulesPage.invalidConversation'))
      return
    }
    if (!trimmedPrompt) {
      message.error(t('schedulesPage.invalidPrompt'))
      return
    }
    if (!previewWhen) {
      message.error(t('schedulesPage.invalidTime'))
      return
    }
    setSaving(true)
    try {
      const finalTitle = title.trim() || deriveTaskTitle(trimmedPrompt)
      const result = task
        ? await harnessApi.harness.updateScheduleFull({
            id: task.id,
            title: finalTitle,
            prompt: trimmedPrompt,
            when: previewWhen
          })
        : await harnessApi.harness.createSchedule({
            topicId,
            title: finalTitle,
            prompt: trimmedPrompt,
            when: previewWhen
          })
      if (!result.ok) {
        message.error(
          result.error.startsWith('invalid-when')
            ? t('schedulesPage.invalidTime')
            : t('schedulesPage.actionFailed')
        )
        return
      }
      message.success(task ? t('schedulesPage.saved') : t('schedulesPage.created'))
      onSaved()
      onClose()
    } catch {
      message.error(t('schedulesPage.actionFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={584}
      title={task ? t('schedulesPage.editorEditTitle') : t('schedulesPage.editorNewTitle')}
      confirmLoading={saving}
      okText={task ? t('schedulesPage.save') : t('schedulesPage.create')}
      cancelText={t('schedulesPage.cancel')}
      onOk={() => void handleSave()}
      destroyOnHidden
    >
      <div style={{ fontSize: 12.3, lineHeight: 1.6, color: token.colorTextSecondary }}>
        {t('schedulesPage.editorDesc')}
      </div>

      <div style={fieldStyle}>
        <div style={labelStyle}>{t('schedulesPage.fieldConversation')}</div>
        <Select
          style={{ width: '100%' }}
          value={topicId ?? undefined}
          onChange={(value: number) => setTopicId(value)}
          options={topics.map((topic) => ({ value: topic.id, label: topic.title || `#${topic.id}` }))}
          placeholder={t('schedulesPage.fieldConversation')}
          notFoundContent={t('schedulesPage.noTopics')}
          showSearch
          optionFilterProp="label"
        />
        <div style={{ marginTop: 6, fontSize: 11.3, color: token.colorTextTertiary }}>
          {t('schedulesPage.fieldConversationHint')}
        </div>
      </div>

      <div style={fieldStyle}>
        <div style={labelStyle}>{t('schedulesPage.fieldWhen')}</div>
        <Segmented
          value={mode}
          onChange={(value) => setMode(value as Mode)}
          options={[
            { value: 'daily', label: t('schedulesPage.whenDaily') },
            { value: 'every', label: t('schedulesPage.whenEvery') },
            { value: 'once', label: t('schedulesPage.whenOnce') }
          ]}
        />
        <div style={{ marginTop: 10, display: 'flex', gap: 10 }}>
          {mode === 'daily' && (
            <TimePicker
              style={{ width: 160 }}
              format="HH:mm"
              allowClear={false}
              value={dayjs(`2000-01-01 ${timeText}`)}
              onChange={(value) => {
                if (value) setTimeText(value.format('HH:mm'))
              }}
            />
          )}
          {mode === 'every' && (
            <InputNumber
              style={{ width: 160 }}
              min={5}
              max={10_080}
              step={5}
              value={minutes}
              onChange={(value) => setMinutes(Number(value ?? 30))}
              addonAfter={t('schedulesPage.fieldMinutes')}
            />
          )}
          {mode === 'once' && (
            <DatePicker
              showTime={{ format: 'HH:mm' }}
              format="YYYY-MM-DD HH:mm"
              style={{ width: 220 }}
              value={onceAt}
              onChange={(value) => setOnceAt(value)}
            />
          )}
        </div>
        <div style={{ marginTop: 8, fontSize: 11.5, color: token.colorTextTertiary }}>
          {nextPreview
            ? t('schedulesPage.previewNext', { time: formatRelativeDay(nextPreview.toISOString()) })
            : t('schedulesPage.nextExpired')}
        </div>
      </div>

      <div style={fieldStyle}>
        <div style={labelStyle}>{t('schedulesPage.fieldPrompt')}</div>
        <Input.TextArea
          rows={4}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t('schedulesPage.promptPlaceholder')}
        />
        <div style={{ marginTop: 6, fontSize: 11.3, color: token.colorTextTertiary }}>
          {t('schedulesPage.fieldPromptHint')}
        </div>
      </div>

      <div style={fieldStyle}>
        <div style={labelStyle}>{t('schedulesPage.fieldTitleOptional')}</div>
        <Input
          value={title}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={deriveTaskTitle(prompt || '')}
        />
      </div>
    </Modal>
  )
}

export default ScheduleEditorModal
