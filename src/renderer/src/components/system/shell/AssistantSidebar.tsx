import React from 'react'
import { theme } from 'antd'
import { useNavigate } from 'react-router-dom'
import { useTheme } from '@renderer/hooks/useTheme'
import { useHarness } from '../../../contexts/harness/HarnessContextCore'
import HarnessSidebar from '../../harness/HarnessSidebar'

/**
 * 系统外壳里的对话侧栏。
 *
 * harness 从插件移出后，原来的 HarnessSidebar（胶囊模式切换 / 工作区树 / 记忆）
 * 作为系统侧栏常驻在新外壳中；这里只负责从 HarnessProvider 取状态、接到导航上。
 *
 * 颜色全部走 antd 主题 token：亮色/暗色设置切换时侧栏和主内容一起变化，
 * 不再固定为深色侧栏 + 浅色主内容。
 */
const AssistantSidebar: React.FC = () => {
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const { effectiveTheme } = useTheme()
  const {
    topics,
    topicsWorkspaceId,
    currentTopicId,
    loadingTopicIds,
    topicsHasMore,
    topicsLoading,
    topicsRefreshing,
    handleSelectTopic,
    handleDeleteTopic,
    handleLoadMoreTopics,
    handleNewHarness
  } = useHarness()

  return (
    <HarnessSidebar
      topics={topics}
      topicsWorkspaceId={topicsWorkspaceId}
      currentTopicId={currentTopicId}
      colorBgContainer={token.colorBgLayout}
      borderRadiusLG={0}
      colorText={token.colorText}
      colorTextSecondary={token.colorTextSecondary}
      colorTextTertiary={token.colorTextTertiary}
      colorFillAlter={token.colorFillAlter}
      loadingTopicIds={loadingTopicIds}
      hasMoreTopics={topicsHasMore}
      isLoadingMoreTopics={topicsLoading}
      isRefreshingTopics={topicsRefreshing}
      onSelectTopic={(topic) => {
        void handleSelectTopic(topic)
        navigate('/harness')
      }}
      onDeleteTopic={handleDeleteTopic}
      onLoadMoreTopics={handleLoadMoreTopics}
      onNewHarness={() => {
        handleNewHarness()
        navigate('/harness')
      }}
      shellMode={effectiveTheme === 'dark'}
    />
  )
}

export default AssistantSidebar
