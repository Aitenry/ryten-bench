import React from 'react'
import MarkdownPreviewModal from '@renderer/components/markdown/MarkdownPreviewModal'
import { useTranslation } from '@renderer/i18n'
import type { DocPreviewModalProps } from '../../../types/notes'

/**
 * 资料库文档预览（知识图谱里点来源文档时打开）。
 *
 * 弹窗外壳抽到 `components/markdown/MarkdownPreviewModal`：资料库与技能页的
 * 「查看内容」共用同一套整窗宽 Markdown 预览，不再各自维护 Modal + 滚动容器。
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
