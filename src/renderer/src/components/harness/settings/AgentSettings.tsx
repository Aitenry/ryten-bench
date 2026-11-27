import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { theme, Button, Switch, Modal, Form, Input, Select, Pagination, App } from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ImportOutlined,
  RobotOutlined,
  TeamOutlined
} from '@ant-design/icons'
import { SkeletonSettingRows } from '@renderer/components/system/Skeleton'
import EntityCard, { EntityChip } from '@renderer/components/system/EntityCard'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import { SUBAGENT_NAME_PATTERN } from '../../../../../shared/harness/subagent'

import type { ProviderOption } from '@renderer/types/components'
import { isEmbeddingProvider, getProviderDisplayName } from '@renderer/utils/providerMeta'
import {
  SettingsPageHeader,
  SettingsSection
} from '@renderer/components/system/settings/SettingsUI'
import { harnessApi } from '../../../api/harness'
import type { HarnessToolInfo } from '../../../types/harness/types'
import type {
  AgentConfigInput,
  AgentConfigRow,
  McpServerView
} from '../../../../../shared/harness/types'
import {
  canonicalToolName,
  isMcpToolName,
  isPluginModeTool,
  mcpNamespace,
  mcpServerGroupValue,
  parseMcpToolName
} from '../../../../../shared/harness/mcp'

const { TextArea } = Input

const PAGE_SIZE = 5

const AgentSettings: React.FC = () => {
  const {
    token: { colorTextSecondary, colorError }
  } = theme.useToken()

  const { viewMessage } = useMessage()
  const { modal } = App.useApp()
  const { t } = useTranslation()

  // 当前工作区 ID
  const [workspaceId, setWorkspaceId] = useState(0)

  // 子智能体列表
  const [agents, setAgents] = useState<AgentConfigRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)

  /**
   * MCP 页当前启用给模型的工具名（`mainAgent.mcpTools`）。
   *
   * 智能体页**不逐项列 MCP 工具**（服务器一多就是几十项，而且与 MCP 页的逐项开关是同一个
   * 决定，两个入口必然漂移）：按**服务器**各给一项，名字就是服务器名，
   * 具体哪几个工具仍然只由 MCP 页决定。见 shared/mcp.ts 的 MCP_SERVER_GROUP_PREFIX。
   */
  const [enabledMcpTools, setEnabledMcpTools] = useState<string[]>([])
  /** MCP 服务器清单（出分组项用：名字、命名空间、可用工具） */
  const [mcpServers, setMcpServers] = useState<McpServerView[]>([])

  // 编辑/创建弹窗
  const [modalOpen, setModalOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState<AgentConfigRow | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  // 选项数据
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [availableTools, setAvailableTools] = useState<HarnessToolInfo[]>([])
  const [skills, setSkills] = useState<{ id: string; name: string; description: string }[]>([])

  // 导入 JSON
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importLoading, setImportLoading] = useState(false)

  const loadPage = useCallback(
    async (page: number, wsId: number) => {
      setLoading(true)
      try {
        const result = await harnessApi.agents.getPaginated(wsId, page - 1, PAGE_SIZE)
        setAgents(result.items)
        setTotal(result.total)
        setCurrentPage(page)
      } catch (error) {
        viewMessage(
          'agent-load',
          'error',
          t('common.message.loadFailedWithReason', { reason: String(error) })
        )
      } finally {
        setLoading(false)
      }
    },
    [viewMessage, t]
  )

  const loadOptions = useCallback(async () => {
    try {
      const [providerList, tools, skillList, main, settings, mcp] = await Promise.all([
        window.api.providers.getEnabled(),
        harnessApi.harness.getTools(),
        harnessApi.harness.listSkills(),
        harnessApi.mainAgent.get(),
        window.api.systemSettings.getAll(),
        harnessApi.mcp.list()
      ])
      setProviders((providerList as ProviderOption[]).filter((p) => !isEmbeddingProvider(p)))
      setAvailableTools(tools)
      setSkills(skillList)
      setMcpServers(mcp)
      const rawMain = main as Record<string, unknown>
      const rawTools = (rawMain.tools as string[]) ?? []
      const rawMcpTools = (rawMain.mcpTools as string[]) ?? []
      const rawSkills = (rawMain.skills as string[]) ?? []
      /**
       * 兼容旧数据：MCP 工具以前会混在智能体页的工具下拉里、被写进 `tools`。现在这一页按
       * 服务器出项、工具级管控在 MCP 页，所以把遗留的 `mcp__…` 名字搬进 `mcpTools`
       * （**只增不减**，用户不会因为这次改版丢掉已勾选的工具）。搬过一次后这里不再触发。
       */
      const legacyMcp = rawTools.filter(isMcpToolName)
      const afterMcp =
        legacyMcp.length > 0 ? rawTools.filter((name) => !isMcpToolName(name)) : rawTools
      /**
       * 插件工坊的 4 个工具以前也要在这一页勾了才注册。现在它们是**插件模式的模式工具**
       * （切到插件模式自动挂载，见 shared/mcp.ts 的 PLUGIN_MODE_TOOL_NAMES），下拉里已经没有
       * 它们的选项；历史配置里残留的名字在这里摘掉，免得留下一个没有对应选项的幽灵标签。
       * 摘掉不影响能力：模式工具由模式带进来，与这一页的勾选无关。
       */
      const staleModeTools = afterMcp.filter(isPluginModeTool)
      const nextTools =
        staleModeTools.length > 0 ? afterMcp.filter((name) => !isPluginModeTool(name)) : afterMcp
      const nextMcpTools =
        legacyMcp.length > 0 ? Array.from(new Set([...rawMcpTools, ...legacyMcp])) : rawMcpTools
      if (legacyMcp.length > 0 || staleModeTools.length > 0) {
        if (legacyMcp.length > 0) await harnessApi.mcp.setToolsEnabled(nextMcpTools)
        await harnessApi.mainAgent.update({ tools: nextTools, skills: rawSkills })
      }
      setEnabledMcpTools(nextMcpTools)
      const wsId = (settings as unknown as Record<string, unknown>)?.harness
        ? ((((settings as unknown as Record<string, unknown>).harness as Record<string, unknown>)
            ?.activeWorkspaceId as number) ?? 0)
        : 0
      setWorkspaceId(wsId)
      return wsId
    } catch (error) {
      viewMessage(
        'agent-options',
        'error',
        t('common.message.loadFailedWithReason', { reason: String(error) })
      )
      return 0
    }
  }, [viewMessage, t])

  /**
   * 只重取工具清单（MCP 目录变化时用：不动分页、不动用户正在编辑的表单值）。
   * 顺带同步 MCP 服务器清单与启用清单——服务器分组项的勾选态与计数都由它们派生，
   * 而这一页不编辑它们（编辑入口在 MCP 页），所以在别处改了要能立刻反映过来。
   */
  const refreshTools = useCallback(async () => {
    try {
      const [tools, main, mcp] = await Promise.all([
        harnessApi.harness.getTools(),
        harnessApi.mainAgent.get(),
        harnessApi.mcp.list()
      ])
      setAvailableTools(tools)
      setEnabledMcpTools(main.mcpTools ?? [])
      setMcpServers(mcp)
    } catch {
      // 工具清单取不到不影响其余功能：保持上一份即可，不弹错
    }
  }, [])

  useEffect(() => {
    loadOptions().then((wsId) => {
      loadPage(1, wsId)
    })
  }, [loadPage, loadOptions])

  // MCP 服务器连接/断开会改变可用工具集：订阅后即时刷新下拉，
  // 用户不用先关掉设置再打开才看得到刚连上的 MCP 工具
  useEffect(() => {
    try {
      return harnessApi.mcp.onCatalogUpdated(() => {
        void refreshTools()
      })
    } catch (err) {
      console.warn('[agent-settings] Failed to subscribe to MCP catalog:', err)
      return
    }
  }, [refreshTools])

  // 监听工作区切换
  useEffect(() => {
    const handleWorkspaceChanged = (): void => {
      loadOptions().then((wsId) => {
        loadPage(1, wsId)
      })
    }
    window.addEventListener('workspace-changed', handleWorkspaceChanged)
    return () => window.removeEventListener('workspace-changed', handleWorkspaceChanged)
  }, [loadOptions, loadPage])

  // ===== 主智能体 =====

  /**
   * MCP 服务器分组项：**一台服务器一项，名字就用服务器自己的名字**（用户 2026-09-26 要求
   * 「要用 mcp 的名称」），勾上=这台服务器的工具进入启用清单，取消=按命名空间摘掉。
   * 具体哪几个工具仍然只在 MCP 页里逐项开关。
   */
  const mcpGroupOptions = useMemo(
    () =>
      mcpServers
        .map((view) => {
          const namespace = mcpNamespace(view.config.name)
          const enabled = view.tools.filter((tool) => enabledMcpTools.includes(tool.name)).length
          return {
            value: mcpServerGroupValue(namespace),
            name: view.config.name,
            namespace,
            total: view.tools.length,
            enabled
          }
        })
        // 连不上的服务器也可能留着之前勾过的名字：只要还有启用的工具就仍然列出来（否则没法关掉）
        .filter(
          (group) =>
            group.total > 0 ||
            enabledMcpTools.some((name) => parseMcpToolName(name)?.server === group.namespace)
        ),
    [mcpServers, enabledMcpTools]
  )

  /** 工具下拉里的选项：普通工具逐个列 + 每台 MCP 服务器一项 */
  const toolOptions = useMemo(() => {
    const regular = availableTools.filter((tool) => !isMcpToolName(tool.name))
    return [
      ...regular,
      ...mcpGroupOptions.map((group) => ({
        name: group.value,
        label: group.name,
        description: '',
        icon: 'RiPlug2Line',
        color: '#8c6b3f'
      }))
    ]
  }, [availableTools, mcpGroupOptions])

  // ===== 子智能体 =====

  const openEditModal = (agent?: AgentConfigRow): void => {
    setEditingAgent(agent ?? null)
    if (agent) {
      const storedTools: string[] = agent.tools ? JSON.parse(agent.tools) : []
      /**
       * 旧数据里存的是逐个 MCP 全名（`mcp__<命名空间>__<工具>`）：归一成**各自服务器**的分组项
       * （具体哪几个工具由 MCP 页决定），随这次保存落库。老的笼统标记 `mcp` 也一并升级。
       */
      const migrated: string[] = []
      for (const name of storedTools) {
        // 插件的模式工坊工具（plugin_draft 等）不是子智能体可选项：它们是插件模式的模式工具，
        // 由模式自动挂载（见 shared/mcp.ts）。历史配置里残留的直接丢掉。
        if (isPluginModeTool(name)) continue
        if (isMcpToolName(name)) {
          const parsed = parseMcpToolName(name)
          if (parsed) migrated.push(mcpServerGroupValue(parsed.server))
          continue
        }
        if (name === 'mcp') {
          for (const view of mcpServers) {
            if (view.tools.some((tool) => enabledMcpTools.includes(tool.name))) {
              migrated.push(mcpServerGroupValue(mcpNamespace(view.config.name)))
            }
          }
          continue
        }
        migrated.push(name)
      }
      form.setFieldsValue({
        name: agent.name,
        rename: agent.rename || '',
        prompt: agent.prompt || '',
        description: agent.description || '',
        tools: Array.from(new Set(migrated)),
        skills: agent.skills ? JSON.parse(agent.skills) : [],
        model: agent.model || undefined,
        enable: agent.enable
      })
    } else {
      form.resetFields()
      form.setFieldsValue({ enable: true, tools: [], skills: [] })
    }
    setModalOpen(true)
  }

  const handleSave = async (): Promise<void> => {
    /**
     * 校验失败时字段下方已经有 antd 的红色提示；此前这一步和保存放在同一个 try 里，
     * catch 还会再弹一条「保存失败: [object Object]」，看起来像后端出了错。先单独
     * 校验，失败就直接返回，只有真正的保存错误才弹错误条。
     *
     * 表单区是固定高度的独立滚动容器：出错字段可能滚在视口外，这时点「保存」看起来
     * 像没反应。把第一个错误字段滚到中间，保留 antd 的字段提示、不再额外弹 toast。
     */
    const values = await form.validateFields().catch((error: unknown) => {
      const firstField = (error as { errorFields?: Array<{ name?: unknown }> })?.errorFields?.[0]
        ?.name
      if (typeof firstField === 'string' || Array.isArray(firstField)) {
        try {
          form.scrollToField(firstField as never)
        } catch {
          // 滚动失败不影响校验提示
        }
      }
      return null
    })
    if (!values) return

    setSaving(true)
    try {
      const input: AgentConfigInput = {
        workspace_id: workspaceId,
        name: values.name,
        rename: values.rename || null,
        prompt: values.prompt || null,
        description: values.description || null,
        tools: values.tools || [],
        skills: values.skills || [],
        model: values.model || null,
        enable: values.enable
      }

      if (editingAgent) {
        await harnessApi.agents.update(workspaceId, editingAgent.id, input, editingAgent.revision)
        viewMessage('agent-save', 'success', t('agentSettings.messages.agentUpdated'), 2)
      } else {
        await harnessApi.agents.create(input)
        viewMessage('agent-save', 'success', t('agentSettings.messages.agentCreated'), 2)
        // 通知记忆树刷新（后端已自动创建记忆目录）
        window.dispatchEvent(new CustomEvent('memory-tree-refresh'))
      }

      setModalOpen(false)
      await loadPage(currentPage, workspaceId)
    } catch (error) {
      viewMessage(
        'agent-save',
        'error',
        t('common.message.saveFailedWithReason', { reason: String(error) })
      )
    } finally {
      setSaving(false)
    }
  }

  const handleToggleEnable = async (agent: AgentConfigRow, checked: boolean): Promise<void> => {
    try {
      await harnessApi.agents.update(workspaceId, agent.id, {
        enable: checked
      })
      setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, enable: checked } : a)))
      viewMessage(
        'agent-toggle',
        'success',
        t(checked ? 'agentSettings.messages.opened' : 'agentSettings.messages.closed'),
        1
      )
    } catch (error) {
      viewMessage(
        'agent-toggle',
        'error',
        t('agentSettings.messages.toggleFailedWithReason', { reason: String(error) })
      )
    }
  }

  const handleDelete = async (agent: AgentConfigRow): Promise<void> => {
    modal.confirm({
      title: t('agentSettings.messages.deleteConfirmTitle', { name: agent.rename || agent.name }),
      content: t('common.message.irreversible'),
      okText: t('common.action.confirm'),
      okType: 'danger',
      cancelText: t('common.action.cancel'),
      onOk: async () => {
        try {
          await harnessApi.agents.delete(workspaceId, agent.id)
          viewMessage('agent-delete', 'success', t('agentSettings.messages.deleted'), 2)
          // 通知记忆树刷新（后端已自动删除记忆目录）
          window.dispatchEvent(new CustomEvent('memory-tree-refresh'))
          await loadPage(currentPage, workspaceId)
        } catch (error) {
          viewMessage(
            'agent-delete',
            'error',
            t('common.message.deleteFailedWithReason', { reason: String(error) })
          )
        }
      }
    })
  }

  // ===== 导入 JSON =====

  interface ImportAgentItem {
    name: string
    rename?: string
    prompt?: string
    description?: string
    skills?: string[] | string | null
    model?: string | null
    tools?: string[]
    enable?: boolean
  }

  const handleImportExec = async (raw: string): Promise<void> => {
    if (!raw) {
      viewMessage('import-error', 'warning', t('agentSettings.messages.importEmptyFile'))
      return
    }

    let data: ImportAgentItem[]
    try {
      data = JSON.parse(raw)
    } catch {
      viewMessage('import-error', 'error', t('agentSettings.messages.importInvalidJson'))
      return
    }

    if (!Array.isArray(data)) {
      viewMessage('import-error', 'error', t('agentSettings.messages.importNotArray'))
      return
    }

    if (data.length === 0) {
      viewMessage('import-error', 'warning', t('agentSettings.messages.importEmptyContent'))
      return
    }

    // 建立有效项集合（MCP 分组项 `mcp@<命名空间>` 也是合法的一项：它引用 MCP 页的勾选）
    const validToolNames = new Set([
      ...availableTools.map((t) => t.name),
      ...mcpGroupOptions.map((group) => group.value)
    ])
    const validSkillIds = new Set(skills.map((s) => s.id))
    const validModelKeys = new Set(providers.map((p) => `${p.provider}:${p.model}`))

    setImportLoading(true)
    let imported = 0
    const skipped: string[] = []
    const stripped: string[] = []

    try {
      for (const item of data) {
        if (!item.name) {
          skipped.push(t('agentSettings.messages.importStrippedSkippedName'))
          continue
        }

        // 验证并过滤 tools（导入文件里若是逐个 MCP 全名，归一到它所属服务器的分组项）
        let filteredTools: string[]
        if (Array.isArray(item.tools) && item.tools.length > 0) {
          const normalized = item.tools.map((name) => {
            const parsed = isMcpToolName(name) ? parseMcpToolName(name) : null
            return parsed ? mcpServerGroupValue(parsed.server) : canonicalToolName(name)
          })
          const removed = normalized.filter((t) => !validToolNames.has(t))
          filteredTools = Array.from(new Set(normalized.filter((t) => validToolNames.has(t))))
          if (removed.length > 0) {
            stripped.push(
              t('agentSettings.messages.importMissingTool', {
                name: item.name,
                items: removed.join(', ')
              })
            )
          }
        } else {
          filteredTools = []
        }

        // 验证并过滤 skills
        let filteredSkills: string[]
        const rawSkills = item.skills
        if (rawSkills !== null && rawSkills !== undefined) {
          const skillArr = (Array.isArray(rawSkills) ? rawSkills : [rawSkills]).filter(
            Boolean
          ) as string[]
          const removed = skillArr.filter((s) => !validSkillIds.has(s))
          filteredSkills = skillArr.filter((s) => validSkillIds.has(s))
          if (removed.length > 0) {
            stripped.push(
              t('agentSettings.messages.importMissingSkill', {
                name: item.name,
                items: removed.join(', ')
              })
            )
          }
        } else {
          filteredSkills = []
        }

        // 验证 model
        let validModel: string | null = null
        if (item.model) {
          if (validModelKeys.has(item.model)) {
            validModel = item.model
          } else {
            stripped.push(
              t('agentSettings.messages.importMissingModel', {
                name: item.name,
                model: item.model
              })
            )
          }
        }

        const input: AgentConfigInput = {
          workspace_id: workspaceId,
          name: item.name,
          rename: item.rename || null,
          prompt: item.prompt || null,
          description: item.description || null,
          tools: filteredTools,
          skills: filteredSkills,
          model: validModel,
          enable: item.enable ?? true
        }

        await harnessApi.agents.create(input)
        imported++
      }
    } catch (err) {
      viewMessage(
        'import-error',
        'error',
        t('agentSettings.messages.importFailedWithReason', { reason: String(err) })
      )
    } finally {
      setImportLoading(false)
    }

    // 汇总提示
    const parts: string[] = []
    if (imported > 0) {
      parts.push(t('agentSettings.messages.importSummaryImported', { count: imported }))
    }
    if (skipped.length > 0) {
      parts.push(t('agentSettings.messages.importSummarySkipped', { count: skipped.length }))
    }
    const summary =
      parts.length > 0
        ? parts.join(t('agentSettings.messages.importSummarySeparator'))
        : t('agentSettings.messages.importSummaryNone')
    viewMessage('import-summary', 'success', summary)

    // 逐条展示剔除提示
    if (stripped.length > 0) {
      setTimeout(() => {
        modal.info({
          title: t('agentSettings.messages.importStrippedTitle'),
          content: (
            <ul className="pl-4 m-0 text-sm">
              {stripped.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          ),
          width: 480
        })
      }, 500)
    }

    // 刷新 & 清空
    if (fileInputRef.current) fileInputRef.current.value = ''
    // 通知记忆树刷新（后端已自动创建记忆目录）
    if (imported > 0) {
      window.dispatchEvent(new CustomEvent('memory-tree-refresh'))
    }
    await loadPage(1, workspaceId)
  }

  // 文件选择处理
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = (ev.target?.result as string) || ''
      handleImportExec(text)
    }
    reader.onerror = () =>
      viewMessage('import-file', 'error', t('agentSettings.messages.readFileFailed'))
    reader.readAsText(file)
  }

  const providerOptions = providers.map((p) => ({
    value: `${p.provider}:${p.model}`,
    label: `${getProviderDisplayName(p)} (${p.provider}:${p.model})`
  }))

  /**
   * 字段标签与定时任务弹窗同一套排版：12px 次要色、标签在控件上方、必填星号跟在
   * 文字后面（antd 默认星号在文字前面且字号 14px，和其余表单并排看差异明显）。
   */
  const fieldLabel = (text: string, required = false): React.ReactNode => (
    <span style={{ fontSize: 12, color: colorTextSecondary }}>
      {text}
      {required && <span style={{ color: colorError, marginLeft: 2 }}>*</span>}
    </span>
  )

  return (
    <div>
      <SettingsPageHeader
        title={t('agentSettings.pageTitle')}
        description={t('agentSettings.pageDescription')}
      />

      {/* ====== 子智能体列表 ====== */}
      <SettingsSection
        title={t('agentSettings.sections.subagents')}
        icon={<TeamOutlined size={14} />}
        description={
          total > 1
            ? t('agentSettings.list.description_other', { count: total })
            : t('agentSettings.list.description_one', { count: total })
        }
        extra={
          <div className="flex items-center" style={{ gap: 8 }}>
            <Button
              icon={<ImportOutlined />}
              size="small"
              loading={importLoading}
              onClick={() => fileInputRef.current?.click()}
            >
              {t('common.action.import')}
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              size="small"
              onClick={() => openEditModal()}
            >
              {t('agentSettings.list.newAgent')}
            </Button>
          </div>
        }
      >
        {loading ? (
          /* 助手行与 SettingRow 同构：左标题 + 描述，右「开关 + 编辑 + 删除」 */
          <div style={{ padding: '4px 0' }}>
            <SkeletonSettingRows rows={4} />
          </div>
        ) : agents.length > 0 ? (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))',
                gap: 14,
                padding: 16
              }}
            >
              {agents.map((agent) => {
                const toolCount = agent.tools ? (JSON.parse(agent.tools) as string[]).length : 0
                const skillCount = agent.skills ? (JSON.parse(agent.skills) as string[]).length : 0
                return (
                  <EntityCard
                    key={agent.id}
                    id={String(agent.id)}
                    icon={<RobotOutlined />}
                    title={agent.rename || agent.name}
                    meta={
                      <>
                        {agent.model && <EntityChip>{agent.model}</EntityChip>}
                        {toolCount > 0 && (
                          <EntityChip>
                            {t('agentSettings.list.toolCount', { count: toolCount })}
                          </EntityChip>
                        )}
                        {skillCount > 0 && (
                          <EntityChip>
                            {t('agentSettings.list.skillCount', { count: skillCount })}
                          </EntityChip>
                        )}
                      </>
                    }
                    description={agent.description || undefined}
                    footerStart={
                      <Switch
                        // enable 库列为可空（DEFAULT TRUE），null 视作默认启用
                        checked={agent.enable ?? true}
                        onChange={(checked) => handleToggleEnable(agent, checked)}
                        size="small"
                      />
                    }
                    footerEnd={
                      <div className="flex items-center" style={{ gap: 2, marginLeft: 'auto' }}>
                        <Button
                          type="text"
                          size="small"
                          icon={<EditOutlined />}
                          onClick={() => openEditModal(agent)}
                        />
                        <Button
                          type="text"
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={() => handleDelete(agent)}
                        />
                      </div>
                    }
                  />
                )
              })}
            </div>
            {total > PAGE_SIZE && (
              <div className="flex justify-center" style={{ padding: '10px 0' }}>
                <Pagination
                  current={currentPage}
                  total={total}
                  pageSize={PAGE_SIZE}
                  onChange={(page) => loadPage(page, workspaceId)}
                  size="small"
                />
              </div>
            )}
          </>
        ) : (
          <div
            style={{
              padding: '28px 0',
              textAlign: 'center',
              fontSize: 13,
              color: colorTextSecondary
            }}
          >
            {t('agentSettings.empty.noAgents')}
          </div>
        )}
      </SettingsSection>

      {/* 编辑/创建弹窗 */}
      <Modal
        title={
          editingAgent
            ? t('agentSettings.form.editTitle', {
                name: editingAgent.rename || editingAgent.name
              })
            : t('agentSettings.form.createTitle')
        }
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        confirmLoading={saving}
        width={640}
        okText={t('common.action.save')}
        cancelText={t('common.action.cancel')}
        styles={{ body: { padding: 0 } }}
      >
        {/*
          滚动区与弹窗标题同一条左边线（此前 `px-5` 让字段比标题多缩进 20px，看起来
          表单被挤在弹窗中间），右侧只留 `app-modal-scroll` 的 6px 滑块槽——与插件设置
          弹窗同一口径。高度与其它表单弹窗一致：上限 560px，矮窗口再按视口高度兜底，
          只让表单区滚动，标题与按钮栏始终留在屏幕内。
        */}
        <div
          className="custom-scrollbar app-modal-scroll"
          style={{
            maxHeight: 'min(560px, calc(100vh - 220px))',
            overflowY: 'auto',
            paddingTop: 16,
            paddingBottom: 16
          }}
        >
          <Form form={form} className="agent-form" layout="vertical" requiredMark={false}>
            <div className="flex gap-3 items-end">
              <Form.Item
                label={fieldLabel(t('agentSettings.form.chineseName'))}
                name="rename"
                style={{ flex: 1 }}
              >
                <Input placeholder={t('agentSettings.form.chineseNamePlaceholder')} />
              </Form.Item>
              <Form.Item
                label={fieldLabel(t('agentSettings.form.identifier'), true)}
                name="name"
                rules={[
                  { required: true, message: t('agentSettings.form.identifierRequired') },
                  {
                    pattern: SUBAGENT_NAME_PATTERN,
                    message: t('agentSettings.form.identifierPattern')
                  }
                ]}
                style={{ flex: 1 }}
              >
                <Input placeholder={t('agentSettings.form.identifierPlaceholder')} />
              </Form.Item>
              <Form.Item
                label={fieldLabel(t('agentSettings.form.enabled'))}
                name="enable"
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
            </div>

            <Form.Item
              label={fieldLabel(t('agentSettings.form.description'), true)}
              name="description"
              rules={[{ required: true, message: t('agentSettings.form.descriptionRequired') }]}
            >
              <TextArea rows={3} placeholder={t('agentSettings.form.descriptionPlaceholder')} />
            </Form.Item>

            <Form.Item
              label={fieldLabel(t('agentSettings.form.systemPrompt'), true)}
              name="prompt"
              rules={[{ required: true, message: t('agentSettings.form.systemPromptRequired') }]}
            >
              <TextArea rows={6} placeholder={t('agentSettings.form.systemPromptPlaceholder')} />
            </Form.Item>

            <Form.Item label={fieldLabel(t('agentSettings.form.tools'))} name="tools">
              <Select
                mode="multiple"
                placeholder={t('agentSettings.form.toolsPlaceholder')}
                options={toolOptions.map((t) => ({
                  value: t.name,
                  label: `${t.label} (${t.description})`
                }))}
                allowClear
                maxTagCount={4}
              />
            </Form.Item>

            <Form.Item
              label={fieldLabel(t('agentSettings.form.model'))}
              name="model"
              tooltip={t('agentSettings.form.modelTooltip')}
            >
              <Select
                placeholder={t('agentSettings.form.modelPlaceholder')}
                options={providerOptions}
                allowClear
                showSearch
                optionFilterProp="label"
              />
            </Form.Item>

            <Form.Item
              label={fieldLabel(t('agentSettings.form.skills'))}
              name="skills"
              tooltip={t('agentSettings.form.skillsTooltip')}
            >
              <Select
                mode="multiple"
                placeholder={t('agentSettings.form.skillsPlaceholder')}
                options={skills.map((s) => ({
                  value: s.id,
                  label: `${s.name}${s.description ? ` — ${s.description}` : ''}`
                }))}
                allowClear
                disabled={skills.length === 0}
                notFoundContent={
                  skills.length === 0
                    ? t('agentSettings.form.skillsNotConfigured')
                    : t('agentSettings.form.skillsNoMatch')
                }
                maxTagCount={4}
              />
            </Form.Item>
          </Form>
        </div>
      </Modal>
      {/* 隐藏文件选择器 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </div>
  )
}

export default AgentSettings
