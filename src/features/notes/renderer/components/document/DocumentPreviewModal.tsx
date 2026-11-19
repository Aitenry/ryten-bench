import React from 'react'
import { Modal, Empty } from 'antd'
import MarkdownView from '@renderer/components/markdown/MarkdownView'
import { useTheme } from '@renderer/hooks/useTheme'
import { useTranslation } from '@renderer/i18n'
import type { DocPreviewModalProps } from '../../types'

const DocumentPreviewModal: React.FC<DocPreviewModalProps> = ({ open, onCancel, currentDoc }) => {
  const { effectiveTheme } = useTheme()
  const { t } = useTranslation()
  return (
    <Modal
      title={currentDoc?.title || t('notes.preview.doc')}
      open={open}
      onCancel={onCancel}
      width="calc(100vw - 137px)"
      centered={true}
      mask={{ closable: false }}
      className="custom-container-scrollbar"
      styles={{ body: { height: 'calc(100vh - 205px)', overflow: 'auto' } }}
      footer={null}
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {currentDoc?.content ? (
            <MarkdownView content={currentDoc.content} isDarkMode={effectiveTheme === 'dark'} />
          ) : (
            <Empty description={t('notes.preview.empty')} />
          )}
        </div>
      </div>
    </Modal>
  )
}

export default DocumentPreviewModal
