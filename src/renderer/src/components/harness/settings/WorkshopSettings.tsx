import React, { useCallback, useEffect, useState } from 'react'
import { App, Button, Checkbox, Drawer, Dropdown, Empty, Input, Tag, theme } from 'antd'
import type { MenuProps } from 'antd'
import {
  RiAddLine,
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiDownload2Line,
  RiErrorWarningLine,
  RiFileList3Line,
  RiFolderOpenLine,
  RiHammerLine,
  RiMore2Line,
  RiPlugLine,
  RiQuestionLine,
  RiRefreshLine,
  RiShieldCheckLine,
  RiUploadCloud2Line
} from '@remixicon/react'
import { SkeletonSettingRows } from '@renderer/components/system/Skeleton'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import {
  SettingsPageHeader,
  SettingsSection,
  SettingRow
} from '@renderer/components/system/settings/SettingsUI'
import { harnessApi } from '../../../api/harness'
import NewDraftModal from '../workshop/NewDraftModal'
import { useDraftActions } from '../workshop/useDraftActions'
import type {
  WorkshopCheck,
  WorkshopDraftDetail,
  WorkshopDraftSummary,
  WorkshopReport
} from '../../../../../shared/harness/workshop'

/**
 * Settings -> Plugin Workshop.
 *
 * This page is the dashboard for **building plugins through conversation**: draft list + build /
 * verify / install + per-check verification report.
 * UI choices:
 * - The row's title is the draft's own name (not the generic word "plugin"); the second line is
 *   the status summary;
 * - One entry point per function: every action folds into the "..." menu at the end of the row
 *   (build / verify / install / disable / uninstall / export / delete), no column of text buttons;
 * - **Uninstall** and **delete draft** are two different things and are separated in the menu;
 *   uninstall goes through the host's uninstall channel (the host shows a confirmation that
 *   separates code and data), while deleting a draft removes only the sources in the workshop;
 * - The report lists every check item, and failed items come with suggestions - the user can
 *   hand that text back to the assistant as is.
 */
interface WorkshopSettingsProps {
  /**
   * Used when embedded in a modal (plugin repository -> "Plugin Workshop" modal):
   * the title comes from the modal header, so the page no longer renders SettingsPageHeader
   * and keeps only the refresh action on the right.
   */
  embedded?: boolean
}

const WorkshopSettings: React.FC<WorkshopSettingsProps> = ({ embedded = false }) => {
  const { token } = theme.useToken()
  const { modal, message } = App.useApp()
  const { viewMessage } = useMessage()
  const { t } = useTranslation()

  const [drafts, setDrafts] = useState<WorkshopDraftSummary[]>([])
  const [pluginsPath, setPluginsPath] = useState('')
  const [pickingRoot, setPickingRoot] = useState(false)
  const [ready, setReady] = useState(true)
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<WorkshopDraftDetail | null>(null)
  const [report, setReport] = useState<WorkshopReport | null>(null)
  const [previewFile, setPreviewFile] = useState<{ path: string; content: string } | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const state = await harnessApi.workshop.state()
      setReady(state.ready)
      setPluginsPath(state.pluginsPath ?? '')
      setDrafts(await harnessApi.workshop.list())
    } catch (error) {
      viewMessage(
        'workshop-load',
        'error',
        t('common.message.loadFailedWithReason', { reason: String(error) })
      )
    } finally {
      setLoading(false)
    }
  }, [t, viewMessage])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // An open workshop page = the current content is on the plugin side: the sidebar's mode switch
  // must follow to "plugin" (see the WORKSHOP_FOCUS_EVENT notes in HarnessSidebar)
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('harness-workshop-focus'))
  }, [])

  // The assistant changed a draft / published a plugin in the conversation: this page must follow
  // (main-process broadcast)
  useEffect(() => harnessApi.workshop.onChanged(() => void refresh()), [refresh])

  /** Open a draft's detail drawer (including its latest verification report) */
  const openDetail = useCallback(
    async (id: string): Promise<void> => {
      try {
        setPreviewFile(null)
        setDetail(await harnessApi.workshop.detail(id))
        setReport(await harnessApi.workshop.report(id))
      } catch (error) {
        viewMessage('workshop-detail', 'error', String(error))
      }
    },
    [viewMessage]
  )

  // Clicking a row in sidebar "plugin mode": open the settings modal and expand that draft's detail
  useEffect(() => {
    const handler = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (typeof id === 'string' && id) void openDetail(id)
    }
    window.addEventListener('workshop-open-draft', handler)
    return () => window.removeEventListener('workshop-open-draft', handler)
  }, [openDetail])

  /**
   * Build / verify / install go through the shared hook (the sidebar plugin row uses the same one,
   * so behavior cannot diverge); `run` stays here for disable / export / delete / uninstall reuse
   * (same busy state and failure hints).
   */
  const {
    busyIds,
    run: runAction,
    build: handleBuild,
    verify: handleVerify,
    publish
  } = useDraftActions({
    onChanged: async (id) => {
      await refresh()
      if (detail?.id === id) await openDetail(id)
    }
  })

  const handlePublish = (id: string): Promise<boolean> =>
    publish(id, () => {
      void message.success(t('workshopSettings.publish.done'))
    })

  const handleDisable = (id: string): Promise<boolean> =>
    runAction(id, () => harnessApi.workshop.disable(id))

  const handleExport = (id: string): Promise<boolean> =>
    runAction(
      id,
      () => harnessApi.workshop.exportZip(id),
      (result) => {
        if (result) {
          viewMessage(
            'workshop-export',
            'success',
            t('workshopSettings.export.done', { file: result.file }),
            6
          )
        }
      }
    )

  /** Uninstall: code and data separately (the checkbox decides whether to delete data too) -
   * goes through the host's uninstall channel */
  const handleUninstall = (draft: WorkshopDraftSummary): void => {
    let purgeData = false
    modal.confirm({
      title: t('workshopSettings.uninstall.title', { name: draft.title }),
      content: (
        <div>
          <p style={{ marginTop: 0 }}>{t('workshopSettings.uninstall.body')}</p>
          <Checkbox onChange={(event) => (purgeData = event.target.checked)}>
            {t('workshopSettings.uninstall.purge')}
          </Checkbox>
        </div>
      ),
      okText: t('common.action.confirm'),
      cancelText: t('common.action.cancel'),
      onOk: async () => {
        try {
          await window.api.plugin.uninstall(draft.id, purgeData)
          await refresh()
          if (detail?.id === draft.id) await openDetail(draft.id)
        } catch (error) {
          viewMessage(`workshop-uninstall-${draft.id}`, 'error', String(error))
        }
      }
    })
  }

  /** Delete a draft (only the workshop sources and artifacts; plugins already installed in the
   * app are unaffected) */
  const handleRemoveDraft = (draft: WorkshopDraftSummary): void => {
    modal.confirm({
      title: t('workshopSettings.remove.title', { name: draft.title }),
      content: t('workshopSettings.remove.body'),
      okText: t('common.action.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common.action.cancel'),
      onOk: async () => {
        const removed = await runAction(draft.id, () => harnessApi.workshop.remove(draft.id))
        // Collapse the drawer only when the deletion really happened: on failure keep "still there"
        // visible so nobody thinks it succeeded
        if (removed) setDetail(null)
      }
    })
  }

  /** Creation done: refresh the list and expand its detail right away (so build / verify /
   * install can follow) */
  const handleCreated = async (createdId: string): Promise<void> => {
    await refresh()
    await openDetail(createdId)
  }

  /**
   * Configure the **plugin storage path** (the source root for all plugins; preset from the
   * install directory on first launch).
   *
   * Existing old drafts are moved over for you (done by the main process); canceling is not a
   * failure and shows no hint.
   */
  const handlePickRoot = async (): Promise<void> => {
    setPickingRoot(true)
    try {
      const result = await harnessApi.workshop.pickRoot()
      if (!result.ok) {
        viewMessage('workshop-root', 'error', result.error ?? '', 6)
        return
      }
      const data = result.data
      if (!data || data.canceled) return
      setPluginsPath(data.dir ?? '')
      await refresh()
      if (detail) await openDetail(detail.id)
      viewMessage(
        'workshop-root',
        'success',
        data.moved && data.moved.length > 0
          ? t('workshopSettings.root.moved', { count: data.moved.length })
          : t('workshopSettings.root.saved', { path: data.dir ?? '' }),
        5
      )
    } catch (error) {
      viewMessage('workshop-root', 'error', String(error))
    } finally {
      setPickingRoot(false)
    }
  }

  /** The row's description line: id · template · version · file count (the draft's own id, not
   * the generic word "plugin") */
  const statusText = (draft: WorkshopDraftSummary): string =>
    [
      draft.id,
      draft.template,
      `v${draft.version}`,
      t('workshopSettings.files', { count: draft.fileCount })
    ].join(' · ')

  const menuFor = (draft: WorkshopDraftSummary): MenuProps['items'] => [
    {
      key: 'build',
      icon: <RiHammerLine size={14} />,
      label: t('workshopSettings.action.build')
    },
    {
      key: 'verify',
      icon: <RiShieldCheckLine size={14} />,
      label: t('workshopSettings.action.verify')
    },
    { type: 'divider' },
    {
      key: 'publish',
      icon: <RiUploadCloud2Line size={14} />,
      label: draft.installed
        ? t('workshopSettings.action.update')
        : t('workshopSettings.action.publish')
    },
    ...(draft.installed && draft.enabled
      ? [
          {
            key: 'disable',
            icon: <RiPlugLine size={14} />,
            label: t('workshopSettings.action.disable')
          }
        ]
      : []),
    {
      key: 'export',
      icon: <RiDownload2Line size={14} />,
      label: t('workshopSettings.action.export')
    },
    { type: 'divider' as const },
    ...(draft.installed
      ? [{ key: 'uninstall', danger: true, label: t('workshopSettings.action.uninstall') }]
      : []),
    { key: 'remove', danger: true, label: t('workshopSettings.action.remove') }
  ]

  const onMenuClick = (draft: WorkshopDraftSummary, key: string): void => {
    switch (key) {
      case 'build':
        void handleBuild(draft.id)
        break
      case 'verify':
        void handleVerify(draft.id)
        break
      case 'publish':
        void handlePublish(draft.id)
        break
      case 'disable':
        void handleDisable(draft.id)
        break
      case 'export':
        void handleExport(draft.id)
        break
      case 'uninstall':
        handleUninstall(draft)
        break
      case 'remove':
        handleRemoveDraft(draft)
        break
      default:
        break
    }
  }

  const checkIcon = useCallback(
    (check: WorkshopCheck): React.ReactNode => {
      if (check.status === 'pass')
        return <RiCheckboxCircleLine size={14} color={token.colorSuccess} />
      if (check.status === 'fail') return <RiCloseCircleLine size={14} color={token.colorError} />
      if (check.status === 'warn')
        return <RiErrorWarningLine size={14} color={token.colorWarning} />
      return <RiQuestionLine size={14} color={token.colorTextTertiary} />
    },
    [token]
  )

  const draftCount = drafts.length

  return (
    <div>
      {embedded ? (
        /* Embedded in a modal: the title lives in the modal header, so only the refresh action
           stays here (otherwise it fights the close button in the modal's top-right) */
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <Button size="small" icon={<RiRefreshLine size={14} />} onClick={() => void refresh()}>
            {t('common.action.refresh')}
          </Button>
        </div>
      ) : (
        <SettingsPageHeader
          title={t('workshopSettings.pageTitle')}
          description={t('workshopSettings.pageDescription')}
          extra={
            <Button size="small" icon={<RiRefreshLine size={14} />} onClick={() => void refresh()}>
              {t('common.action.refresh')}
            </Button>
          }
        />
      )}

      {!ready && (
        <div style={{ marginBottom: 16, fontSize: 13, color: token.colorError }}>
          {t('workshopSettings.notReady')}
        </div>
      )}

      {/* Plugin storage path: the source root for all plugins. Preset from the install directory
          on first launch; the user can change it (changing it migrates data) */}
      <SettingsSection
        title={t('workshopSettings.root.title')}
        icon={<RiFolderOpenLine size={14} />}
      >
        <SettingRow
          title={pluginsPath || t('workshopSettings.root.rowEmpty')}
          /* The description is a single sentence shared by both states: when unconfigured, no
             persuasive paragraph (user wording 2026-09-27) */
          description={t('workshopSettings.root.rowDesc')}
          control={
            <Button size="small" loading={pickingRoot} onClick={() => void handlePickRoot()}>
              {pluginsPath ? t('workshopSettings.root.change') : t('workshopSettings.root.pick')}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection
        title={t('workshopSettings.list.title')}
        icon={<RiFileList3Line size={14} />}
        /* The workshop's own internal directory is deliberately **not** shown here (userData/...,
           per the user: do not display this directory on the settings page); what is shown is the
           user-configured plugin storage path, see the row above */
        extra={
          /* With no storage path configured, creation cannot be clicked (the configuration entry
             is in the empty state below; the modal deliberately has no picker) */
          <Button
            size="small"
            icon={<RiAddLine size={14} />}
            disabled={!pluginsPath}
            title={pluginsPath ? undefined : t('workshopSettings.list.needRoot')}
            onClick={() => setCreating(true)}
          >
            {t('workshopSettings.list.new')}
          </Button>
        }
      >
        {loading ? (
          <div style={{ padding: '4px 0' }}>
            <SkeletonSettingRows rows={3} />
          </div>
        ) : draftCount === 0 ? (
          /* The two empty states differ by one sentence only (no path / path set but no plugins
             yet); same style as the sidebar empty state: one centered gray line, no explanatory
             paragraph, and no extra "Choose folder" entry - the only way to configure the path is
             the button in the row above (one entry point per function) */
          <div style={{ padding: '28px 0', textAlign: 'center' }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span style={{ fontSize: 13, color: token.colorTextSecondary }}>
                  {pluginsPath
                    ? t('workshopSettings.list.empty')
                    : t('workshopSettings.list.needRoot')}
                </span>
              }
            />
          </div>
        ) : (
          drafts.map((draft) => {
            const flags: React.ReactNode[] = []
            if (draft.installed) {
              flags.push(
                <Tag key="installed" color={draft.enabled ? 'green' : 'default'} bordered={false}>
                  {draft.enabled
                    ? t('workshopSettings.state.enabled')
                    : t('workshopSettings.state.disabled')}
                </Tag>
              )
            }
            if (draft.lastReport) {
              flags.push(
                <Tag key="report" color={draft.lastReport.ok ? 'blue' : 'red'} bordered={false}>
                  {draft.lastReport.ok
                    ? t('workshopSettings.state.verified')
                    : t('workshopSettings.state.verifyFailed', {
                        failed: draft.lastReport.failed,
                        total: draft.lastReport.total
                      })}
                </Tag>
              )
            } else if (draft.built) {
              flags.push(
                <Tag key="built" bordered={false}>
                  {t('workshopSettings.state.built')}
                </Tag>
              )
            }
            return (
              <SettingRow
                key={draft.id}
                title={draft.title}
                description={statusText(draft)}
                control={
                  <div className="flex items-center" style={{ gap: 8 }}>
                    <Button
                      size="small"
                      type="text"
                      onClick={() => void openDetail(draft.id)}
                      style={{ fontSize: 12, color: token.colorTextSecondary }}
                    >
                      {t('workshopSettings.action.detail')}
                    </Button>
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: menuFor(draft),
                        onClick: ({ key }) => onMenuClick(draft, key)
                      }}
                    >
                      <Button
                        size="small"
                        type="text"
                        loading={busyIds.has(draft.id)}
                        aria-label={t('workshopSettings.action.menu')}
                        icon={<RiMore2Line size={16} />}
                      />
                    </Dropdown>
                  </div>
                }
              >
                {flags.length > 0 && (
                  <span className="flex items-center" style={{ gap: 6, marginTop: 5 }}>
                    {flags}
                  </span>
                )}
              </SettingRow>
            )
          })
        )}
      </SettingsSection>

      {/* ── Draft detail drawer: files + verification report ── */}
      <Drawer
        open={detail !== null}
        onClose={() => setDetail(null)}
        width={640}
        title={detail?.title}
        extra={
          detail && (
            <div className="flex items-center" style={{ gap: 8 }}>
              <Button
                size="small"
                icon={<RiHammerLine size={14} />}
                loading={busyIds.has(detail.id)}
                onClick={() => void handleBuild(detail.id)}
              >
                {t('workshopSettings.action.build')}
              </Button>
              <Button
                size="small"
                icon={<RiShieldCheckLine size={14} />}
                loading={busyIds.has(detail.id)}
                onClick={() => void handleVerify(detail.id)}
              >
                {t('workshopSettings.action.verify')}
              </Button>
              <Button
                size="small"
                type="primary"
                icon={<RiUploadCloud2Line size={14} />}
                loading={busyIds.has(detail.id)}
                onClick={() => void handlePublish(detail.id)}
              >
                {t('workshopSettings.action.publish')}
              </Button>
              <Button
                size="small"
                type="text"
                aria-label={t('workshopSettings.action.openDir')}
                icon={<RiFolderOpenLine size={14} />}
                onClick={async () => {
                  const result = await harnessApi.workshop.openDir(detail.id)
                  if (!result.ok) viewMessage('workshop-open', 'error', result.error ?? '')
                }}
              />
            </div>
          )
        }
      >
        {detail && (
          <div className="flex flex-col" style={{ gap: 16 }}>
            {/* Source location (the subdirectory under "plugin storage path"; the path itself is
                configured in the section above) */}
            <div
              style={{
                fontSize: 12,
                color: token.colorTextTertiary,
                wordBreak: 'break-all'
              }}
            >
              {detail.dir}
            </div>

            {/* Verification report: per-check conclusions (failed items carry suggestions that
                can be handed back to the assistant as is) */}
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                {t('workshopSettings.report.title')}
                {report && (
                  <span style={{ marginLeft: 8, fontWeight: 400, color: token.colorTextTertiary }}>
                    {new Date(report.at).toLocaleString()}
                  </span>
                )}
              </div>
              {!report ? (
                <div style={{ fontSize: 12, color: token.colorTextTertiary }}>
                  {t('workshopSettings.report.empty')}
                </div>
              ) : (
                <div className="flex flex-col" style={{ gap: 8 }}>
                  {report.checks.map((check) => (
                    <div key={check.id} className="flex" style={{ gap: 8 }}>
                      <span style={{ marginTop: 2, flexShrink: 0 }}>{checkIcon(check)}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12.5 }}>
                          <span style={{ fontFamily: 'monospace', opacity: 0.7 }}>{check.id}</span>
                          <span style={{ marginLeft: 6 }}>{check.title}</span>
                        </div>
                        {check.detail && (
                          <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
                            {check.detail}
                          </div>
                        )}
                        {check.hint && check.status !== 'pass' && (
                          <div style={{ fontSize: 12, color: token.colorWarning }}>
                            {t('workshopSettings.report.hint')}
                            {check.hint}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Files: click to preview read-only (no editor here - editing code is the
                assistant's job) */}
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                {t('workshopSettings.filesSection', { count: detail.files.length })}
              </div>
              <div className="flex flex-col">
                {detail.files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    onClick={async () => {
                      try {
                        const content = await harnessApi.workshop.readFile(detail.id, file.path)
                        setPreviewFile({ path: file.path, content })
                      } catch (error) {
                        viewMessage('workshop-file', 'error', String(error))
                      }
                    }}
                    className="flex items-center justify-between"
                    style={{
                      gap: 12,
                      padding: '6px 0',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      borderBottom: `1px solid ${token.colorBorderSecondary}`,
                      color: token.colorText
                    }}
                  >
                    <span style={{ fontFamily: 'monospace', fontSize: 12.5 }}>{file.path}</span>
                    <span style={{ fontSize: 11, color: token.colorTextTertiary }}>
                      {file.size}B
                    </span>
                  </button>
                ))}
              </div>
              {previewFile && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, marginBottom: 6, fontFamily: 'monospace' }}>
                    {previewFile.path}
                  </div>
                  <Input.TextArea
                    value={previewFile.content}
                    readOnly
                    autoSize={{ minRows: 6, maxRows: 18 }}
                    style={{ fontFamily: 'monospace', fontSize: 12 }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </Drawer>

      {/*
        ── New draft ──
        Only asks for id and display name: **the user no longer picks a template**
        (user wording 2026-09-27: "the default is everything") - the generated skeleton already
        includes pages / settings page / AI tools / event push / uninstall data cleanup, and the
        assistant can delete whatever it does not need.
      */}
      {/* New draft: shares the same modal component as the sidebar's + (asks only for id and
          display name; template is fixed to full) */}
      <NewDraftModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => void handleCreated(id)}
      />
    </div>
  )
}

export default WorkshopSettings
