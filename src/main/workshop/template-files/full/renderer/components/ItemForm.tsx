import { useEffect, useState } from 'react'
import { Input, Modal } from 'antd'
import type { ${vars.pascal}Item, ${vars.pascal}ItemInput } from '../../shared/types'
import { formModalProps } from './ui'

/**
 * Modal for creating / editing a record.
 *
 * Why it is a separate component: the form is **the state-heaviest part** (draft values,
 * validation, submitting); keeping it inside the page component would re-render the list along with
 * it. The component only knows props and the plugin's own DTOs.
 *
 * **Every Modal must spread formModalProps (or createModalProps)**: a modal without a height limit
 * produces a "whole page" scrollbar in short windows (the scroll container is the viewport-sized
 * .ant-modal-wrap), and the title and the Save button scroll out of the viewport together. Forms
 * with many fields that need internal scrolling use formModalProps.
 */
export default function ItemForm(props: {
  open: boolean
  /** Passed = edit, omitted = create */
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

  // Reset the draft from the current record on every open (closing and reopening must not keep the previous input)
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
