import React from 'react'
import MarkdownPreviewModal from '@renderer/components/markdown/MarkdownPreviewModal'
import { useTranslation } from '@renderer/i18n'
import type { DocPreviewModalProps } from '../../../types/notes'

/**
 * Material-library document preview (opened when clicking a source document in the knowledge graph).
 *
 * The dialog shell is extracted into `components/markdown/MarkdownPreviewModal`: the material library
 * and the skills page share the same full-window-width Markdown preview for "view content", instead of
 * each maintaining its own Modal + scroll container.
 */
const DocumentPreviewModal: React.FC<DocPreviewModalProps> = ({ open, onCancel, currentDoc }) => {
  const { t } = useTranslation()
  return (
    <MarkdownPreviewModal
      open={open}
      onCancel={onCancel}
      title={currentDoc?.title || t('notes.preview.doc')}
      content={currentDoc?.content}
      emptyText={t('notes.preview.empty')}
    />
  )
}

export default DocumentPreviewModal
