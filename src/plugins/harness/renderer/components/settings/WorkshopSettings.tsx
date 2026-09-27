import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App,
  Button,
  Checkbox,
  Drawer,
  Dropdown,
  Empty,
  Input,
  Modal,
  Select,
  Tag,
  theme
} from 'antd'
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
import { harnessApi } from '../../api'
import type {
  WorkshopCheck,
  WorkshopDraftDetail,
  WorkshopDraftSummary,
  WorkshopReport
} from '../../../shared/workshop'

/**
 * 设置 → 插件工坊。
 *
 * 这一页是**对话式做插件**的仪表盘：草稿列表 + 构建/验收/安装 + 逐项验收报告。
 * 界面上的取舍（沿用本仓库既有口径）：
 * - 行的主标题用草稿自己的名字（不是笼统的「插件」二字），第二行才是状态摘要；
 * - 一次功能只给一个入口：所有动作收进行尾的「⋯」菜单（构建 / 验收 / 安装 / 停用 / 卸载 /
 *   导出 / 删除），不摆一列文字按钮；
 * - **卸载**与**删除草稿**是两件事，菜单里分开；卸载走宿主的卸载通道（宿主会弹
 *   「代码 / 数据分开」的确认框），删除草稿只删工坊里的源码；
 * - 报告按「检查项」逐条列，失败项直接给出建议——用户能把这段话原样丢回给助手。
 */
const WorkshopSettings: React.FC = () => {
  const { token } = theme.useToken()
  const { modal, message } = App.useApp()
  const { viewMessage } = useMessage()
  const { t } = useTranslation()

  const [drafts, setDrafts] = useState<WorkshopDraftSummary[]>([])
  const [root, setRoot] = useState('')
  const [ready, setReady] = useState(true)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string>('')
  const [detail, setDetail] = useState<WorkshopDraftDetail | null>(null)
  const [report, setReport] = useState<WorkshopReport | null>(null)
  const [previewFile, setPreviewFile] = useState<{ path: string; content: string } | null>(null)
  const [toolsEnabled, setToolsEnabled] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newId, setNewId] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newTemplate, setNewTemplate] = useState('page')

  /** 工坊的 4 个工具是否已在「设置 → 智能体 → 工具」里勾上 */
  const checkTools = useCallback(async (): Promise<void> => {
    try {
      const config = await harnessApi.mainAgent.get()
      const names = ['plugin_draft', 'plugin_build', 'plugin_verify', 'plugin_publish']
      setToolsEnabled(names.every((name) => (config.tools ?? []).includes(name)))
    } catch {
      setToolsEnabled(true)
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const state = await harnessApi.workshop.state()
      setReady(state.ready)
      setRoot(state.root)
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
    void checkTools()
  }, [refresh, checkTools])

  // 助手在对话里改了草稿/发布了插件时，这一页要跟着变（主进程广播）
  useEffect(() => harnessApi.workshop.onChanged(() => void refresh()), [refresh])

  /** 打开某草稿的详情抽屉（含最近一次验收报告） */
  const openDetail = async (id: string): Promise<void> => {
    try {
      setPreviewFile(null)
      setDetail(await harnessApi.workshop.detail(id))
      setReport(await harnessApi.workshop.report(id))
    } catch (error) {
      viewMessage('workshop-detail', 'error', String(error))
    }
  }

  /**
   * 统一执行一次工坊动作：置忙 → 调主进程 → 失败提示原文 → 成功后刷新列表与抽屉。
   *
   * `onSuccess` 拿到的是动作的真实返回值（构建诊断 / 验收报告），用于给更强的反馈
   * （例如验收未通过时把失败项数报出来）——刻意**不重复调用**接口：
   * 构建/验收都是重活，调两次等于干两遍。
   */
  const runAction = async <T,>(
    id: string,
    run: () => Promise<{ ok: boolean; error?: string; data?: T }>,
    onSuccess?: (data: T | undefined) => void
  ): Promise<void> => {
    setBusyId(id)
    try {
      const result = await run()
      if (!result.ok) {
        viewMessage(
          `workshop-${id}`,
          'error',
          result.error ?? t('workshopSettings.actionFailed'),
          6
        )
        return
      }
      onSuccess?.(result.data)
      await refresh()
      if (detail?.id === id) await openDetail(id)
    } catch (error) {
      viewMessage(`workshop-${id}`, 'error', String(error))
    } finally {
      setBusyId('')
    }
  }

  const handleBuild = (id: string): Promise<void> =>
    runAction(
      id,
      () => harnessApi.workshop.build(id),
      (info) => {
        if (info && !info.ok) {
          viewMessage(`workshop-build-${id}`, 'error', info.errors.join('；'), 6)
        } else if (info) {
          viewMessage(
            `workshop-build-${id}`,
            'success',
            t('workshopSettings.build.ok', { count: info.files.length }),
            3
          )
        }
      }
    )

  const handleVerify = (id: string): Promise<void> =>
    runAction(
      id,
      () => harnessApi.workshop.verify(id, true),
      (report) => {
        if (!report) return
        const failed = report.checks.filter((c) => c.status === 'fail').length
        viewMessage(
          `workshop-verify-${id}`,
          report.ok ? 'success' : 'error',
          report.ok
            ? t('workshopSettings.verify.passed', { count: report.checks.length })
            : t('workshopSettings.verify.failed', { count: failed }),
          4
        )
      }
    )

  const handlePublish = (id: string): Promise<void> =>
    runAction(
      id,
      () => harnessApi.workshop.publish(id),
      () => {
        void message.success(t('workshopSettings.publish.done'))
      }
    )

  const handleDisable = (id: string): Promise<void> =>
    runAction(id, () => harnessApi.workshop.disable(id))

  const handleExport = (id: string): Promise<void> =>
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

  /** 卸载：代码与数据分开（勾选项决定要不要连数据一起删）——走宿主的卸载通道 */
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

  /** 删除草稿（只删工坊里的源码与产物，不影响已装进应用的插件） */
  const handleRemoveDraft = (draft: WorkshopDraftSummary): void => {
    modal.confirm({
      title: t('workshopSettings.remove.title', { name: draft.title }),
      content: t('workshopSettings.remove.body'),
      okText: t('common.action.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common.action.cancel'),
      onOk: async () => {
        await runAction(draft.id, () => harnessApi.workshop.remove(draft.id))
        setDetail(null)
      }
    })
  }

  const handleCreate = async (): Promise<void> => {
    const id = newId.trim()
    if (!id) return
    const result = await harnessApi.workshop.create({
      id,
      title: newTitle.trim() || undefined,
      template: newTemplate
    })
    if (!result.ok) {
      viewMessage('workshop-create', 'error', result.error ?? '')
      return
    }
    setCreating(false)
    setNewId('')
    setNewTitle('')
    await refresh()
    if (result.data?.id) await openDetail(result.data.id)
  }

  /** 行的说明行：id · 模板 · 版本 · 文件数（用草稿自己的 id，不写笼统的「插件」） */
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
  const templates = useMemo(
    () => [
      { value: 'page', label: t('workshopSettings.template.page') },
      { value: 'panel', label: t('workshopSettings.template.panel') },
      { value: 'tool', label: t('workshopSettings.template.tool') },
      { value: 'minimal', label: t('workshopSettings.template.minimal') }
    ],
    [t]
  )

  return (
    <div>
      <SettingsPageHeader
        title={t('workshopSettings.pageTitle')}
        description={t('workshopSettings.pageDescription')}
        extra={
          <Button size="small" icon={<RiRefreshLine size={14} />} onClick={() => void refresh()}>
            {t('common.action.refresh')}
          </Button>
        }
      />

      {!ready && (
        <div style={{ marginBottom: 16, fontSize: 13, color: token.colorError }}>
          {t('workshopSettings.notReady')}
        </div>
      )}

      {!toolsEnabled && (
        <SettingsSection
          title={t('workshopSettings.tools.title')}
          icon={<RiPlugLine size={14} />}
          description={t('workshopSettings.tools.description')}
        >
          <SettingRow
            title={t('workshopSettings.tools.row')}
            description={t('workshopSettings.tools.hint')}
            control={
              <Button
                type="primary"
                size="small"
                onClick={async () => {
                  const result = await harnessApi.workshop.enableTools()
                  if (!result.ok) {
                    viewMessage('workshop-tools', 'error', result.error ?? '')
                    return
                  }
                  setToolsEnabled(true)
                  void message.success(t('workshopSettings.tools.done'))
                }}
              >
                {t('workshopSettings.tools.enable')}
              </Button>
            }
          />
        </SettingsSection>
      )}

      <SettingsSection
        title={t('workshopSettings.list.title')}
        icon={<RiFileList3Line size={14} />}
        description={root ? t('workshopSettings.list.root', { path: root }) : undefined}
        extra={
          <Button size="small" icon={<RiAddLine size={14} />} onClick={() => setCreating(true)}>
            {t('workshopSettings.list.new')}
          </Button>
        }
      >
        {loading ? (
          <div style={{ padding: '4px 0' }}>
            <SkeletonSettingRows rows={3} />
          </div>
        ) : draftCount === 0 ? (
          <div style={{ padding: '28px 0', textAlign: 'center' }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span style={{ fontSize: 13, color: token.colorTextSecondary }}>
                  {t('workshopSettings.list.empty')}
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
                        loading={busyId === draft.id}
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

      {/* ── 草稿详情抽屉：文件 + 验收报告 ── */}
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
                loading={busyId === detail.id}
                onClick={() => void handleBuild(detail.id)}
              >
                {t('workshopSettings.action.build')}
              </Button>
              <Button
                size="small"
                icon={<RiShieldCheckLine size={14} />}
                loading={busyId === detail.id}
                onClick={() => void handleVerify(detail.id)}
              >
                {t('workshopSettings.action.verify')}
              </Button>
              <Button
                size="small"
                type="primary"
                icon={<RiUploadCloud2Line size={14} />}
                loading={busyId === detail.id}
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
            <div style={{ fontSize: 12, color: token.colorTextTertiary, wordBreak: 'break-all' }}>
              {detail.dir}
            </div>

            {/* 验收报告：逐项结论（失败项带建议，可直接丢回给助手） */}
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

            {/* 文件：点开只读预览（编辑器不在这里——改代码是助手的事） */}
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

      {/* ── 新建草稿（助手是主路径，这里是「先建骨架再让助手填」的备用入口） ── */}
      <Modal
        open={creating}
        title={t('workshopSettings.create.title')}
        okText={t('common.action.create')}
        cancelText={t('common.action.cancel')}
        okButtonProps={{ disabled: !/^[a-z][a-z0-9-]*$/.test(newId.trim()) }}
        onOk={() => void handleCreate()}
        onCancel={() => setCreating(false)}
      >
        <div className="flex flex-col" style={{ gap: 12, paddingTop: 8 }}>
          <Input
            value={newId}
            onChange={(event) => setNewId(event.target.value)}
            placeholder={t('workshopSettings.create.idPlaceholder')}
            addonBefore="id"
          />
          <Input
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder={t('workshopSettings.create.titlePlaceholder')}
          />
          <Select value={newTemplate} onChange={setNewTemplate} options={templates} />
          <div style={{ fontSize: 12, color: token.colorTextTertiary }}>
            {t('workshopSettings.create.note')}
          </div>
        </div>
      </Modal>
    </div>
  )
}

export default WorkshopSettings
