import React, { useState, useEffect, useCallback } from 'react'
import { Button, Input, Tabs, Tag, Switch, Empty, Popconfirm, Modal, Tooltip, theme } from 'antd'
import {
  FolderOutlined,
  PlusOutlined,
  DeleteOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  ReloadOutlined
} from '@ant-design/icons'
import type { TFunction } from 'i18next'
import { useTranslation } from '@renderer/i18n'
import { useMessage } from '@renderer/hooks/useMessage'
import type { SystemSettings, HarnessSettings } from '@renderer/types/settings'
import {
  SettingsPageHeader,
  SettingsSection,
  SettingRow
} from '@renderer/components/system/settings/SettingsUI'
import { harnessApi } from '../../api'
import { useMemoryScope, useMemoryScopeName } from '../../memory-scope'

/**
 * Mnemon 记忆管理（三层记忆）
 * - 热记忆：USER 用户画像 / MEMORY 项目记忆（每轮注入 prompt，容量 4KiB / 10KiB）
 * - 长期空间：Memory Spaces（PGlite 数据库 + 关系图，按需召回）
 * - 档案：Project Documents（完整 Markdown，active/archived 冷热分层）
 *
 * **跟着当前会话的作用域走**：插件会话里进来管的就是这份插件自己的记忆
 * （`<memoryPath>/plugin-<id>/`），工作会话里就是当前工作区那套（renderer/memory-scope.ts）。
 */

type MnemonSnapshot = Awaited<ReturnType<typeof harnessApi.harness.mnemonSnapshot>>

/** 优先级圆点色（编辑部风格：克制用色） */
const IMPORTANCE_DOT: Record<string, string> = {
  critical: '#d4380d',
  normal: '#1677ff',
  low: '#bfbfbf'
}

/** 重要性文案：把 t 作为参数传入，普通函数内不调用 hook */
function getImportanceLabel(t: TFunction, importance: string): string {
  switch (importance) {
    case 'critical':
      return t('memorySettings.importance.critical')
    case 'normal':
      return t('memorySettings.importance.normal')
    case 'low':
      return t('memorySettings.importance.low')
    default:
      return importance
  }
}

/** 目标选择卡片（选中：强调色左条 + 浅色底 + 强调描边） */
const TargetCard: React.FC<{
  label: string
  desc: string
  selected: boolean
  onClick: () => void
}> = ({ label, desc, selected, onClick }) => {
  const t = useThemeTokens()
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left"
      style={{
        position: 'relative',
        padding: '10px 12px 10px 16px',
        borderRadius: 8,
        cursor: 'pointer',
        border: `1px solid ${selected ? t.primary : t.cardBorder}`,
        background: selected ? t.iconBg : 'transparent',
        transition: 'border-color 0.15s, background 0.15s'
      }}
    >
      {selected && (
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 8,
            bottom: 8,
            width: 3,
            borderRadius: 1.5,
            background: t.primary
          }}
        />
      )}
      <div style={{ fontSize: 13, fontWeight: 600, color: t.text, lineHeight: '19px' }}>
        {label}
      </div>
      <div style={{ fontSize: 11, color: t.textTertiary, marginTop: 1, lineHeight: '16px' }}>
        {desc}
      </div>
    </button>
  )
}

/** 重要性胶囊（选中：强调色描边 + 浅底） */
const ImportancePill: React.FC<{
  color: string
  label: string
  selected: boolean
  onClick: () => void
}> = ({ color, label, selected, onClick }) => {
  const t = useThemeTokens()
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 10px',
        borderRadius: 999,
        fontSize: 12,
        lineHeight: '18px',
        border: `1px solid ${selected ? t.primary : t.cardBorder}`,
        color: selected ? t.primary : t.textSecondary,
        background: selected ? t.iconBg : 'transparent',
        cursor: 'pointer',
        transition: 'border-color 0.15s, color 0.15s, background 0.15s'
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: color,
          display: 'inline-block'
        }}
      />
      {label}
    </button>
  )
}

/** 主题化常量（暗色/亮色自适应） */
function useThemeTokens(): {
  cardBg: string
  cardBorder: string
  hairline: string
  formBg: string
  text: string
  textSecondary: string
  textTertiary: string
  iconBg: string
  trackBg: string
  primary: string
  error: string
} {
  const { token } = theme.useToken()
  return {
    cardBg: token.colorBgContainer,
    cardBorder: token.colorBorderSecondary,
    hairline: token.colorSplit,
    formBg: token.colorFillAlter,
    text: token.colorText,
    textSecondary: token.colorTextSecondary,
    textTertiary: token.colorTextTertiary,
    iconBg: token.colorPrimaryBg,
    trackBg: token.colorFillTertiary,
    primary: token.colorPrimary,
    error: token.colorError
  }
}

/** 细容量条：4px 圆角条 + 文字 */
const CapacityBar: React.FC<{
  used: number
  limit: number
}> = ({ used, limit }) => {
  const t = useThemeTokens()
  const { t: translate } = useTranslation()
  const percent = Math.min(100, Math.round((used / limit) * 100))
  const nearFull = percent >= 85
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Tooltip title={translate('memorySettings.runtime.bytes', { used, limit })}>
        <div
          style={{
            width: 110,
            height: 4,
            borderRadius: 2,
            background: t.trackBg,
            overflow: 'hidden'
          }}
        >
          <div
            style={{
              width: `${percent}%`,
              height: '100%',
              borderRadius: 2,
              background: nearFull ? t.error : t.primary,
              transition: 'width 0.3s'
            }}
          />
        </div>
      </Tooltip>
      <span style={{ fontSize: 12, color: nearFull ? t.error : t.textTertiary }}>
        {used} / {limit} B
      </span>
    </div>
  )
}

/** 单条热记忆：圆点 + 内容 + 时间 + 删除（hover 显示） */
const RuntimeEntryRow: React.FC<{
  entry: { content: string; importance: string; updated_at?: string }
  onRemove: () => void
  onRemoveTitle: string
}> = ({ entry, onRemove, onRemoveTitle }) => {
  const t = useThemeTokens()
  const { t: translate } = useTranslation()
  return (
    <div
      className="group flex items-start gap-2.5 px-3 py-2.5 transition-colors"
      style={{ borderBottom: `1px solid ${t.hairline}` }}
    >
      <span
        className="mt-[7px] rounded-full shrink-0"
        style={{ width: 7, height: 7, background: IMPORTANCE_DOT[entry.importance] ?? '#bfbfbf' }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            lineHeight: '20px',
            color: t.text,
            wordBreak: 'break-all'
          }}
        >
          {entry.content}
        </div>
        <div
          style={{
            fontSize: 11,
            lineHeight: '16px',
            color: t.textTertiary,
            marginTop: 1
          }}
        >
          {getImportanceLabel(translate, entry.importance)}
          {entry.updated_at ? ` · ${entry.updated_at.slice(0, 10)}` : ''}
        </div>
      </div>
      <Popconfirm
        title={onRemoveTitle}
        onConfirm={onRemove}
        okText={translate('common.action.delete')}
        cancelText={translate('common.action.cancel')}
      >
        <Button
          type="text"
          size="small"
          danger
          icon={<DeleteOutlined />}
          className="opacity-0 group-hover:opacity-100 transition-opacity"
        />
      </Popconfirm>
    </div>
  )
}

/** 分组卡片：色条标题 + 容量 + 条目列表 */
const RuntimeGroupCard: React.FC<{
  title: string
  accent: string
  entries: { content: string; importance: string; updated_at?: string }[]
  usage: { used: number; limit: number }
  emptyText: string
  onRemove: (entry: { content: string }) => void
}> = ({ title, accent, entries, usage, emptyText, onRemove }) => {
  const t = useThemeTokens()
  const { t: translate } = useTranslation()
  return (
    <div
      style={{
        border: `1px solid ${t.cardBorder}`,
        borderRadius: 10,
        overflow: 'hidden',
        background: t.cardBg
      }}
    >
      <div
        className="flex items-center justify-between px-3.5 py-2.5"
        style={{ borderBottom: `1px solid ${t.hairline}` }}
      >
        <span className="flex items-center gap-2" style={{ fontSize: 13, fontWeight: 600 }}>
          <span style={{ width: 3, height: 14, borderRadius: 1.5, background: accent }} />
          {title}
          <span style={{ fontSize: 12, fontWeight: 400, color: t.textTertiary }}>
            {translate('memorySettings.runtime.count', { count: entries.length })}
          </span>
        </span>
        <CapacityBar used={usage.used} limit={usage.limit} />
      </div>
      {entries.length === 0 ? (
        <div className="text-center py-6" style={{ fontSize: 12, color: t.textTertiary }}>
          {emptyText}
        </div>
      ) : (
        <div className="custom-scrollbar" style={{ maxHeight: 240, overflow: 'auto' }}>
          {entries.map((entry, i) => (
            <RuntimeEntryRow
              key={i}
              entry={entry}
              onRemoveTitle={translate('memorySettings.runtime.removeConfirm')}
              onRemove={() => onRemove(entry)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const MemorySettings: React.FC = () => {
  const { t: translate } = useTranslation()
  const { viewMessage } = useMessage()
  const t = useThemeTokens()

  const [settings, setSettings] = useState<SystemSettings | null>(null)
  const [memoryPath, setMemoryPath] = useState('')
  const [savingPath, setSavingPath] = useState(false)
  const [snapshot, setSnapshot] = useState<MnemonSnapshot | null>(null)
  const [loadingSnapshot, setLoadingSnapshot] = useState(false)
  /** 当前会话的记忆作用域（插件会话 = 这份插件自己的记忆；空 = 当前工作区） */
  const memoryScope = useMemoryScope()
  /** 插件作用域时显示插件名，供页面标注「现在管的是谁的记忆」 */
  const memoryScopeName = useMemoryScopeName()

  // 热记忆添加表单
  const [addTarget, setAddTarget] = useState<'user' | 'memory'>('memory')
  const [addContent, setAddContent] = useState('')
  const [addImportance, setAddImportance] = useState<'critical' | 'normal' | 'low'>('normal')
  const [adding, setAdding] = useState(false)

  // 空间创建表单
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [creatingBody, setCreatingBody] = useState(false)

  // 空间内容浏览
  const [browsingBody, setBrowsingBody] = useState<{ id: string; name: string } | null>(null)
  const [bodyInsights, setBodyInsights] = useState<
    { id: string; content: string; category?: string; importance?: number; createdAt?: string }[]
  >([])
  const [browsingLoading, setBrowsingLoading] = useState(false)

  const loadSettings = useCallback(async () => {
    const msgKey = 'memory-settings-load'
    try {
      const result = await window.api.systemSettings.getAll()
      setSettings(result)
      setMemoryPath(result.harness?.memoryPath ?? '')
    } catch (error) {
      viewMessage(
        msgKey,
        'error',
        translate('common.message.loadFailedWithReason', { reason: String(error) })
      )
    }
  }, [viewMessage, translate])

  const loadSnapshot = useCallback(async () => {
    setLoadingSnapshot(true)
    try {
      const snap = await harnessApi.harness.mnemonSnapshot(memoryScope)
      setSnapshot(snap)
    } catch (error) {
      viewMessage(
        'mnemon-snapshot',
        'error',
        translate('memorySettings.manage.snapshotFailed', { reason: String(error) })
      )
    } finally {
      setLoadingSnapshot(false)
    }
  }, [viewMessage, translate, memoryScope])

  useEffect(() => {
    loadSettings().then()
  }, [loadSettings])

  useEffect(() => {
    if (settings?.harness?.memoryPath) {
      loadSnapshot().then()
    }
  }, [settings?.harness?.memoryPath, loadSnapshot])

  // 切换作用域（换会话 / 换工作区）后重载快照：那是另一套记忆，旧数据必须失效
  useEffect(() => {
    const handleWorkspaceChanged = (): void => {
      if (settings?.harness?.memoryPath) {
        loadSnapshot().then()
      }
    }
    window.addEventListener('workspace-changed', handleWorkspaceChanged)
    return () => window.removeEventListener('workspace-changed', handleWorkspaceChanged)
  }, [settings?.harness?.memoryPath, loadSnapshot])

  const handleBrowsePath = async (): Promise<void> => {
    try {
      const path = await harnessApi.harness.selectMemoryDirectory()
      if (path) setMemoryPath(path)
    } catch (error) {
      viewMessage(
        'memory-path',
        'error',
        translate('memorySettings.storage.selectFailed', { reason: String(error) })
      )
    }
  }

  const handleSavePath = async (): Promise<void> => {
    const msgKey = 'memory-path'
    try {
      setSavingPath(true)
      const trimmed = memoryPath.trim()
      const nextHarness: HarnessSettings = {
        ...(settings?.harness ?? {}),
        memoryPath: trimmed || undefined
      }
      await window.api.systemSettings.update({ harness: nextHarness })
      setSettings((prev) => (prev ? { ...prev, harness: nextHarness } : prev))
      setMemoryPath(trimmed)
      const savedMessage = trimmed
        ? translate('memorySettings.storage.saved')
        : translate('memorySettings.storage.cleared')
      viewMessage(msgKey, 'success', savedMessage, 2)
      if (trimmed) {
        loadSnapshot().then()
      } else {
        setSnapshot(null)
      }
    } catch (error) {
      viewMessage(
        msgKey,
        'error',
        translate('common.message.saveFailedWithReason', { reason: String(error) })
      )
    } finally {
      setSavingPath(false)
    }
  }

  /** 热记忆新增 */
  const handleAddRuntime = async (): Promise<void> => {
    const msgKey = 'mnemon-runtime-add'
    const content = addContent.trim()
    if (!content) {
      viewMessage(msgKey, 'warning', translate('memorySettings.runtime.contentRequired'), 2)
      return
    }
    setAdding(true)
    try {
      const result = await harnessApi.harness.mnemonRuntimeMutate(
        {
          action: 'add',
          target: addTarget,
          content,
          importance: addImportance
        },
        memoryScope
      )
      viewMessage(msgKey, result.success ? 'success' : 'warning', result.message, 3)
      if (result.success) {
        setAddContent('')
        loadSnapshot().then()
      }
    } finally {
      setAdding(false)
    }
  }

  /** 热记忆删除（唯一子串定位） */
  const handleRemoveRuntime = async (entry: {
    content: string
    target: 'user' | 'memory'
  }): Promise<void> => {
    const msgKey = 'mnemon-runtime-remove'
    try {
      const oldText = entry.content.slice(0, 60)
      const result = await harnessApi.harness.mnemonRuntimeMutate(
        {
          action: 'remove',
          target: entry.target,
          old_text: oldText
        },
        memoryScope
      )
      viewMessage(msgKey, result.success ? 'success' : 'warning', result.message, 3)
      loadSnapshot().then()
    } catch (error) {
      viewMessage(
        msgKey,
        'error',
        translate('common.message.deleteFailedWithReason', { reason: String(error) })
      )
    }
  }

  /** 空间激活开关 */
  const handleToggleBody = async (id: string, active: boolean): Promise<void> => {
    const msgKey = 'mnemon-body-toggle'
    try {
      const result = await harnessApi.harness.mnemonBodyUpdate(
        id,
        {
          active
        },
        memoryScope
      )
      viewMessage(msgKey, result.success ? 'success' : 'warning', result.message ?? '', 2)
      loadSnapshot().then()
    } catch (error) {
      viewMessage(
        msgKey,
        'error',
        translate('common.message.updateFailedWithReason', { reason: String(error) })
      )
    }
  }

  /** 创建空间 */
  const handleCreateBody = async (): Promise<void> => {
    const msgKey = 'mnemon-body-create'
    if (!createName.trim()) {
      viewMessage(msgKey, 'warning', translate('memorySettings.bodies.nameRequired'), 2)
      return
    }
    setCreatingBody(true)
    try {
      const result = await harnessApi.harness.mnemonBodyCreate(
        createName.trim(),
        createDescription.trim(),
        memoryScope
      )
      const createdMessage = result.success
        ? translate('memorySettings.bodies.created', { name: result.body?.name })
        : (result.message ?? '')
      viewMessage(msgKey, result.success ? 'success' : 'warning', createdMessage, 3)
      if (result.success) {
        setCreateName('')
        setCreateDescription('')
        loadSnapshot().then()
      }
    } finally {
      setCreatingBody(false)
    }
  }

  /** 浏览空间内容 */
  const handleBrowseBody = async (body: { id: string; name: string }): Promise<void> => {
    setBrowsingBody(body)
    setBrowsingLoading(true)
    setBodyInsights([])
    try {
      const items = await harnessApi.harness.mnemonBodyList([body.id], memoryScope)
      setBodyInsights(items)
    } catch {
      setBodyInsights([])
    } finally {
      setBrowsingLoading(false)
    }
  }

  const runtime = snapshot?.runtime
  const userEntries = runtime?.entries.filter((e) => e.target === 'user') ?? []
  const memoryEntries = runtime?.entries.filter((e) => e.target === 'memory') ?? []
  const bodies = snapshot?.bodies?.items ?? []
  const documents = snapshot?.documents
  const configured = !!settings?.harness?.memoryPath

  const renderRuntimeTab = (): React.ReactNode => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 添加记忆 */}
      <div
        style={{
          padding: '14px',
          border: `1px solid ${t.cardBorder}`,
          borderRadius: 10,
          background: t.formBg
        }}
      >
        {/* 目标选择卡片 */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <TargetCard
            label={translate('memorySettings.targets.userLabel')}
            desc={translate('memorySettings.targets.userDesc')}
            selected={addTarget === 'user'}
            onClick={() => setAddTarget('user')}
          />
          <TargetCard
            label={translate('memorySettings.targets.memoryLabel')}
            desc={translate('memorySettings.targets.memoryDesc')}
            selected={addTarget === 'memory'}
            onClick={() => setAddTarget('memory')}
          />
        </div>

        {/* 内容输入（下划线式） */}
        <div
          style={{
            marginTop: 12,
            borderBottom: `1px solid ${t.hairline}`,
            transition: 'border-color 0.15s',
            paddingBottom: 2
          }}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = t.primary)}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = t.hairline)}
        >
          <Input.TextArea
            value={addContent}
            onChange={(e) => setAddContent(e.target.value)}
            placeholder={
              addTarget === 'user'
                ? translate('memorySettings.targets.userPlaceholder')
                : translate('memorySettings.targets.memoryPlaceholder')
            }
            autoSize={{ minRows: 1, maxRows: 3 }}
            style={{
              padding: '4px 0',
              fontSize: 13.5,
              background: 'transparent',
              border: 'none',
              boxShadow: 'none',
              outline: 'none'
            }}
            onPressEnter={handleAddRuntime}
          />
        </div>

        {/* 重要性 + 记住 */}
        <div
          className="flex items-center justify-between gap-2 flex-wrap"
          style={{ marginTop: 10 }}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span style={{ fontSize: 12, color: t.textTertiary }}>
              {translate('memorySettings.importance.label')}
            </span>
            <ImportancePill
              color="#d4380d"
              label={translate('memorySettings.importance.critical')}
              selected={addImportance === 'critical'}
              onClick={() => setAddImportance('critical')}
            />
            <ImportancePill
              color="#1677ff"
              label={translate('memorySettings.importance.normal')}
              selected={addImportance === 'normal'}
              onClick={() => setAddImportance('normal')}
            />
            <ImportancePill
              color="#bfbfbf"
              label={translate('memorySettings.importance.low')}
              selected={addImportance === 'low'}
              onClick={() => setAddImportance('low')}
            />
          </div>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            loading={adding}
            onClick={handleAddRuntime}
          >
            {translate('memorySettings.runtime.add')}
          </Button>
        </div>

        {/* 目标说明（随选择切换） */}
        <div style={{ fontSize: 11, color: t.textTertiary, marginTop: 10, lineHeight: '16px' }}>
          {addTarget === 'user' ? (
            <>{translate('memorySettings.targets.userHint')}</>
          ) : (
            <>{translate('memorySettings.targets.memoryHint')}</>
          )}
        </div>
      </div>

      {/* 用户画像 */}
      <RuntimeGroupCard
        title={translate('memorySettings.targets.userLabel')}
        accent="#1677ff"
        entries={userEntries}
        usage={runtime ? runtime.targets.user : { used: 0, limit: 4096 }}
        emptyText={translate('memorySettings.runtime.emptyUser')}
        onRemove={(entry) => handleRemoveRuntime({ content: entry.content, target: 'user' })}
      />

      {/* 项目记忆 */}
      <RuntimeGroupCard
        title={translate('memorySettings.targets.memoryLabel')}
        accent="#52c41a"
        entries={memoryEntries}
        usage={runtime ? runtime.targets.memory : { used: 0, limit: 10240 }}
        emptyText={translate('memorySettings.runtime.emptyMemory')}
        onRemove={(entry) => handleRemoveRuntime({ content: entry.content, target: 'memory' })}
      />
    </div>
  )

  const renderBodiesTab = (): React.ReactNode => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 创建空间 */}
      <div
        className="flex items-center gap-2 flex-wrap"
        style={{
          padding: '10px 12px',
          border: `1px solid ${t.cardBorder}`,
          borderRadius: 10,
          background: t.formBg
        }}
      >
        <Input
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          placeholder={translate('memorySettings.bodies.namePlaceholder')}
          style={{ width: 170 }}
        />
        <Input
          value={createDescription}
          onChange={(e) => setCreateDescription(e.target.value)}
          placeholder={translate('memorySettings.bodies.descriptionPlaceholder')}
          style={{ flex: 1, minWidth: 220 }}
          onPressEnter={handleCreateBody}
        />
        <Button
          type="primary"
          icon={<PlusOutlined />}
          loading={creatingBody}
          onClick={handleCreateBody}
        >
          {translate('memorySettings.bodies.create')}
        </Button>
      </div>

      {bodies.length === 0 ? (
        <Empty
          description={translate('memorySettings.bodies.empty')}
          style={{ padding: '32px 0' }}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {bodies.map((body) => (
            <div
              key={body.id}
              className="flex items-start gap-3 px-3.5 py-3"
              style={{
                border: `1px solid ${t.cardBorder}`,
                borderRadius: 10,
                background: t.cardBg
              }}
            >
              <div
                className="flex items-center justify-center shrink-0"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: body.active ? t.iconBg : t.trackBg
                }}
              >
                <DatabaseOutlined
                  style={{ fontSize: 17, color: body.active ? t.primary : t.textTertiary }}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span style={{ fontSize: 13.5, fontWeight: 600 }}>{body.name}</span>
                  {body.active ? (
                    <Tag color="green" style={{ marginRight: 0, fontSize: 11, lineHeight: '18px' }}>
                      {translate('memorySettings.bodies.active')}
                    </Tag>
                  ) : (
                    <Tag style={{ marginRight: 0, fontSize: 11, lineHeight: '18px' }}>
                      {translate('memorySettings.bodies.inactive')}
                    </Tag>
                  )}
                  {!body.healthy && (
                    <Tag color="red" style={{ marginRight: 0, fontSize: 11 }}>
                      {translate('memorySettings.bodies.unhealthy')}
                    </Tag>
                  )}
                </div>
                {body.description && (
                  <div
                    style={{
                      fontSize: 12,
                      color: t.textSecondary,
                      marginTop: 2,
                      lineHeight: '17px'
                    }}
                  >
                    {body.description}
                  </div>
                )}
                <div style={{ fontSize: 11, color: t.textTertiary, marginTop: 4 }}>
                  {translate('memorySettings.bodies.stats', {
                    insights: body.stats?.totalInsights ?? 0,
                    edges: body.stats?.edgeCount ?? 0,
                    deleted: body.stats?.deletedInsights ?? 0
                  })}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0" style={{ marginTop: 2 }}>
                <Button
                  type="text"
                  size="small"
                  disabled={!body.healthy}
                  onClick={() => handleBrowseBody({ id: body.id, name: body.name })}
                >
                  {translate('memorySettings.bodies.content')}
                </Button>
                <Tooltip
                  title={
                    body.active
                      ? translate('memorySettings.bodies.participatesInRecall')
                      : translate('memorySettings.bodies.excludedFromRecall')
                  }
                >
                  <Switch
                    checked={body.active}
                    size="small"
                    onChange={(checked) => handleToggleBody(body.id, checked)}
                  />
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 空间内容浏览 */}
      <Modal
        open={browsingBody !== null}
        title={translate('memorySettings.insights.title', { name: browsingBody?.name })}
        footer={null}
        onCancel={() => setBrowsingBody(null)}
        width={640}
      >
        {browsingLoading ? (
          <Empty description={translate('common.state.loading')} style={{ padding: '24px 0' }} />
        ) : bodyInsights.length === 0 ? (
          <Empty
            description={translate('memorySettings.insights.empty')}
            style={{ padding: '24px 0' }}
          />
        ) : (
          <div className="custom-scrollbar" style={{ maxHeight: 420, overflowY: 'auto' }}>
            {bodyInsights.map((item) => (
              <div
                key={item.id}
                className="px-3 py-2.5"
                style={{ borderBottom: `1px solid ${t.hairline}` }}
              >
                <div
                  style={{
                    fontSize: 13,
                    lineHeight: '20px',
                    wordBreak: 'break-all',
                    color: t.text
                  }}
                >
                  {item.content}
                </div>
                <div style={{ fontSize: 11, color: t.textTertiary, marginTop: 2 }}>
                  {translate('memorySettings.insights.meta', {
                    category: item.category ?? 'general',
                    importance: item.importance ?? 3,
                    date: item.createdAt?.slice(0, 10)
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  )

  const renderDocumentsTab = (): React.ReactNode => (
    <div>
      {!documents || documents.total === 0 ? (
        <Empty
          description={translate('memorySettings.documents.empty')}
          style={{ padding: '32px 0' }}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {documents.documents.map((doc) => (
            <div
              key={doc.id}
              className="flex items-start gap-3 px-3.5 py-3"
              style={{
                border: `1px solid ${t.cardBorder}`,
                borderRadius: 10,
                background: t.cardBg
              }}
            >
              <div
                className="flex items-center justify-center shrink-0"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: t.iconBg
                }}
              >
                <FileTextOutlined style={{ fontSize: 17, color: t.primary }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span style={{ fontSize: 13.5, fontWeight: 600 }}>{doc.title}</span>
                  {doc.status === 'active' ? (
                    <Tag color="blue" style={{ marginRight: 0, fontSize: 11, lineHeight: '18px' }}>
                      active
                    </Tag>
                  ) : (
                    <Tag style={{ marginRight: 0, fontSize: 11, lineHeight: '18px' }}>archived</Tag>
                  )}
                </div>
                {doc.excerpt && (
                  <div
                    style={{
                      fontSize: 12,
                      color: t.textSecondary,
                      marginTop: 2,
                      lineHeight: '17px'
                    }}
                  >
                    {doc.excerpt}
                  </div>
                )}
                <div style={{ fontSize: 11, color: t.textTertiary, marginTop: 4 }}>
                  {translate('memorySettings.documents.updatedAt', {
                    time: doc.updatedAt.slice(0, 16).replace('T', ' '),
                    revision: doc.revision
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <div>
      <SettingsPageHeader
        title={translate('memorySettings.page.title')}
        description={translate('memorySettings.page.description')}
      />

      {/* 目录选择 */}
      <SettingsSection
        title={translate('memorySettings.storage.sectionTitle')}
        icon={<FolderOutlined size={14} />}
        bodyPadding={16}
      >
        <div style={{ display: 'flex', gap: 8, maxWidth: 720, flexWrap: 'wrap' }}>
          <Input
            value={memoryPath}
            onChange={(e) => setMemoryPath(e.target.value)}
            placeholder={translate('memorySettings.storage.placeholder')}
            allowClear
            style={{ flex: 1, minWidth: 320 }}
          />
          <Button onClick={handleBrowsePath}>{translate('memorySettings.storage.browse')}</Button>
          <Button
            type="primary"
            loading={savingPath}
            disabled={memoryPath.trim() === (settings?.harness?.memoryPath ?? '')}
            onClick={handleSavePath}
          >
            {translate('common.action.save')}
          </Button>
        </div>
        {settings?.harness?.memoryPath && (
          <p
            style={{
              margin: '10px 0 0',
              fontSize: 12,
              opacity: 0.65,
              wordBreak: 'break-all'
            }}
          >
            {translate('memorySettings.storage.activePath', {
              path: settings.harness.memoryPath
            })}
          </p>
        )}
      </SettingsSection>

      {/* 未配置引导 / 三层记忆管理 */}
      {!configured ? (
        <SettingsSection
          title={translate('memorySettings.enable.sectionTitle')}
          icon={<DatabaseOutlined size={14} />}
          bodyPadding={24}
        >
          <Empty
            styles={{ image: { height: 56 } }}
            description={
              <span style={{ fontSize: 13 }}>
                {translate('memorySettings.enable.empty')}
                <br />
                {translate('memorySettings.enable.emptyHint')}
              </span>
            }
          />
        </SettingsSection>
      ) : (
        <SettingsSection
          title={translate('memorySettings.manage.sectionTitle')}
          icon={<DatabaseOutlined size={14} />}
          bodyPadding={12}
          extra={
            <>
              {/* 管的是**谁的**记忆：插件会话进来时写清插件名（工作区会话沿用既有样子，不标注） */}
              {memoryScopeName && (
                <span
                  data-memory-scope={memoryScopeName}
                  style={{ fontSize: 12, color: t.textSecondary, whiteSpace: 'nowrap' }}
                >
                  {translate('memorySettings.manage.scopePlugin', { name: memoryScopeName })}
                </span>
              )}
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                loading={loadingSnapshot}
                onClick={() => loadSnapshot()}
              />
            </>
          }
        >
          {loadingSnapshot && !snapshot ? (
            <Empty description={translate('common.state.loading')} style={{ padding: '24px 0' }} />
          ) : (
            <Tabs
              size="small"
              items={[
                {
                  key: 'runtime',
                  label: translate('memorySettings.tabs.runtime', {
                    count: userEntries.length + memoryEntries.length
                  }),
                  children: renderRuntimeTab()
                },
                {
                  key: 'bodies',
                  label: translate('memorySettings.tabs.bodies', { count: bodies.length }),
                  children: renderBodiesTab()
                },
                {
                  key: 'documents',
                  label: translate('memorySettings.tabs.documents', {
                    count: documents?.total ?? 0
                  }),
                  children: renderDocumentsTab()
                }
              ]}
            />
          )}
        </SettingsSection>
      )}

      {/* 机制说明 */}
      <SettingsSection title={translate('memorySettings.mechanism.sectionTitle')} bodyPadding={16}>
        <SettingRow
          title={translate('memorySettings.mechanism.runtimeTitle')}
          description={translate('memorySettings.mechanism.runtimeDesc')}
          control={<span />}
        />
        <SettingRow
          title={translate('memorySettings.mechanism.bodiesTitle')}
          description={translate('memorySettings.mechanism.bodiesDesc')}
          control={<span />}
        />
        <SettingRow
          title={translate('memorySettings.mechanism.documentsTitle')}
          description={translate('memorySettings.mechanism.documentsDesc')}
          control={<span />}
        />
      </SettingsSection>
    </div>
  )
}

export default MemorySettings
