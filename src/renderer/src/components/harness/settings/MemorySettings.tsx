import React, { useState, useEffect, useCallback } from 'react'
import { Button, Input, Tabs, Switch, Empty, Popconfirm, Modal, Tooltip, theme } from 'antd'
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
  SettingsSection
} from '@renderer/components/system/settings/SettingsUI'
import EntityCard, { EntityChip } from '@renderer/components/system/EntityCard'
import { harnessApi } from '../../../api/harness'
import { useMemoryScope, useMemoryScopeName } from '../../../utils/harness/memory-scope'

/**
 * Mnemon memory management (three layers)
 * - Hot memory: USER user profile / MEMORY project memory (injected into the prompt every turn,
 *   capacity 4KiB / 10KiB)
 * - Long-term spaces: Memory Spaces (PGlite database + relationship graph, recalled on demand)
 * - Archive: Project Documents (full Markdown, active/archived hot/cold tiers)
 *
 * **Follows the current conversation's scope**: entering from a plugin conversation manages that
 * plugin's own memory (`<memoryPath>/plugin-<id>/`), while from a work conversation it is the
 * current workspace's set (renderer/memory-scope.ts).
 */

type MnemonSnapshot = Awaited<ReturnType<typeof harnessApi.harness.mnemonSnapshot>>

/** Priority dot colors (editorial style: restrained color use) */
const IMPORTANCE_DOT: Record<string, string> = {
  critical: '#d4380d',
  normal: '#1677ff',
  low: '#bfbfbf'
}

/** Importance label: takes t as a parameter, so no hook is called inside a plain function */
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

/** Target selection card (selected: accent left bar + light background + accent outline) */
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

/** Importance pill (selected: accent outline + light background) */
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

/** Theme tokens (adapt to dark / light) */
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

/** Thin capacity bar: 4px rounded bar + text */
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

/** Single hot-memory entry: dot + content + time + delete (shown on hover) */
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

/** Group card: color-bar title + capacity + entry list */
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
  /** Memory scope of the current conversation (plugin conversation = that plugin's own memory;
   * chat mode = that mode's own set; empty = current workspace) */
  const memoryScope = useMemoryScope()
  /** Show the plugin name for a plugin scope, or the mode name for "chat" mode, so the page can
   * label "whose memory is being managed now" */
  const memoryScopeName = useMemoryScopeName(translate('memorySettings.manage.scopeChat'))

  // Hot-memory add form
  const [addTarget, setAddTarget] = useState<'user' | 'memory'>('memory')
  const [addContent, setAddContent] = useState('')
  const [addImportance, setAddImportance] = useState<'critical' | 'normal' | 'low'>('normal')
  const [adding, setAdding] = useState(false)

  // Space create form
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [creatingBody, setCreatingBody] = useState(false)

  // Space content browsing
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

  // Reload the snapshot after switching scope (changing conversation / workspace): that is
  // another memory set, so old data must be invalidated
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

  /** Add a hot memory */
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

  /** Remove a hot memory (located by unique substring) */
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

  /** Space activation toggle */
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

  /** Create a space */
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

  /** Browse space content */
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
      {/* Add memory */}
      <div
        style={{
          padding: '14px',
          border: `1px solid ${t.cardBorder}`,
          borderRadius: 10,
          background: t.formBg
        }}
      >
        {/* Target selection card */}
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

        {/* Content input (underline style) */}
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

        {/* Importance + remember */}
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

        {/* Target description (switches with the selection) */}
        <div style={{ fontSize: 11, color: t.textTertiary, marginTop: 10, lineHeight: '16px' }}>
          {addTarget === 'user' ? (
            <>{translate('memorySettings.targets.userHint')}</>
          ) : (
            <>{translate('memorySettings.targets.memoryHint')}</>
          )}
        </div>
      </div>

      {/* User profile */}
      <RuntimeGroupCard
        title={translate('memorySettings.targets.userLabel')}
        accent="#1677ff"
        entries={userEntries}
        usage={runtime ? runtime.targets.user : { used: 0, limit: 4096 }}
        emptyText={translate('memorySettings.runtime.emptyUser')}
        onRemove={(entry) => handleRemoveRuntime({ content: entry.content, target: 'user' })}
      />

      {/* Project memory */}
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
      {/* Create space */}
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
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))',
              gap: 14
            }}
          >
            {bodies.map((body) => (
              <EntityCard
                key={body.id}
                id={`body-${body.id}`}
                icon={<DatabaseOutlined />}
                title={body.name}
                meta={
                  <>
                    <EntityChip>
                      {body.active
                        ? translate('memorySettings.bodies.active')
                        : translate('memorySettings.bodies.inactive')}
                    </EntityChip>
                    {!body.healthy && (
                      <EntityChip>{translate('memorySettings.bodies.unhealthy')}</EntityChip>
                    )}
                    <EntityChip>
                      {translate('memorySettings.bodies.stats', {
                        insights: body.stats?.totalInsights ?? 0,
                        edges: body.stats?.edgeCount ?? 0,
                        deleted: body.stats?.deletedInsights ?? 0
                      })}
                    </EntityChip>
                  </>
                }
                description={body.description || undefined}
                footerStart={
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
                }
                footerEnd={
                  <Button
                    type="text"
                    size="small"
                    style={{ marginLeft: 'auto' }}
                    disabled={!body.healthy}
                    onClick={() => handleBrowseBody({ id: body.id, name: body.name })}
                  >
                    {translate('memorySettings.bodies.content')}
                  </Button>
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* Space content browsing */}
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
          <div
            className="custom-scrollbar app-modal-scroll"
            style={{ maxHeight: 420, overflowY: 'auto' }}
          >
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
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))',
              gap: 14
            }}
          >
            {documents.documents.map((doc) => (
              <EntityCard
                key={doc.id}
                id={`doc-${doc.id}`}
                icon={<FileTextOutlined />}
                title={doc.title}
                meta={<EntityChip>{doc.status === 'active' ? 'active' : 'archived'}</EntityChip>}
                description={doc.excerpt || undefined}
              >
                <div style={{ marginTop: 10, fontSize: 11, color: t.textTertiary }}>
                  {translate('memorySettings.documents.updatedAt', {
                    time: doc.updatedAt.slice(0, 16).replace('T', ' '),
                    revision: doc.revision
                  })}
                </div>
              </EntityCard>
            ))}
          </div>
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

      {/* Directory selection */}
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

      {/* Not configured guidance / three-layer memory management */}
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
              {/* **Whose** memory is managed: show the plugin name when entering from a plugin
                  conversation (workspace conversations keep the existing look, no label) */}
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
    </div>
  )
}

export default MemorySettings
