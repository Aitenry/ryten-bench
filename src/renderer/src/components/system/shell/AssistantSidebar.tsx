import React, { useCallback } from 'react'
import { theme } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTheme } from '@renderer/hooks/useTheme'
import { useHarness } from '../../../contexts/harness/HarnessContextCore'
import HarnessSidebar from '../../harness/HarnessSidebar'

/**
 * The conversation sidebar inside the system shell.
 *
 * After moving out of the plugin, the former HarnessSidebar (capsule mode switch / workspace tree /
 * memory) lives permanently as the system sidebar in the new shell; this component only pulls state
 * from HarnessProvider and wires it to navigation.
 *
 * All colors go through antd theme tokens: when the light/dark setting switches, the sidebar and
 * the main content change together instead of a fixed dark sidebar with light main content.
 */
const AssistantSidebar: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  /**
   * A "user action" from the sidebar must bring the main content area back to the conversation page
   * (`/harness`), but **startup restoration does not count as a user action**.
   *
   * Previous approach: navigation was decided here based on whether the conversation page was
   * already active. The intent was to block the startup restoration right after mount — it resets
   * the content to a blank session / restores the last session, and the callback used to call
   * `navigate('/harness')` unconditionally, so entering `/plugins` from the login page pulled the
   * freshly mounted shell back to the conversation page.
   *
   * But that guard also blocked **real clicks**: while the user stays on the library / plugin
   * repository / more (agents…) page and clicks "+ New session" or a session, state changes but the
   * route does not, so the UI appears unresponsive (user report 2026-11-21: "after opening another
   * page… then clicking new session, nothing happens, the page does not return to the new session
   * page").
   *
   * The two concerns are now separated: navigation is only notified by HarnessSidebar on an
   * **explicit click** via `onOpenHarness` (see the prop comment there), while the startup
   * restoration path never notifies — so there is no need to guess intent from the route. When
   * already on the conversation page nothing is pushed again, avoiding extra history entries from
   * repeated "new session" clicks.
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
