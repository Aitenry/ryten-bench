import React from 'react'
import { Empty, Modal, Spin } from 'antd'
import MarkdownView from './MarkdownView'
import { useTheme } from '@renderer/hooks/useTheme'

/**
 * Shared shell for the Notes document preview modal.
 *
 * Originally only `DocumentPreviewModal` (opened from a source document in the knowledge graph)
 * used it; the skills page's "view content" also needs the same preview experience (full window
 * width, centered, same scroll container and Markdown rendering), so the modal shell was
 * extracted here for both to reuse, instead of the skills page drawing a smaller lookalike.
 *
 * Only handles "viewing": title, Markdown body, empty state, loading state; the caller owns
 * open/close and the data.
 */
export interface MarkdownPreviewModalProps {
  open: boolean
  onCancel: () => void
  title: string
  content?: string | null
  /** Empty-state text when there is no body */
  emptyText: string
  /** Data is still loading (skill bodies are read from disk on demand): show the loading state first, no empty-state flash */
  loading?: boolean
}

const MarkdownPreviewModal: React.FC<MarkdownPreviewModalProps> = ({
  open,
  onCancel,
  title,
  content,
  emptyText,
  loading = false
}) => {
  const { effectiveTheme } = useTheme()

  return (
    <Modal
      title={title}
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
        <div className="custom-scrollbar app-modal-scroll" style={{ flex: 1, overflow: 'auto' }}>
          {loading ? (
            <div
              style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <Spin />
            </div>
          ) : content ? (
            <MarkdownView content={content} isDarkMode={effectiveTheme === 'dark'} />
          ) : (
            <Empty description={emptyText} />
          )}
        </div>
      </div>
    </Modal>
  )
}

export default MarkdownPreviewModal
