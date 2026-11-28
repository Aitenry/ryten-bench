import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { theme, Button, Spin, App } from 'antd'
import { RiAiAgentLine, RiChatAiLine, RiFoldersLine, RiListSettingsLine } from '@remixicon/react'
import { useTheme } from '@renderer/hooks/useTheme'
import { useTranslation } from '@renderer/i18n'
import { useHarness } from '../contexts/harness/HarnessContextCore'
import HarnessHeader from '../components/harness/HarnessHeader'
import TerminalPanel from '../components/harness/TerminalPanel'
import BrowserPanel from '../components/harness/BrowserPanel'
import StartPage, { type StartToolKind } from './StartPage'
import ConversationPane from '../components/harness/ConversationPane'
import ConversationFooter from '../components/harness/ConversationFooter'
import SubagentInput from '../components/harness/SubagentInput'
import HarnessInput from '../components/harness/HarnessInput'
import InlineGoalCard from '../components/harness/InlineGoalCard'
import InlinePlanTray from '../components/harness/InlinePlanTray'
import PermissionApprovalPanel from '../components/harness/PermissionApprovalPanel'
import AskQuestionPanel from '../components/harness/AskQuestionPanel'
import ProposalPrefillBar from '../components/harness/ProposalPrefillBar'
import { useTopicPending } from '../hooks/harness/useTopicPending'
import { findPendingProposal } from '../utils/harness/proposal'
import WelcomeIntro from '../components/harness/WelcomeIntro'
import QueueDock from '../components/harness/QueueDock'
import TaskProgressCard from '../components/harness/TaskProgressCard'
import ModelRecoveryModal from '../components/harness/ModelRecoveryModal'
import WorkspacePanel, { type WorkspacePanelHandle } from '../components/harness/WorkspacePanel'
import { useSubagentConversation } from '../hooks/harness/useSubagentConversation'
import type {
  ApprovalDecision,
  ApprovalRequestView,
  PendingQuestionView,
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
 * AI assistant page (route `/harness`).
 *
 * The shell owns the sidebar and title; this page is the main conversation area:
 * top status bar → message area → goal/task/queue overlays → input box, with a collapsible
 * workspace panel on the right.
 * Lazy-loaded from `route/MainRoutes.tsx`; all in-page state comes from HarnessProvider.
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
    /**
     * Current topic is archived = read-only: do not render the input (user request 2026-11-25: hide
     * the chat input once selected)
     */
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
    /**
     * Incremented on every external focus request (the + in plugin rows): the input moves the caret
     * in on change
     */
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
    setAgentSelection,
    /**
     * Team-collaboration draft for a blank conversation (persisted when the first message creates
     * the topic)
     */
    pendingTeamMode,
    setPendingTeamMode,
    /**
     * Message to jump to after a conversation search hit (sidebar search → open topic and scroll to
     * it)
     */
    pendingJumpDialogueId,
    clearPendingJumpDialogueId
  } = useHarness()

  /**
   * Trigger counter for goal editing / plan mode toggling: slash commands only increment it, the
   * inline areas handle the rest
   */
  const [planToggleSignal, setPlanToggleSignal] = useState(0)
  /**
   * Goal compose mode: instead of opening another textarea inside the goal card, reuse the
   * bottom chat input. Entered via the goal pencil / `/goal`; Enter saves the goal and starts
   * an LLM turn immediately, Esc exits.
   */
  const [goalCompose, setGoalCompose] = useState(false)
  /** Round limit for goal compose mode (null = backend default of 256) */
  const [goalRoundsLimit, setGoalRoundsLimit] = useState<number | null>(null)
  /**
   * Plan review pending: locks goal actions and the input; review feedback stays in the plan card
   */
  const [planReviewPending, setPlanReviewPending] = useState(false)

  /**
   * Pending propose_action (used by the input-area prefill bar; user request 2026-11-27).
   *
   * Only a propose_action in the latest assistant message after the last user message counts;
   * no cards are rendered in the message stream anymore. Dismissing with ✕ records the key in
   * dismissedProposalKey so the same proposal does not pop up again.
   */
  const pendingProposal = useMemo(() => findPendingProposal(messages), [messages])
  const [dismissedProposalKey, setDismissedProposalKey] = useState<string | null>(null)
  const visibleProposal =
    pendingProposal && pendingProposal.key !== dismissedProposalKey ? pendingProposal : null

  /**
   * Prefill bar › / Enter: same pipeline as a manual send (queued while generating), and the bar
   * collapses immediately
   */
  const handleSendProposalText = useCallback(
    (text: string): void => {
      if (pendingProposal) setDismissedProposalKey(pendingProposal.key)
      window.dispatchEvent(new CustomEvent('harness-propose-action', { detail: { text } }))
    },
    [pendingProposal]
  )

  /**
   * Permission approval: while a pending approval exists, the input area yields entirely to the
   * inline approval panel
   */
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

  /**
   * Questions (ask_user_question): inline panel in the input area (no more popup).
   * Sort priority: permission approval > question > propose_action prefill bar > regular input.
   * "Switch model and continue" and "plan review" are still handled by their own dedicated
   * popups and are filtered out here.
   */
  const fetchQuestionPending = useCallback(
    (topicId: number) => harnessApi.harness.getQuestion(topicId),
    []
  )
  const subscribeQuestion = useCallback(
    (listener: (pending: PendingQuestionView) => void) =>
      harnessApi.harness.onQuestionAsked(listener),
    []
  )
  const { pending: questionPending, clear: clearQuestionPending } =
    useTopicPending<PendingQuestionView>({
      currentTopicId,
      fetchPending: fetchQuestionPending,
      subscribe: subscribeQuestion,
      accept: (pending) =>
        !pending.questions.some(
          (question) => question.kind === 'model-recovery' || question.kind === 'plan-review'
        )
    })
  const [questionSubmitting, setQuestionSubmitting] = useState(false)
  const handleSubmitQuestion = useCallback(
    async (answers: Array<{ id: string; selected: string[]; custom?: string }>): Promise<void> => {
      if (!questionPending || questionSubmitting) return
      setQuestionSubmitting(true)
      try {
        await harnessApi.harness.answerQuestion(questionPending.requestId, answers)
        clearQuestionPending()
      } catch (err) {
        message.error((err as Error).message)
      } finally {
        setQuestionSubmitting(false)
      }
    },
    [questionPending, questionSubmitting, clearQuestionPending, message]
  )
  /**
   * Cancel answering: **does not end the turn**. Collapse the panel first, then have the main
   * process settle the pending question as cancelled so the model receives "user cancelled the
   * answer" and continues; the input area is restored immediately.
   */
  const handleCancelQuestion = useCallback((): void => {
    if (!questionPending) return
    const requestId = questionPending.requestId
    clearQuestionPending()
    void harnessApi.harness.cancelQuestion(requestId).catch((err: unknown) => {
      console.error('Failed to cancel question:', err)
    })
  }, [questionPending, clearQuestionPending])

  // Model readiness check: the app is usable immediately; only the Assistant page depends on
  // model configuration — guide in-page when unconfigured
  const hasModels = providers.length > 0
  const [workspacePath, setWorkspacePath] = useState<string>('')
  /**
   * Whether a workspace is configured: null = checking (no guidance shown yet, to avoid flashing)
   */
  const [hasWorkspace, setHasWorkspace] = useState<boolean | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelHasEditor, setPanelHasEditor] = useState(false)
  /**
   * Right terminal panel (persistent terminal). Mutually exclusive with the workspace panel in
   * the **same column**: opening one collapses the other, and both reuse the same draggable
   * panel width so they look consistent.
   */
  const [terminalOpen, setTerminalOpen] = useState(false)
  /**
   * In-app browser panel: mutually exclusive in the same column with terminal/workspace (opened
   * from a start-page choice)
   */
  const [browserOpen, setBrowserOpen] = useState(false)
  /**
   * "Start" panel: tool picker entry (one of the right-column panels, exclusive with
   * workspace/terminal/browser)
   */
  const [startPanelOpen, setStartPanelOpen] = useState(false)
  /**
   * Background subagent conversation currently being viewed (opened from the entry at the
   * right of the top bar).
   *
   * When non-null, the main conversation area switches entirely to that subagent's streaming
   * session view; "back to main agent" resets it to null. The main conversation's
   * messages/streaming state is kept as-is in the Provider, so switching back loses nothing
   * and does not interrupt the main agent.
   */
  const [subagentView, setSubagentView] = useState<{
    topicId: number
    agentId: string
    label: string
  } | null>(null)
  /**
   * Switching topics: subagent sessions are isolated per topic, so changing topics must return to
   * the main conversation
   */
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
  /**
   * Main-conversation "dispatched" card → open that subagent's session view (agentId comes from
   * block.subAgent.subagentId)
   */
  const handleOpenSubagentById = useCallback(
    (agentId: string): void => {
      if (currentTopicId == null || !agentId) return
      setSubagentView({ topicId: currentTopicId, agentId, label: '' })
    },
    [currentTopicId]
  )
  /**
   * Referentially stable bridge object: AssistantMessage's block-level render cache does not see
   * function props (see the subagent-view-bridge comment)
   */
  const subagentViewBridge = useMemo(
    () => ({ openSubagent: handleOpenSubagentById }),
    [handleOpenSubagentById]
  )
  /**
   * Subagent conversation data: the top-bar breadcrumb and the session view share one
   * subscription (each agent is watched only once). When not viewing, null is passed in, the
   * hook returns empty state, and no IPC is issued.
   */
  const subagentConversation = useSubagentConversation(
    subagentView?.topicId ?? null,
    subagentView?.agentId ?? null
  )
  /**
   * Bottom anchor for the subagent conversation message area (separate ref from the main
   * conversation; the ConversationPane instance is reused when the target switches)
   */
  const subagentMessagesEndRef = useRef<HTMLDivElement | null>(null)
  /** Subagent conversations are read-only: edit/delete/branch/pagination are all no-ops */
  const subagentNoop = useCallback((): void => {}, [])
  const subagentNoopAsync = useCallback(async (): Promise<void> => {}, [])
  /**
   * While viewing a subagent conversation, Esc returns to the main agent (not intercepted inside
   * the input, to preserve IME/cancel semantics)
   */
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
   * Pending changes under review (path → count), reported back by the right panel.
   * It serves exactly one purpose: the change badge on task section headers — once a section is
   * collapsed its edit cards unmount, so the chat needs somewhere that still shows what that
   * section changed (issue reported by the user on 2026-09-23).
   */
  const [pendingByPath, setPendingByPath] = useState<Map<string, number>>(new Map())
  /**
   * Imperative handle to the right workspace panel (tool card click → open file / reveal directory
   * / result detail tab)
   */
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

  // Guidance action: pick a directory to create and activate a workspace (same flow as "new
  // workspace" in the sidebar)
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
      // The conversation list is refetched centrally by the Provider's `workspace-changed`
      // subscription (see useHarnessHandlers); fetching again here would just add a DB query
    } catch (err) {
      console.error('Failed to setup workspace:', err)
    }
  }, [t])

  /**
   * Refresh the workspace path after a workspace switch (explorer root / virtual path mapping).
   *
   * The conversation list is **not** fetched here: that subscription moved to the Provider
   * (`useHarnessHandlers`), because most workspace-switch entry points are on `/plugins` and
   * the persistent sidebar — when this page is not mounted the event would be missed and the
   * list would stay on the previous workspace while the sidebar keeps showing the loading
   * skeleton.
   */
  const handleWorkspaceChange = useCallback(async () => {
    await checkWorkspace()
  }, [checkWorkspace])

  // Global workspace switch: this page only re-reads the workspace path (explorer root / virtual
  // path mapping); the conversation list is handled by the Provider's subscription of the same
  // name, see useHarnessHandlers.
  // No longer also calls handleNewHarness() — when opening a conversation under another
  // workspace that step clears and re-sets the just-selected conversation, causing the list and
  // selection highlight to flicker; entry points that need a blank welcome state (new
  // conversation / new workspace / delete workspace) call onNewHarness() explicitly from the
  // sidebar.
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
   * Virtual path → real workspace path.
   *
   * Paths in tool cards are virtual ('/' mounts the AI workspace, '/memories/' mounts the
   * memories directory). The explorer only accepts real absolute paths, so only the workspace
   * mount can be mapped; the memories mount returns null and such files are opened by the panel
   * in a read-only tab (mount resolution in the main process enforces boundary checks).
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

  /**
   * Stash the action while the panel is not yet mounted (first card click from the closed state)
   * and run it once mounted
   */
  const pendingPanelActionRef = useRef<((handle: WorkspacePanelHandle) => void) | null>(null)
  const runOnPanel = useCallback((action: (handle: WorkspacePanelHandle) => void): void => {
    const handle = workspacePanelRef.current
    if (handle) action(handle)
    else pendingPanelActionRef.current = action
    setTerminalOpen(false)
    setBrowserOpen(false)
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

  /** Terminal panel toggle: mutually exclusive with workspace/browser/start panels */
  const toggleTerminalPanel = useCallback((): void => {
    setTerminalOpen((prev) => {
      const next = !prev
      if (next) {
        setPanelOpen(false)
        setBrowserOpen(false)
        setStartPanelOpen(false)
      }
      return next
    })
  }, [])

  /**
   * Whether any panel is already open on the right (start/workspace/terminal/browser).
   * The top bar has a single button: with a panel open it collapses everything; without one it
   * opens "Start".
   */
  const anyPanelOpen = panelOpen || terminalOpen || browserOpen || startPanelOpen

  /** Top-bar button: collapse all right panels / open the start panel */
  const toggleStartPanel = useCallback((): void => {
    if (anyPanelOpen) {
      setPanelOpen(false)
      setTerminalOpen(false)
      setBrowserOpen(false)
      setStartPanelOpen(false)
      return
    }
    setStartPanelOpen(true)
  }, [anyPanelOpen])

  /**
   * Tool picked on the start page: collapse the start page and open the matching right-column panel
   */
  const handleStartSelect = useCallback(
    (kind: StartToolKind): void => {
      setStartPanelOpen(false)
      if (kind === 'terminal') {
        setTerminalOpen(true)
        setPanelOpen(false)
        setBrowserOpen(false)
      } else if (kind === 'browser') {
        setBrowserOpen(true)
        setPanelOpen(false)
        setTerminalOpen(false)
      } else {
        setPanelOpen(true)
        setTerminalOpen(false)
        setBrowserOpen(false)
      }
    },
    []
  )

  /**
   * Bridge from tool cards → right workspace panel (see contexts/WorkspaceBridgeContext).
   * Click behavior is dispatched by tool semantics: file tools open the real file, ls reveals a
   * directory, everything else opens a result detail tab.
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
   * Context window of the current model: the input footer's usage ring uses it to compute a
   * percentage.
   *
   * The only source is the provider profile's `metadata.context_window` (can be entered manually
   * in settings or inherited from the model profile); if unset it returns null and the footer
   * shows only tokens and cache hits, drawing no ring — the window size is never guessed.
   */
  const modelContextWindow = useMemo(() => {
    const provider = providers.find((item) => item.id === selectedProviderId)
    const contextWindow = provider?.metadata?.context_window
    return typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : null
  }, [providers, selectedProviderId])
  /**
   * Blank conversation (no messages yet): treat "welcome text + input" as one group and center
   * it vertically.
   *
   * Per the user request on 2026-11-19 ("the chat input should be vertically centered like the
   * tagline"), in an empty conversation the input is no longer pinned to the bottom but sits
   * centered as part of the opening screen with the welcome tagline; after the first message it
   * switches back to the regular "message list + bottom input" layout automatically.
   */
  const isWelcomeMode = messages.length === 0
  /**
   * Enter goal compose mode: put the goal text into the bottom input (no extra input control is
   * created)
   */
  const beginGoalCompose = useCallback(
    async (prefill?: string): Promise<void> => {
      if (currentTopicId == null) {
        message.info(t('harness.input.commands.noTopic'))
        return
      }
      if (planReviewPending) return
      // Read the goal regardless of prefill: the round limit must come from the saved value
      // (empty when new = default)
      const goal = await harnessApi.harness.getGoal(currentTopicId).catch(() => null)
      const text = prefill ?? goal?.objective ?? ''
      setGoalRoundsLimit(goal?.maxGoalRounds ?? null)
      setInputValue(text)
      setGoalCompose(true)
    },
    [currentTopicId, message, planReviewPending, setInputValue, t]
  )

  const cancelGoalCompose = useCallback((): void => {
    setGoalCompose(false)
    setGoalRoundsLimit(null)
    setInputValue('')
  }, [setInputValue])

  /**
   * Enter in goal compose mode: write to the GoalStore first, then send the raw input text as the
   * execution instruction
   */
  const submitGoalFromInput = useCallback(async (): Promise<void> => {
    const topicId = currentTopicId
    const text = inputValue.trim()
    if (topicId == null || !text) return
    const existing = await harnessApi.harness.getGoal(topicId).catch(() => null)
    // Round limit: include it when filled in; empty = leave unchanged (backend default 256 when
    // creating)
    const rounds = goalRoundsLimit ?? undefined
    const result =
      existing && existing.phase !== 'complete'
        ? await harnessApi.harness.updateGoal({
            topicId,
            action: 'edit',
            objective: text,
            maxGoalRounds: rounds
          })
        : await harnessApi.harness.createGoal({
            topicId,
            objective: text,
            maxGoalRounds: rounds
          })
    if (!result.ok) {
      message.error(result.error ?? t('harness.goalInline.saveFailed'))
      return
    }
    setGoalCompose(false)
    setGoalRoundsLimit(null)
    setInputValue('')
    await handleStartGoal(text)
  }, [currentTopicId, goalRoundsLimit, handleStartGoal, inputValue, message, setInputValue, t])

  /** Send entry for the input in goal compose mode (shared by Enter and the send button) */
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

  // Goal compose mode: exits when the topic changes; global Esc listener (HarnessInput only
  // calls back on Enter)
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

  /**
   * Input area: the main conversation and subagents share the same ConversationFooter shell; only
   * the inner controls differ
   */
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
  ) : questionPending ? (
    /* Inline question panel: no separate window anymore; cancelling does not end the turn */
    <ConversationFooter
      welcome={false}
      colorBgContainer={colorBgContainer}
      colorBorderSecondary={colorBorderSecondary}
    >
      <AskQuestionPanel
        key={questionPending.requestId}
        pending={questionPending}
        submitting={questionSubmitting}
        onSubmit={(answers) => void handleSubmitQuestion(answers)}
        onCancel={handleCancelQuestion}
      />
    </ConversationFooter>
  ) : visibleProposal ? (
    /* propose_action prefill bar: replaces the input box, leaving no trace in the message stream */
    <ConversationFooter
      welcome={false}
      colorBgContainer={colorBgContainer}
      colorBorderSecondary={colorBorderSecondary}
    >
      <ProposalPrefillBar
        proposal={visibleProposal}
        onSend={handleSendProposalText}
        onDismiss={() => setDismissedProposalKey(visibleProposal.key)}
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
        /* The assistant mascot appears only in blank conversations: with content it would cover
           messages/reasoning */
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
        goalRoundsLimit={goalRoundsLimit}
        onGoalRoundsLimitChange={setGoalRoundsLimit}
        locked={planReviewPending}
        onGoalCommand={() => void beginGoalCompose()}
        onPlanCommand={() => setPlanToggleSignal((value) => value + 1)}
        agentSelection={agentSelection}
        onAgentSelectionChange={setAgentSelection}
        pendingTeamMode={pendingTeamMode}
        onPendingTeamModeChange={setPendingTeamMode}
      />
    </ConversationFooter>
  )

  // Actual available width of the conversation area (main content width); panel max width is
  // derived from it
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

  // Right panel (workspace editor or persistent terminal)
  const [panelWidth, setPanelWidth] = useState(() =>
    Math.max(500, Math.floor(window.innerWidth * 0.4))
  )

  /**
   * Minimum readable width for terminal/browser panels (the workspace panel is only 220 when no
   * file is open)
   */
  const TERMINAL_PANEL_MIN_WIDTH = 360
  /**
   * Workspace / terminal / browser occupy the same column: unified width limits so switching panels
   * does not jump
   */
  const workspaceMinWidth = panelMinWidthFor(panelHasEditor)
  const panelMinWidth = anyPanelOpen ? TERMINAL_PANEL_MIN_WIDTH : workspaceMinWidth
  /*
   * Panel max width: the smaller of the ratio cap (relaxed from 45% to 65% on large screens) and
   * "conversation keeps at least MAIN_MIN_WIDTH". The terminal panel uses the "has editor" tier,
   * otherwise the workspace panel's 220px no-file cap would clamp it. The width policy and all
   * constants live together in utils/panelLayout.ts — <main>'s minWidth uses the same constants,
   * so they are no longer written twice (the old 410/420 drift clipped 10px off the panel).
   */
  const panelMaxWidth = computePanelMaxWidth({
    layoutWidth,
    hasEditor: anyPanelOpen ? true : panelHasEditor,
    sidebarOpen: false,
    sidebarWidth: 0
  })

  // Panel width policy: auto-expand/shrink when an editor opens/closes; other changes (window
  // resize) only clamp the width back into the valid range, preserving the user's drag result
  // and avoiding overflow horizontal scrollbars
  const prevHasEditorRef = useRef(panelHasEditor)
  useEffect(() => {
    // When any right panel opens, width is handled by the unified open effect below: all three
    // panels share one width and do not jump with content
    if (anyPanelOpen) {
      setPanelWidth((prev) => clampWidth(prev, panelMinWidth, panelMaxWidth))
      return
    }
    if (panelHasEditor === prevHasEditorRef.current) {
      setPanelWidth((prev) => clampWidth(prev, panelMinWidth, panelMaxWidth))
      return
    }
    prevHasEditorRef.current = panelHasEditor
    setPanelWidth(
      panelHasEditor ? autoOpenPanelWidth(layoutWidth, panelMaxWidth) : PANEL_MIN_WITHOUT_EDITOR
    )
  }, [anyPanelOpen, panelHasEditor, layoutWidth, panelMinWidth, panelMaxWidth])

  // Give a readable default width when any panel opens; all three panels then keep that width
  // (unified)
  const prevAnyPanelOpenRef = useRef(anyPanelOpen)
  useEffect(() => {
    if (anyPanelOpen === prevAnyPanelOpenRef.current) return
    prevAnyPanelOpenRef.current = anyPanelOpen
    if (!anyPanelOpen) return
    setPanelWidth((prev) =>
      clampWidth(
        Math.max(prev, Math.max(TERMINAL_PANEL_MIN_WIDTH, 420)),
        panelMinWidth,
        panelMaxWidth
      )
    )
  }, [anyPanelOpen, panelMaxWidth, panelMinWidth])

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
                /* No workspace configured: conversations are isolated per workspace, so
                   guide the user to pick a directory first (same in-page guidance as
                   "configure model") */
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
                /* Model not configured: in-page guidance on the Assistant page only; other
                   features remain usable */
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
                    startOpen={anyPanelOpen}
                    onToggleStart={toggleStartPanel}
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

                  {/* Main conversation area: the main agent and background subagents share the
                     same ConversationPane (message window + bottom input area). When the target
                     switches the component instance is reused and only the data source changes —
                     per the user, the message area should also reuse the previous conversation
                     window. */}
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
                    /* Blank conversation: welcome text and input are centered vertically as one
                     group. The top bar stays — the workspace panel toggle must still work in a
                     blank conversation, otherwise a panel opened in an existing conversation
                     could not be closed after starting a new one. */
                    <div className="flex-1 min-h-0 flex flex-col justify-center pt-6 pb-10">
                      <div className="w-full max-w-2xl mx-auto px-8">
                        <WelcomeIntro
                          colorText={colorText}
                          colorTextSecondary={colorTextSecondary}
                        />
                      </div>
                      {/* Archived conversations are read-only: the input is not rendered at all
                        (per the user: no hint bar, nothing left behind) */}
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
                        // Section header badge → open that file's diff view directly (a real path
                        // in the workspace)
                        runOnPanel((handle) => handle.openVirtualFile(realPath, realPath))
                      }}
                      jumpToDialogueId={pendingJumpDialogueId}
                      onJumpToDialogueConsumed={clearPendingJumpDialogueId}
                      footer={currentTopicArchived ? null : inputArea}
                    />
                  )}
                </>
              )}
            </main>

            {/* Right column: workspace / terminal / embedded browser (mutually exclusive) */}
            {anyPanelOpen && (
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
                  {startPanelOpen ? (
                    <StartPage onSelect={handleStartSelect} />
                  ) : terminalOpen ? (
                    <TerminalPanel
                      topicId={currentTopicId}
                      isDarkMode={isDarkMode}
                      colorBgContainer={colorBgContainer}
                      colorText={colorText}
                      colorTextSecondary={colorTextSecondary}
                      colorTextTertiary={colorTextTertiary}
                      onClosePanel={toggleTerminalPanel}
                    />
                  ) : browserOpen ? (
                    <BrowserPanel
                      isDarkMode={isDarkMode}
                      colorBgContainer={colorBgContainer}
                      colorText={colorText}
                      colorTextSecondary={colorTextSecondary}
                      colorTextTertiary={colorTextTertiary}
                      colorBorderSecondary={colorBorderSecondary}
                    />
                  ) : (
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
                  )}
                </div>
              </>
            )}
          </div>

          {/* Question popup: collects user answers while the ask_user_question tool is pending
            (now an inline panel in the input area) */}
          {/* Model request failure popup: after automatic retries are exhausted, choose whether
            to switch models and continue (continues in place, without resending the question) */}
          <ModelRecoveryModal currentTopicId={currentTopicId} />
        </div>
      </WorkspaceBridgeContext.Provider>
    </SubagentViewContext.Provider>
  )
}

export default Harness
