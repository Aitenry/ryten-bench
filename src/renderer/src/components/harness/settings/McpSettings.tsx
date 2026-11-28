import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Form, Input, InputNumber, Modal, Select, Spin, Switch, theme } from 'antd'
import { PlusOutlined, UploadOutlined } from '@ant-design/icons'
import {
  RiAddLine,
  RiDeleteBin6Line,
  RiEditLine,
  RiFileTextLine,
  RiPlug2Line,
  RiRefreshLine
} from '@remixicon/react'
import { SkeletonSettingRows } from '@renderer/components/system/Skeleton'
import EntityCard, { EntityChip } from '@renderer/components/system/EntityCard'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import {
  SettingsPageHeader,
  SettingsSection
} from '@renderer/components/system/settings/SettingsUI'
import {
  harnessApi,
  type McpResourceContentEntry,
  type McpResourceEntry,
  type McpResourceTemplateEntry
} from '../../../api/harness'
import type {
  McpServerInput,
  McpServerView,
  McpToolInfo
} from '../../../../../shared/harness/types'

/**
 * Settings -> MCP (server management).
 *
 * Layout follows the settings page conventions: **fields flow in order** (page header + section
 * cards + rows), no decorative group headings and no boxed info blocks; structure exists only
 * when it carries information - so "tools" is not a boolean switch but a list of per-item toggles
 * (which server brings which tools, and which are actually attached to the model, must be visible
 * at a glance and editable on the spot).
 *
 * Data flow: the main process is the single source of truth (config in electron-store, status
 * from real connections). This page only does three things: read (`mcp.list`), write
 * (save/remove/toggle/setToolsEnabled), and trigger reconnect and test connections
 * (reconnect/test). Catalog changes are broadcast back via `mcp.onCatalogUpdated`, so config
 * changes made elsewhere (e.g. import) also refresh here automatically.
 *
 * Two sources for the tool list: editing a connected server uses the list from the catalog
 * snapshot; creating one (or just changing connection parameters) gets it from a live "Test
 * connection". Both land in the same "tools" field; the user checks the boxes and saves.
 *
 * Tool-enabled checkboxes are not kept in this page's temporary state; they are merged into
 * `mainAgent.mcpTools` on save (see shared/mcp.ts): one shared enabled list with the agent page's
 * tool dropdown, so there is only one copy.
 */

/** Form values (env/headers carry key-value pairs as arrays and are folded into objects on
 * submit) */
interface ServerFormValues {
  /** May be empty when creating (required validation is handled by the Form.Item rules) */
  name?: string
  description?: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  argsText?: string
  env?: { key?: string; value?: string }[]
  cwd?: string
  url?: string
  headers?: { key?: string; value?: string }[]
  timeoutMs?: number | null
  enabled?: boolean
}

/**
 * Tool switches: recorded **by the server-reported raw name (rawName)**, not the full name.
 *
 * The full name (`mcp__<sanitized server name>__<tool name>`) contains the server name, so a
 * single rename changes all of it; recording selections by full name makes them all disappear
 * after a rename. On save, the latest catalog maps rawName to the full name (see handleSave).
 */
type ToolSelection = Record<string, boolean>

/** Source of the form modal's initial values: creating (empty) or editing a server; the parent
 * computes the catalog and initial switch state from current data */
interface FormSeed {
  /** Increments on every open: used as the modal's `key` so a different set of initial values
   * always means a fresh instance (see the openCreate comment) */
  seq: number
  mode: 'create' | 'edit'
  /** Server view while editing (config + runtime status + known tool catalog) */
  server?: McpServerView
  /** Tool catalog known when opened (for editing a connected server, from the catalog snapshot) */
  catalog: McpToolInfo[]
  selection: ToolSelection
}

/** Result of one test connection: on success the latest tool catalog (laid out in place as the
 * "tools" field), on failure the raw error */
interface TestResult {
  ok: boolean
  text: string
  tools: McpToolInfo[]
}

/** Status dot: color is the only status language, consistent with other list pages */
const StatusDot: React.FC<{ color: string }> = ({ color }) => (
  <span
    style={{
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: color,
      display: 'inline-block',
      flexShrink: 0
    }}
  />
)

const McpSettings: React.FC = () => {
  const {
    token,
    token: {
      colorText,
      colorTextSecondary,
      colorTextTertiary,
      colorSuccess,
      colorError,
      colorBorderSecondary
    }
  } = theme.useToken()
  const { t } = useTranslation()
  const { viewMessage } = useMessage()
  const { modal, message } = App.useApp()

  const [servers, setServers] = useState<McpServerView[]>([])
  const [loading, setLoading] = useState(true)
  const [reconnecting, setReconnecting] = useState(false)
  /** Tool names already enabled for the model (shared with the agent page via
   * mainAgent.mcpTools) */
  const [enabledTools, setEnabledTools] = useState<string[]>([])
  /** Id of the server whose switch is being toggled (inline switch loading) */
  const [togglingId, setTogglingId] = useState<string | null>(null)

  /**
   * Initial values for the form modal (**fed to the inner form once when the modal opens**, see
   * ServerForm).
   *
   * Why the form is a "child mounted with initial values" instead of holding a useForm instance
   * above: when one instance is wired by two Modals in turn (open then close), antd's field
   * registration/wiring timing is fragile - in practice Form.List (env / headers) does not
   * repopulate when editing an existing server. With "a fresh form instance per open, injected
   * via initialValues", there is no cross-open leftover and mount order no longer matters.
   */
  const [formSeed, setFormSeed] = useState<FormSeed | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  /** Test result: shown in place above the "tools" field (catalog on success, raw error on
   * failure) */
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  /**
   * Resource browser modal: the model side has long been able to read MCP resources
   * (list_mcp_resources / read_mcp_resource), but users had no entry point. This adds a
   * "Resources" button on the server card; the modal lists resources + templates and previews
   * text / images in place when a row is clicked (for binaries only size and mime, no download).
   */
  const [resourcesTarget, setResourcesTarget] = useState<McpServerView | null>(null)
  const [resourceEntries, setResourceEntries] = useState<McpResourceEntry[]>([])
  const [templateEntries, setTemplateEntries] = useState<McpResourceTemplateEntry[]>([])
  const [resourcesLoading, setResourcesLoading] = useState(false)
  const [resourcesError, setResourcesError] = useState<string | null>(null)
  const [resourceCursor, setResourceCursor] = useState<string | undefined>(undefined)
  const [resourcePreview, setResourcePreview] = useState<{
    uri: string
    text?: string
    imageUrl?: string
    binaryNote?: string
  } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const load = useCallback(async () => {
    try {
      const [list, main] = await Promise.all([harnessApi.mcp.list(), harnessApi.mainAgent.get()])
      setServers(list)
      setEnabledTools(main.mcpTools ?? [])
    } catch (error) {
      viewMessage(
        'mcp-load',
        'error',
        t('mcpSettings.messages.loadFailedWithReason', { reason: String(error) })
      )
    } finally {
      setLoading(false)
    }
  }, [viewMessage, t])

  useEffect(() => {
    void load()
  }, [load])

  // The main process broadcasts catalog changes (after save/import/reconnect): refresh this page
  // and the server list together
  useEffect(() => {
    try {
      return harnessApi.mcp.onCatalogUpdated(() => {
        void load()
      })
    } catch (err) {
      console.warn('[mcp-settings] Failed to subscribe to MCP catalog:', err)
      return
    }
  }, [load])

  /** Tool name -> whether enabled (whether a server's tools are currently in the model tool
   * list) */
  const enabledSet = useMemo(() => new Set(enabledTools), [enabledTools])

  const serverEnabledCount = (view: McpServerView): number =>
    view.tools.filter((tool) => enabledSet.has(tool.name)).length

  /** All tool names of this server (used to merge into / remove from mainAgent.mcpTools) */
  const toolNamesOf = (view: McpServerView): string[] => view.tools.map((tool) => tool.name)

  // ── Form: open / submit ──────────────────────────────────────────────

  /**
   * Sequence number incremented on every form open, used as `ServerFormModal`'s `key`.
   *
   * Why it is needed: when `formSeed` switches straight from "edit A" to "create" (close and open
   * in the same batch, or more entry points later), React **reuses** the same component instance -
   * the `Form.useForm` instance, `initialValues`, and `useState(seed.selection)` all keep the
   * first-mount values, so the UI would show the previous server's fields and checkboxes
   * (observed: the create window still contains the command of the server just edited). With
   * `key`, every open forces a new instance, matching the "fresh form instance per open" rule.
   */
  const seedSeq = React.useRef(0)

  const openCreate = (): void => {
    setTestResult(null)
    seedSeq.current += 1
    setFormSeed({ seq: seedSeq.current, mode: 'create', catalog: [], selection: {} })
  }

  const openEdit = (view: McpServerView): void => {
    setTestResult(null)
    // The per-item switch initial state comes straight from the enabled list: no heuristics,
    // what you see is real
    const selection: ToolSelection = {}
    for (const tool of view.tools) selection[tool.rawName] = enabledSet.has(tool.name)
    seedSeq.current += 1
    setFormSeed({
      seq: seedSeq.current,
      mode: 'edit',
      server: view,
      catalog: view.tools,
      selection
    })
  }

  const closeForm = (): void => {
    setFormSeed(null)
    setTestResult(null)
  }

  /** Form values -> IPC input (key-value pairs folded into objects, args split by line, empty
   * values not persisted) */
  const toInput = (values: ServerFormValues, editing?: McpServerView | null): McpServerInput => {
    const pairs = (
      rows?: { key?: string; value?: string }[]
    ): Record<string, string> | undefined => {
      const out: Record<string, string> = {}
      for (const row of rows ?? []) {
        const key = row?.key?.trim()
        if (key) out[key] = row?.value ?? ''
      }
      return Object.keys(out).length > 0 ? out : undefined
    }
    const base: McpServerInput = {
      id: editing?.config.id,
      name: values.name?.trim() ?? '',
      description: values.description?.trim() || undefined,
      enabled: values.enabled ?? true,
      transport: values.transport,
      timeoutMs: values.timeoutMs ?? undefined
    }
    if (values.transport === 'stdio') {
      return {
        ...base,
        command: values.command?.trim(),
        args: (values.argsText ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        env: pairs(values.env),
        cwd: values.cwd?.trim() || undefined
      }
    }
    return { ...base, url: values.url?.trim(), headers: pairs(values.headers) }
  }

  const handleSave = async (values: ServerFormValues, selection: ToolSelection): Promise<void> => {
    const editing = formSeed?.mode === 'edit' ? (formSeed.server ?? null) : null
    setSaving(true)
    try {
      const saved = await harnessApi.mcp.save(toInput(values, editing))
      // Destination of the [tool enabled] state: merge this server's tools into / remove them from
      // mainAgent.mcpTools. The key is to **first remove all tool names under this server, then add
      // back the checked ones** - the user may have deleted tools on the server, and a pure union
      // would leave ghost names that can never be attached.
      const before = servers.find((s) => s.config.id === saved.id)
      const stale = before ? toolNamesOf(before) : []
      const rest = enabledTools.filter((name) => !stale.includes(name))
      // `saved` has just been written and the tool catalog only becomes available after reconnect:
      // refetch the list and map the selections recorded by rawName to full names using the latest
      // names (a rename changes the namespace, so old full names cannot be used directly). Names
      // missing from the catalog (newly discovered / never test-connected) default to enabled,
      // consistent with "a new server is fully usable".
      const fresh = (await harnessApi.mcp.list()).find((v) => v.config.id === saved.id)
      const kept = (fresh?.tools ?? [])
        .filter((tool) => selection[tool.rawName] !== false)
        .map((tool) => tool.name)
      const next = Array.from(new Set([...rest, ...kept]))
      await harnessApi.mcp.setToolsEnabled(next)
      setEnabledTools(next)
      message.success(t('mcpSettings.messages.saved', { name: saved.name }))
      closeForm()
      await load()
    } catch (error) {
      viewMessage(
        'mcp-save',
        'error',
        t('mcpSettings.messages.saveFailedWithReason', { reason: String(error) })
      )
    } finally {
      setSaving(false)
    }
  }

  // ── Row actions ──────────────────────────────────────────────────────

  const handleToggle = async (view: McpServerView, checked: boolean): Promise<void> => {
    setTogglingId(view.config.id)
    // Optimistic update: the switch should not wait for a real connection handshake
    setServers((prev) =>
      prev.map((s) =>
        s.config.id === view.config.id ? { ...s, config: { ...s.config, enabled: checked } } : s
      )
    )
    try {
      await harnessApi.mcp.toggle(view.config.id, checked)
    } catch (error) {
      viewMessage(
        'mcp-toggle',
        'error',
        t('mcpSettings.list.enableFailedWithReason', { reason: String(error) })
      )
    } finally {
      setTogglingId(null)
      await load()
    }
  }

  const handleRemove = (view: McpServerView): void => {
    modal.confirm({
      title: t('mcpSettings.list.removeConfirmTitle', { name: view.config.name }),
      content: t('mcpSettings.list.removeConfirmBody'),
      okText: t('common.action.confirm'),
      okType: 'danger',
      cancelText: t('common.action.cancel'),
      onOk: async () => {
        try {
          await harnessApi.mcp.remove(view.config.id)
          // Also remove the tools it brought from the enabled list, so no names that can never
          // be attached are left
          const rest = enabledTools.filter((name) => !toolNamesOf(view).includes(name))
          await harnessApi.mcp.setToolsEnabled(rest)
          setEnabledTools(rest)
          message.success(t('mcpSettings.list.removed', { name: view.config.name }))
          await load()
        } catch (error) {
          viewMessage(
            'mcp-remove',
            'error',
            t('common.message.deleteFailedWithReason', { reason: String(error) })
          )
        }
      }
    })
  }

  const handleReconnect = async (): Promise<void> => {
    setReconnecting(true)
    try {
      await harnessApi.mcp.reconnect()
      const list = await harnessApi.mcp.list()
      setServers(list)
      message.success(
        t('mcpSettings.list.reconnectDone', { count: list.filter((v) => v.status === 'ok').length })
      )
    } catch (error) {
      viewMessage(
        'mcp-reconnect',
        'error',
        t('common.message.operationFailedWithReason', { reason: String(error) })
      )
    } finally {
      setReconnecting(false)
    }
  }

  const handleImport = async (): Promise<void> => {
    try {
      const result = await harnessApi.mcp.pickImportFile()
      if (!result) return
      if (result.imported.length === 0) {
        viewMessage('mcp-import', 'warning', t('mcpSettings.messages.importNone'))
      } else {
        message.success(t('mcpSettings.messages.importDone', { count: result.imported.length }))
      }
      if (result.failed.length > 0) {
        setTimeout(() => {
          modal.info({
            title: t('mcpSettings.messages.importPartial'),
            width: 480,
            content: (
              <ul className="pl-4 m-0 text-sm">
                {result.failed.map((item) => (
                  <li key={item.name}>
                    {item.name}: {item.reason}
                  </li>
                ))}
              </ul>
            )
          })
        }, 300)
      }
      await load()
    } catch (error) {
      viewMessage(
        'mcp-import',
        'error',
        t('mcpSettings.messages.importFailedWithReason', { reason: String(error) })
      )
    }
  }

  const handleTest = async (values: ServerFormValues): Promise<void> => {
    const editing = formSeed?.mode === 'edit' ? (formSeed.server ?? null) : null
    setTesting(true)
    setTestResult(null)
    try {
      const result = await harnessApi.mcp.test(toInput(values, editing))
      if (result.ok) {
        const tools = result.tools ?? []
        setTestResult({
          ok: true,
          tools,
          // Tool count is no longer repeated in this sentence: the count is shown on the same
          // line (see ServerFormModal's statusLine)
          text: tools.length ? t('mcpSettings.form.testOk') : t('mcpSettings.form.testEmpty')
        })
      } else {
        setTestResult({
          ok: false,
          tools: [],
          text: result.error ?? t('mcpSettings.form.testFailed')
        })
      }
    } catch (error) {
      setTestResult({ ok: false, tools: [], text: String(error) })
    } finally {
      setTesting(false)
    }
  }

  // ── Layout fragments ─────────────────────────────────────────────────

  /** Status: small dot + text (color is the only status language, consistent with other list
   * pages) */
  const statusNode = (view: McpServerView): React.ReactNode => {
    const color =
      view.status === 'ok' ? colorSuccess : view.status === 'error' ? colorError : colorTextTertiary
    return (
      <span className="flex items-center" style={{ gap: 6, fontSize: 12, color }}>
        <StatusDot color={color} />
        {t(`mcpSettings.status.${view.status}`)}
      </span>
    )
  }

  /** Connection target (command + args / URL): truncated to one line; the full value is in the
   * edit form */
  const targetOf = (view: McpServerView): string => {
    const config = view.config
    return config.transport === 'stdio'
      ? [config.command, ...(config.args ?? [])].filter(Boolean).join(' ')
      : (config.url ?? '')
  }

  /** Fetch the resource list (the first page replaces, cursor pages append) */
  const loadResources = useCallback(
    async (server: string, cursor?: string): Promise<void> => {
      setResourcesLoading(true)
      setResourcesError(null)
      try {
        const result = await harnessApi.mcp.listResources(server, cursor)
        if (!result.ok) {
          setResourcesError(result.error)
          return
        }
        setResourceEntries((prev) =>
          cursor ? [...prev, ...result.resources] : result.resources
        )
        setResourceCursor(result.nextCursor)
      } catch (error) {
        setResourcesError(String(error))
      } finally {
        setResourcesLoading(false)
      }
    },
    []
  )

  /** Open the "Resources" modal: fetch resources + templates in parallel (a template failure
   * does not block the resource list) */
  const openResources = useCallback(
    (view: McpServerView): void => {
      setResourcesTarget(view)
      setResourceEntries([])
      setTemplateEntries([])
      setResourceCursor(undefined)
      setResourcePreview(null)
      setResourcesError(null)
      void loadResources(view.config.name)
      void harnessApi.mcp
        .listResourceTemplates(view.config.name)
        .then((result) => {
          if (result.ok) setTemplateEntries(result.templates)
        })
        .catch(() => {
          // Templates are supplementary: fail silently (the resource list shows connection
          // errors itself)
        })
    },
    [loadResources]
  )

  const closeResources = useCallback((): void => {
    setResourcesTarget(null)
    setResourceEntries([])
    setTemplateEntries([])
    setResourceCursor(undefined)
    setResourcePreview(null)
    setResourcesError(null)
  }, [])

  /** Read one resource and preview it in place: text is shown directly; images become data URLs
   * from the base64 blob; other binaries get a description */
  const previewResource = useCallback(
    async (uri: string): Promise<void> => {
      if (!resourcesTarget) return
      setPreviewLoading(true)
      setResourcesError(null)
      try {
        const result = await harnessApi.mcp.readResource(resourcesTarget.config.name, uri)
        if (!result.ok) {
          setResourcesError(result.error)
          setResourcePreview(null)
          return
        }
        const parts = result.contents
        const text = parts
          .map((part: McpResourceContentEntry) => part.text)
          .filter((value): value is string => typeof value === 'string')
          .join('\n\n')
        const binary = parts.find(
          (part: McpResourceContentEntry) => typeof part.blob === 'string' && !part.text
        )
        if (text) {
          setResourcePreview({ uri, text })
          return
        }
        if (binary?.blob) {
          const mime = binary.mimeType ?? ''
          if (/^image\/(png|jpe?g|webp|gif)$/i.test(mime)) {
            setResourcePreview({ uri, imageUrl: `data:${mime};base64,${binary.blob}` })
          } else {
            setResourcePreview({
              uri,
              binaryNote: t('mcpSettings.resources.binaryNote', {
                mime: mime || 'application/octet-stream',
                bytes: String(Math.round((binary.blob.length * 3) / 4))
              })
            })
          }
          return
        }
        setResourcePreview({ uri, text: t('mcpSettings.resources.emptyContent') })
      } catch (error) {
        setResourcesError(String(error))
        setResourcePreview(null)
      } finally {
        setPreviewLoading(false)
      }
    },
    [resourcesTarget, t]
  )

  return (
    <div>
      <SettingsPageHeader
        title={t('mcpSettings.pageTitle')}
        description={t('mcpSettings.pageDescription')}
      />

      <SettingsSection
        title={t('mcpSettings.list.sectionTitle')}
        icon={<RiPlug2Line size={14} />}
        extra={
          <div className="flex items-center" style={{ gap: 8 }}>
            <Button
              icon={<RiRefreshLine size={14} />}
              size="small"
              loading={reconnecting}
              onClick={handleReconnect}
            >
              {t('mcpSettings.list.reconnect')}
            </Button>
            <Button icon={<UploadOutlined />} size="small" onClick={handleImport}>
              {t('mcpSettings.list.importFile')}
            </Button>
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreate}>
              {t('mcpSettings.list.newServer')}
            </Button>
          </div>
        }
      >
        {loading ? (
          <div style={{ padding: '4px 0' }}>
            <SkeletonSettingRows rows={3} />
          </div>
        ) : servers.length === 0 ? (
          <div
            style={{
              padding: '28px 0',
              textAlign: 'center',
              fontSize: 13,
              color: colorTextSecondary
            }}
          >
            {t('mcpSettings.list.empty')}
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))',
              gap: 14,
              padding: 16
            }}
          >
            {servers.map((view) => {
              const enabledCount = serverEnabledCount(view)
              const target = targetOf(view)
              return (
                <EntityCard
                  key={view.config.id}
                  id={view.config.id}
                  icon={<RiPlug2Line size={19} />}
                  title={view.config.name}
                  meta={
                    <>
                      {statusNode(view)}
                      {view.tools.length > 0 && (
                        <span data-mcp-row-tools style={{ display: 'inline-flex' }}>
                          <EntityChip>
                            {t('mcpSettings.list.toolsEnabledCount', {
                              enabled: enabledCount,
                              total: view.tools.length
                            })}
                          </EntityChip>
                        </span>
                      )}
                    </>
                  }
                  description={view.config.description || undefined}
                  footerStart={
                    <Switch
                      size="small"
                      checked={view.config.enabled}
                      loading={togglingId === view.config.id}
                      onChange={(checked) => void handleToggle(view, checked)}
                    />
                  }
                  footerEnd={
                    <div className="flex items-center" style={{ gap: 2, marginLeft: 'auto' }}>
                      <Button
                        type="text"
                        size="small"
                        data-mcp-row-action="resources"
                        aria-label={t('mcpSettings.resources.open')}
                        title={t('mcpSettings.resources.open')}
                        icon={<RiFileTextLine size={14} />}
                        onClick={() => openResources(view)}
                      />
                      <Button
                        type="text"
                        size="small"
                        data-mcp-row-action="edit"
                        aria-label={t('mcpSettings.list.edit')}
                        icon={<RiEditLine size={14} />}
                        onClick={() => openEdit(view)}
                      />
                      <Button
                        type="text"
                        size="small"
                        danger
                        data-mcp-row-action="remove"
                        aria-label={t('mcpSettings.list.remove')}
                        icon={<RiDeleteBin6Line size={14} />}
                        onClick={() => handleRemove(view)}
                      />
                    </div>
                  }
                >
                  {target && (
                    <div
                      style={{
                        marginTop: 10,
                        fontSize: 11.5,
                        color: colorTextTertiary,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                    >
                      {target}
                    </div>
                  )}
                  {view.status === 'error' && view.error && (
                    <div
                      style={{
                        marginTop: 6,
                        fontSize: 11.5,
                        color: colorError,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden'
                      }}
                    >
                      {view.error}
                    </div>
                  )}
                </EntityCard>
              )
            })}
          </div>
        )}
      </SettingsSection>

      {/* ── Create / edit (a fresh form instance is mounted on every open,
          see the formSeed comment) ── */}
      {formSeed && (
        <ServerFormModal
          key={formSeed.seq}
          seed={formSeed}
          saving={saving}
          testing={testing}
          testResult={testResult}
          onClose={closeForm}
          onSubmit={(values, selection) => void handleSave(values, selection)}
          onTest={(values) => void handleTest(values)}
        />
      )}

      {/* ── Resource browsing (read-only): resources / resource templates exposed by the
          server ── */}
      <Modal
        open={resourcesTarget !== null}
        onCancel={closeResources}
        footer={null}
        width={780}
        destroyOnHidden
        title={t('mcpSettings.resources.title', { name: resourcesTarget?.config.name ?? '' })}
      >
        <div style={{ display: 'flex', gap: 16, height: 440 }}>
          {/* Left column: resource list + templates */}
          <div
            style={{
              width: 300,
              flexShrink: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: colorText }}>
              {t('mcpSettings.resources.listTitle')}
            </div>
            <div
              className="custom-scrollbar app-modal-scroll"
              style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
              data-mcp-resources-list
            >
              {resourcesLoading && resourceEntries.length === 0 ? (
                <SkeletonSettingRows rows={3} />
              ) : null}
              {resourcesError ? (
                <div style={{ fontSize: 12, color: colorError, lineHeight: 1.6 }}>
                  {t('mcpSettings.resources.listFailed', { reason: resourcesError })}
                </div>
              ) : null}
              {!resourcesLoading && !resourcesError && resourceEntries.length === 0 ? (
                <div style={{ fontSize: 12, color: colorTextTertiary, padding: '12px 0' }}>
                  {t('mcpSettings.resources.empty')}
                </div>
              ) : null}
              {resourceEntries.map((entry) => (
                <button
                  key={entry.uri}
                  type="button"
                  data-mcp-resource-uri={entry.uri}
                  title={entry.uri}
                  onClick={() => void previewResource(entry.uri)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    background:
                      resourcePreview?.uri === entry.uri
                        ? token.colorFillTertiary
                        : 'transparent',
                    borderRadius: 7,
                    padding: '6px 8px',
                    cursor: 'pointer'
                  }}
                >
                  <div style={{ fontSize: 12.5, color: colorText }}>
                    {entry.name || entry.uri}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: colorTextTertiary,
                      wordBreak: 'break-all',
                      marginTop: 1
                    }}
                  >
                    {entry.uri}
                    {entry.mimeType ? ` · ${entry.mimeType}` : ''}
                  </div>
                </button>
              ))}
              {resourceCursor ? (
                <Button
                  size="small"
                  loading={resourcesLoading}
                  style={{ marginTop: 6 }}
                  onClick={() =>
                    void loadResources(resourcesTarget?.config.name ?? '', resourceCursor)
                  }
                >
                  {t('mcpSettings.resources.loadMore')}
                </Button>
              ) : null}
            </div>
            {templateEntries.length > 0 && (
              <div style={{ marginTop: 12, flexShrink: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: colorText }}>
                  {t('mcpSettings.resources.templatesTitle')}
                </div>
                <div
                  className="custom-scrollbar"
                  style={{ maxHeight: 110, overflowY: 'auto' }}
                >
                  {templateEntries.map((template) => (
                    <div
                      key={template.uriTemplate}
                      style={{ padding: '3px 0', wordBreak: 'break-all' }}
                    >
                      <div style={{ fontSize: 11.5, color: colorTextSecondary }}>
                        {template.name || template.uriTemplate}
                      </div>
                      <div style={{ fontSize: 10.5, color: colorTextTertiary }}>
                        {template.uriTemplate}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right column: resource content preview */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: colorText }}>
              {t('mcpSettings.resources.previewTitle')}
            </div>
            <div
              className="custom-scrollbar app-modal-scroll"
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                border: `1px solid ${colorBorderSecondary}`,
                borderRadius: 8,
                padding: 10
              }}
              data-mcp-resource-preview
            >
              {previewLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
                  <Spin size="small" />
                </div>
              ) : resourcePreview?.imageUrl ? (
                <img
                  src={resourcePreview.imageUrl}
                  alt={resourcePreview.uri}
                  style={{ maxWidth: '100%', borderRadius: 6 }}
                />
              ) : resourcePreview?.binaryNote ? (
                <div style={{ fontSize: 12, color: colorTextSecondary }}>
                  {resourcePreview.binaryNote}
                </div>
              ) : resourcePreview?.text ? (
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontSize: 12,
                    lineHeight: 1.6,
                    color: colorText
                  }}
                >
                  {resourcePreview.text}
                </pre>
              ) : (
                <div style={{ fontSize: 12, color: colorTextTertiary, padding: '12px 0' }}>
                  {t('mcpSettings.resources.previewEmpty')}
                </div>
              )}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}

/**
 * Key-value list (shared by env / headers).
 *
 * Uses antd `Form.List` instead of home-grown state: indexes must shift when an item is deleted
 * (home-grown state most easily goes out of sync here - delete row 2 and the value stays in row
 * 3). Sensitive values use `Input.Password`, which echoes a masked string (the main process never
 * sends plaintext).
 */
const KeyValueList: React.FC<{
  name: string
  label: string
  keyPlaceholder: string
  addLabel: string
  extra?: string
}> = ({ name, label, keyPlaceholder, addLabel, extra }) => {
  const { colorTextTertiary } = theme.useToken().token
  return (
    <Form.Item label={label} extra={extra} style={{ marginBottom: 12 }}>
      <Form.List name={name}>
        {(fields, { add, remove }) => (
          <div className="flex flex-col" style={{ gap: 6 }}>
            {fields.map((field) => (
              <div key={field.key} className="flex items-center" style={{ gap: 6 }}>
                <Form.Item name={[field.name, 'key']} noStyle>
                  <Input placeholder={keyPlaceholder} style={{ flex: 1 }} />
                </Form.Item>
                <Form.Item name={[field.name, 'value']} noStyle>
                  <Input.Password placeholder="••••" style={{ flex: 1 }} visibilityToggle={false} />
                </Form.Item>
                <Button
                  type="text"
                  size="small"
                  icon={<RiDeleteBin6Line size={14} />}
                  onClick={() => remove(field.name)}
                />
              </div>
            ))}
            <Button
              type="dashed"
              size="small"
              icon={<RiAddLine size={14} />}
              onClick={() => add({ key: '', value: '' })}
              style={{ color: colorTextTertiary }}
            >
              {addLabel}
            </Button>
          </div>
        )}
      </Form.List>
    </Form.Item>
  )
}

/**
 * Create / edit server form modal.
 *
 * **Mounts a new instance on every open** (`{formSeed && <ServerFormModal …/>}`): the form
 * instance is owned by this component (`Form.useForm`) and initial values go through
 * `initialValues`, so
 *  - no "set values then connect the form" ordering is needed before opening (with the parent's
 *    instance, values may be dropped before mount);
 *  - closing and reopening leaves no fields from the previous round (including `Form.List` rows);
 *  - when `transport` changes, `Form.useWatch` decides whether the stdio or http field group
 *    renders.
 *
 * Layout: fields flow in order, **no decorative group headings**, secondary inputs two per row
 * (transport + call timeout, name + enabled); hint text stays only on fields that really need it.
 *
 * Fixed height: body is capped + only the form area scrolls (same as the other form modals on the
 * settings page), so the bottom buttons cannot be pushed out of view no matter how many entries.
 */
const ServerFormModal: React.FC<{
  seed: FormSeed
  saving: boolean
  testing: boolean
  testResult: TestResult | null
  onClose: () => void
  onSubmit: (values: ServerFormValues, selection: ToolSelection) => void
  onTest: (values: ServerFormValues) => void
}> = ({ seed, saving, testing, testResult, onClose, onSubmit, onTest }) => {
  const {
    token: {
      colorTextTertiary,
      colorTextSecondary,
      colorSuccess,
      colorError,
      colorBorderSecondary,
      colorPrimary
    }
  } = theme.useToken()
  const { t } = useTranslation()
  const [form] = Form.useForm<ServerFormValues>()
  const transport = Form.useWatch('transport', form)
  const editing = seed.server ?? null

  /** The user's current checkboxes (rawName -> enabled) */
  const [selection, setSelection] = useState<ToolSelection>(seed.selection)
  /** The "tools" field (test result and catalog both hang here, see the scroll below) */
  const toolsRef = React.useRef<HTMLDivElement | null>(null)

  /**
   * Scroll the "tools" field into view when a test connection finishes.
   *
   * This field sits at the bottom of the form, and the form (stdio + env vars) is often taller
   * than the modal: after the user clicks "Test connection" at the bottom, a result outside the
   * viewport feels like "clicking does nothing" - exactly the user report "cannot see the tool
   * list after testing". Scrolling is idempotent (no movement if already visible).
   */
  React.useEffect(() => {
    if (!testResult) return
    // jsdom does not implement scrollIntoView; skip it via an optional call in the test harness
    toolsRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [testResult])

  /** Initial values on open: create gets usable defaults; edit flattens the existing config
   * into fields (credentials are masked) */
  const initialValues: ServerFormValues = editing
    ? {
        name: editing.config.name,
        description: editing.config.description,
        transport: editing.config.transport,
        command: editing.config.command,
        argsText: (editing.config.args ?? []).join('\n'),
        env: Object.entries(editing.config.env ?? {}).map(([key, value]) => ({ key, value })),
        cwd: editing.config.cwd,
        url: editing.config.url,
        headers: Object.entries(editing.config.headers ?? {}).map(([key, value]) => ({
          key,
          value
        })),
        timeoutMs: editing.config.timeoutMs,
        enabled: editing.config.enabled
      }
    : { transport: 'stdio', enabled: true, env: [] }

  /** Call back only after validation passes (both save and "Test connection" go through it,
   * avoiding connecting with a half-filled config) */
  const withValidValues = async (handler: (values: ServerFormValues) => void): Promise<void> => {
    try {
      handler(await form.validateFields())
    } catch {
      // Validation failed: antd already marks the field red, no extra hint here
    }
  }

  const isStdio = transport !== 'http' && transport !== 'sse'

  /**
   * Catalog in the "tools" field: use the one just fetched when the test succeeded, otherwise the
   * catalog snapshot from open time. On test **failure** keep the old catalog (the user can still
   * see which tools were there, instead of a blank area).
   */
  const catalog = testResult?.ok ? testResult.tools : seed.catalog
  const isEnabled = (rawName: string): boolean => selection[rawName] !== false
  const enabledCount = catalog.filter((tool) => isEnabled(tool.rawName)).length
  const allEnabled = catalog.length > 0 && enabledCount === catalog.length

  /**
   * Top line of the tools field = connection status + tool count (previously two lines; the user
   * asked for one).
   *  - Just test-connected: success reports "connected", failure reports the raw error;
   *  - Opened for edit without a test yet: a previously connected server reports "connected",
   *    otherwise the raw error.
   * The count and "enable/disable all" follow it, with the button pinned to the far right of the
   * field via `margin-left: auto`.
   */
  const statusLine: { color: string; text: string } | null = testResult
    ? { color: testResult.ok ? colorSuccess : colorError, text: testResult.text }
    : editing?.status === 'error' && editing.error
      ? { color: colorError, text: editing.error }
      : editing?.status === 'ok'
        ? { color: colorSuccess, text: t('mcpSettings.status.ok') }
        : null

  /**
   * With no test connection and no known catalog, **the whole block does not render** (the user
   * explicitly asked: without clicking "Test connection" there should be no "tools" field and no
   * "click test connection to read the catalog" hint). It expands only when there is a catalog or
   * a test result.
   */
  const showTools = catalog.length > 0 || testResult !== null

  const toggleAll = (): void => {
    const next: ToolSelection = {}
    for (const tool of catalog) next[tool.rawName] = !allEnabled
    setSelection(next)
  }

  return (
    <Modal
      open
      title={
        editing
          ? t('mcpSettings.form.editTitle', { name: editing.config.name })
          : t('mcpSettings.form.createTitle')
      }
      onCancel={onClose}
      width={620}
      okText={t('common.action.save')}
      cancelText={t('common.action.cancel')}
      footer={[
        <Button key="test" loading={testing} onClick={() => void withValidValues(onTest)}>
          {testing ? t('mcpSettings.form.testing') : t('mcpSettings.form.test')}
        </Button>,
        <Button key="cancel" onClick={onClose}>
          {t('common.action.cancel')}
        </Button>,
        <Button
          key="save"
          type="primary"
          loading={saving}
          onClick={() => void withValidValues((values) => onSubmit(values, selection))}
        >
          {t('common.action.save')}
        </Button>
      ]}
      /**
       * Fixed-height form window (same as the other form modals on the settings page: capped body +
       * custom scrollbar).
       *
       * Without a cap, the window keeps growing as entries accumulate (a few rows each for env vars
       * and headers), pushing the bottom buttons out of view so the user cannot find "Save". Here
       * the height is locked and **only the form area scrolls**, keeping the title and buttons on
       * screen and preventing the modal from jumping with content.
       */
      styles={{ body: { maxHeight: 560, padding: '16px 20px', overflowY: 'auto' } }}
      classNames={{ body: 'custom-scrollbar' }}
    >
      <Form form={form} layout="vertical" size="small" initialValues={initialValues}>
        <div className="flex gap-3">
          <Form.Item
            label={t('mcpSettings.field.name')}
            name="name"
            rules={[{ required: true, message: t('mcpSettings.field.namePlaceholder') }]}
            extra={t('mcpSettings.field.nameHint')}
            style={{ flex: 1, marginBottom: 12 }}
          >
            <Input placeholder={t('mcpSettings.field.namePlaceholder')} />
          </Form.Item>
          <Form.Item
            label={t('mcpSettings.field.enabled')}
            name="enabled"
            valuePropName="checked"
            style={{ flex: '0 0 auto', marginBottom: 12 }}
          >
            <Switch />
          </Form.Item>
        </div>
        <Form.Item label={t('mcpSettings.field.description')} name="description">
          <Input placeholder={t('mcpSettings.field.descriptionPlaceholder')} />
        </Form.Item>

        <div className="flex gap-3">
          <Form.Item label={t('mcpSettings.field.transport')} name="transport" style={{ flex: 1 }}>
            <Select
              options={[
                { value: 'stdio', label: t('mcpSettings.transport.stdio') },
                { value: 'http', label: t('mcpSettings.transport.http') },
                { value: 'sse', label: t('mcpSettings.transport.sse') }
              ]}
            />
          </Form.Item>
          <Form.Item label={t('mcpSettings.field.timeout')} name="timeoutMs" style={{ flex: 1 }}>
            <InputNumber
              min={1000}
              step={1000}
              style={{ width: '100%' }}
              placeholder={t('mcpSettings.field.timeoutPlaceholder')}
            />
          </Form.Item>
        </div>

        {isStdio ? (
          <>
            <Form.Item
              label={t('mcpSettings.field.command')}
              name="command"
              rules={[{ required: true, message: t('mcpSettings.field.commandPlaceholder') }]}
            >
              <Input placeholder={t('mcpSettings.field.commandPlaceholder')} />
            </Form.Item>
            <Form.Item label={t('mcpSettings.field.args')} name="argsText">
              <Input.TextArea
                rows={2}
                placeholder={t('mcpSettings.field.argsPlaceholder')}
                style={{ fontFamily: 'monospace' }}
              />
            </Form.Item>
            <Form.Item label={t('mcpSettings.field.cwd')} name="cwd">
              <Input placeholder={t('mcpSettings.field.cwdPlaceholder')} />
            </Form.Item>
            <KeyValueList
              name="env"
              label={t('mcpSettings.field.env')}
              keyPlaceholder={t('mcpSettings.field.envPlaceholder')}
              addLabel={t('mcpSettings.field.addEnv')}
              extra={editing ? t('mcpSettings.field.secretsKept') : undefined}
            />
          </>
        ) : (
          <>
            <Form.Item
              label={t('mcpSettings.field.url')}
              name="url"
              rules={[{ required: true, message: t('mcpSettings.field.urlPlaceholder') }]}
            >
              <Input placeholder={t('mcpSettings.field.urlPlaceholder')} />
            </Form.Item>
            <KeyValueList
              name="headers"
              label={t('mcpSettings.field.headers')}
              keyPlaceholder={t('mcpSettings.field.headerPlaceholder')}
              addLabel={t('mcpSettings.field.addHeader')}
              extra={editing ? t('mcpSettings.field.secretsKept') : undefined}
            />
          </>
        )}

        {/*
          "Tools" field: status + count on one line, then the catalog + per-item toggles, with an
          "enable/disable all" on the right. **With no test connection (and no known catalog) the
          whole block does not render** - no empty field and no "click test connection to read the
          catalog" hint (explicit user requirement 2026-09-26); when a catalog exists, entries
          scroll only inside this block.
        */}
        {showTools && (
          <Form.Item label={t('mcpSettings.field.tools')} style={{ marginBottom: 12 }}>
            {/* The status line + catalog scroll into view as one unit (ref is on this layer,
                see the useEffect above) */}
            <div ref={toolsRef} data-mcp-tools-field>
              <div className="flex items-center" style={{ gap: 8 }}>
                {statusLine && (
                  <span
                    className="flex items-center"
                    data-mcp-tools-status
                    style={{ gap: 6, fontSize: 12, color: statusLine.color, minWidth: 0 }}
                  >
                    <StatusDot color={statusLine.color} />
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {statusLine.text}
                    </span>
                  </span>
                )}
                {catalog.length > 0 && (
                  <>
                    {statusLine && (
                      <span style={{ fontSize: 12, color: colorTextTertiary }}>·</span>
                    )}
                    <span
                      data-mcp-tools-count
                      style={{ fontSize: 12, color: colorTextTertiary, flexShrink: 0 }}
                    >
                      {t('mcpSettings.form.toolsCount', {
                        total: catalog.length,
                        enabled: enabledCount
                      })}
                    </span>
                    <button
                      type="button"
                      data-mcp-tools-all
                      onClick={toggleAll}
                      style={{
                        // Pinned to the far right of the field: this row spans the control
                        // width, and the button's auto margin pushes it to the end
                        marginLeft: 'auto',
                        flexShrink: 0,
                        padding: 0,
                        border: 'none',
                        background: 'none',
                        cursor: 'pointer',
                        fontSize: 12,
                        color: colorPrimary
                      }}
                    >
                      {allEnabled
                        ? t('mcpSettings.field.toolsNone')
                        : t('mcpSettings.field.toolsAll')}
                    </button>
                  </>
                )}
              </div>
              {catalog.length > 0 && (
                <div
                  className="custom-scrollbar app-modal-scroll"
                  style={{ maxHeight: 208, overflowY: 'auto' }}
                >
                  {catalog.map((tool, index) => {
                    const on = isEnabled(tool.rawName)
                    return (
                      <div
                        key={tool.rawName}
                        data-mcp-tool={tool.rawName}
                        className="flex items-center"
                        style={{
                          gap: 12,
                          padding: '5px 0',
                          borderTop: index === 0 ? 'none' : `1px solid ${colorBorderSecondary}`
                        }}
                      >
                        <span
                          style={{
                            flex: '0 0 150px',
                            fontFamily: 'monospace',
                            fontSize: 12,
                            color: on ? colorTextSecondary : colorTextTertiary,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}
                        >
                          {tool.rawName}
                        </span>
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: 12,
                            color: colorTextTertiary,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}
                        >
                          {tool.description || '—'}
                        </span>
                        <Switch
                          size="small"
                          checked={on}
                          onChange={(checked) =>
                            setSelection((prev) => ({ ...prev, [tool.rawName]: checked }))
                          }
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </Form.Item>
        )}
      </Form>
    </Modal>
  )
}

export default McpSettings
