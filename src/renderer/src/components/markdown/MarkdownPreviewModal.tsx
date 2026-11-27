import React from 'react'
import { Empty, Modal, Spin } from 'antd'
import MarkdownView from './MarkdownView'
import { useTheme } from '@renderer/hooks/useTheme'

/**
 * 资料库（Notes）文档预览弹窗的通用外壳。
 *
 * 原先只有 `DocumentPreviewModal`（知识图谱里点来源文档）在用；技能页的「查看内容」
 * 也要同一套预览体验（整窗宽、居中、同一滚动容器与 Markdown 渲染），所以把弹窗
 * 外壳抽到这里，两边复用，避免技能页再画一个小尺寸的近似弹窗。
 *
 * 只负责「看」：标题、Markdown 正文、空态、加载态；打开/关闭与数据由调用方管。
 */
export interface MarkdownPreviewModalProps {
  open: boolean
  onCancel: () => void
  title: string
  content?: string | null
  /** 没有正文时的空态文案 */
  emptyText: string
  /** 数据还在读（技能正文按需读盘）：先显示加载态，不闪空态 */
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
        <div className="app-modal-scroll" style={{ flex: 1, overflow: 'auto' }}>
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
