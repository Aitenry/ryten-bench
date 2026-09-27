import React, { useState } from 'react'
import { Input, Modal, theme } from 'antd'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import { harnessApi } from '../../api'

/**
 * 「新建草稿」弹窗（侧栏的 ＋ 与设置页的「新建草稿」共用同一个）。
 *
 * 两处入口共用它，是为了让「点一下就开始」这条路径**只有一次跳转**：
 * 侧栏插件模式里点 ＋ 直接弹这个框，不再先弹设置弹窗（2026-09-27 用户口径
 * 「在页面点击新建插件直接打开这个即可」）。
 *
 * 只问两件事：id（小写 kebab，同时是目录名/命名空间）与展示名。
 * **没有模板选择**——生成的一律是含全部内容的 `full` 骨架，用不上的部分交给助手删。
 */
const NewDraftModal: React.FC<{
  open: boolean
  onClose: () => void
  /** 建成之后（面板刷新、侧栏重列草稿各自决定怎么接） */
  onCreated?: (id: string) => void
}> = ({ open, onClose, onCreated }) => {
  const { token } = theme.useToken()
  const { viewMessage } = useMessage()
  const { t } = useTranslation()
  const [id, setId] = useState('')
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)

  /** id 规则与主进程一致：小写 kebab（不合规时「新建」保持禁用） */
  const valid = /^[a-z][a-z0-9-]*$/.test(id.trim())

  const close = (): void => {
    setId('')
    setTitle('')
    onClose()
  }

  const handleCreate = async (): Promise<void> => {
    if (!valid || creating) return
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
      okButtonProps={{ disabled: !valid }}
      onOk={() => void handleCreate()}
      onCancel={close}
    >
      <div className="flex flex-col" style={{ gap: 12, paddingTop: 8 }}>
        <Input
          value={id}
          onChange={(event) => setId(event.target.value)}
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
        <div style={{ fontSize: 12, color: token.colorTextTertiary }}>
          {t('workshopSettings.create.note')}
        </div>
      </div>
    </Modal>
  )
}

export default NewDraftModal
