import React, { useCallback, useEffect, useState } from 'react'
import { Modal, Input, Button, Tag as AntTag, Typography } from 'antd'
import { theme } from 'antd'
import { getTagsArray } from '@renderer/utils/document'
import { useTranslation } from '@renderer/i18n'

const { Text } = Typography

export interface DocPropertiesModalProps {
  open: boolean
  /** 当前文档元信息 */
  doc: { title: string; summary: string | null; tags: string | null; image: string | null } | null
  onClose: () => void
  /** 保存回调（仅元信息：标签/摘要/封面） */
  onSave: (data: { image: string | null; summary: string | null; tags: string[] }) => Promise<void>
}

/**
 * 文档属性小弹窗（标签 / 摘要 / 封面）。
 * 替代原来带编辑器的大弹窗——正文编辑已全部内联化。
 */
const DocPropertiesModal: React.FC<DocPropertiesModalProps> = ({ open, doc, onClose, onSave }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [editTags, setEditTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [editImage, setEditImage] = useState<string | null>(null)
  const [editSummary, setEditSummary] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open && doc) {
      setEditTags(getTagsArray(doc.tags))
      setEditImage(doc.image)
      setEditSummary(doc.summary ?? '')
      setTagInput('')
    }
  }, [open, doc])

  const handleAddTag = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'Enter' && tagInput.trim()) {
        e.preventDefault()
        if (!editTags.includes(tagInput.trim())) {
          setEditTags([...editTags, tagInput.trim()])
        }
        setTagInput('')
      }
    },
    [tagInput, editTags]
  )

  const handleRemoveTag = useCallback(
    (tagToRemove: string): void => {
      setEditTags(editTags.filter((tag) => tag !== tagToRemove))
    },
    [editTags]
  )

  const handleSelectImage = useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.file.selectImageFile(true)
      if (result?.isImage) {
        setEditImage(result.dataUrl)
      }
    } catch (error) {
      console.error('Failed to select image:', error)
    }
  }, [])

  const handleSave = useCallback(async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave({
        image: editImage,
        summary: editSummary || null,
        tags: editTags
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }, [onSave, onClose, editImage, editSummary, editTags])

  return (
    <Modal
      title={
        doc?.title ? t('notes.props.titleWithDoc', { name: doc.title }) : t('notes.props.title')
      }
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      okText={t('common.action.save')}
      cancelText={t('common.action.cancel')}
      confirmLoading={saving}
      width={460}
      centered
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* 标签 */}
        <div>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
            {t('notes.field.tags')}
          </Text>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              alignItems: 'center',
              padding: '8px 10px',
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: 8,
              background: token.colorFillQuaternary
            }}
          >
            {editTags.map((tag) => (
              <AntTag
                key={tag}
                closable
                onClose={() => handleRemoveTag(tag)}
                color="processing"
                style={{ margin: 0 }}
              >
                {tag}
              </AntTag>
            ))}
            <Input
              placeholder={
                editTags.length === 0
                  ? t('notes.field.tagPlaceholder')
                  : t('notes.field.tagPlaceholderMore')
              }
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleAddTag}
              variant="borderless"
              size="small"
              style={{ flex: 1, minWidth: 100 }}
            />
          </div>
        </div>

        {/* 封面 */}
        <div>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
            {t('notes.field.cover')}
          </Text>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Button type="default" onClick={handleSelectImage}>
              {editImage ? t('notes.field.changeImage') : t('notes.field.uploadImage')}
            </Button>
            {editImage && (
              <Button type="default" danger onClick={() => setEditImage(null)}>
                {t('notes.field.removeImage')}
              </Button>
            )}
          </div>
          {editImage && (
            <div
              style={{
                width: '100%',
                maxHeight: 200,
                overflow: 'hidden',
                borderRadius: 8,
                marginTop: 8,
                border: `1px solid ${token.colorBorderSecondary}`
              }}
            >
              <img
                src={editImage}
                alt={t('notes.field.coverAlt')}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            </div>
          )}
        </div>

        {/* 摘要 */}
        <div>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
            {t('notes.field.summary')}
          </Text>
          <Input.TextArea
            placeholder={t('notes.props.summaryPlaceholder')}
            value={editSummary}
            onChange={(e) => setEditSummary(e.target.value)}
            maxLength={500}
            autoSize={{ minRows: 3, maxRows: 6 }}
          />
        </div>
      </div>
    </Modal>
  )
}

export default DocPropertiesModal
