import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Form, Input, InputNumber, Modal, Select, Switch, theme } from 'antd'
import { PlusOutlined, UploadOutlined } from '@ant-design/icons'
import {
  RiAddLine,
  RiDeleteBin6Line,
  RiEditLine,
  RiPlug2Line,
  RiRefreshLine
} from '@remixicon/react'
import { SkeletonSettingRows } from '@renderer/components/system/Skeleton'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import {
  SettingsPageHeader,
  SettingsSection,
  SettingRow
} from '@renderer/components/system/settings/SettingsUI'
import { harnessApi } from '../../api'
import type { McpServerInput, McpServerView, McpToolInfo } from '../../../shared/types'

/**
 * 设置 → MCP（服务器管理）。
 *
 * 版面遵循设置页既有约定：**字段顺排**（页头 + 分区卡片 + 行式条目），不用装饰性分组标题、
 * 不用带框的信息块；结构只在携带信息时才成立——所以「工具」不是一个布尔开关，而是一份
 * 逐项开关的清单（哪台服务器带来哪些工具、哪些真的挂给了模型，都要能一眼看见并当场改）。
 *
 * 数据流：主进程是唯一真源（配置落 electron-store，状态来自真实连接）。这一页只做三件事：
 * 读（`mcp.list`）、写（save/remove/toggle/setToolsEnabled）、触发重连并试连（reconnect/test）。
 * 目录变化由 `mcp.onCatalogUpdated` 广播回来，因此别处（如导入）改了配置这里也会自动刷新。
 *
 * 工具清单的两个来源：编辑已连上的服务器时用目录快照里的清单；新建（或刚改了连接参数）时
 * 由「测试连接」现连一次拿回来。两者都落在同一个「工具」字段上，用户勾完保存即可。
 *
 * 「工具启用」的勾选不写在本页的临时 state 里，而是保存时并入 `mainAgent.mcpTools`
 * （见 shared/mcp.ts）：与智能体页的工具下拉共用同一份启用清单，避免两处各存一份。
 */

/** 表单值（env/headers 用数组形态承载键值对，提交时折叠成对象） */
interface ServerFormValues {
  /** 新建时可以为空（必填校验交给 Form.Item 的 rules） */
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
 * 工具开关：**按服务器上报的原始名（rawName）记**，不是全名。
 *
 * 全名（`mcp__<服务器名净化>__<工具名>`）里含服务器名，用户改一次名字就会整体换掉；
 * 按全名记选择会在改名后集体丢失。保存时再拿最新清单把 rawName 映射成全名（见 handleSave）。
 */
type ToolSelection = Record<string, boolean>

/** 表单窗口的初始值来源：新建（空）或编辑某台服务器；清单与开关初始态由父组件按当前数据算好 */
interface FormSeed {
  /** 每次打开递增：作为弹窗的 `key`，保证换一份初始值时一定是全新实例（见 openCreate 的注释） */
  seq: number
  mode: 'create' | 'edit'
  /** 编辑时的服务器视图（配置 + 运行期状态 + 已知工具清单） */
  server?: McpServerView
  /** 打开时已知的工具清单（编辑已连上的服务器时来自目录快照） */
  catalog: McpToolInfo[]
  selection: ToolSelection
}

/** 一次试连的结果：成功时带最新工具清单（就地铺成「工具」字段），失败时带原始错误 */
interface TestResult {
  ok: boolean
  text: string
  tools: McpToolInfo[]
}

/** 状态点：颜色是唯一的状态语言，与列表其它页一致 */
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
    token: { colorTextSecondary, colorTextTertiary, colorSuccess, colorError }
  } = theme.useToken()
  const { t } = useTranslation()
  const { viewMessage } = useMessage()
  const { modal, message } = App.useApp()

  const [servers, setServers] = useState<McpServerView[]>([])
  const [loading, setLoading] = useState(true)
  const [reconnecting, setReconnecting] = useState(false)
  /** 已启用给模型的工具名（与智能体页共用 mainAgent.mcpTools） */
  const [enabledTools, setEnabledTools] = useState<string[]>([])
  /** 正在切开关的服务器 id（行内开关的 loading） */
  const [togglingId, setTogglingId] = useState<string | null>(null)

  /**
   * 表单窗口的初始值（**弹窗打开时一次性喂给内层表单**，见 ServerForm）。
   *
   * 为什么把表单做成「按初始值挂载的子组件」而不是上面持有一个 useForm 实例：
   * 同一个实例被两个 Modal 轮流连（先开后关）时，antd 的字段注册/连线时序很脆——
   * 实测 Form.List（环境变量 / 请求头）在编辑既有服务器时不回填。改成「每次打开用一个
   * 全新的表单实例、由 initialValues 注入」后，既没有跨次残留，也不受挂载顺序影响。
   */
  const [formSeed, setFormSeed] = useState<FormSeed | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  /** 试连结果：就地显示在「工具」字段上方（成功给清单，失败给原始错误） */
  const [testResult, setTestResult] = useState<TestResult | null>(null)

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

  // 主进程广播目录变化（保存/导入/重连后）：本页与服务清单一并刷新
  useEffect(() => {
    try {
      return harnessApi.mcp.onCatalogUpdated(() => {
        void load()
      })
    } catch (err) {
      console.warn('[mcp-settings] 目录订阅失败:', err)
      return
    }
  }, [load])

  /** 工具名 → 是否已启用（判断某台服务器的工具当前是否进了模型工具清单） */
  const enabledSet = useMemo(() => new Set(enabledTools), [enabledTools])

  const serverEnabledCount = (view: McpServerView): number =>
    view.tools.filter((tool) => enabledSet.has(tool.name)).length

  /** 这台服务器的全部工具名（用于并入 / 移出 mainAgent.mcpTools） */
  const toolNamesOf = (view: McpServerView): string[] => view.tools.map((tool) => tool.name)

  // ── 表单：打开 / 提交 ────────────────────────────────────────────────

  /**
   * 每次打开表单递增一次的序号，作为 `ServerFormModal` 的 `key`。
   *
   * 为什么需要它：`formSeed` 直接从「编辑 A」换成「新建」时（关闭与打开落在同一批次，
   * 或将来多了别的入口），React 会**复用**同一个组件实例——`Form.useForm` 的实例、
   * `initialValues`、`useState(seed.selection)` 全是首次挂载时的值，界面就会显示上一个
   * 服务器的字段与勾选（实测：新建窗口里还留着刚编辑那台服务器的命令）。加 `key` 后
   * 每次打开都强制新实例，与「每次打开用一个全新的表单实例」的约定一致。
   */
  const seedSeq = React.useRef(0)

  const openCreate = (): void => {
    setTestResult(null)
    seedSeq.current += 1
    setFormSeed({ seq: seedSeq.current, mode: 'create', catalog: [], selection: {} })
  }

  const openEdit = (view: McpServerView): void => {
    setTestResult(null)
    // 逐项开关的初始态直接来自「已启用清单」：无启发式，看到的就是真的
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

  /** 表单值 → IPC 入参（键值对折成对象、参数按行拆、空值不落库） */
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
      // 【工具启用】的落点：把这台服务器的工具并入 / 移出 mainAgent.mcpTools。
      // 关键是**先摘掉这台服务器名下的全部工具名再按勾选补回**——用户可能在服务器上
      // 删过工具，只做并集会留下永远挂不上的幽灵名字。
      const before = servers.find((s) => s.config.id === saved.id)
      const stale = before ? toolNamesOf(before) : []
      const rest = enabledTools.filter((name) => !stale.includes(name))
      // saved 刚写入、工具清单要等重连完成才有：重新拉一次列表，拿最新工具名把
      // 按 rawName 记的勾选映射成全名（改名会换命名空间，所以不能直接用旧全名）。
      // 清单里没出现过的（新发现的 / 没试连过的）按默认启用处理，与「新服务器整台可用」一致。
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

  // ── 行操作 ──────────────────────────────────────────────────────────

  const handleToggle = async (view: McpServerView, checked: boolean): Promise<void> => {
    setTogglingId(view.config.id)
    // 乐观更新：开关的手感不该等一次真实的连接握手
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
          // 顺手把它带来的工具从启用清单里摘掉，避免留下永远挂不上的名字
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
          // 工具数不再重复写进这句话：计数跟着同一行显示（见 ServerFormModal 的 statusLine）
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

  // ── 版面片段 ────────────────────────────────────────────────────────

  /** 状态：小圆点 + 文案（颜色是唯一的状态语言，与列表其它页一致） */
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

  /** 连接目标（命令 + 参数 / 地址）：单行截断，完整值在编辑表单里看 */
  const targetOf = (view: McpServerView): string => {
    const config = view.config
    return config.transport === 'stdio'
      ? [config.command, ...(config.args ?? [])].filter(Boolean).join(' ')
      : (config.url ?? '')
  }

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
          servers.map((view) => {
            const enabledCount = serverEnabledCount(view)
            const target = targetOf(view)
            return (
              <SettingRow
                key={view.config.id}
                title={view.config.name}
                description={view.config.description || undefined}
                control={
                  <div className="flex items-center" style={{ gap: 8 }}>
                    {statusNode(view)}
                    <Switch
                      size="small"
                      checked={view.config.enabled}
                      loading={togglingId === view.config.id}
                      onChange={(checked) => void handleToggle(view, checked)}
                    />
                    {/*
                      行内操作直接摆出来（用户 2026-09-26 要求：编辑/删除从「⋯」菜单里移出来，
                      且只要图标、不带文字）。`aria-label` 只给读屏用，界面上不出现文字。
                    */}
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
                {/* 连接目标：单行截断（整条命令可能很长，任它换行会把行高撑散） */}
                {target && (
                  <div
                    style={{
                      marginTop: 2,
                      fontSize: 12,
                      color: colorTextTertiary,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}
                  >
                    {target}
                  </div>
                )}
                {view.tools.length > 0 && (
                  <div
                    data-mcp-row-tools
                    style={{ marginTop: 2, fontSize: 12, color: colorTextTertiary }}
                  >
                    {t('mcpSettings.list.toolsEnabledCount', {
                      enabled: enabledCount,
                      total: view.tools.length
                    })}
                  </div>
                )}
                {view.status === 'error' && view.error && (
                  <div
                    style={{
                      marginTop: 2,
                      fontSize: 12,
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
              </SettingRow>
            )
          })
        )}
      </SettingsSection>

      {/* ── 新增 / 编辑（每次打开挂载一个全新的表单实例，见 formSeed 的注释）── */}
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
    </div>
  )
}

/**
 * 键值对列表（env / headers 共用）。
 *
 * 用 antd `Form.List` 而不是自造 state：删除某一项后索引要跟着重排（自造 state 最容易
 * 在这里错位——删了第 2 行、值却留在第 3 行）。敏感值用 `Input.Password`，
 * 回显的是掩码串（主进程不下发明文）。
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
 * 新增 / 编辑服务器的表单窗口。
 *
 * **每次打开挂载一个新实例**（`{formSeed && <ServerFormModal …/>}`）：表单实例由本组件
 * 自己持有（`Form.useForm`），初始值走 `initialValues`，因此
 *  - 打开前不需要「先 set 值再连表单」的时序配合（用父组件的实例时，值可能在挂载前被丢掉）；
 *  - 关掉再打开不会残留上一次的字段（含 `Form.List` 的行）；
 *  - `transport` 切换时 stdio / http 两组字段由 `Form.useWatch` 决定渲染哪一组。
 *
 * 版面：字段顺排、**不摆装饰性分组标题**，次要输入两两一行（连接方式 + 调用超时、
 * 名称 + 启用）；说明文字只留在真正需要解释的字段上。
 *
 * 固定高度：body 限高 + 只有表单区滚动（与设置页其余表单弹窗同款），
 * 条目再多也不会把底部按钮顶出视口。
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

  /** 用户当前的勾选（rawName → 是否启用） */
  const [selection, setSelection] = useState<ToolSelection>(seed.selection)
  /** 「工具」字段（试连结果与清单都挂在这里，见下面的滚动） */
  const toolsRef = React.useRef<HTMLDivElement | null>(null)

  /**
   * 试连结束后把「工具」字段滚进视野。
   *
   * 这个字段在表单最下方，而表单（stdio + 环境变量）常常长过弹窗高度：用户点完底部
   * 「测试连接」，结果落在视口外就等于「点了没反应」——这正是用户反馈
   * 「测试后不能看见工具列表」的现场。滚动是幂等的（已在视野内就不动）。
   */
  React.useEffect(() => {
    if (!testResult) return
    // jsdom 没实现 scrollIntoView，工装里靠可选调用跳过
    toolsRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [testResult])

  /** 打开时的初始值：新建给一份可用默认值；编辑把既有配置摊平进字段（凭据是掩码） */
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

  /** 校验通过才回调（保存与「测试连接」都先过这一关，避免拿半填配置去连） */
  const withValidValues = async (handler: (values: ServerFormValues) => void): Promise<void> => {
    try {
      handler(await form.validateFields())
    } catch {
      // 校验失败：antd 已在字段下方标红，这里不额外提示
    }
  }

  const isStdio = transport !== 'http' && transport !== 'sse'

  /**
   * 「工具」字段里的清单：试连成功就用刚拿回来的那份，否则用打开时的目录快照。
   * 试连**失败**时保留旧清单（用户还能看见原来有哪些工具，不至于一片空白）。
   */
  const catalog = testResult?.ok ? testResult.tools : seed.catalog
  const isEnabled = (rawName: string): boolean => selection[rawName] !== false
  const enabledCount = catalog.filter((tool) => isEnabled(tool.rawName)).length
  const allEnabled = catalog.length > 0 && enabledCount === catalog.length

  /**
   * 工具字段顶部那一行 = 连接状态 + 工具计数（原本是上下两行，用户要求合成一行）。
   *  - 刚试连过：成功报「连接成功」，失败报原始错误；
   *  - 打开编辑时还没试连：连接成功过的服务器报「已连接」，连不上时报原始错误。
   * 计数与「全部启用/停用」跟在它后面，按钮靠 `margin-left: auto` 贴字段最右边。
   */
  const statusLine: { color: string; text: string } | null = testResult
    ? { color: testResult.ok ? colorSuccess : colorError, text: testResult.text }
    : editing?.status === 'error' && editing.error
      ? { color: colorError, text: editing.error }
      : editing?.status === 'ok'
        ? { color: colorSuccess, text: t('mcpSettings.status.ok') }
        : null

  /**
   * 没试连、也没有已知清单时**整块不渲染**（用户明确要求：没点「测试连接」就不要出现
   * 「工具」字段与那句「点测试连接读取清单」的提示）。有清单或有试连结果时才铺开。
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
       * 固定高度的表单窗口（与设置页其余表单弹窗同款：body 限高 + 自定义滚动条）。
       *
       * 不设上限时，条目一多（环境变量 / 请求头各几行）窗口会一路长高，底部按钮被顶出视口，
       * 用户找不到「保存」。这里锁住高度、**只有表单区滚动**，标题与按钮始终留在屏幕内，
       * 弹窗也不会随内容忽高忽低。
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
          「工具」字段：状态 + 计数一行，下面是清单 + 逐项开关，右侧一个「全部启用/停用」。
          **没试连过（也没有已知清单）时整块不渲染**——不摆空字段、也不摆「点测试连接读取清单」
          这类提示（用户 2026-09-26 明确要求）；有清单时条目再多也只在这块内部滚动。
        */}
        {showTools && (
          <Form.Item label={t('mcpSettings.field.tools')} style={{ marginBottom: 12 }}>
            {/* 状态行 + 清单作为一个整体滚进视野（ref 挂在这层，见上面的 useEffect） */}
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
                        // 贴字段最右边：这一行铺满控件宽度，按钮自带 auto 外边距把它推到尽头
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
                <div className="custom-scrollbar" style={{ maxHeight: 208, overflowY: 'auto' }}>
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
