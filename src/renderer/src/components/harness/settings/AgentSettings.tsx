import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { theme, Button, Switch, Modal, Form, Input, Select, Pagination, App } from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ImportOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
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
  SettingsSection,
  SettingRow
} from '@renderer/components/system/settings/SettingsUI'
import { harnessApi, type SandboxStatusView } from '../../../api/harness'
import type { HarnessToolInfo } from '../../../types/harness/types'
import ToolSourceTag, { type ToolSourceKind } from '../ToolSourceTag'
import type {
  AgentConfigInput,
  AgentConfigRow,
  McpServerView,
  PermissionMode
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

  // Current workspace ID
  const [workspaceId, setWorkspaceId] = useState(0)

  // Subagent list
  const [agents, setAgents] = useState<AgentConfigRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)

  /**
   * Tool names currently enabled for the model on the MCP page (`mainAgent.mcpTools`).
   *
   * The agent page does **not** list MCP tools one by one (a few servers already mean dozens of
   * items, and it is the same decision as the per-item switches on the MCP page, so the two entry
   * points would inevitably drift): it gives one item per **server**, named after the server,
   * while which tools are actually on is still decided only by the MCP page. See
   * MCP_SERVER_GROUP_PREFIX in shared/mcp.ts.
   */
  const [enabledMcpTools, setEnabledMcpTools] = useState<string[]>([])
  /** MCP server list (for group options: name, namespace, available tools) */
  const [mcpServers, setMcpServers] = useState<McpServerView[]>([])

  // Edit/create modal
  const [modalOpen, setModalOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState<AgentConfigRow | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  // Option data
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [availableTools, setAvailableTools] = useState<HarnessToolInfo[]>([])
  const [skills, setSkills] = useState<{ id: string; name: string; description: string }[]>([])

  // Import JSON
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importLoading, setImportLoading] = useState(false)

  /**
   * Runtime & security (sandbox + default permission mode for new conversations).
   *
   * Both previously existed only on the backend and in the locale entries: the sandbox state had
   * no UI at all (when the backend is unavailable, commands are rejected outright), and the
   * default mode could only be switched per conversation in the input box. This gives a minimal
   * but complete read-only status + the only write entry point (default mode, revoke the
   * workspace's persistent grant).
   */
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatusView | null>(null)
  const [sandboxLoading, setSandboxLoading] = useState(true)
  const [defaultPermission, setDefaultPermission] = useState<PermissionMode>('workspace-write')
  const [permissionSaving, setPermissionSaving] = useState(false)
  const [sandboxCleanupBusy, setSandboxCleanupBusy] = useState(false)
  const [workspacePath, setWorkspacePath] = useState('')

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
       * Legacy-data compatibility: MCP tools used to be mixed into the agent page's tool dropdown
       * and written into `tools`. Now this page shows one item per server and tool-level control
       * lives on the MCP page, so legacy `mcp__...` names are moved into `mcpTools` (**add only,
       * never remove**, so users do not lose checked tools because of this redesign). This no
       * longer triggers after one migration.
       */
      const legacyMcp = rawTools.filter(isMcpToolName)
      const afterMcp =
        legacyMcp.length > 0 ? rawTools.filter((name) => !isMcpToolName(name)) : rawTools
      /**
       * The 4 plugin-workshop tools used to be registered only when checked on this page. They are
       * now **plugin-mode mode tools** (mounted automatically when switching to plugin mode, see
       * PLUGIN_MODE_TOOL_NAMES in shared/mcp.ts), and their options are gone from the dropdown;
       * names left over in historical config are dropped here so no ghost tag without a matching
       * option remains. Dropping them costs nothing: mode tools come with the mode and are
       * unrelated to the checkboxes on this page.
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
   * Refetch only the tool list (used when the MCP catalog changes: leaves paging and the form
   * values the user is editing untouched). The MCP server list and enabled list are synced along
   * the way - the group items' checked state and counts derive from them, and this page does not
   * edit them (the edit entry point is the MCP page), so changes made elsewhere must show up
   * immediately.
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
      // Failing to fetch the tool list does not affect the rest: keep the previous one,
      // no error popup
    }
  }, [])

  useEffect(() => {
    loadOptions().then((wsId) => {
      loadPage(1, wsId)
    })
  }, [loadPage, loadOptions])

  // Runtime & security: sandbox backend status + default permission mode for new conversations
  // (loaded independently of the subagent list, so an unavailable backend does not block the page)
  const loadRuntimeSecurity = useCallback(async (): Promise<void> => {
    setSandboxLoading(true)
    try {
      const [permission, settings, sandbox] = await Promise.all([
        harnessApi.harness.getPermission(),
        window.api.systemSettings.getAll(),
        harnessApi.harness.sandboxStatus().catch(() => null)
      ])
      setDefaultPermission(permission.defaultMode)
      setWorkspacePath(settings.harness?.workspacePath ?? '')
      setSandboxStatus(sandbox)
    } catch (error) {
      console.warn('[agent-settings] Failed to load sandbox/permission state:', error)
    } finally {
      setSandboxLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRuntimeSecurity()
  }, [loadRuntimeSecurity])

  const handleDefaultPermissionChange = useCallback(
    async (mode: PermissionMode): Promise<void> => {
      setPermissionSaving(true)
      try {
        const state = await harnessApi.harness.setPermission({ mode, scope: 'default' })
        setDefaultPermission(state.defaultMode)
        viewMessage('agent-permission', 'success', t('harness.permission.defaultChanged'), 2)
      } catch {
        viewMessage('agent-permission', 'error', t('harness.permission.switchFailed'))
      } finally {
        setPermissionSaving(false)
      }
    },
    [t, viewMessage]
  )

  const handleSandboxCleanup = useCallback(async (): Promise<void> => {
    if (!workspacePath) return
    setSandboxCleanupBusy(true)
    try {
      const cleaned = await harnessApi.harness.cleanupSandbox(workspacePath)
      viewMessage(
        'agent-sandbox',
        cleaned ? 'success' : 'error',
        cleaned ? t('harness.sandbox.cleanupDone') : t('harness.sandbox.cleanupFailed'),
        2
      )
    } catch {
      viewMessage('agent-sandbox', 'error', t('harness.sandbox.cleanupFailed'))
    } finally {
      setSandboxCleanupBusy(false)
    }
  }, [t, viewMessage, workspacePath])

  // MCP server connect/disconnect changes the available tool set: subscribe and refresh the
  // dropdown immediately, so users need not close and reopen settings to see a just-connected
  // MCP tool
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

  // Listen for workspace switches
  useEffect(() => {
    const handleWorkspaceChanged = (): void => {
      loadOptions().then((wsId) => {
        loadPage(1, wsId)
      })
    }
    window.addEventListener('workspace-changed', handleWorkspaceChanged)
    return () => window.removeEventListener('workspace-changed', handleWorkspaceChanged)
  }, [loadOptions, loadPage])

  // ===== Main agent =====

  /**
   * MCP server group item: **one item per server, named after the server itself** (user
   * requirement 2026-09-26: "use the mcp name"), checked = this server's tools enter the enabled
   * list, unchecked = removed by namespace. Which tools are on is still switched item by item only
   * on the MCP page.
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
        // An unreachable server may still have a previously checked name: list it as long as any
        // tool is still enabled (otherwise it cannot be turned off)
        .filter(
          (group) =>
            group.total > 0 ||
            enabledMcpTools.some((name) => parseMcpToolName(name)?.server === group.namespace)
        ),
    [mcpServers, enabledMcpTools]
  )

  /** Options in the tool dropdown: regular tools listed one by one + one item per MCP server */
  const toolOptions = useMemo(() => {
    const regular = availableTools.filter((tool) => !isMcpToolName(tool.name))
    return [
      ...regular,
      ...mcpGroupOptions.map((group) => ({
        name: group.value,
        label: group.name,
        description: '',
        icon: 'RiPlug2Line',
        color: '#8c6b3f',
        // MCP server group item: the list also tags the source (neither a system tool nor a plugin)
        source: 'mcp' as const
      }))
    ]
  }, [availableTools, mcpGroupOptions])

  // ===== Subagents =====

  const openEditModal = (agent?: AgentConfigRow): void => {
    setEditingAgent(agent ?? null)
    if (agent) {
      const storedTools: string[] = agent.tools ? JSON.parse(agent.tools) : []
      /**
       * Old data stored full MCP names one by one (`mcp__<namespace>__<tool>`): normalize them into
       * **one group item per server** (which tools are on is decided by the MCP page) and persist
       * that on this save. The old generic `mcp` marker is upgraded too.
       */
      const migrated: string[] = []
      for (const name of storedTools) {
        // The plugin's mode-workshop tools (plugin_draft etc.) are not subagent options: they are
        // plugin-mode mode tools mounted automatically by the mode (see shared/mcp.ts). Historical
        // leftovers are dropped.
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
        // Normalize old tool names: the four material tools merged into one, and web fetch/search
        // merged into `web-tools` (see shared/harness/mcp.ts)
        migrated.push(canonicalToolName(name))
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
     * On validation failure antd already shows a red hint under the field; this step used to share
     * the save's try block, and catch would pop another "Save failed: [object Object]" as if the
     * backend had errored. Validate separately first and return on failure; only real save errors
     * show an error bar.
     *
     * The form area is a fixed-height scroll container: an offending field may be scrolled out of
     * view, so clicking "Save" seems to do nothing. Scroll the first invalid field into the middle,
     * keep antd's field hint, and do not pop an extra toast.
     */
    const values = await form.validateFields().catch((error: unknown) => {
      const firstField = (error as { errorFields?: Array<{ name?: unknown }> })?.errorFields?.[0]
        ?.name
      if (typeof firstField === 'string' || Array.isArray(firstField)) {
        try {
          form.scrollToField(firstField as never)
        } catch {
          // A failed scroll does not affect the validation hints
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
        // Notify the memory tree to refresh (the backend already created the memory directory)
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
          // Notify the memory tree to refresh (the backend already deleted the memory directory)
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

  // ===== Import JSON =====

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

    // Build the valid item set (an MCP group item `mcp@<namespace>` is also valid: it references
    // the MCP page's checkbox)
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

        // Validate and filter tools (individual full MCP names in the import file are normalized
        // to their server's group item)
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

        // Validate and filter skills
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

        // Validate model
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

    // Summary hint
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

    // Show the stripped hints one by one
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

    // Refresh & clear
    if (fileInputRef.current) fileInputRef.current.value = ''
    // Notify the memory tree to refresh (the backend already created the memory directory)
    if (imported > 0) {
      window.dispatchEvent(new CustomEvent('memory-tree-refresh'))
    }
    await loadPage(1, workspaceId)
  }

  // File selection handling
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
   * Field labels follow the same layout as the schedule modal: 12px secondary color, label above
   * the control, required asterisk after the text (antd puts the asterisk before the text by
   * default at 14px, which looks clearly different next to the other forms).
   */
  const fieldLabel = (text: string, required = false): React.ReactNode => (
    <span style={{ fontSize: 12, color: colorTextSecondary }}>
      {text}
      {required && <span style={{ color: colorError, marginLeft: 2 }}>*</span>}
    </span>
  )

  /** Sandbox status text: backend + enforcement level (when the backend is unavailable,
   * state clearly that "commands will be rejected") */
  const sandboxStatusLabel = sandboxLoading
    ? t('harness.sandbox.loading')
    : sandboxStatus?.usable !== true
      ? t('harness.sandbox.unavailable')
      : sandboxStatus?.enforcement === 'full'
        ? t('harness.sandbox.full')
        : t('harness.sandbox.partial')
  const sandboxBackendLabel = ((): string => {
    const backend = sandboxStatus?.backend ?? ''
    if (backend.includes('windows')) return t('harness.sandbox.backendWindows')
    if (backend.includes('bwrap') || backend.includes('bubblewrap'))
      return t('harness.sandbox.backendBwrap')
    if (backend.includes('landlock')) return t('harness.sandbox.backendLandlock')
    if (backend.includes('seatbelt')) return t('harness.sandbox.backendSeatbelt')
    return backend
  })()
  const sandboxDescription = sandboxLoading
    ? ''
    : sandboxStatus?.usable !== true
      ? t('harness.sandbox.unavailableHint', { reason: sandboxStatus?.reason ?? '—' })
      : sandboxStatus?.enforcement === 'full'
        ? t('harness.sandbox.fullHint')
        : t('harness.sandbox.partialHint')

  return (
    <div>
      <SettingsPageHeader
        title={t('agentSettings.pageTitle')}
        description={t('agentSettings.pageDescription')}
      />

      {/* ====== Subagent list ====== */}
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
          /* Assistant rows mirror SettingRow: title + description on the left,
             "switch + edit + delete" on the right */
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
                        // The enable column is nullable in the DB (DEFAULT TRUE);
                        // treat null as enabled by default
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

      {/* ====== Runtime & security: default permission mode for new conversations + sandbox
          status ====== */}
      <SettingsSection
        title={t('agentSettings.sections.runtime')}
        icon={<SafetyCertificateOutlined size={14} />}
        description={t('agentSettings.sections.runtimeDesc')}
      >
        <SettingRow
          title={t('harness.permission.defaultLabel')}
          description={t('harness.permission.defaultHint')}
          control={
            <Select
              size="small"
              style={{ width: 172 }}
              value={defaultPermission}
              loading={permissionSaving}
              onChange={(value: PermissionMode) => void handleDefaultPermissionChange(value)}
              options={[
                { value: 'read-only', label: t('harness.permission.readOnly') },
                { value: 'workspace-write', label: t('harness.permission.workspaceWrite') },
                { value: 'danger-full-access', label: t('harness.permission.fullAccess') }
              ]}
            />
          }
        />
        <SettingRow
          title={t('harness.sandbox.label')}
          description={
            sandboxBackendLabel
              ? `${sandboxBackendLabel}${sandboxDescription ? ` · ${sandboxDescription}` : ''}`
              : sandboxDescription
          }
          control={
            <div className="flex items-center" style={{ gap: 10 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  color:
                    sandboxStatus?.usable !== true
                      ? colorError
                      : sandboxStatus?.enforcement === 'full'
                        ? '#49aa19'
                        : '#d89614'
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'currentColor'
                  }}
                />
                {sandboxStatusLabel}
              </span>
              <Button
                size="small"
                loading={sandboxCleanupBusy}
                disabled={!workspacePath || sandboxLoading}
                title={
                  workspacePath
                    ? t('harness.sandbox.cleanupHint', { path: workspacePath })
                    : t('harness.sandbox.cleanupNoWorkspace')
                }
                onClick={() => void handleSandboxCleanup()}
              >
                {t('harness.sandbox.cleanup')}
              </Button>
            </div>
          }
        />
      </SettingsSection>

      {/* Edit/create modal */}
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
          The scroll area shares the same left edge as the modal title (previously `px-5` indented
          fields 20px more than the title, making the form look squeezed into the middle of the
          modal); on the right only the 6px scrollbar slot of `app-modal-scroll` remains - the same
          rule as the plugin settings modal. Height matches other form modals: 560px max, falling
          back to the viewport height on short windows; only the form area scrolls, so the title and
          button bar always stay on screen.
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
                options={toolOptions.map((tool) => ({
                  value: tool.name,
                  label: `${tool.label} (${tool.description})`,
                  // Custom field: extracted in optionRender as the source tag at the end of the row
                  source: tool.source
                }))}
                // Tag "system / plugin / MCP" at the far right of the name: previously the two
                // kinds of tools were mixed in one list and indistinguishable
                optionRender={(option) => {
                  const source = (option.data as { source?: ToolSourceKind } | undefined)?.source
                  return (
                    <div className="ryt-tool-option">
                      <span className="ryt-tool-option__label">{option.label}</span>
                      <ToolSourceTag source={source} />
                    </div>
                  )
                }}
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
      {/* Hidden file picker */}
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
