import { useEffect, useState } from 'react'
import { Input, Modal } from 'antd'
import type { ${vars.pascal}Item, ${vars.pascal}ItemInput } from '../../shared/harness/types'
import { formModalProps } from './ui'

/**
 * 新建 / 编辑记录的弹窗。
 *
 * 为什么拆出来：表单是**状态最多的那一块**（草稿值、校验、提交中），
 * 塞在页面组件里会让列表渲染跟着一起重渲染。组件只认 props 与本插件自己的 DTO。
 *
 * **每个 Modal 都要展开 formModalProps（或 createModalProps）**：
 * 不限制高度的弹窗在矮窗口下会撑出「整页」滚动条（滚动容器是铺满视口的 .ant-modal-wrap），
 * 标题与「保存」按钮一起被滚出视口。字段多、需要内部滚动的表单用 formModalProps。
 */
export default function ItemForm(props: {
  open: boolean
  /** 传了就是编辑，没传就是新建 */
  item?: ${vars.pascal}Item | null
  saving: boolean
  labels: {
    createTitle: string
    editTitle: string
    titleLabel: string
    titlePlaceholder: string
    noteLabel: string
    notePlaceholder: string
    save: string
    cancel: string
  }
  onCancel: () => void
  onSubmit: (input: ${vars.pascal}ItemInput) => void
}): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')

  // 每次打开都用当前这条记录重置草稿（关掉再打开不能留着上一次的输入）
  useEffect(() => {
    if (!props.open) return
    setTitle(props.item?.title ?? '')
    setNote(props.item?.note ?? '')
  }, [props.open, props.item])

  return (
    <Modal
      {...formModalProps}
      open={props.open}
      title={props.item ? props.labels.editTitle : props.labels.createTitle}
      okText={props.labels.save}
      cancelText={props.labels.cancel}
      confirmLoading={props.saving}
      okButtonProps={{ disabled: title.trim().length === 0 }}
      onCancel={props.onCancel}
      onOk={() => props.onSubmit({ title: title.trim(), note: note.trim() })}
    >
      <div className="flex flex-col gap-3 pt-2">
        <Input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={props.labels.titlePlaceholder}
          addonBefore={props.labels.titleLabel}
        />
        <Input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={props.labels.notePlaceholder}
          addonBefore={props.labels.noteLabel}
        />
      </div>
    </Modal>
  )
}
