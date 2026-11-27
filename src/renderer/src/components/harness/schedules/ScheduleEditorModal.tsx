/**
 * 新建 / 编辑定时任务弹窗（侧边栏「定时任务」页）。
 *
 * 目标可以在三种模式（对话 / 工作 / 插件）下任选一条已有会话，或选「新会话」每次触发都开一条；
 * 目标与「当前界面停在哪个模式」无关。提示词下面还能选本轮启用的工具 / 技能 / MCP
 * （不选 = 跟随会话/默认；技能与 MCP 默认不启用）。
 */
import React, { useEffect, useMemo, useState } from 'react'
import {
  App,
  DatePicker,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  TimePicker,
  theme
} from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useTranslation } from '@renderer/i18n'
import {
  harnessApi,
  type AgentSelectionView,
  type ScheduleView,
  type ScheduleWhenView
} from '../../../api/harness'
import { computeNextRunPreview, deriveTaskTitle, formatRelativeDay } from '../../../utils/schedules/format'

type Mode = 'chat' | 'work' | 'plugin'

interface TopicOption {
  id: number
  title: string
  workspaceId: number
  mode: Mode
  workspaceLabel: string
}

interface WorkspaceLite {
  id: number
  name: string
  kind: string
}

interface Props {
  open: boolean
  /** null = 新建 */
  task: ScheduleView | null
  onClose: () => void
  onSaved: () => void
}

const NEW_SESSION = '__new__'

/** agentConfig → 三个选择控件的值（null 显示为空；保存时空数组回到 null） */
function selectionToArrays(selection: AgentSelectionView | null | undefined): {
  tools: string[]
  skills: string[]
  mcpTools: string[]
} {
  return {
    tools: selection?.tools ?? [],
    skills: selection?.skills ?? [],
    mcpTools: selection?.mcpTools ?? []
  }
}

/** 选择控件值 → agentConfig（三项都空 = null，表示跟随会话/默认） */
function arraysToSelection(
  tools: string[],
  skills: string[],
  mcpTools: string[]
): AgentSelectionView | null {
  if (tools.length === 0 && skills.length === 0 && mcpTools.length === 0) return null
  return {
    tools: tools.length > 0 ? tools : null,
    skills: skills.length > 0 ? skills : null,
    mcpTools: mcpTools.length > 0 ? mcpTools : null
  }
}

const ScheduleEditorModal: React.FC<Props> = ({ open, task, onClose, onSaved }) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()

  // 规则
  const [mode, setMode] = useState<Mode>('work')
  const [whenMode, setWhenMode] = useState<'daily' | 'every' | 'once'>('daily')
  const [timeText, setTimeText] = useState('09:00')
  const [minutes, setMinutes] = useState<number>(30)
  const [onceAt, setOnceAt] = useState<Dayjs | null>(dayjs().add(1, 'hour').startOf('minute'))
  // 目标
  const [topicId, setTopicId] = useState<number | null>(null)
  const [targetWorkspaceId, setTargetWorkspaceId] = useState<number | null>(null)
  const [targetMemoryScope, setTargetMemoryScope] = useState<string | null>(null)
  // 任务级选择
  const [selectedTools, setSelectedTools] = useState<string[]>([])
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [selectedMcp, setSelectedMcp] = useState<string[]>([])
  const [toolOptions, setToolOptions] = useState<{ label: string; value: string }[]>([])
  const [skillOptions, setSkillOptions] = useState<{ label: string; value: string }[]>([])
  const [mcpOptions, setMcpOptions] = useState<{ label: string; value: string }[]>([])
  // 标题 / 提示词
  const [title, setTitle] = useState('')
  const [promptText, setPromptText] = useState('')
  // 目录
  const [topics, setTopics] = useState<TopicOption[]>([])
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[]>([])
  const [chatRootId, setChatRootId] = useState<number | null>(null)
  const [pluginWorkspaces, setPluginWorkspaces] = useState<
    { draftId: string; workspaceId: number; path: string }[]
  >([])
  const [draftNames, setDraftNames] = useState<Record<string, string>>({})
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // 打开时载入目录 + 按任务预填
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setCatalogLoading(true)
    void (async () => {
      try {
        const [allWorkspaces, chatResult, workshopState, drafts, tools, skills, servers] =
          await Promise.all([
            harnessApi.harness.getAllWorkspaces().catch(() => []),
            harnessApi.harness.chatWorkspaces().catch(() => null),
            harnessApi.workshop.state().catch(() => null),
            harnessApi.workshop.list().catch(() => []),
            harnessApi.harness.getTools().catch(() => []),
            harnessApi.harness.listSkills().catch(() => []),
            harnessApi.mcp.list().catch(() => [])
          ])
        if (cancelled) return
        const chatIds = chatResult?.ok && chatResult.data ? chatResult.data.ids : []
        const plugins = workshopState?.pluginWorkspaces ?? []
        const wsList: WorkspaceLite[] = (allWorkspaces as WorkspaceLite[]).map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.kind ?? 'user'
        }))
        // 补齐对话根工作区（kind 可能是 chat）与插件工作区（可能不在工作区列表里）
        for (const id of chatIds) {
          if (!wsList.some((w) => w.id === id)) wsList.push({ id, name: '对话', kind: 'chat' })
        }
        for (const plugin of plugins) {
          if (!wsList.some((w) => w.id === plugin.workspaceId)) {
            wsList.push({ id: plugin.workspaceId, name: plugin.draftId, kind: 'plugin' })
          }
        }
        const nameMap: Record<string, string> = {}
        for (const draft of drafts as { id?: string; name?: string; title?: string }[]) {
          const id = draft.id ?? ''
          nameMap[id] = draft.title ?? draft.name ?? id
        }
        setWorkspaces(wsList)
        setChatRootId(chatResult?.ok && chatResult.data ? chatResult.data.rootWorkspaceId : null)
        setPluginWorkspaces(plugins)
        setDraftNames(nameMap)
        setToolOptions(
          (tools as { name: string; label?: string }[]).map((tool) => ({
            value: tool.name,
            label: tool.label || tool.name
          }))
        )
        setSkillOptions(
          (skills as { id: string; name: string }[]).map((skill) => ({
            value: skill.id,
            label: skill.name || skill.id
          }))
        )
        setMcpOptions(
          (servers as { config: { name: string } }[]).map((server) => ({
            value: `mcp@${server.config.name}`,
            label: server.config.name
          }))
        )

        // 话题按工作区拉取（对话模式用 chat 工作区列表）
        const targetWorkspaceIds = Array.from(
          new Set(wsList.map((workspace) => workspace.id))
        )
        const topicLists = await Promise.all(
          targetWorkspaceIds.map((workspaceId) =>
            harnessApi.harness.getAllTopics(workspaceId).catch(() => [])
          )
        )
        if (cancelled) return
        const flat: TopicOption[] = []
        topicLists.forEach((rows, index) => {
          const workspaceId = targetWorkspaceIds[index]
          const workspace = wsList.find((item) => item.id === workspaceId)
          const topicMode: Mode =
            workspace?.kind === 'chat' ? 'chat' : workspace?.kind === 'plugin' ? 'plugin' : 'work'
          for (const row of rows as { id: number; title: string | null }[]) {
            flat.push({
              id: row.id,
              title: row.title ?? '',
              workspaceId,
              mode: topicMode,
              workspaceLabel: workspace?.name ?? ''
            })
          }
        })
        setTopics(flat)
        setCatalogLoading(false)

        // 预填：编辑用任务上的目标，找不到时推断所属模式
        const selectionArrays = selectionToArrays(task?.agentConfig)
        setSelectedTools(selectionArrays.tools)
        setSelectedSkills(selectionArrays.skills)
        setSelectedMcp(selectionArrays.mcpTools)
        if (task) {
          const topic = task.topicId != null ? flat.find((item) => item.id === task.topicId) : null
          const nextMode: Mode =
            (task.targetMode as Mode | null) ?? topic?.mode ?? 'work'
          setMode(nextMode)
          setTopicId(task.topicId)
          setTargetWorkspaceId(task.targetWorkspaceId ?? topic?.workspaceId ?? null)
          setTargetMemoryScope(task.targetMemoryScope ?? null)
          setTimeText(task.when.kind === 'daily' ? task.when.time : '09:00')
          setMinutes(task.when.kind === 'every' ? task.when.minutes : 30)
          setOnceAt(task.when.kind === 'once' ? dayjs(task.when.at) : dayjs().add(1, 'hour'))
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('[schedules] failed to load editor catalogs:', err)
          setCatalogLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, task])

  // 新建：每次打开重置表单（编辑由上面的预填负责）
  useEffect(() => {
    if (!open || task) return
    setMode('work')
    setTopicId(null)
    setTargetWorkspaceId(null)
    setTargetMemoryScope(null)
    setSelectedTools([])
    setSelectedSkills([])
    setSelectedMcp([])
    setTimeText('09:00')
    setMinutes(30)
    setOnceAt(dayjs().add(1, 'hour').startOf('minute'))
  }, [open, task])


  const topicsOfMode = useMemo(() => topics.filter((item) => item.mode === mode), [topics, mode])
  const workWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.kind === 'user' || !workspace.kind),
    [workspaces]
  )
  const pluginWorkspaceOptions = useMemo(
    () =>
      pluginWorkspaces.map((item) => {
        const workspace = workspaces.find((w) => w.id === item.workspaceId)
        return {
          value: item.workspaceId,
          label: draftNames[item.draftId] || workspace?.name || item.draftId
        }
      }),
    [draftNames, pluginWorkspaces, workspaces]
  )

  // 新建任务：等目录载入后给「新的会话」补一个默认目标工作区
  useEffect(() => {
    if (!open || task || catalogLoading || targetWorkspaceId != null) return
    if (mode === 'chat') setTargetWorkspaceId(chatRootId)
    else if (mode === 'plugin') {
      const first = pluginWorkspaces[0]
      setTargetWorkspaceId(first?.workspaceId ?? null)
      setTargetMemoryScope(first ? `plugin:${first.draftId}` : null)
    } else setTargetWorkspaceId(workWorkspaces[0]?.id ?? null)
    // workWorkspaces / pluginWorkspaces 由目录载入后才有值，这里只需在它们变化时补一次
  }, [
    catalogLoading,
    chatRootId,
    mode,
    open,
    pluginWorkspaces,
    targetWorkspaceId,
    task,
    workWorkspaces
  ])
  const isNewSession = topicId == null
  const selectValue = topicId == null ? NEW_SESSION : String(topicId)

  // 切模式：清掉不属于该模式的选择，新会话默认落到该模式的工作区
  const handleModeChange = (next: Mode): void => {
    setMode(next)
    setTopicId(null)
    setTargetMemoryScope(next === 'chat' ? 'chat' : null)
    if (next === 'chat') setTargetWorkspaceId(chatRootId)
    else if (next === 'plugin') {
      setTargetWorkspaceId(pluginWorkspaceOptions[0]?.value ?? null)
      const plugin = pluginWorkspaces.find((item) => item.workspaceId === pluginWorkspaceOptions[0]?.value)
      setTargetMemoryScope(plugin ? `plugin:${plugin.draftId}` : null)
    } else setTargetWorkspaceId(workWorkspaces[0]?.id ?? null)
  }

  const handleWorkspaceChange = (workspaceId: number): void => {
    setTargetWorkspaceId(workspaceId)
    if (mode === 'plugin') {
      const plugin = pluginWorkspaces.find((item) => item.workspaceId === workspaceId)
      setTargetMemoryScope(plugin ? `plugin:${plugin.draftId}` : null)
    } else {
      setTargetMemoryScope(mode === 'chat' ? 'chat' : null)
    }
  }

  // 规则与模式无关：单独按当前规则控件算（避免上面 Mode 变量混淆）
  const currentWhen = useMemo<ScheduleWhenView | null>(() => {
    if (whenMode === 'daily') {
      return /^\d{2}:\d{2}$/.test(timeText) ? { kind: 'daily', time: timeText } : null
    }
    if (whenMode === 'every') {
      return Number.isFinite(minutes) && minutes >= 5 && minutes <= 10_080
        ? { kind: 'every', minutes }
        : null
    }
    return onceAt ? { kind: 'once', at: onceAt.toISOString() } : null
  }, [whenMode, timeText, minutes, onceAt])
  const nextPreview = currentWhen ? computeNextRunPreview(currentWhen) : null

  const handleSave = async (): Promise<void> => {
    const trimmedPrompt = promptText.trim()
    if (!trimmedPrompt) {
      message.error(t('schedulesPage.invalidPrompt'))
      return
    }
    if (!currentWhen) {
      message.error(t('schedulesPage.invalidTime'))
      return
    }
    let targetPayload: {
      topicId?: number | null
      targetMode?: Mode | null
      targetWorkspaceId?: number | null
      targetMemoryScope?: string | null
    }
    if (topicId != null) {
      targetPayload = { topicId, targetMode: mode }
    } else {
      if (!targetWorkspaceId) {
        message.error(t('schedulesPage.invalidTarget'))
        return
      }
      targetPayload = {
        topicId: null,
        targetMode: mode,
        targetWorkspaceId,
        targetMemoryScope
      }
    }
    setSaving(true)
    try {
      const finalTitle = title.trim() || deriveTaskTitle(trimmedPrompt)
      const agentConfig = arraysToSelection(selectedTools, selectedSkills, selectedMcp)
      const result = task
        ? await harnessApi.harness.updateScheduleFull({
            id: task.id,
            title: finalTitle,
            prompt: trimmedPrompt,
            when: currentWhen,
            ...targetPayload,
            agentConfig
          })
        : await harnessApi.harness.createSchedule({
            title: finalTitle,
            prompt: trimmedPrompt,
            when: currentWhen,
            ...targetPayload,
            agentConfig
          })
      if (!result.ok) {
        message.error(
          result.error.startsWith('invalid-when')
            ? t('schedulesPage.invalidTime')
            : result.error === 'invalid-target'
              ? t('schedulesPage.invalidTarget')
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

  // 编辑预填标题/提示词/规则模式
  useEffect(() => {
    if (!open) return
    if (task) {
      setTitle(task.title)
      setPromptText(task.prompt)
      setWhenMode(task.when.kind)
    }
  }, [open, task])
  useEffect(() => {
    if (!open || task) return
    setTitle('')
    setPromptText('')
    setWhenMode('daily')
  }, [open, task])

  const fieldStyle: React.CSSProperties = { marginTop: 16 }
  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: token.colorTextSecondary,
    marginBottom: 7
  }

  const conversationOptions = useMemo(
    () => [
      { value: NEW_SESSION, label: t('schedulesPage.newSessionOption') },
      ...topicsOfMode.map((topic) => ({
        value: String(topic.id),
        label: `${topic.workspaceLabel ? `${topic.workspaceLabel} · ` : ''}${topic.title || `#${topic.id}`}`
      }))
    ],
    [t, topicsOfMode]
  )

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={620}
      title={task ? t('schedulesPage.editorEditTitle') : t('schedulesPage.editorNewTitle')}
      confirmLoading={saving}
      okText={task ? t('schedulesPage.save') : t('schedulesPage.create')}
      cancelText={t('schedulesPage.cancel')}
      onOk={() => void handleSave()}
      destroyOnHidden
      /* 字段较多：弹窗内容区限高滚动，保证按钮栏始终可见 */
      styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}
    >
      <div style={{ fontSize: 12.3, lineHeight: 1.6, color: token.colorTextSecondary }}>
        {t('schedulesPage.editorDesc')}
      </div>

      {/* 目标：模式 → 会话 / 新会话 */}
      <div style={fieldStyle}>
        <div style={labelStyle}>{t('schedulesPage.fieldMode')}</div>
        <Segmented
          value={mode}
          onChange={(value) => handleModeChange(value as Mode)}
          options={[
            { value: 'chat', label: t('schedulesPage.modeChat') },
            { value: 'work', label: t('schedulesPage.modeWork') },
            { value: 'plugin', label: t('schedulesPage.modePlugin') }
          ]}
        />
        <div style={{ marginTop: 10 }}>
          <Select
            style={{ width: '100%' }}
            value={selectValue}
            loading={catalogLoading}
            showSearch
            optionFilterProp="label"
            onChange={(value: string) => {
              if (value === NEW_SESSION) {
                setTopicId(null)
                setTargetMemoryScope(mode === 'chat' ? 'chat' : null)
                if (mode === 'chat') setTargetWorkspaceId(chatRootId)
                else if (mode === 'plugin') {
                  setTargetWorkspaceId(pluginWorkspaceOptions[0]?.value ?? null)
                } else setTargetWorkspaceId(workWorkspaces[0]?.id ?? null)
              } else {
                setTopicId(Number(value))
              }
            }}
            options={conversationOptions}
            placeholder={t('schedulesPage.fieldConversation')}
          />
          {isNewSession && (mode === 'work' || mode === 'plugin') && (
            <Select
              style={{ width: '100%', marginTop: 8 }}
              value={targetWorkspaceId ?? undefined}
              loading={catalogLoading}
              onChange={(value: number) => handleWorkspaceChange(value)}
              options={
                mode === 'plugin' ? pluginWorkspaceOptions : workWorkspaces.map((w) => ({ value: w.id, label: w.name }))
              }
              placeholder={mode === 'plugin' ? t('schedulesPage.fieldPlugin') : t('schedulesPage.fieldWorkspace')}
            />
          )}
        </div>
        <div style={{ marginTop: 6, fontSize: 11.3, color: token.colorTextTertiary }}>
          {t('schedulesPage.fieldConversationHint')}
        </div>
      </div>

      {/* 规则 */}
      <div style={fieldStyle}>
        <div style={labelStyle}>{t('schedulesPage.fieldWhen')}</div>
        <Segmented
          value={whenMode}
          onChange={(value) => setWhenMode(value as 'daily' | 'every' | 'once')}
          options={[
            { value: 'daily', label: t('schedulesPage.whenDaily') },
            { value: 'every', label: t('schedulesPage.whenEvery') },
            { value: 'once', label: t('schedulesPage.whenOnce') }
          ]}
        />
        <div style={{ marginTop: 10, display: 'flex', gap: 10 }}>
          {whenMode === 'daily' && (
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
          {whenMode === 'every' && (
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
          {whenMode === 'once' && (
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

      {/* 提示词 */}
      <div style={fieldStyle}>
        <div style={labelStyle}>{t('schedulesPage.fieldPrompt')}</div>
        <Input.TextArea
          rows={4}
          value={promptText}
          onChange={(event) => setPromptText(event.target.value)}
          placeholder={t('schedulesPage.promptPlaceholder')}
        />
        <div style={{ marginTop: 6, fontSize: 11.3, color: token.colorTextTertiary }}>
          {t('schedulesPage.fieldPromptHint')}
        </div>
      </div>

      {/* 任务级工具 / 技能 / MCP 选择 */}
      <div style={fieldStyle}>
        <div style={labelStyle}>{t('schedulesPage.fieldAgentConfig')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Select
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            style={{ width: '100%' }}
            value={selectedTools}
            onChange={setSelectedTools}
            options={toolOptions}
            placeholder={t('schedulesPage.fieldToolsHint')}
            optionFilterProp="label"
          />
          <Select
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            style={{ width: '100%' }}
            value={selectedSkills}
            onChange={setSelectedSkills}
            options={skillOptions}
            placeholder={t('schedulesPage.fieldSkillsHint')}
            optionFilterProp="label"
          />
          <Select
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            style={{ width: '100%' }}
            value={selectedMcp}
            onChange={setSelectedMcp}
            options={mcpOptions}
            placeholder={t('schedulesPage.fieldMcpHint')}
            optionFilterProp="label"
          />
        </div>
        <div style={{ marginTop: 6, fontSize: 11.3, color: token.colorTextTertiary }}>
          {t('schedulesPage.fieldAgentConfigHint')}
        </div>
      </div>

      <div style={fieldStyle}>
        <div style={labelStyle}>{t('schedulesPage.fieldTitleOptional')}</div>
        <Input
          value={title}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={deriveTaskTitle(promptText || '')}
        />
      </div>
    </Modal>
  )
}

export default ScheduleEditorModal
