import React from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react'

/**
 * 文件引用内联节点（chip）。
 *
 * 用 ProseMirror 的 atom 节点实现：不可编辑、可整体删除（光标紧贴时退格/删除键
 * 自动删除整个节点）、IME 组合、粘贴、撤销全部由 ProseMirror 内核托管，
 * 无需手工维护 DOM。
 *
 * 渲染为 NodeView（React 组件），样式复用原 contentEditable 方案的 chip
 * 高度契约：13px 字号 + 2px padding + 1px border = 19px 行高。
 * 颜色使用 CSS 变量（--file-chip-*），由 HarnessInput 容器按主题注入。
 */
const FileRef = Node.create({
  name: 'fileRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      path: { default: null },
      label: { default: '' }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-file-ref]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-file-ref': '' })]
  },

  // editor.getText() 时以路径文本参与，与发送内容兼容
  renderText({ node }) {
    return node.attrs.path ?? ''
  },

  addNodeView() {
    return ReactNodeViewRenderer(FileRefView)
  }
})

const FileRefView: React.FC<NodeViewProps> = ({ node, deleteNode, editor }) => {
  const path: string = node.attrs.path ?? ''
  const label: string = node.attrs.label || path.split('/').filter(Boolean).pop() || path
  const isDir = path.endsWith('/') || !path.includes('.')

  return (
    <NodeViewWrapper as="span" className="file-ref-chip" data-path={path} title={path}>
      <span className="file-ref-icon">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          {isDir ? (
            <path d="M12.414 5H21C21.5523 5 22 5.44772 22 6V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3H10.414L12.414 5Z" />
          ) : (
            <path d="M3 8L9.00319 2H19.9978C20.5513 2 21 2.45531 21 2.99078V21.0092C21 21.556 20.5551 22 20.0066 22H3.9934C3.44476 22 3 21.5501 3 20.9932V8ZM10 4V9H5V20H19V4H10Z" />
          )}
        </svg>
      </span>
      <span className="file-ref-label">{label}</span>
      <span
        className="file-ref-close"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          deleteNode()
          editor.commands.focus()
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M12 10.586L17.95 4.636L19.364 6.05L13.414 12L19.364 17.95L17.95 19.364L12 13.414L6.05 19.364L4.636 17.95L10.586 12L4.636 6.05L6.05 4.636L12 10.586Z" />
        </svg>
      </span>
    </NodeViewWrapper>
  )
}

export default FileRef
