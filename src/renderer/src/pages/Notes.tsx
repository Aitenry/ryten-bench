import React from 'react'
import { theme } from 'antd'
import NotesView from '../components/notes/NotesView'

/**
 * Library page (route `/notes`).
 *
 * Three-column layout: document tree on the left / main area in the middle (documents, graph, todos) / outline and properties on the right.
 * Lazy-loaded entry: see `route/MainRoutes.tsx`.
 */
const Notes: React.FC = () => {
  const { token } = theme.useToken()

  return (
    <div
      className="h-full flex-1 flex"
      style={{
        boxSizing: 'border-box',
        /* Use the container color: the gutter matches both side panels, so no dark border ring appears */
        background: token.colorBgContainer,
        borderTopLeftRadius: token.borderRadiusLG
      }}
    >
      <NotesView />
    </div>
  )
}

export default Notes
