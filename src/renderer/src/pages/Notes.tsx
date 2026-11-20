import React from 'react'
import { theme } from 'antd'
import NotesView from '../components/notes/NotesView'

/**
 * 资料库页面（路由 `/notes`）。
 *
 * 三栏布局：左侧文档树 / 中间主区（文档、图谱、待办）/ 右侧大纲与属性。
 * 懒加载入口见 `route/MainRoutes.tsx`。
 */
const Notes: React.FC = () => {
  const { token } = theme.useToken()

  return (
    <div
      className="h-full flex-1 flex"
      style={{
        boxSizing: 'border-box',
        /* 用容器色：留白区域与两侧面板同色，不会出现一圈黑边 */
        background: token.colorBgContainer,
        borderTopLeftRadius: token.borderRadiusLG
      }}
    >
      <NotesView />
    </div>
  )
}

export default Notes
