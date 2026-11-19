import React, { useState, useEffect, useCallback } from 'react'
import { Modal, Input, Button, Space, Typography, Tag as AntTag } from 'antd'
import type { WikiEditModalProps } from '../../types'
import { getTagsArray } from '@renderer/utils/document'
import { useTranslation } from '@renderer/i18n'

const { Text } = Typography

/* ── component ── */

const WikiEditModal: React.FC<WikiEditModalProps> = ({
  open,
  isNew,
  initialTitle = '',
  initialSummary = '',
  initialTags = '',
  initialImage = null,
  onSave,
  onCancel
}) => {
  const { t } = useTranslation()
  const [title, setTitle] = useState(initialTitle)
  const [summary, setSummary] = useState(initialSummary)
  const [editTags, setEditTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [image, setImage] = useState<string | null>(initialImage)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setTitle(initialTitle)
      setSummary(initialSummary)
      setEditTags(getTagsArray(initialTags))
      setTagInput('')
      setImage(initialImage)
    }
  }, [open, initialTitle, initialSummary, initialTags, initialImage])

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

  const handleSelectImage = async (): Promise<void> => {
    try {
      const result = await window.api.file.selectImageFile(true)
      if (result?.isImage) {
        setImage(result.dataUrl)
      }
    } catch (error) {
      console.error('Failed to select image:', error)
    }
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave({
        title,
        summary: summary || null,
        tags: editTags.length > 0 ? JSON.stringify(editTags) : null,
        image
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={isNew ? t('notes.wiki.create') : t('notes.wiki.edit')}
      open={open}
      onOk={handleSave}
      onCancel={onCancel}
      okText={t('common.action.save')}
      cancelText={t('common.action.cancel')}
      confirmLoading={saving}
      styles={{ body: { maxHeight: 'calc(100vh - 300px)', padding: '0 6px', overflowY: 'auto' } }}
      classNames={{ body: 'custom-scrollbar' }}
    >
      <Space vertical style={{ width: '100%' }}>
        <Text strong>{t('notes.field.title')}</Text>
        <Input
          placeholder={t('notes.wiki.titlePlaceholder')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Text strong>{t('notes.field.summary')}</Text>
        <Input.TextArea
          placeholder={t('notes.wiki.summaryPlaceholder')}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={4}
        />
        <Text strong>{t('notes.field.tags')}</Text>
        {editTags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {editTags.map((tag, index) => (
              <AntTag key={index} closable onClose={() => handleRemoveTag(tag)} color="processing">
                {tag}
              </AntTag>
            ))}
          </div>
        )}
        <Input
          placeholder={t('notes.field.tagPlaceholder')}
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={handleAddTag}
          allowClear
        />
        <Text strong>{t('notes.field.coverImage')}</Text>
        <Space>
          <Button type="default" onClick={handleSelectImage}>
            {t('notes.field.selectImage')}
          </Button>
          {image && (
            <Button type="default" danger onClick={() => setImage(null)}>
              {t('notes.field.removeImage')}
            </Button>
          )}
        </Space>
        {image && (
          <div style={{ maxHeight: 300, overflow: 'hidden', borderRadius: 8 }}>
            <img
              src={image}
              alt={t('notes.field.coverAlt')}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </div>
        )}
      </Space>
    </Modal>
  )
}

export default WikiEditModal
