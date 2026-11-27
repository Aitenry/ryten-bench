import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { theme, Button, Spin, App } from 'antd'
import { RiAiAgentLine, RiChatAiLine, RiFoldersLine, RiListSettingsLine } from '@remixicon/react'
import { useTheme } from '@renderer/hooks/useTheme'
import { useTranslation } from '@renderer/i18n'
import { useHarness } from '../contexts/harness/HarnessContextCore'
import HarnessHeader from '../components/harness/HarnessHeader'
import ConversationPane from '../components/harness/ConversationPane'
import ConversationFooter from '../components/harness/ConversationFooter'
import SubagentInput from '../components/harness/SubagentInput'
import HarnessInput from '../components/harness/HarnessInput'
import InlineGoalCard from '../components/harness/InlineGoalCard'
import InlinePlanTray from '../components/harness/InlinePlanTray'
import PermissionApprovalPanel from '../components/harness/PermissionApprovalPanel'
import { useTopicPending } from '../hooks/harness/useTopicPending'
import WelcomeIntro from '../components/harness/WelcomeIntro'
import QueueDock from '../components/harness/QueueDock'
import TaskProgressCard from '../components/harness/TaskProgressCard'
import AskQuestionModal from '../components/harness/AskQuestionModal'
import ModelRecoveryModal from '../components/harness/ModelRecoveryModal'
import WorkspacePanel, { type WorkspacePanelHandle } from '../components/harness/WorkspacePanel'
import { useSubagentConversation } from '../hooks/harness/useSubagentConversation'
import type {
  ApprovalDecision,
  ApprovalRequestView,
  SubagentSessionRow
} from '../../../shared/harness/types'
import {
  WorkspaceBridgeContext,
  type WorkspaceBridge,
  type ToolDetailRequest
} from '../contexts/harness/workspace-bridge'
import { SubagentViewContext } from '../contexts/harness/subagent-view-bridge'
import {
  MAIN_MIN_WIDTH,
  PANEL_MIN_WITHOUT_EDITOR,
  autoOpenPanelWidth,
  clampWidth,
  computePanelMaxWidth,
  panelMinWidthFor
} from '../utils/harness/panelLayout'
import { harnessApi } from '../api/harness'

/**
 * AI 助手页面（路由 `/harness`）。
 *
 * 外壳负责侧栏与标题，这一页是对话主区：
 * 顶部状态条 → 消息区 → 目标/任务/队列浮层 → 输入框，右侧可展开工作区面板。
 * 懒加载入口见 `route/MainRoutes.tsx`；页面内部状态全部来自 HarnessProvider。
 */
const Harness: React.FC = () => {
  const {
    token: {
      colorBgContainer,
      borderRadiusLG,
      colorBgLayout,
      colorFillAlter,
      colorText,
      colorTextSecondary,
      colorTextTertiary,
      colorBorder,
      colorBorderSecondary,
      colorPrimary,
      colorPrimaryBg
    }
  } = theme.useToken()
  const { effectiveTheme } = useTheme()
  const isDarkMode = effectiveTheme === 'dark'
  const { t } = useTranslation()
  const { message } = App.useApp()

  const {
    messages,
    inputValue,
    setInputValue,
    copiedId,
    currentTopicId,
    /** 当前会话已归档 = 只读：不渲染输入框（用户 2026-11-25「选中之后对话输入框应该不要显示」） */
    currentTopicArchived,
    selectedProviderId,
    setSelectedProviderId,
    attachments,
    setAttachments,
    providers,
    isLoading,
    messagesEndRef,
    textareaRef,
    inputHistoryRef,
    modelSupportsTools,
    modelSupportsVision,
    groupedProviderOptions,
    messagesHasMore,
    messagesLoadingMore,
    handleCopy,
    handleSend,
    /** 每次外部请求聚焦输入框自增（插件行的 ＋）：输入框据此把光标放进去 */
    focusInputToken,
    handleDeleteMessagePair,
    handleStartEditMessage,
    handleSubmitEditMessage,
    handleCancelEditMessage,
    editingMessageId,
    handleBranchConversation,
    handleKeyDown,
    handleStop,
    handleStartGoal,
    handleLoadMoreMessages,
    queuedMessages,
    steeredNotice,
    handleRemoveQueued,
    handleUpdateQueued,
    handleSteerQueued,
    agentSelection,
    setAgentSelection
  } = useHarness()

  /** 目标编辑 / 计划模式切换的触发计数器：斜杠命令只负责递增，具体内联区自己处理 */
  const [planToggleSignal, setPlanToggleSignal] = useState(0)
  /**
   * 目标输入态：不在目标卡片里再开一个 textarea，而是复用底部对话输入框。
   * 点目标铅笔 / `/goal` 进入；Enter 保存目标并立即发起一轮 LLM，Esc 退出。
   */
  const [goalCompose, setGoalCompose] = useState(false)
  /** 计划评审挂起：锁目标操作与输入框，评审反馈只在计划卡内 */
  const [planReviewPending, setPlanReviewPending] = useState(false)

  /** 权限授权：挂起审批存在时，输入区整体让位给内联审批面板 */
  const fetchApprovalPending = useCallback(
    (topicId: number) => harnessApi.harness.getApproval(topicId),
    []
  )
  const subscribeApproval = useCallback(
    (listener: (pending: ApprovalRequestView) => void) =>
      harnessApi.harness.onApprovalAsked(listener),
    []
  )
  const { pending: approvalPending, clear: clearApprovalPending } =
    useTopicPending<ApprovalRequestView>({
      currentTopicId,
      fetchPending: fetchApprovalPending,
      subscribe: subscribeApproval
    })
  const [approvalSubmitting, setApprovalSubmitting] = useState(false)
  const handleDecideApproval = useCallback(
    async (decision: ApprovalDecision): Promise<void> => {
      if (!approvalPending || approvalSubmitting) return
      setApprovalSubmitting(true)
      try {
        await harnessApi.harness.decideApproval(approvalPending.requestId, decision)
        clearApprovalPending()
      } catch (err) {
        message.error((err as Error).message)
      } finally {
        setApprovalSubmitting(false)
      }
    },
    [approvalPending, approvalSubmitting, clearApprovalPending, message]
  )

  // 模型就绪检查：应用即开即用，只有「助手」页依赖模型配置——未配置时在本页内引导
  const hasModels = providers.length > 0
  const [workspacePath, setWorkspacePath] = useState<string>('')
  /** 是否已配置工作区：null = 检查中（此时不显示引导，避免闪现） */
  const [hasWorkspace, setHasWorkspace] = useState<boolean | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelHasEditor, setPanelHasEditor] = useState(false)
  /**
   * 正在查看的后台子代理会话（顶部栏右侧入口点开）。
   *
   * 非空时主对话区（用户圈中的区域）整体切换成该子代理的流式会话视图；
   * 「返回主智能体」把这里置回 null，主对话的 messages/流式状态在 Provider 里
   * 原样保留，切回来不会丢内容或中断主代理。
   */
  const [subagentView, setSubagentView] = useState<{
    topicId: number
    agentId: string
    label: string
  } | null>(null)
  /** 切换会话：子代理会话按话题隔离，换话题必须回到主对话 */
  useEffect(() => {
    setSubagentView(null)
  }, [currentTopicId])

  const handleSelectSubagent = useCallback(
    (agent: SubagentSessionRow): void => {
      if (currentTopicId == null) return
      setSubagentView({ topicId: currentTopicId, agentId: agent.id, label: agent.label })
    },
    [currentTopicId]
  )
  const handleBackToMainAgent = useCallback((): void => setSubagentView(null), [])
  /** 主对话「已派发」卡片 → 打开对应子代理的会话视图（agentId 来自 block.subAgent.subagentId） */
  const handleOpenSubagentById = useCallback(
    (agentId: string): void => {
      if (currentTopicId == null || !agentId) return
      setSubagentView({ topicId: currentTopicId, agentId, label: '' })
    },
    [currentTopicId]
  )
  /** 引用稳定的桥对象：AssistantMessage 的块级渲染缓存不感知函数 props（见 subagent-view-bridge 注释） */
  const subagentViewBridge = useMemo(
    () => ({ openSubagent: handleOpenSubagentById }),
    [handleOpenSubagentById]
  )
  /**
   * 子代理会话数据：顶部栏面包屑与会话视图共用同一份订阅（一个 agent 只 watch 一次）。
   * 非查看态传入 null，hook 返回空状态，不产生 IPC。
   */
  const subagentConversation = useSubagentConversation(
    subagentView?.topicId ?? null,
    subagentView?.agentId ?? null
  )
  /** 子代理会话消息区的底部锚点（与主对话各用各的 ref，切 target 时 ConversationPane 实例复用） */
  const subagentMessagesEndRef = useRef<HTMLDivElement | null>(null)
  /** 子代理会话是只读视图：编辑/删除/分支/分页一律 no-op */
  const subagentNoop = useCallback((): void => {}, [])
  const subagentNoopAsync = useCallback(async (): Promise<void> => {}, [])
  /** 查看子代理会话时 Esc = 返回主智能体（输入框内不拦截，避免吞掉输入法/取消语义） */
  useEffect(() => {
    if (!subagentView) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const target = document.activeElement
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')
      ) {
        return
      }
      handleBackToMainAgent()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleBackToMainAgent, subagentView])
  /**
   * 待审查改动（路径 → 条数），由右侧面板回传。
   * 用途只有一个：任务段头上的改动徽标——段折起后段里的编辑卡片会被卸载，
   * 聊天里必须有个还看得见「这段改了什么」的地方（用户 2026-09-23 报的问题）。
   */
  const [pendingByPath, setPendingByPath] = useState<Map<string, number>>(new Map())
  /** 右侧工作区面板的命令式入口（工具卡片点击 → 打开文件 / 定位目录 / 结果详情页签） */
  const workspacePanelRef = useRef<WorkspacePanelHandle>(null)

  const checkWorkspace = useCallback(async (): Promise<boolean> => {
    try {
      const settings = await window.api.systemSettings.getAll()
      const wsPath = settings.harness?.workspacePath || ''
      setWorkspacePath(wsPath)
      const ok = Boolean(settings.harness?.activeWorkspaceId)
      setHasWorkspace(ok)
      return ok
    } catch {
      setHasWorkspace(false)
      return false
    }
  }, [])

  useEffect(() => {
    checkWorkspace().then()
  }, [checkWorkspace])

  // 引导项：选择目录创建并激活工作区（与侧边栏「新建工作区」同一套流程）
  const handleWorkspaceSetup = useCallback(async (): Promise<void> => {
    try {
      const dir = await harnessApi.harness.selectWorkspace()
      if (!dir) return
      const name =
        dir
          .replace(/[/\\]$/, '')
          .split(/[/\\]/)
          .pop() || t('harness.sidebar.defaultWorkspaceName')
      const id = await harnessApi.harness.createWorkspace(name, dir)
      await window.api.systemSettings.update({
        harness: {
          workspacePath: dir,
          activeWorkspaceId: id
        } as Parameters<typeof window.api.systemSettings.update>[0]['harness']
      })
      setWorkspacePath(dir)
      setHasWorkspace(true)
      window.dispatchEvent(new CustomEvent('workspace-changed', { detail: { workspaceId: id } }))
      // 会话列表由 Provider 的 `workspace-changed` 订阅统一重拉（见 useHarnessHandlers），
      // 这里再拉一次只会多打一次库
    } catch (err) {
      console.error('Failed to setup workspace:', err)
    }
  }, [t])

  /**
   * 工作区切换后刷新工作区路径（资源管理器根 / 虚拟路径映射）。
   *
   * 会话列表**不在这里**拉：那条订阅已经挪到 Provider（`useHarnessHandlers`），因为切工作区的
   * 入口大多在 `/plugins` 与常驻侧栏上——本页没挂载时收不到事件，列表就会停在上一个工作区，
   * 侧栏一直显示加载骨架。
   */
  const handleWorkspaceChange = useCallback(async () => {
    await checkWorkspace()
  }, [checkWorkspace])

  // 全局工作区切换：本页只重读工作区路径（资源管理器根 / 虚拟路径映射）；
  // 会话列表由 Provider 的同名订阅负责，见 useHarnessHandlers。
  // 不再顺带 handleNewHarness()——「点开其他工作区下的会话」时那一步会把刚选中的会话清空再重设，
  // 造成列表与选中高亮闪动；需要回到空白欢迎态的入口（新建会话/新建工作区/删除工作区）
  // 由侧边栏显式调用 onNewHarness()。
  const handleWorkspaceChangedRef = useRef<() => void>(() => {})
  useEffect(() => {
    handleWorkspaceChangedRef.current = () => {
      handleWorkspaceChange().then()
    }
  })
  useEffect(() => {
    const onWorkspaceChanged = (): void => {
      handleWorkspaceChangedRef.current()
    }
    window.addEventListener('workspace-changed', onWorkspaceChanged)
    return () => window.removeEventListener('workspace-changed', onWorkspaceChanged)
  }, [])

  /**
   * 虚拟路径 → 工作区真实路径。
   *
   * 工具卡片里的路径是虚拟路径（'/' 挂在 AI 工作区、'/memories/' 挂在记忆目录）。
   * 资源管理器只认真实绝对路径，所以只有工作区挂载能映射；记忆挂载返回 null，
   * 这类文件由面板以只读页签打开（主进程的挂载解析负责边界校验）。
   */
  const toRealPath = useCallback(
    (virtualPath: string): string | null => {
      if (!workspacePath) return null
      const normalized = virtualPath.replace(/\\/g, '/')
      if (normalized === '/memories' || normalized.startsWith('/memories/')) return null
      const segments = normalized.replace(/^\/+/, '').split('/').filter(Boolean)
      const root = workspacePath.replace(/[\\/]+$/, '')
      if (segments.length === 0) return root
      const sep = workspacePath.includes('\\') ? '\\' : '/'
      return `${root}${sep}${segments.join(sep)}`
    },
    [workspacePath]
  )

  /** 面板尚未挂载时（第一次从关闭状态点卡片）暂存动作，挂载完成后补执行 */
  const pendingPanelActionRef = useRef<((handle: WorkspacePanelHandle) => void) | null>(null)
  const runOnPanel = useCallback((action: (handle: WorkspacePanelHandle) => void): void => {
    const handle = workspacePanelRef.current
    if (handle) action(handle)
    else pendingPanelActionRef.current = action
    setPanelOpen(true)
  }, [])
  useEffect(() => {
    if (!panelOpen) return
    const action = pendingPanelActionRef.current
    const handle = workspacePanelRef.current
    if (!action || !handle) return
    pendingPanelActionRef.current = null
    action(handle)
  }, [panelOpen, panelHasEditor])

  /**
   * 工具卡片 → 右侧工作区面板的桥（见 contexts/WorkspaceBridgeContext）。
   * 点击行为按工具语义分派：文件类打开真实文件、ls 定位目录、其余打开结果详情页签。
   */
  const workspaceBridge = useMemo<WorkspaceBridge>(
    () => ({
      openFile: (virtualPath) => {
        runOnPanel((handle) => handle.openVirtualFile(virtualPath, toRealPath(virtualPath)))
      },
      revealPath: (virtualPath) => {
        const realPath = toRealPath(virtualPath)
        if (!realPath) return false
        runOnPanel((handle) => handle.revealPath(realPath))
        return true
      },
      openToolDetail: (request: ToolDetailRequest) => {
        runOnPanel((handle) => handle.openToolDetail(request))
      }
    }),
    [runOnPanel, toRealPath]
  )

  const scrollbarThumbColor = isDarkMode ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'
  const scrollbarThumbHoverColor = isDarkMode ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)'
  const inputScrollbarThumbColor = isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'
  const inputScrollbarThumbHoverColor = isDarkMode ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'
  /**
   * 当前模型的上下文窗口：输入框底栏的占用圆环按它算百分比。
   *
   * 唯一来源是供应商档案的 `metadata.context_window`（设置里可手填、从模型档案带出）；
   * 没填就返回 null，底栏只显示 token 与缓存命中，不画圆环——不猜窗口大小。
   */
  const modelContextWindow = useMemo(() => {
    const provider = providers.find((item) => item.id === selectedProviderId)
    const contextWindow = provider?.metadata?.context_window
    return typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : null
  }, [providers, selectedProviderId])
  /**
   * 空白会话（还没有任何消息）：把「欢迎语 + 输入框」当成一组整体垂直居中。
   *
   * 用户 2026-11-19 口径「对话窗口的输入框应该垂直居中和标语一样垂直居中」——
   * 空会话时输入框不再钉在底部，而是跟欢迎标语一起作为开场画面居中；
   * 发第一条消息后自动切回「消息列表 + 底部输入框」的常规布局。
   */
  const isWelcomeMode = messages.length === 0
  /** 进入目标输入态：把目标正文放进底部输入框（不额外造输入控件） */
  const beginGoalCompose = useCallback(
    async (prefill?: string): Promise<void> => {
      if (currentTopicId == null) {
        message.info(t('harness.input.commands.noTopic'))
        return
      }
      if (planReviewPending) return
      let text = prefill
      if (text === undefined) {
        const goal = await harnessApi.harness.getGoal(currentTopicId).catch(() => null)
        text = goal?.objective ?? ''
      }
      setInputValue(text)
      setGoalCompose(true)
    },
    [currentTopicId, message, planReviewPending, setInputValue, t]
  )

  const cancelGoalCompose = useCallback((): void => {
    setGoalCompose(false)
    setInputValue('')
  }, [setInputValue])

  /** 目标输入态回车：先写 GoalStore，再把输入框原文当作执行指令发出去 */
  const submitGoalFromInput = useCallback(async (): Promise<void> => {
    const topicId = currentTopicId
    const text = inputValue.trim()
    if (topicId == null || !text) return
    const existing = await harnessApi.harness.getGoal(topicId).catch(() => null)
    const result =
      existing && existing.phase !== 'complete'
        ? await harnessApi.harness.updateGoal({ topicId, action: 'edit', objective: text })
        : await harnessApi.harness.createGoal({ topicId, objective: text })
    if (!result.ok) {
      message.error(result.error ?? t('harness.goalInline.saveFailed'))
      return
    }
    setGoalCompose(false)
    setInputValue('')
    await handleStartGoal(text)
  }, [currentTopicId, handleStartGoal, inputValue, message, setInputValue, t])

  /** 输入框在目标输入态下的发送入口（Enter 与发送按钮共用） */
  const handleComposerSend = useCallback((): void => {
    if (planReviewPending) return
    if (goalCompose) {
      void submitGoalFromInput()
      return
    }
    void handleSend()
  }, [goalCompose, handleSend, planReviewPending, submitGoalFromInput])

  const handleComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (planReviewPending) return
      if (goalCompose) {
        if (event.key === 'Escape') {
          event.preventDefault()
          cancelGoalCompose()
          return
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          void submitGoalFromInput()
          return
        }
      }
      handleKeyDown(event)
    },
    [cancelGoalCompose, goalCompose, handleKeyDown, planReviewPending, submitGoalFromInput]
  )

  // 目标输入态：切换话题时退出；挂全局 Esc（HarnessInput 只在 Enter 时回调）
  useEffect(() => {
    if (!goalCompose) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      cancelGoalCompose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cancelGoalCompose, goalCompose])

  useEffect(() => {
    if (!goalCompose) return
    const timer = window.setTimeout(() => {
      const editor = textareaRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')
      editor?.focus()
    }, 40)
    return () => window.clearTimeout(timer)
  }, [goalCompose, textareaRef])

  useEffect(() => {
    setGoalCompose(false)
  }, [currentTopicId])

  useEffect(() => {
    if (!planReviewPending || !goalCompose) return
    setGoalCompose(false)
    setInputValue('')
  }, [goalCompose, planReviewPending, setInputValue])

  /** 输入区：主对话与子代理共用同一个 ConversationFooter 外壳，只有内层控件不同 */
  const inputArea = approvalPending ? (
    <ConversationFooter
      welcome={false}
      colorBgContainer={colorBgContainer}
      colorBorderSecondary={colorBorderSecondary}
    >
      <PermissionApprovalPanel
        pending={approvalPending}
        submitting={approvalSubmitting}
        onDecide={handleDecideApproval}
      />
    </ConversationFooter>
  ) : (
    <ConversationFooter
      welcome={isWelcomeMode}
      colorBgContainer={colorBgContainer}
      colorBorderSecondary={colorBorderSecondary}
      top={
        <>
          <InlinePlanTray
            currentTopicId={currentTopicId}
            toggleSignal={planToggleSignal}
            onCancelTurn={handleStop}
            onReviewPendingChange={setPlanReviewPending}
            isDarkMode={isDarkMode}
          />
          <InlineGoalCard
            currentTopicId={currentTopicId}
            selected={goalCompose}
            disabled={planReviewPending}
            onRequestEdit={(objective) => void beginGoalCompose(objective)}
          />
          <TaskProgressCard currentTopicId={currentTopicId} />
          <QueueDock
            queue={queuedMessages}
            running={isLoading}
            steeredNotice={steeredNotice}
            colorBorderSecondary={colorBorderSecondary}
            colorText={colorText}
            colorTextSecondary={colorTextSecondary}
            colorTextTertiary={colorTextTertiary}
            colorFillAlter={colorFillAlter}
            onRemove={handleRemoveQueued}
            onUpdate={handleUpdateQueued}
            onSteer={handleSteerQueued}
          />
        </>
      }
    >
      <HarnessInput
        inputValue={inputValue}
        onInputChange={setInputValue}
        focusInputToken={focusInputToken}
        textareaRef={textareaRef}
        inputHistoryRef={inputHistoryRef}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        isLoading={isLoading}
        selectedProviderId={selectedProviderId}
        onSelectProvider={(value) => setSelectedProviderId(value)}
        groupedProviderOptions={groupedProviderOptions}
        modelSupportsTools={modelSupportsTools}
        modelSupportsVision={modelSupportsVision}
        currentTopicId={currentTopicId}
        /* 助手形象只在空白会话里出现：有对话内容时会压住消息/思考过程 */
        showMascot={isWelcomeMode}
        modelContextWindow={modelContextWindow}
        isDarkMode={isDarkMode}
        colorBgLayout={colorBgLayout}
        colorBorder={colorBorder}
        colorText={colorText}
        colorBorderSecondary={colorBorderSecondary}
        onSend={handleComposerSend}
        onStop={handleStop}
        onKeyDown={handleComposerKeyDown}
        placeholder={goalCompose ? t('harness.goalInline.composePlaceholder') : undefined}
        goalCompose={goalCompose}
        locked={planReviewPending}
        onGoalCommand={() => void beginGoalCompose()}
        onPlanCommand={() => setPlanToggleSignal((value) => value + 1)}
        agentSelection={agentSelection}
        onAgentSelectionChange={setAgentSelection}
      />
    </ConversationFooter>
  )

  // 对话区实际可用宽度（主内容区宽度）；面板宽度上限以它为准
  const layoutRef = useRef<HTMLDivElement>(null)
  const [layoutWidth, setLayoutWidth] = useState(0)

  useEffect(() => {
    const el = layoutRef.current
    if (!el) return
    const update = (): void => setLayoutWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Workspace panel resizer
  const [panelWidth, setPanelWidth] = useState(() =>
    Math.max(500, Math.floor(window.innerWidth * 0.4))
  )

  const panelMinWidth = panelMinWidthFor(panelHasEditor)
  /* 面板宽度上限：比例上限（大屏会从 45% 放开到 65%）与「对话至少 MAIN_MIN_WIDTH」取小。
     宽度策略与全部常量同源在 utils/panelLayout.ts——<main> 的 minWidth 也取同一个常量，
     不再两处各写一份（曾经的 410/420 漂移会让面板多出 10px 被裁掉）。 */
  const panelMaxWidth = computePanelMaxWidth({
    layoutWidth,
    hasEditor: panelHasEditor,
    sidebarOpen: false,
    sidebarWidth: 0
  })

  // 面板宽度策略：编辑器打开/关闭时自动展开/收窄；其余变化（窗口缩放）
  // 只把宽度收敛回合法区间，保留用户拖拽结果，避免溢出出现横向滚动条
  const prevHasEditorRef = useRef(panelHasEditor)
  useEffect(() => {
    if (panelHasEditor === prevHasEditorRef.current) {
      setPanelWidth((prev) => clampWidth(prev, panelMinWidth, panelMaxWidth))
      return
    }
    prevHasEditorRef.current = panelHasEditor
    setPanelWidth(
      panelHasEditor ? autoOpenPanelWidth(layoutWidth, panelMaxWidth) : PANEL_MIN_WITHOUT_EDITOR
    )
  }, [panelHasEditor, layoutWidth, panelMinWidth, panelMaxWidth])

  const panelDraggingRef = useRef(false)

  const handlePanelResizerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      panelDraggingRef.current = true
      const startX = e.clientX
      const startWidth = panelWidth

      const handleMouseMove = (ev: MouseEvent): void => {
        if (!panelDraggingRef.current) return
        const newWidth = clampWidth(
          startWidth - (ev.clientX - startX),
          panelMinWidth,
          panelMaxWidth
        )
        setPanelWidth(newWidth)
      }

      const handleMouseUp = (): void => {
        panelDraggingRef.current = false
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [panelWidth, panelMinWidth, panelMaxWidth]
  )

  return (
    <SubagentViewContext.Provider value={subagentViewBridge}>
      <WorkspaceBridgeContext.Provider value={workspaceBridge}>
        <div className="h-full flex-1">
          <style>{`
        .harness-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
        .harness-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .harness-scrollbar::-webkit-scrollbar-thumb {
          background: ${scrollbarThumbColor};
          border-radius: 4px;
          transition: background 0.2s;
        }
        .harness-scrollbar::-webkit-scrollbar-thumb:hover { background: ${scrollbarThumbHoverColor}; }
        .harness-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: ${scrollbarThumbColor} transparent;
        }
        .input-scrollbar textarea::-webkit-scrollbar { width: 4px; }
        .input-scrollbar textarea::-webkit-scrollbar-track { background: transparent; }
        .input-scrollbar textarea::-webkit-scrollbar-thumb {
          background: ${inputScrollbarThumbColor};
          border-radius: 2px;
          transition: background 0.2s;
        }
        .input-scrollbar textarea::-webkit-scrollbar-thumb:hover { background: ${inputScrollbarThumbHoverColor}; }
        .input-scrollbar textarea {
          scrollbar-width: thin;
          scrollbar-color: ${inputScrollbarThumbColor} transparent;
        }
        .history-scrollbar::-webkit-scrollbar { width: 4px; }
        .history-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .history-scrollbar::-webkit-scrollbar-thumb {
          background: ${inputScrollbarThumbColor};
          border-radius: 2px;
        }
        .history-scrollbar::-webkit-scrollbar-thumb:hover { background: ${inputScrollbarThumbHoverColor}; }
        .history-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: ${inputScrollbarThumbColor} transparent;
        }
        .harness-resizer {
          width: 6px;
          cursor: col-resize;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
        }
        .harness-resizer-dragger {
          width: 2px;
          height: calc(100% - 16px);
          border-radius: 1px;
          background: ${isDarkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'};
          transition: background 0.15s;
        }
        .harness-resizer:hover .harness-resizer-dragger {
          background: ${isDarkMode ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)'};
        }
      `}</style>

          <div
            ref={layoutRef}
            className="harness-layout"
            style={{ height: '100%', display: 'flex', overflow: 'hidden' }}
          >
            <main
              className="h-full flex flex-col overflow-hidden"
              style={{
                flex: 1,
                minWidth: MAIN_MIN_WIDTH,
                background: colorBgContainer,
                borderTopLeftRadius: borderRadiusLG
              }}
            >
              {hasWorkspace === null ? null : hasWorkspace === false ? (
                /* 未配置工作区：对话按工作区隔离，先引导选择目录（同「配置模型」的页内引导） */
                <div
                  className="flex-1 flex items-center justify-center"
                  style={{ minHeight: 0, padding: 24 }}
                >
                  <div style={{ maxWidth: 420, textAlign: 'center' }}>
                    <div
                      style={{
                        width: 56,
                        height: 56,
                        margin: '0 auto 14px',
                        borderRadius: 16,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: colorPrimaryBg,
                        color: colorPrimary,
                        fontSize: 26
                      }}
                    >
                      <RiFoldersLine size={26} />
                    </div>
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: colorText }}>
                      {t('harness.index.setupWorkspaceTitle')}
                    </h2>
                    <p style={{ margin: '8px 0 20px', fontSize: 13, color: colorTextSecondary }}>
                      {t('harness.index.setupWorkspaceDescription')}
                    </p>
                    <Button
                      type="primary"
                      icon={<RiFoldersLine size={15} />}
                      onClick={handleWorkspaceSetup}
                    >
                      {t('harness.index.setupWorkspaceButton')}
                    </Button>
                  </div>
                </div>
              ) : !hasModels ? (
                /* 模型未配置：仅「助手」页内引导，不影响其他功能使用 */
                <div
                  className="flex-1 flex items-center justify-center"
                  style={{ minHeight: 0, padding: 24 }}
                >
                  <div style={{ maxWidth: 420, textAlign: 'center' }}>
                    <div
                      style={{
                        width: 56,
                        height: 56,
                        margin: '0 auto 14px',
                        borderRadius: 16,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: colorPrimaryBg,
                        color: colorPrimary,
                        fontSize: 26
                      }}
                    >
                      <RiChatAiLine size={26} />
                    </div>
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: colorText }}>
                      {t('harness.index.setupModelTitle')}
                    </h2>
                    <p style={{ margin: '8px 0 20px', fontSize: 13, color: colorTextSecondary }}>
                      {t('harness.index.setupModelDescription')}
                    </p>
                    <Button
                      type="primary"
                      icon={<RiListSettingsLine size={15} />}
                      onClick={() =>
                        window.dispatchEvent(
                          new CustomEvent('open-system-settings', { detail: { tab: 'model' } })
                        )
                      }
                    >
                      {t('harness.index.setupModelButton')}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <HarnessHeader
                    panelOpen={panelOpen}
                    onTogglePanel={() => setPanelOpen(!panelOpen)}
                    colorBorderSecondary={colorBorderSecondary}
                    currentTopicId={currentTopicId}
                    onSelectSubagent={handleSelectSubagent}
                    activeSubagentId={subagentView?.agentId ?? null}
                    onBackToMainAgent={handleBackToMainAgent}
                    subagentBreadcrumb={
                      subagentView
                        ? {
                            agentId: subagentView.agentId,
                            name:
                              subagentConversation.meta?.label ||
                              subagentConversation.meta?.name ||
                              subagentView.label ||
                              subagentView.agentId,
                            status: subagentConversation.meta?.status ?? 'running',
                            lastStatus: subagentConversation.meta?.lastStatus,
                            queuedMessages: subagentConversation.meta?.queuedMessages ?? 0
                          }
                        : null
                    }
                  />

                  {/* 对话主区：主智能体与后台子智能体共用同一个 ConversationPane
                     （消息窗口 + 底部输入区）。切 target 时组件实例复用、只换数据源——
                     用户口径：消息区域也要复用之前的对话窗口。 */}
                  {subagentView ? (
                    <ConversationPane
                      messages={subagentConversation.messages}
                      streaming={subagentConversation.streaming}
                      currentTopicId={subagentView.topicId}
                      readOnly
                      isDarkMode={isDarkMode}
                      colorText={colorText}
                      colorTextSecondary={colorTextSecondary}
                      colorTextTertiary={colorTextTertiary}
                      colorFillAlter={colorFillAlter}
                      colorBorderSecondary={colorBorderSecondary}
                      copiedId={copiedId}
                      hasMoreMessages={subagentConversation.hasOlder}
                      isLoadingMoreMessages={subagentConversation.loadingOlder}
                      onCopy={handleCopy}
                      onDelete={subagentNoopAsync}
                      onStartEditMessage={subagentNoop}
                      onSubmitEditMessage={subagentNoopAsync}
                      onCancelEditMessage={subagentNoop}
                      editingMessageId={null}
                      onBranch={subagentNoopAsync}
                      onLoadMoreMessages={subagentConversation.loadMore}
                      messagesEndRef={subagentMessagesEndRef}
                      empty={
                        !subagentConversation.ready ? (
                          <>
                            <Spin size="small" />
                            <span style={{ fontSize: 12, color: colorTextTertiary }}>
                              {t('harness.backgroundAgents.conversation.loading')}
                            </span>
                          </>
                        ) : (
                          <>
                            <RiAiAgentLine size={22} style={{ color: colorTextTertiary }} />
                            <span style={{ fontSize: 12, color: colorTextTertiary }}>
                              {subagentConversation.meta
                                ? t('harness.backgroundAgents.conversation.empty')
                                : t('harness.backgroundAgents.conversation.missing')}
                            </span>
                          </>
                        )
                      }
                      footer={
                        subagentConversation.meta ? (
                          <SubagentInput
                            topicId={subagentView.topicId}
                            agentId={subagentView.agentId}
                            running={subagentConversation.meta.status === 'running'}
                            isDarkMode={isDarkMode}
                            colorBgLayout={colorBgLayout}
                            colorBgContainer={colorBgContainer}
                            colorBorder={colorBorder}
                            colorText={colorText}
                            colorBorderSecondary={colorBorderSecondary}
                          />
                        ) : null
                      }
                    />
                  ) : isWelcomeMode ? (
                    /* 空白会话：欢迎语和输入框作为一组整体垂直居中。
                     顶部栏保留——工作区面板开关在空白会话里也要能开/关，
                     否则在已有会话里打开面板后再新建会话就关不掉了。 */
                    <div className="flex-1 min-h-0 flex flex-col justify-center pt-6 pb-10">
                      <div className="w-full max-w-2xl mx-auto px-8">
                        <WelcomeIntro
                          colorText={colorText}
                          colorTextSecondary={colorTextSecondary}
                        />
                      </div>
                      {/* 归档会话只读：输入框整个不渲染（用户口径：不要提示条，什么都不要留） */}
                      {currentTopicArchived ? null : inputArea}
                    </div>
                  ) : (
                    <ConversationPane
                      messages={messages}
                      streaming={isLoading}
                      currentTopicId={currentTopicId}
                      readOnly={currentTopicArchived}
                      isDarkMode={isDarkMode}
                      colorText={colorText}
                      colorTextSecondary={colorTextSecondary}
                      colorTextTertiary={colorTextTertiary}
                      colorFillAlter={colorFillAlter}
                      colorBorderSecondary={colorBorderSecondary}
                      copiedId={copiedId}
                      hasMoreMessages={messagesHasMore}
                      isLoadingMoreMessages={messagesLoadingMore}
                      onCopy={handleCopy}
                      onDelete={handleDeleteMessagePair}
                      onStartEditMessage={handleStartEditMessage}
                      onSubmitEditMessage={handleSubmitEditMessage}
                      onCancelEditMessage={handleCancelEditMessage}
                      editingMessageId={editingMessageId}
                      onBranch={handleBranchConversation}
                      onLoadMoreMessages={handleLoadMoreMessages}
                      messagesEndRef={messagesEndRef}
                      pendingByPath={pendingByPath}
                      onOpenChangedFile={(realPath) => {
                        // 段头徽标 → 直接打开该文件的差异视图（工作区内的真实路径）
                        runOnPanel((handle) => handle.openVirtualFile(realPath, realPath))
                      }}
                      footer={currentTopicArchived ? null : inputArea}
                    />
                  )}
                </>
              )}
            </main>

            {/* Workspace panel resizer */}
            {panelOpen && (
              <>
                <div className="harness-resizer" onMouseDown={handlePanelResizerMouseDown}>
                  <div className="harness-resizer-dragger" />
                </div>
                <div
                  style={{
                    width: panelWidth,
                    minWidth: panelMinWidth,
                    maxWidth: panelMaxWidth,
                    flexShrink: 0
                  }}
                >
                  <WorkspacePanel
                    ref={workspacePanelRef}
                    workspacePath={workspacePath}
                    isDarkMode={isDarkMode}
                    colorBgContainer={colorBgContainer}
                    borderRadiusLG={borderRadiusLG}
                    colorText={colorText}
                    colorTextSecondary={colorTextSecondary}
                    colorTextTertiary={colorTextTertiary}
                    onHasOpenFilesChange={setPanelHasEditor}
                    onPendingByPathChange={setPendingByPath}
                  />
                </div>
              </>
            )}
          </div>

          {/* 提问弹窗：ask_user_question 工具挂起时收集用户回答 */}
          <AskQuestionModal currentTopicId={currentTopicId} onCancelTurn={handleStop} />
          {/* 模型请求失败弹窗：自动重试耗尽后选择是否切换模型继续（原位继续，不重发问题） */}
          <ModelRecoveryModal currentTopicId={currentTopicId} />
        </div>
      </WorkspaceBridgeContext.Provider>
    </SubagentViewContext.Provider>
  )
}

export default Harness
