import React, { useEffect, useState } from 'react'
import { Button, Input, Modal, theme } from 'antd'
import { RiFolderOpenLine } from '@remixicon/react'
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
 *
 * 另外把**插件存放路径**摆在最上面（用户口径「不要有默认目录，需要配置所有插件的存放路径」）：
 * 没配过时这里是空的 + 一个「选择」按钮，选好之前「新建」保持禁用——
 * 插件源码是用户自己的东西，落在哪儿必须由他决定。
 */
const NewDraftModal: React.FC<{
  open: boolean
  onClose: () => void
  /** 建成之后（面板刷新、侧栏重列草稿各自决定怎么接） */
  onCreated?: (id: string) => void
  /** 存放路径变化时通知调用方（侧栏据此重拉列表） */
  onRootChanged?: () => void
}> = ({ open, onClose, onCreated, onRootChanged }) => {
  const { token } = theme.useToken()
  const { viewMessage } = useMessage()
  const { t } = useTranslation()
  const [id, setId] = useState('')
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [picking, setPicking] = useState(false)
  const [pluginsPath, setPluginsPath] = useState('')

  // 打开时读一次当前配置（关掉再打开、或在别处改过都能拿到最新值）
  useEffect(() => {
    if (!open) return
    void harnessApi.workshop
      .state()
      .then((state) => setPluginsPath(state.pluginsPath ?? ''))
      .catch(() => setPluginsPath(''))
  }, [open])

  /** id 规则与主进程一致：小写 kebab */
  const validId = /^[a-z][a-z0-9-]*$/.test(id.trim())
  const ready = validId && pluginsPath.trim() !== ''

  const close = (): void => {
    setId('')
    setTitle('')
    onClose()
  }

  const handlePickRoot = async (): Promise<void> => {
    setPicking(true)
    try {
      const result = await harnessApi.workshop.pickRoot()
      if (!result.ok) {
        viewMessage('workshop-root', 'error', result.error ?? '', 6)
        return
      }
      const data = result.data
      if (!data || data.canceled) return
      setPluginsPath(data.dir ?? '')
      onRootChanged?.()
      if (data.moved && data.moved.length > 0) {
        viewMessage(
          'workshop-root-moved',
          'success',
          t('workshopSettings.root.moved', { count: data.moved.length }),
          5
        )
      }
    } catch (error) {
      viewMessage('workshop-root', 'error', String(error))
    } finally {
      setPicking(false)
    }
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
        {/* 插件存放路径：所有插件的源码根目录，没有默认值 */}
        <div className="flex items-center" style={{ gap: 8 }}>
          <Input
            value={pluginsPath}
            readOnly
            // 稳定钩子：工装按字段定位（路径框在 id 之前，不能靠「第一个 input」）
            data-workshop-field="path"
            placeholder={t('workshopSettings.root.placeholder')}
            prefix={<RiFolderOpenLine size={14} style={{ color: token.colorTextTertiary }} />}
            style={{ flex: 1 }}
          />
          <Button loading={picking} onClick={() => void handlePickRoot()}>
            {pluginsPath ? t('workshopSettings.root.change') : t('workshopSettings.root.pick')}
          </Button>
        </div>
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
        <div style={{ fontSize: 12, color: token.colorTextTertiary }}>
          {t('workshopSettings.create.note')}
        </div>
      </div>
    </Modal>
  )
}

export default NewDraftModal
