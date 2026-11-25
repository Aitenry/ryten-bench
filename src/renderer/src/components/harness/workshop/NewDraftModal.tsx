import React, { useEffect, useState } from 'react'
import { Input, Modal, theme } from 'antd'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import { harnessApi } from '../../../api/harness'

/**
 * 与主进程 `workshop/paths.ts` 的 `assertDraftId` 保持同一口径：
 * 只允许小写 kebab（不能有连续的 `-`、不能以 `-` 结尾）、最长 40、宿主保留 id 与
 * Windows 设备名不允许。以前前端只查 `/^[a-z][a-z0-9-]*$/`，`foo-` / 41 个字符
 * 都能点「创建」，然后在主进程才被拒——用户看到的是一次莫名其妙的失败。
 */
const DRAFT_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const DRAFT_ID_MAX = 40
const RESERVED_DRAFT_IDS = new Set([
  'host',
  ...['con', 'prn', 'aux', 'nul'],
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)
])

function isValidDraftId(value: string): boolean {
  const id = value.trim()
  if (!id || id.length > DRAFT_ID_MAX) return false
  if (!DRAFT_ID_RE.test(id)) return false
  if (RESERVED_DRAFT_IDS.has(id)) return false
  return true
}

/**
 * 「新建草稿」弹窗（侧栏的 ＋ 与设置页的「新建草稿」共用同一个）。
 *
 * 两处入口共用它，是为了让「点一下就开始」这条路径**只有一次跳转**：
 * 侧栏插件模式里点 ＋ 直接弹这个框（没配插件存放路径时先弹文件夹选择，见侧栏的
 * `handleNewDraft`）。弹窗里**只问 id 与展示名**——选择存放路径的动作不在这里
 * （用户口径 2026-09-27「新建插件里面不要弄一个选择插件目录」）：
 * 选文件夹的入口只有两个，都是各页面自己的入口——设置 → 插件工坊的「插件存放路径」
 * 那一行，和侧栏右上角的 ＋。
 *
 * 模板也**不提供选择**：生成的一律是含全部内容的 `full` 骨架，用不上的部分交给助手删。
 */
const NewDraftModal: React.FC<{
  open: boolean
  onClose: () => void
  /** 建成之后（面板刷新、侧栏重列插件各自决定怎么接） */
  onCreated?: (id: string) => void
}> = ({ open, onClose, onCreated }) => {
  const { token } = theme.useToken()
  const { viewMessage } = useMessage()
  const { t } = useTranslation()
  const [id, setId] = useState('')
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [configured, setConfigured] = useState(true)

  // 打开时确认「插件存放路径」已配置（正常路径下已由调用方保证；没配就禁用「新建」并说明）
  useEffect(() => {
    if (!open) return
    void harnessApi.workshop
      .state()
      .then((state) => setConfigured(Boolean(state.pluginsPath)))
      .catch(() => setConfigured(false))
  }, [open])

  /** id 规则与主进程一致：小写 kebab（含长度上限 / 保留名） */
  const validId = isValidDraftId(id)
  const ready = validId && configured

  const close = (): void => {
    setId('')
    setTitle('')
    onClose()
  }

  const handleCreate = async (): Promise<void> => {
    if (!ready || creating) return
    setCreating(true)
    try {
      const result = await harnessApi.workshop.create({
        id: id.trim(),
        title: title.trim() || undefined
      })
      if (!result.ok) {
        viewMessage('workshop-create', 'error', result.error ?? '', 6)
        return
      }
      const createdId = result.data?.id ?? id.trim()
      close()
      onCreated?.(createdId)
    } catch (error) {
      viewMessage('workshop-create', 'error', String(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal
      open={open}
      title={t('workshopSettings.create.title')}
      okText={t('common.action.create')}
      cancelText={t('common.action.cancel')}
      confirmLoading={creating}
      okButtonProps={{ disabled: !ready }}
      onOk={() => void handleCreate()}
      onCancel={close}
    >
      <div className="flex flex-col" style={{ gap: 12, paddingTop: 8 }}>
        <Input
          value={id}
          onChange={(event) => setId(event.target.value)}
          data-workshop-field="id"
          placeholder={t('workshopSettings.create.idPlaceholder')}
          addonBefore="id"
          autoFocus
        />
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t('workshopSettings.create.titlePlaceholder')}
          onPressEnter={() => void handleCreate()}
        />
        <div
          style={{ fontSize: 12, color: configured ? token.colorTextTertiary : token.colorError }}
        >
          {configured ? t('workshopSettings.create.note') : t('workshopSettings.list.needRoot')}
        </div>
      </div>
    </Modal>
  )
}

export default NewDraftModal
