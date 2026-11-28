/**
 * Create / edit schedule modal (the "Schedules" page in the sidebar).
 *
 * The target can be any existing conversation in any of the three modes (chat / work / plugin),
 * or "new conversation" to open a fresh one on every trigger; the target is unrelated to which
 * mode the current UI is in. Below the prompt you can also pick the tools / skills / MCP servers
 * enabled for this run (nothing selected = follow the conversation / defaults; skills and MCP are
 * disabled by default).
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
import { computeNextRunPreview, formatRelativeDay } from '../../../utils/schedules/format'
import {
  MCP_TOOL_GROUP,
  canonicalToolName,
  mcpNamespace,
  mcpServerGroupValue
} from '../../../../../shared/harness/mcp'
import ToolSourceTag, { type ToolSourceKind } from '../ToolSourceTag'

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
  /** null = create new */
  task: ScheduleView | null
  onClose: () => void
  onSaved: () => void
}

const NEW_SESSION = '__new__'

/** agentConfig → values for the three select controls (null renders empty; [] becomes null on save) */
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

/** Select control values → agentConfig (all three empty = null, meaning follow the conversation / defaults) */
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

  // Rule
  const [mode, setMode] = useState<Mode>('work')
  const [whenMode, setWhenMode] = useState<'daily' | 'every' | 'once'>('daily')
  const [timeText, setTimeText] = useState('09:00')
  const [minutes, setMinutes] = useState<number>(30)
  const [onceAt, setOnceAt] = useState<Dayjs | null>(dayjs().add(1, 'hour').startOf('minute'))
  // Target
  const [topicId, setTopicId] = useState<number | null>(null)
  const [targetWorkspaceId, setTargetWorkspaceId] = useState<number | null>(null)
  const [targetMemoryScope, setTargetMemoryScope] = useState<string | null>(null)
  // Task-level selection
  const [selectedTools, setSelectedTools] = useState<string[]>([])
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [selectedMcp, setSelectedMcp] = useState<string[]>([])
  const [toolOptions, setToolOptions] = useState<
    { label: string; value: string; source?: ToolSourceKind }[]
  >([])
  const [skillOptions, setSkillOptions] = useState<{ label: string; value: string }[]>([])
  const [mcpOptions, setMcpOptions] = useState<{ label: string; value: string }[]>([])
  // Title / prompt
  const [title, setTitle] = useState('')
  const [promptText, setPromptText] = useState('')
  // Catalogs
  const [topics, setTopics] = useState<TopicOption[]>([])
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[]>([])
  const [chatRootId, setChatRootId] = useState<number | null>(null)
  const [pluginWorkspaces, setPluginWorkspaces] = useState<
    { draftId: string; workspaceId: number; path: string }[]
  >([])
  const [draftNames, setDraftNames] = useState<Record<string, string>>({})
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // Load catalogs and prefill from the task when opening
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
        // Add missing chat root workspaces (kind may be chat) and plugin workspaces (may be
        // absent from the workspace list)
        for (const id of chatIds) {
          if (!wsList.some((w) => w.id === id)) {
            wsList.push({ id, name: t('schedulesPage.modeChat'), kind: 'chat' })
          }
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
          (tools as { name: string; label?: string; source?: ToolSourceKind }[]).map((tool) => ({
            value: tool.name,
            label: tool.label || tool.name,
            // Source tag at the end of the row: system / plugin / MCP
            source: tool.source
          }))
        )
        setSkillOptions(
          (skills as { id: string; name: string }[]).map((skill) => ({
            value: skill.id,
            label: skill.name || skill.id
          }))
        )
        const serverList = servers as { config: { name: string } }[]
        const mcpServerValues = serverList.map((server) =>
          mcpServerGroupValue(mcpNamespace(server.config.name))
        )
        setMcpOptions(
          serverList.map((server) => ({
            value: mcpServerGroupValue(mcpNamespace(server.config.name)),
            label: server.config.name
          }))
        )

        // Fetch topics per workspace (chat mode uses the chat workspace list)
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

        // Prefill: on edit use the task's target, inferring the owning mode when not found
        const selectionArrays = selectionToArrays(task?.agentConfig)
        // Legacy `mcp` (select-all marker) in old data migrates to the group value for "all
        // current servers"; web_fetch / web_search normalize to the `web-tools` group entry
        // (web fetch and search are merged).
        const migratedTools = selectionArrays.tools.flatMap((name) =>
          name === MCP_TOOL_GROUP ? mcpServerValues : [name]
        )
        setSelectedTools(Array.from(new Set(migratedTools.map((name) => canonicalToolName(name)))))
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
  }, [open, task, t])

  // Create: reset the form on every open (edit is prefilled by the effect above)
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

  // New task: give "new conversation" a default target workspace once the catalogs load
  useEffect(() => {
    if (!open || task || catalogLoading || targetWorkspaceId != null) return
    if (mode === 'chat') setTargetWorkspaceId(chatRootId)
    else if (mode === 'plugin') {
      const first = pluginWorkspaces[0]
      setTargetWorkspaceId(first?.workspaceId ?? null)
      setTargetMemoryScope(first ? `plugin:${first.draftId}` : null)
    } else setTargetWorkspaceId(workWorkspaces[0]?.id ?? null)
    // workWorkspaces / pluginWorkspaces only have values after the catalogs load, so this only
    // needs to fill in once when they change
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

  // Switching mode: clear selections that do not belong to that mode; a new conversation defaults
  // to a workspace of that mode
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

  // The rule is independent of the mode: compute it from the current rule controls alone (to avoid
  // confusion with the Mode variable above)
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
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      message.error(t('schedulesPage.titleRequired'))
      return
    }
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
      const agentConfig = arraysToSelection(selectedTools, selectedSkills, selectedMcp)
      const result = task
        ? await harnessApi.harness.updateScheduleFull({
            id: task.id,
            title: trimmedTitle,
            prompt: trimmedPrompt,
            when: currentWhen,
            ...targetPayload,
            agentConfig
          })
        : await harnessApi.harness.createSchedule({
            title: trimmedTitle,
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

  // Prefill title / prompt / rule mode when editing
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

  // Vertical field layout: each label sits above its control (per the user's request: label and
  // options stacked)
  const fieldStyle: React.CSSProperties = { marginTop: 14 }
  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: token.colorTextSecondary,
    marginBottom: 7
  }
  const requiredMarkStyle: React.CSSProperties = {
    color: token.colorError,
    marginLeft: 2
  }
  const controlRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap'
  }

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
      /* Many fields: the modal body has a fixed max height (560px) so only the form area scrolls
         and the title and button bar always stay on screen; short windows fall back to the
         viewport height. The 6px on the right is the scrollbar gutter, so the scrollbar does not
         cover the inputs. */
      styles={{
        body: { maxHeight: 'min(560px, calc(100vh - 220px))', overflowY: 'auto' }
      }}
      classNames={{ body: 'custom-scrollbar app-modal-scroll' }}
    >
      <div style={{ fontSize: 12.3, lineHeight: 1.6, color: token.colorTextSecondary }}>
        {t('schedulesPage.editorDesc')}
      </div>

      {/* Name: first form field, required */}
      <div style={fieldStyle}>
        <div style={labelStyle}>
          {t('schedulesPage.fieldTitle')}
          <span style={requiredMarkStyle}>*</span>
        </div>
        <Input
          value={title}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t('schedulesPage.titlePlaceholder')}
        />
      </div>

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
      </div>

      <div style={fieldStyle}>
        <div style={labelStyle}>{t('schedulesPage.fieldConversation')}</div>
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
      </div>

      {isNewSession && (mode === 'work' || mode === 'plugin') && (
        <div style={fieldStyle}>
          <div style={labelStyle}>
            {mode === 'plugin'
              ? t('schedulesPage.fieldPlugin')
              : t('schedulesPage.fieldWorkspace')}
          </div>
          <Select
            style={{ width: '100%' }}
            value={targetWorkspaceId ?? undefined}
            loading={catalogLoading}
            onChange={(value: number) => handleWorkspaceChange(value)}
            options={
              mode === 'plugin'
                ? pluginWorkspaceOptions
                : workWorkspaces.map((workspace) => ({
                    value: workspace.id,
                    label: workspace.name
                  }))
            }
            placeholder={
              mode === 'plugin'
                ? t('schedulesPage.fieldPlugin')
                : t('schedulesPage.fieldWorkspace')
            }
          />
        </div>
      )}

      <div style={fieldStyle}>
        <div style={labelStyle}>{t('schedulesPage.fieldWhen')}</div>
        <div style={controlRowStyle}>
          <Segmented
            value={whenMode}
            onChange={(value) => setWhenMode(value as 'daily' | 'every' | 'once')}
            options={[
              { value: 'daily', label: t('schedulesPage.whenDaily') },
              { value: 'every', label: t('schedulesPage.whenEvery') },
              { value: 'once', label: t('schedulesPage.whenOnce') }
            ]}
          />
          {whenMode === 'daily' && (
            <TimePicker
              style={{ width: 120 }}
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
              style={{ width: 130 }}
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
              style={{ width: 190 }}
              value={onceAt}
              onChange={(value) => setOnceAt(value)}
            />
          )}
          <span style={{ fontSize: 11, color: token.colorTextTertiary }}>
            {nextPreview
              ? t('schedulesPage.previewNext', {
                  time: formatRelativeDay(nextPreview.toISOString())
                })
              : t('schedulesPage.nextExpired')}
          </span>
        </div>
      </div>

      <div style={fieldStyle}>
        <div style={labelStyle}>{t('schedulesPage.fieldPrompt')}</div>
        <Input.TextArea
          rows={4}
          value={promptText}
          onChange={(event) => setPromptText(event.target.value)}
          placeholder={t('schedulesPage.promptPlaceholder')}
        />
      </div>

      <div style={fieldStyle}>
        <div style={labelStyle}>{t('schedulesPage.fieldTool')}</div>
        <Select
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          style={{ width: '100%' }}
          value={selectedTools}
          onChange={setSelectedTools}
          options={toolOptions}
          placeholder={t('schedulesPage.toolsPlaceholder')}
          optionFilterProp="label"
          // Tag "system / plugin / MCP" at the far right of the name
          optionRender={(option) => (
            <div className="ryt-tool-option">
              <span className="ryt-tool-option__label">{option.label}</span>
              <ToolSourceTag
                source={(option.data as { source?: ToolSourceKind } | undefined)?.source}
              />
            </div>
          )}
        />
      </div>

      <div style={fieldStyle}>
        <div style={labelStyle}>{t('schedulesPage.fieldSkill')}</div>
        <Select
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          style={{ width: '100%' }}
          value={selectedSkills}
          onChange={setSelectedSkills}
          options={skillOptions}
          placeholder={t('schedulesPage.skillsPlaceholder')}
          optionFilterProp="label"
        />
      </div>

      <div style={fieldStyle}>
        <div style={labelStyle}>{t('schedulesPage.fieldMcp')}</div>
        <Select
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          style={{ width: '100%' }}
          value={selectedMcp}
          onChange={setSelectedMcp}
          options={mcpOptions}
          placeholder={t('schedulesPage.mcpPlaceholder')}
          optionFilterProp="label"
        />
      </div>
    </Modal>
  )
}

export default ScheduleEditorModal
