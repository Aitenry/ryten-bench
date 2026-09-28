import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  theme,
  Button,
  Switch,
  Modal,
  Form,
  Input,
  Select,
  Pagination,
  Tag,
  Badge,
  App
} from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ImportOutlined,
  RobotOutlined,
  TeamOutlined
} from '@ant-design/icons'
import { SkeletonSettingRows } from '@renderer/components/system/Skeleton'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'

import type { ProviderOption } from '@renderer/types/components'
import { toolIconMap } from '../HarnessConstants'
import { isEmbeddingProvider, getProviderDisplayName } from '@renderer/utils/providerMeta'
import {
  SettingsPageHeader,
  SettingsSection,
  SettingRow
} from '@renderer/components/system/settings/SettingsUI'
import { harnessApi } from '../../api'
import type { HarnessToolInfo } from '../../types'
import type { SandboxStatusView } from '../../api'
import type {
  AgentConfigInput,
  AgentConfigRow,
  McpServerView,
  PermissionMode
} from '../../../shared/types'
import {
  isMcpServerGroup,
  isMcpToolName,
  isPluginModeTool,
  mcpNamespace,
  mcpServerGroupValue,
  parseMcpToolName
} from '../../../shared/mcp'

const { TextArea } = Input

const PAGE_SIZE = 5

/** 沙箱后端显示名（i18n 键是字面量，动态拼键过不了 t() 的类型校验） */
function sandboxBackendLabel(
  backend: string | null,
  t: (
    key:
      | 'harness.sandbox.backendWindows'
      | 'harness.sandbox.backendBwrap'
      | 'harness.sandbox.backendLandlock'
      | 'harness.sandbox.backendSeatbelt'
  ) => string
): string {
  switch (backend) {
    case 'windows-restricted-token':
      return t('harness.sandbox.backendWindows')
    case 'linux-bwrap':
      return t('harness.sandbox.backendBwrap')
    case 'linux-landlock':
      return t('harness.sandbox.backendLandlock')
    case 'macos-seatbelt':
      return t('harness.sandbox.backendSeatbelt')
    default:
      return backend ?? '—'
  }
}

const AgentSettings: React.FC = () => {
  const {
    token: { colorTextSecondary, colorTextTertiary, colorFillAlter, colorWarning, colorSuccess }
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

  // 主智能体
  const [mainAgent, setMainAgent] = useState<{
    tools: string[]
    skills: string[]
  }>({ tools: [], skills: [] })
  /**
   * 主智能体配置的**同步快照**。
   *
   * 这一区没有保存按钮（用户 2026-09-26 要求「保存按钮不需要了，操作后即可保存」）：改一次
   * 工具/技能就落一次库。快照存在的理由是连续两次改动可能落在同一批次里——那时 `setMainAgent`
   * 还没生效，回调里读 state 会拿到旧值，后一次写入就把前一次抹掉。
   */
  const mainAgentRef = useRef<{ tools: string[]; skills: string[] }>({ tools: [], skills: [] })
  /**
   * MCP 页当前启用给模型的工具名（`mainAgent.mcpTools`）。
   *
   * 智能体页**不逐项列 MCP 工具**（服务器一多就是几十项，而且与 MCP 页的逐项开关是同一个
   * 决定，两个入口必然漂移）：按**服务器**各给一项，名字就是服务器名，
   * 具体哪几个工具仍然只由 MCP 页决定。见 shared/mcp.ts 的 MCP_SERVER_GROUP_PREFIX。
   */
  const [enabledMcpTools, setEnabledMcpTools] = useState<string[]>([])
  /** 权限档位的「新会话默认值」（改当前会话用输入框左下角的选择器） */
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<PermissionMode | null>(null)
  /** 沙箱后端状态（拿不到内核级隔离时命令会被拒绝执行——界面必须说出来） */
  const [sandbox, setSandbox] = useState<SandboxStatusView | null>(null)
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
      // 沙箱状态与权限档位是**附加信息**：单独取、各自吞错——它们失败（例如某平台探针
      // 起不来、通道暂时不可用）绝不能让整页加载失败（这里曾经因为并进上面的 Promise.all
      // 而整页空白，2026-09-27 被 verify-agent-mcp-tools.mjs 抓到）
      const [permission, sandboxStatus] = await Promise.all([
        harnessApi.harness.getPermission(null).catch(() => null),
        harnessApi.harness.sandboxStatus().catch(() => null)
      ])
      setProviders((providerList as ProviderOption[]).filter((p) => !isEmbeddingProvider(p)))
      setAvailableTools(tools)
      setSkills(skillList)
      setMcpServers(mcp)
      if (permission) setDefaultPermissionMode(permission.defaultMode)
      if (sandboxStatus) setSandbox(sandboxStatus)
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
      mainAgentRef.current = { tools: nextTools, skills: rawSkills }
      setMainAgent(mainAgentRef.current)
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
      console.warn('[agent-settings] MCP 目录订阅失败:', err)
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

  /** 该服务器此刻算不算勾上：属于它命名空间的工具至少有一个被启用 */
  const groupChecked = (namespace: string): boolean =>
    enabledMcpTools.some((name) => parseMcpToolName(name)?.server === namespace)

  /** 主智能体工具下拉的受控值：普通工具 + 勾上的 MCP 服务器 */
  const mainToolsValue = useMemo(
    () => [
      ...mainAgent.tools.filter((name) => !isMcpServerGroup(name) && !isMcpToolName(name)),
      ...mcpGroupOptions.filter((group) => groupChecked(group.namespace)).map((g) => g.value)
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mainAgent.tools, mcpGroupOptions, enabledMcpTools]
  )

  /**
   * 落库主智能体配置（**没有保存按钮，改完即存**）并同步本地快照。
   *
   * 只写 `tools` / `skills`：`mcpTools` 由 MCP 页单独维护（见 main/ipc/agent.ts 的说明），
   * 整对象覆盖会把「MCP 页刚勾好」的清单抹掉。失败弹错时快照仍是用户刚改的值——界面不会
   * 假装回滚，用户再动一次即可重试。
   */
  const saveMainAgent = useCallback(
    async (patch: Partial<{ tools: string[]; skills: string[] }>): Promise<void> => {
      // tools 里只该有**用户可勾的**真实工具名：万一还留着 MCP 分组项或模式工具
      // （旧配置/被复制过来的），落库前摘掉——模式工具由插件模式自动挂载，勾了也没有意义
      const next = {
        ...mainAgentRef.current,
        ...patch
      }
      next.tools = next.tools.filter(
        (name) => !isMcpServerGroup(name) && !isMcpToolName(name) && !isPluginModeTool(name)
      )
      mainAgentRef.current = next
      setMainAgent(next)
      try {
        await harnessApi.mainAgent.update({ tools: next.tools, skills: next.skills })
        viewMessage('main-save', 'success', t('agentSettings.main.saved'), 1)
      } catch (error) {
        viewMessage(
          'main-save',
          'error',
          t('common.message.saveFailedWithReason', { reason: String(error) })
        )
      }
    },
    [viewMessage, t]
  )

  /**
   * 按服务器整组勾选/取消。
   *
   * 勾上 = 把**这台服务器**当前可用的工具并进启用清单（并集，不影响别的服务器）；
   * 取消 = 按命名空间把这台服务器的名字摘掉（连着旧数据里残留的幽灵名字一起清）。
   * 想细调具体工具，仍然去 MCP 页逐项开关——那边是工具级的唯一入口。
   *
   * 普通工具与 MCP 分组项是两份存储（`tools` / `mcpTools`），所以一次改动要分别落：
   * 分组项走 `mcp-tools-set`，普通工具走 `main-agent-update`。
   */
  const handleMainToolsChange = async (value: string[]): Promise<void> => {
    const selected = value.filter(isMcpServerGroup)
    const tools = value.filter((name) => !isMcpServerGroup(name) && !isMcpToolName(name))
    let next = [...enabledMcpTools]
    let changed = false
    for (const group of mcpGroupOptions) {
      const wants = selected.includes(group.value)
      const has = groupChecked(group.namespace)
      if (wants === has) continue
      changed = true
      if (wants) {
        const view = mcpServers.find((s) => mcpNamespace(s.config.name) === group.namespace)
        next = Array.from(new Set([...next, ...(view?.tools ?? []).map((tool) => tool.name)]))
      } else {
        next = next.filter((name) => parseMcpToolName(name)?.server !== group.namespace)
      }
    }
    if (changed) {
      try {
        await harnessApi.mcp.setToolsEnabled(next)
        setEnabledMcpTools(next)
      } catch (error) {
        // 失败时保持原状态（受控值由 enabledMcpTools 派生，界面不会停在「已勾选」的假象上）
        viewMessage(
          'main-mcp-tools',
          'error',
          t('common.message.saveFailedWithReason', { reason: String(error) })
        )
      }
    }
    await saveMainAgent({ tools })
  }

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
    try {
      const values = await form.validateFields()
      setSaving(true)

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
        await harnessApi.agents.update(workspaceId, editingAgent.id, input)
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
            return parsed ? mcpServerGroupValue(parsed.server) : name
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

  return (
    <div>
      <SettingsPageHeader
        title={t('agentSettings.pageTitle')}
        description={t('agentSettings.pageDescription')}
      />

      {/* ====== 主智能体（改完即存：这一区没有保存按钮） ====== */}
      <SettingsSection
        title={t('agentSettings.sections.mainAgent')}
        icon={<RobotOutlined size={14} />}
      >
        <SettingRow
          title={t('agentSettings.main.defaultTools')}
          description={t('agentSettings.main.defaultToolsDescription')}
          control={
            <Select
              mode="multiple"
              size="small"
              placeholder={t('agentSettings.main.defaultToolsPlaceholder')}
              value={mainToolsValue}
              onChange={(value) => void handleMainToolsChange(value)}
              allowClear
              maxTagCount="responsive"
              style={{ minWidth: 280 }}
              optionRender={(option) => {
                const tool = toolOptions.find((t) => t.name === option.value)
                if (!tool) return option.label as React.ReactNode
                const group = mcpGroupOptions.find((g) => g.value === option.value)
                return (
                  <div className="flex items-center gap-2">
                    <span style={{ color: tool.color }}>{toolIconMap[tool.icon]}</span>
                    <span>{tool.label}</span>
                    {group && group.total > 0 && (
                      <span style={{ fontSize: 11, color: colorTextTertiary }}>
                        {t('agentSettings.main.mcpToolsCount', {
                          enabled: group.enabled,
                          total: group.total
                        })}
                      </span>
                    )}
                  </div>
                )
              }}
              tagRender={(props) => {
                const tool = toolOptions.find((t) => t.name === props.value)
                const { label, closable, onClose } = props
                // MCP 服务器那一项带上这台服务器的「已启用/可用」计数（名字就是服务器名）
                const group = mcpGroupOptions.find((g) => g.value === props.value)
                const text =
                  group && group.total > 0 ? `${label} ${group.enabled}/${group.total}` : label
                return (
                  <Tag
                    closable={closable}
                    onClose={onClose}
                    style={{
                      marginInlineEnd: 4,
                      background: tool ? `${tool.color}12` : undefined,
                      border: tool ? `1px solid ${tool.color}30` : undefined,
                      color: tool?.color,
                      borderRadius: 12,
                      paddingInline: 8,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between'
                    }}
                  >
                    <span style={{ marginRight: 4 }}>{tool ? toolIconMap[tool.icon] : null}</span>
                    {text}
                  </Tag>
                )
              }}
              options={toolOptions.map((t) => ({
                value: t.name,
                label: t.label,
                icon: t.icon,
                color: t.color
              }))}
            />
          }
        />
        <SettingRow
          title={t('agentSettings.main.defaultSkills')}
          description={t('agentSettings.main.defaultSkillsDescription')}
          control={
            <Select
              mode="multiple"
              size="small"
              placeholder={t('agentSettings.main.defaultSkillsPlaceholder')}
              value={mainAgent.skills}
              onChange={(value) => void saveMainAgent({ skills: value })}
              allowClear
              disabled={skills.length === 0}
              style={{ minWidth: 280 }}
              notFoundContent={
                skills.length === 0
                  ? t('agentSettings.form.skillsNotConfigured')
                  : t('agentSettings.form.skillsNoMatch')
              }
              maxTagCount="responsive"
              options={skills.map((s) => ({
                value: s.id,
                label: `${s.name}${s.description ? ` — ${s.description}` : ''}`
              }))}
            />
          }
        />
        {/* 权限档位：这一行只管「之后新建会话的默认值」，当前会话在输入框左下角切换 */}
        <SettingRow
          title={t('harness.permission.defaultLabel')}
          description={t('harness.permission.defaultHint')}
          control={
            <Select
              size="small"
              style={{ minWidth: 160 }}
              value={defaultPermissionMode ?? undefined}
              loading={defaultPermissionMode == null}
              options={[
                { value: 'read-only', label: t('harness.permission.readOnly') },
                { value: 'workspace-write', label: t('harness.permission.workspaceWrite') },
                { value: 'danger-full-access', label: t('harness.permission.fullAccess') }
              ]}
              onChange={(value) => {
                const mode = value as PermissionMode
                setDefaultPermissionMode(mode)
                void harnessApi.harness
                  .setPermission({ mode, scope: 'default' })
                  .then((state) => setDefaultPermissionMode(state.defaultMode))
                  .catch(() => {
                    viewMessage(
                      'main-agent-permission',
                      'error',
                      t('harness.permission.switchFailed')
                    )
                  })
              }}
            />
          }
        />
        {/* 沙箱后端：只读状态。拿不到内核级隔离时命令会被拒绝执行（绝不静默放行） */}
        <SettingRow
          title={t('harness.sandbox.label')}
          description={
            sandbox?.usable
              ? sandbox.enforcement === 'partial'
                ? t('harness.sandbox.partialHint')
                : t('harness.sandbox.fullHint')
              : t('harness.sandbox.unavailableHint', { reason: sandbox?.reason ?? '' })
          }
          control={
            <span
              style={{
                fontSize: 12,
                color: sandbox?.usable
                  ? sandbox.enforcement === 'partial'
                    ? colorTextTertiary
                    : colorSuccess
                  : colorWarning
              }}
            >
              {sandbox == null
                ? '—'
                : sandbox.usable
                  ? `${sandboxBackendLabel(sandbox.backend, t)} · ${
                      sandbox.enforcement === 'partial'
                        ? t('harness.sandbox.partial')
                        : t('harness.sandbox.full')
                    }`
                  : t('harness.sandbox.unavailable')}
            </span>
          }
        />
      </SettingsSection>

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
            {agents.map((agent) => (
              <SettingRow
                key={agent.id}
                title={agent.rename || agent.name}
                description={agent.description || undefined}
                control={
                  <div className="flex items-center" style={{ gap: 4 }}>
                    <Switch
                      // enable 库列为可空（DEFAULT TRUE），null 视作默认启用
                      checked={agent.enable ?? true}
                      onChange={(checked) => handleToggleEnable(agent, checked)}
                      size="small"
                    />
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
              >
                {agent.rename && (
                  <span
                    style={{
                      display: 'block',
                      fontSize: 12,
                      color: colorTextTertiary,
                      marginTop: 1
                    }}
                  >
                    {agent.name}
                  </span>
                )}
                <div
                  className="flex items-center"
                  style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}
                >
                  {agent.tools && (
                    <Badge
                      count={t('agentSettings.list.toolCount', {
                        count: (JSON.parse(agent.tools) as string[]).length
                      })}
                      style={{
                        background: colorFillAlter,
                        color: colorTextTertiary,
                        boxShadow: 'none'
                      }}
                    />
                  )}
                  {agent.model && (
                    <Badge
                      count={agent.model}
                      style={{
                        background: colorFillAlter,
                        color: colorTextTertiary,
                        boxShadow: 'none'
                      }}
                    />
                  )}
                  {agent.skills && JSON.parse(agent.skills).length > 0 && (
                    <Badge
                      count={t('agentSettings.list.skillCount', {
                        count: (JSON.parse(agent.skills) as string[]).length
                      })}
                      style={{
                        background: colorFillAlter,
                        color: colorTextTertiary,
                        boxShadow: 'none'
                      }}
                    />
                  )}
                </div>
              </SettingRow>
            ))}
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
        <div className="py-4 px-5 custom-scrollbar" style={{ maxHeight: 480, overflowY: 'auto' }}>
          <Form form={form} layout="vertical" size="small">
            <div className="flex gap-3 items-end">
              <Form.Item
                label={t('agentSettings.form.chineseName')}
                name="rename"
                style={{ flex: 1 }}
              >
                <Input placeholder={t('agentSettings.form.chineseNamePlaceholder')} />
              </Form.Item>
              <Form.Item
                label={t('agentSettings.form.identifier')}
                name="name"
                rules={[
                  { required: true, message: t('agentSettings.form.identifierRequired') },
                  {
                    pattern: /^[a-z][a-z0-9-]*$/,
                    message: t('agentSettings.form.identifierPattern')
                  }
                ]}
                style={{ flex: 1 }}
              >
                <Input placeholder={t('agentSettings.form.identifierPlaceholder')} />
              </Form.Item>
              <Form.Item
                label={t('agentSettings.form.enabled')}
                name="enable"
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
            </div>

            <Form.Item
              label={t('agentSettings.form.description')}
              name="description"
              rules={[{ required: true, message: t('agentSettings.form.descriptionRequired') }]}
            >
              <TextArea rows={3} placeholder={t('agentSettings.form.descriptionPlaceholder')} />
            </Form.Item>

            <Form.Item
              label={t('agentSettings.form.systemPrompt')}
              name="prompt"
              rules={[{ required: true, message: t('agentSettings.form.systemPromptRequired') }]}
            >
              <TextArea rows={6} placeholder={t('agentSettings.form.systemPromptPlaceholder')} />
            </Form.Item>

            <Form.Item label={t('agentSettings.form.tools')} name="tools">
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
              label={t('agentSettings.form.model')}
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
              label={t('agentSettings.form.skills')}
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
