import React, { useCallback } from 'react'
import { theme } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
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
  const location = useLocation()
  /**
   * 侧栏的「用户动作」要把主内容区带回对话页（`/harness`），但**启动恢复不算用户动作**。
   *
   * 此前的写法：这里按「当前是不是已经在对话页」决定导不导航，本意是拦住
   * 挂载后那次启动恢复——它会把内容复位成空白会话 / 恢复上次那条会话，回调原先无条件
   * `navigate('/harness')`，于是「从登录页进入 /plugins」时外壳刚挂载就被拉回对话页。
   *
   * 但那个守卫把**真实点击**也一并拦了：人停在资料库 / 插件仓库 / 更多（智能体…）时点
   * 「＋ 新建会话」或一条会话，state 变了、路由不动，界面看起来毫无反应
   * （用户口径 2026-11-21「打开其他界面……然后点击新建会话，都没有反应，页面不会回到
   * 新建会话这个页面」）。
   *
   * 现在把两件事分开：导航只由 HarnessSidebar 在**显式点击**时通过 `onOpenHarness`
   * 通知（见那边的 prop 注释），启动恢复那条路根本不通知——因此不需要按路由猜意图。
   * 已经在对话页时不再重复 push，避免点几次「新建会话」就多出几层历史。
   */
  const inHarness = location.pathname === '/harness' || location.pathname.startsWith('/harness/')
  const openHarness = useCallback((): void => {
    if (!inHarness) navigate('/harness')
  }, [inHarness, navigate])

  const { token } = theme.useToken()
  const { effectiveTheme } = useTheme()
  const {
    topics,
    topicsWorkspaceId,
    currentTopicId,
    loadingTopicIds,
    awaitingTopicIds,
    completedTopicIds,
    topicsHasMore,
    topicsLoading,
    topicsRefreshing,
    handleSelectTopic,
    handleDeleteTopic,
    handleLoadMoreTopics,
    handleNewHarness,
    refreshTopics,
    setPendingJumpDialogueId
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
      colorWarning={token.colorWarning}
      colorSuccess={token.colorSuccess}
      loadingTopicIds={loadingTopicIds}
      awaitingTopicIds={awaitingTopicIds}
      completedTopicIds={completedTopicIds}
      hasMoreTopics={topicsHasMore}
      isLoadingMoreTopics={topicsLoading}
      isRefreshingTopics={topicsRefreshing}
      onSelectTopic={handleSelectTopic}
      onDeleteTopic={handleDeleteTopic}
      onLoadMoreTopics={handleLoadMoreTopics}
      onRefreshTopics={refreshTopics}
      onNewHarness={handleNewHarness}
      onOpenHarness={openHarness}
      onSetPendingJumpDialogue={setPendingJumpDialogueId}
      shellMode={effectiveTheme === 'dark'}
    />
  )
}

export default AssistantSidebar
