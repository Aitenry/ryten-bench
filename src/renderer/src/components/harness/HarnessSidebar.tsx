import React, { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState } from 'react'
import { App, Dropdown, Input, Modal, theme } from 'antd'
import { SkeletonListRows, SkeletonTextLines } from '@renderer/components/system/Skeleton'
import type { InputRef } from 'antd'
import {
  RiAddLine,
  RiArchiveLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiBrain4Line,
  RiBriefcaseLine,
  RiChat3Line,
  RiCloseLine,
  RiCodeLine,
  RiDatabase2Line,
  RiDeleteBin6Line,
  RiEditLine,
  RiExternalLinkLine,
  RiFileTextLine,
  RiFolder2Line,
  RiFolderOpenLine,
  RiFoldersLine,
  RiGitBranchLine,
  RiHammerLine,
  RiInboxUnarchiveLine,
  RiMoreLine,
  RiPuzzleLine,
  RiPushpinFill,
  RiPushpinLine,
  RiSearchLine,
  RiSettings4Line,
  RiShieldCheckLine,
  RiUploadCloud2Line
} from '@remixicon/react'
import { useNavigate } from 'react-router-dom'
import ChaseDots from './ChaseDots'
import TopicStatusDot from './TopicStatusDot'
import NewDraftModal from './workshop/NewDraftModal'
import { requestWorkshopModal } from './workshop/workshop-modal-request'
import { useDraftActions } from './workshop/useDraftActions'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import { setWindowTitleSource } from '@renderer/window-title'
import type { HarnessSettings } from '@renderer/types/settings'
import type { MenuProps } from 'antd'
import type { TFunction } from 'i18next'
import type { HarnessTopicRow, WorkspaceRow } from '../../../../shared/harness/types'
import type { WorkshopDraftSummary } from '../../../../shared/harness/workshop'
import { harnessApi, type WorkspaceSearchResult } from '../../api/harness'
import { useMemoryScope } from '../../utils/harness/memory-scope'
import { resolveTopicRunStatus } from '../../hooks/harness/useTopicRunStatus'

interface HarnessSidebarProps {
  /** Conversation list for the current workspace (live + paged, maintained by useHarness) */
  topics: HarnessTopicRow[]
  /** Which workspace the topics above belong to (null = not loaded yet) */
  topicsWorkspaceId: number | null
  currentTopicId: number | null
  colorBgContainer: string
  borderRadiusLG: number
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  colorFillAlter: string
  /** Color of the yellow breathing dot (waiting for user confirmation) */
  colorWarning: string
  /** Color of the green breathing dot (just finished, not opened yet) */
  colorSuccess: string
  loadingTopicIds: Set<number>
  /** Conversations with a pending question / approval, waiting for the user (yellow dot at row start) */
  awaitingTopicIds: Set<number>
  /** Conversations that just finished on their own while the chat view was not open (green dot at row start, cleared on open) */
  completedTopicIds: Set<number>
  /** Pagination */
  hasMoreTopics: boolean
  isLoadingMoreTopics: boolean
  /** Whole-list refresh in progress (as opposed to scroll pagination) */
  isRefreshingTopics: boolean
  /**
   * Open a conversation. **Completes putting its content on screen** (synchronous on cache hit, otherwise waits for the first page of messages),
   * hence it returns a Promise: callers must `await` it first, then switch routes; see `onOpenHarness` below.
   *
   * The second argument is "the chat row to locate after opening": passed when a message-text search hit occurs; hooks
   * keep paging as needed until the target message is read into the list (hits beyond the first 20 rows still scroll into view).
   */
  onSelectTopic: (
    topic: HarnessTopicRow,
    options?: { focusDialogueId?: number }
  ) => void | Promise<void>
  onDeleteTopic: (topicId: number, e?: React.MouseEvent) => Promise<void>
  onLoadMoreTopics: () => void
  /** Refresh all conversations of the active workspace (keeps list and title in sync after pin/rename/archive/fork) */
  onRefreshTopics: () => Promise<void>
  /** Create a conversation in the current workspace */
  onNewHarness: () => void
  /**
   * "The user just acted on conversation content" -> the shell brings the main content area back to the chat page (`/harness`).
   *
   * The sidebar is **always mounted** inside the shell: the user may be on Notes / the plugin repository / More (agents...). After clicking a conversation or
   * "+ New conversation", the content is on the chat page, so the route must follow; otherwise the UI looks "unresponsive"
   * (user wording 2026-11-21: "open another view... then click new conversation, nothing happens, the page does not go back to
   * the new-conversation page").
   *
   * **Call timing: content first, route after**. As soon as `/harness` mounts it renders the current conversation from the Provider;
   * if the route switches first and the IPC preparing the new content is still pending, those frames still paint the **previous** conversation — what the user sees
   * is "the old conversation flashing". User wording 2026-11-25: "switch to the plugin repository, then select new conversation, the page
   * flashes from the history conversation content to the new conversation content instead of starting on the new conversation content". Therefore every
   * "user click -> swap conversation content" entry in this component does not call it at the start, but after `onNewHarness` / `onSelectTopic`
   * has swapped the content, at the end of the same synchronous block / the same await chain (when idle the route update takes effect immediately and
   * the wait is imperceptible, and no flash occurs).
   *
   * **Only called from user actions**: startup restore (restoreLastContent) goes through the same callbacks, but restore must not drag people
   * coming from the login page / a deep link back to the chat page — that is exactly what the old route guard was preventing, so here
   * "notify only on explicit click" replaces "never navigate when not on the chat page".
   */
  onOpenHarness: () => void
  /**
   * When conversation search hits "message text", hand the target chat row id to the page's message area (scroll and highlight after opening).
   * null = clear the pending target (used when a title hit is clicked / search is closed).
   */
  onSetPendingJumpDialogue?: (dialogueId: number | null) => void
  /** System-shell mode: dark sidebar with the light capsule thumb from the mockup */
  shellMode?: boolean
}

/** Mnemon memory overview snapshot */
interface MnemonSidebarSnapshot {
  configured: boolean
  runtime?: {
    entries: { content: string; target: 'user' | 'memory'; importance: string }[]
    targets: Record<'user' | 'memory', { used: number; limit: number; entryCount: number }>
  }
  bodies?: {
    total: number
    activeCount: number
  }
  documents?: {
    total: number
    activeCount: number
  }
}

/** Conversation page size (kept consistent with TOPICS_PAGE_SIZE in useHarnessHandlers) */
const TOPICS_PAGE_SIZE = 20

/** Thumb easing: slight overshoot at the end; switching feels tactile without being exaggerated */
const MODE_THUMB_EASE = 'cubic-bezier(0.32, 1.35, 0.5, 1)'

/**
 * Sidebar mode: `work` (workspaces -> conversations) / `chat` (conversations, no workspace concept) / `plugin` (plugins).
 *
 * This switch expresses **which kind of content the panel is looking at right now**, so it **follows the content**: selecting a workspace conversation -> work;
 * entering the "chat" side -> chat; opening a plugin / entering the workshop page -> plugin (see `WORKSHOP_FOCUS_EVENT`
 * and onSelectTopic below).
 *
 * At the same time it is **persisted** together with each side's "current content" and restored next time
 * (user wording 2026-09-28: "remember work mode and plugin mode, the selected conversation, so it can be remembered next time").
 * This supersedes the 2026-09-27 wording "the plugin tab must not be selected on startup" — that wording assumed content could not be restored;
 * now each side's content is remembered together, and the switch follows the restored content, so "sidebar lists plugins while content is a work conversation" cannot happen.
 *
 * History: `work` used to be called `'chat'` (before "chat" mode existed); old values may remain on disk —
 * normalize them to `'work'` on restore (see restoreLastContent) rather than writing a data migration.
 */
type SidebarMode = 'work' | 'chat' | 'plugin'

/** Work mode "current content" */
type WorkContent = { workspaceId: number; topicId: number | null }
/** "Chat" mode "current content" */
type ChatContent = { workspaceId: number; topicId: number | null }
/** Plugin mode "current content" (including which plugin) */
type PluginContent = { pluginId: string; workspaceId: number; topicId: number | null }

/** Dispatched when the workshop page / plugin detail opens: the sidebar switches the toggle to "plugin" */
const WORKSHOP_FOCUS_EVENT = 'harness-workshop-focus'

/**
 * Three positions of the mode switch (order is the visual order: **chat / work / plugin** — user wording 2026-09-29: "chat mode should come first").
 *
 * The array order is also the index source for the thumb offset, so it **is** the visual order; do not order it again elsewhere.
 */
const SIDEBAR_MODES: SidebarMode[] = ['chat', 'work', 'plugin']

/**
 * Icons for the three positions (12px, same color as the text):
 * chat = speech bubble, work = briefcase, plugin = puzzle piece.
 *
 * Placed before the label rather than leaving text only: all three labels are two-character words, and text alone can only be told apart by position;
 * with shapes, the meaning of "chat / work / plugin" is recognized before reading, and the thumb has a landing point when switching.
 */
const SIDEBAR_MODE_ICONS: Record<SidebarMode, React.ReactNode> = {
  chat: <RiChat3Line size={12} />,
  work: <RiBriefcaseLine size={12} />,
  plugin: <RiPuzzleLine size={12} />
}

/**
 * Sidebar mode switch (capsule + thumb, three positions: chat / work / plugin).
 *
 * Why not "three buttons each changing their background color": that switches by **instant jump**, and the eye has to re-locate;
 * with a sliding thumb, "which position am I on" is said by the position itself, and switching back and forth has no competing highlights.
 *
 * After three positions, **no fixed per-position width** (two positions used 44px each): label lengths differ (two chars / two chars / two chars,
 * but in English Chat / Work / Plugins), so a fixed width either clips the English or leaves extra whitespace for Chinese.
 * Therefore the thumb is positioned from the **measured** target button geometry (`scrollWidth`/`offsetLeft`),
 * and ResizeObserver covers wrapping / font-size changes from window resizing; the thumb transition is unchanged.
 *
 * All colors go through antd tokens (theme-aware).
 */
const SidebarModeSwitch: React.FC<{
  mode: SidebarMode
  onChange: (next: SidebarMode) => void
  track: string
  thumb: string
  active: string
  inactive: string
  hairline: string
  t: TFunction
}> = ({ mode, onChange, track, thumb, active, inactive, hairline, t }) => {
  const listRef = useRef<HTMLDivElement>(null)
  const [thumbBox, setThumbBox] = useState({ left: 0, width: 0 })
  /**
   * The thumb transition plays only when the **user clicks the switch**.
   *
   * Startup restore (the remembered mode) and following the content (clicking a conversation, opening the workshop page) also change mode, but that is "state follows
   * content", not a switching action; sliding the thumb then would make a returning user think someone clicked it (user wording
   * 2026-11-23: "when the selected mode is remembered there is no need for a switching animation; only actively clicking another mode
   * should show the animation").
   */
  const [animateThumb, setAnimateThumb] = useState(false)
  /** Which position the user clicked; only a following mode change that equals it counts as a visible switch */
  const clickTargetRef = useRef<SidebarMode | null>(null)

  /** Measured geometry of the current position's button (including padding), used to align the thumb */
  const measure = useCallback((): void => {
    const list = listRef.current
    if (!list) return
    const buttons = Array.from(list.querySelectorAll('button'))
    const index = SIDEBAR_MODES.indexOf(mode)
    const target = buttons[index]
    if (!target) return
    setThumbBox((prev) =>
      prev.left === target.offsetLeft && prev.width === target.offsetWidth
        ? prev
        : { left: target.offsetLeft, width: target.offsetWidth }
    )
  }, [mode])

  useLayoutEffect(() => {
    // Mode changes not caused by clicks (restore / following content) land directly without sliding; clicking the same position is not a switch and never reaches here
    setAnimateThumb(clickTargetRef.current === mode)
    clickTargetRef.current = null
    measure()
    const list = listRef.current
    if (!list || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [measure, mode])

  return (
    <div
      ref={listRef}
      role="tablist"
      className="relative flex items-center select-none"
      style={{ padding: 2, height: 24, borderRadius: 7, background: track }}
    >
      {/* Thumb: absolutely positioned + transform (no layout shift, no text reflow); it slides to the other position on switch.
          The transition is enabled only on click (see animateThumb) and turned off by onTransitionEnd when it finishes. */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 2,
          left: 0,
          width: thumbBox.width,
          height: 20,
          borderRadius: 7,
          background: thumb,
          border: `1px solid ${hairline}`,
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.28)',
          transform: `translateX(${thumbBox.left}px)`,
          transition: animateThumb
            ? `transform 240ms ${MODE_THUMB_EASE}, width 240ms ${MODE_THUMB_EASE}`
            : 'none'
        }}
        onTransitionEnd={() => setAnimateThumb(false)}
      />
      {SIDEBAR_MODES.map((item) => (
        <button
          key={item}
          type="button"
          role="tab"
          aria-selected={mode === item}
          onClick={() => {
            if (item === mode) return
            clickTargetRef.current = item
            onChange(item)
          }}
          title={t(`harness.sidebar.mode.${item}Hint` as never)}
          style={{
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 3,
            height: 20,
            padding: '0 6px',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: 12,
            lineHeight: '20px',
            whiteSpace: 'nowrap',
            color: mode === item ? active : inactive,
            fontWeight: mode === item ? 500 : 400,
            transition: animateThumb ? 'color 180ms ease' : 'none'
          }}
        >
          {/* Icon shares the text color: the selected/unselected state travels with the button's color, so no separate palette is needed */}
          {SIDEBAR_MODE_ICONS[item]}
          {t(`harness.sidebar.mode.${item}` as never)}
        </button>
      ))}
    </div>
  )
}

/**
 * Merge two conversation-row lists (dedupe by id, **incoming wins for the same row**, order from base).
 *
 * The "chat" mode list has two sources: the `topics` prop (the active workspace's list, first page only) and the sidebar's own
 * paged results. Either may arrive first, and plain overwrite would keep losing pages, so both go through this merge.
 *
 * For duplicate ids the incoming row must win: it is the freshest row just read from the DB (pin / archive / rename
 * rely on it to bring the new state in). The earlier "keep the row seen first" behavior made pin, archive and rename
 * all ineffective in chat mode — the list still held the old objects.
 */
function mergeTopicRows(base: HarnessTopicRow[], incoming: HarnessTopicRow[]): HarnessTopicRow[] {
  if (incoming.length === 0) return base
  const byId = new Map(incoming.map((topic) => [topic.id, topic]))
  const merged = base.map((topic) => byId.get(topic.id) ?? topic)
  const seen = new Set(merged.map((topic) => topic.id))
  for (const topic of incoming) {
    if (seen.has(topic.id)) continue
    seen.add(topic.id)
    merged.push(topic)
  }
  return merged
}

/** Relative conversation time: just now / 12 minutes / 3 hours / 1 day / Sep 10 (rendered muted when the value is null)
 *  Non-component function: the caller passes the translation function t */
function formatRelativeTime(t: TFunction, value: string | null): string {
  if (!value) return ''
  const then = new Date(value).getTime()
  if (!Number.isFinite(then)) return ''
  const now = Date.now()
  const diff = Math.max(0, now - then)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return t('harness.sidebar.timeJustNow')
  if (diff < hour) return t('harness.sidebar.timeMinutes', { count: Math.floor(diff / minute) })
  if (diff < day) return t('harness.sidebar.timeHours', { count: Math.floor(diff / hour) })
  if (diff < 7 * day) return t('harness.sidebar.timeDays', { count: Math.floor(diff / day) })

  const d = new Date(then)
  const nowDate = new Date(now)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() === nowDate.getFullYear()
    ? t('harness.sidebar.timeDate', { month: mm, day: dd })
    : t('harness.sidebar.timeFullDate', { year: d.getFullYear(), month: mm, day: dd })
}

const HarnessSidebar: React.FC<HarnessSidebarProps> = ({
  topics,
  topicsWorkspaceId,
  currentTopicId,
  colorBgContainer,
  borderRadiusLG,
  colorText,
  colorTextSecondary,
  colorTextTertiary,
  colorFillAlter,
  colorWarning,
  colorSuccess,
  loadingTopicIds,
  awaitingTopicIds,
  completedTopicIds,
  hasMoreTopics,
  isLoadingMoreTopics,
  isRefreshingTopics,
  onSelectTopic,
  onDeleteTopic,
  onLoadMoreTopics,
  onRefreshTopics,
  onNewHarness,
  onOpenHarness,
  onSetPendingJumpDialogue,
  shellMode = false
}) => {
  const { token } = theme.useToken()
  const { viewMessage } = useMessage()
  const { modal, message } = App.useApp()
  const { t } = useTranslation()
  const navigate = useNavigate()
  /**
   * Platform (`process.platform` exposed by preload; do not guess navigator in the renderer):
   * the file manager's name (Finder / Explorer / File Manager) and the shortcut modifiers (⌘/⌥ vs Ctrl/Alt) both follow it.
   */
  const platform = window.api.platform
  const isMacPlatform = platform === 'darwin'
  /** Platform-specific label for the workspace row's "show in folder" action */
  const revealWorkspaceLabel = t(
    isMacPlatform
      ? 'harness.sidebar.workspaceRevealInFinder'
      : platform === 'win32'
        ? 'harness.sidebar.workspaceRevealInFolder'
        : 'harness.sidebar.workspaceRevealInFileManager'
  )

  const scrollRef = useRef<HTMLDivElement>(null)

  /* ── Mode (work / chat / plugin) and plugins ── */
  /** Initial "work": restoreLastContent overrides it after mount when restoring the previous side (see startup restore below) */
  const [mode, setMode] = useState<SidebarMode>('work')

  // Native window title: inside the chat page it is updated per mode to "Chat mode / Work mode / Plugin mode - RytenBench"
  useEffect(() => {
    const key = mode === 'chat' ? 'chatMode' : mode === 'plugin' ? 'pluginMode' : 'workMode'
    setWindowTitleSource('harness', t(`shell.windowTitle.${key}` as never))
  }, [mode, t])
  const [drafts, setDrafts] = useState<WorkshopDraftSummary[]>([])
  const [draftsLoading, setDraftsLoading] = useState(false)
  /** "New draft" modal (shared with the settings page; after creation it lands in the list below, no navigation) */
  const [newDraftOpen, setNewDraftOpen] = useState(false)
  /** User-configured plugin storage path (empty = not configured yet: the list area shows gray text + a "Choose plugin storage path" button, and the top-right + can configure it too) */
  const [pluginsPath, setPluginsPath] = useState('')
  /** Plugin workspace index (plugin id -> its workspace row; the main process decides by kind, see workshop/workspace.ts) */
  const [pluginWorkspaces, setPluginWorkspaces] = useState<
    { draftId: string; workspaceId: number; path: string }[]
  >([])
  /**
   * The "chat" mode workspace (a directory the app initializes itself, see main/chat/workspace.ts):
   * - `ids`: all workspace ids of this kind (the sidebar uses them to filter these rows out of the "work" list);
   * - `rootWorkspaceId`: the root directory row (the active workspace when there are no conversations yet).
   *
   * Same approach as plugin workspaces: only the main process knows how paths are computed; the renderer only gets an id to judge the kind.
   */
  const [chatWorkspaces, setChatWorkspaces] = useState<{
    ids: number[]
    rootWorkspaceId: number | null
  }>({ ids: [], rootWorkspaceId: null })
  /* Rename plugin modal (same interaction as workspace rename: one input line + save) */
  const [draftRenameTarget, setDraftRenameTarget] = useState<WorkshopDraftSummary | null>(null)
  const [draftRenameName, setDraftRenameName] = useState('')
  const [draftRenameSaving, setDraftRenameSaving] = useState(false)

  /**
   * Each mode's "current content": switching modes switches back to it (user wording 2026-09-28: "when switching to work mode or
   * plugin mode, default to the content of the currently selected item in that mode"), **and persists it** —
   * next launch restores it (same-day wording "remember work mode and plugin mode, the selected conversation, so it can be remembered next time").
   *
   * It stores "topic id + the workspace it lives in" (the topic may not exist yet = null, meaning the blank conversation of this workspace);
   * when switching back the topic row is re-read by id — the title may have changed, so do not render an old snapshot.
   * Uses a ref instead of state: it only affects "where the next mode switch goes", does not participate in rendering; writes go through
   * rememberWork / rememberChat / rememberPlugin below (all writes happen only there, avoiding "changed the ref but forgot to persist").
   */
  const workContentRef = useRef<WorkContent | null>(null)
  const chatContentRef = useRef<ChatContent | null>(null)
  const pluginContentRef = useRef<PluginContent | null>(null)
  /**
   * Request sequence number for plugin row clicks: clicking plugins A then B in quick succession lets only the **last one** land.
   *
   * `handlePluginSession` contains several awaits (ensureWorkspace -> write settings -> refresh index);
   * if two calls complete interleaved, the active workspace may be B while the remembered plugin / memory scope is A (the next message
   * would carry the wrong `plugin:<id>` memory). Same "last request wins" pattern as the topic refresh.
   */
  const pluginSessionSeqRef = useRef(0)

  /**
   * "Is the conversation on screen still generating" (ref version).
   *
   * The new-conversation entry points (workspace + / plugin row + / choose folder / chat mode +) are all useCallback;
   * closing over props directly would capture stale values, so a ref lets them read the latest state at click time.
   *
   * Only used to decide "whether to show a hint", **never to block creation**: creating clears the current chat view to blank, and if the
   * swapped-out conversation happened to be the one generating, people easily think that turn was lost (it still streams in the background and is persisted normally; clicking that
   * row back in the sidebar continues watching it). User wording 2026-11-25: "why do you prevent me from creating a conversation, it worked before": creating stays possible
   * while generating; just make clear that "that turn continues in the background".
   */
  const currentTopicRunningRef = useRef(false)
  useEffect(() => {
    currentTopicRunningRef.current = currentTopicId != null && loadingTopicIds.has(currentTopicId)
  }, [currentTopicId, loadingTopicIds])

  /** Creating swapped out a generating conversation -> show one hint (no block, only explains the background continues) */
  const viewReplacedRunningTopic = useCallback((): void => {
    viewMessage('new-session-running', 'info', t('harness.sidebar.newSessionRunning'), 4)
  }, [viewMessage, t])

  /**
   * Topic ids **already deleted** in this session.
   *
   * Only one purpose: stop a **late call** of the effect that "remembers each side's current content". Deletion is asynchronous
   * (delete DB -> refresh list), and the effect may run once with the **old currentTopicId** before `handleNewHarness` clears
   * `currentTopicId`, overwriting "the chat side is now a blank conversation" that we just wrote back to the deleted
   * topic (observed call order `[1,1,null,1]`, the last one from a passive effect). Topic ids auto-increment and are never reused,
   * so remembering deleted ids is safe; the set only grows for the lifetime of this mount (size = number of conversations deleted this session).
   */
  const deletedTopicIdsRef = useRef<Set<number>>(new Set())
  /** Last user workspace visited in work mode (switching back to work mode prefers returning to it) */
  const lastWorkWorkspaceIdRef = useRef<number | null>(null)

  /**
   * Whether startup restore has finished. **Never write settings before restore completes**: otherwise the initial "work"
   * at mount would overwrite the remembered "plugin" (writes and reads share the same keys; racing means overwriting each other).
   */
  const hydratedRef = useRef(false)

  /**
   * Whether each of the three lists (workspaces / drafts + plugin workspaces / chat workspaces) has been read once:
   * startup restore must wait for all of them — missing any one makes "is this row still there" misjudge.
   */
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false)
  const [draftsLoaded, setDraftsLoaded] = useState(false)
  const [chatWorkspacesLoaded, setChatWorkspacesLoaded] = useState(false)

  /** Write the mode / each side's content back to settings (single entry point; low-frequency, no debounce needed) */
  const persistSelection = useCallback(
    (patch: {
      activeMode?: SidebarMode
      workContent?: WorkContent | null
      chatContent?: ChatContent | null
      pluginContent?: PluginContent | null
    }): void => {
      if (!hydratedRef.current) return
      void window.api.systemSettings
        .update({
          harness: patch as Parameters<typeof window.api.systemSettings.update>[0]['harness']
        })
        .catch((err) => console.error('Failed to persist sidebar selection:', err))
    },
    []
  )

  /** Remember work mode's current content (memory + persisted) */
  const rememberWork = useCallback(
    (next: WorkContent | null): void => {
      workContentRef.current = next
      persistSelection({ workContent: next })
    },
    [persistSelection]
  )

  /** Remember "chat" mode's current content (memory + persisted) */
  const rememberChat = useCallback(
    (next: ChatContent | null): void => {
      chatContentRef.current = next
      persistSelection({ chatContent: next })
    },
    [persistSelection]
  )

  /** Remember plugin mode's current content (memory + persisted) */
  const rememberPlugin = useCallback(
    (next: PluginContent | null): void => {
      pluginContentRef.current = next
      persistSelection({ pluginContent: next })
    },
    [persistSelection]
  )

  /**
   * Fetch the "chat" mode workspace list (ids of that kind of workspace + the root directory row).
   *
   * A separate function and a separate loaded flag: startup restore must wait for it — without it,
   * "the active workspace is the chat directory" would be treated as a user workspace, and restore would switch to the wrong side.
   */
  const loadChatWorkspaces = useCallback(async (): Promise<void> => {
    try {
      const chat = await harnessApi.harness.chatWorkspaces()
      if (chat.ok && chat.data) setChatWorkspaces(chat.data)
      else setChatWorkspaces({ ids: [], rootWorkspaceId: null })
    } catch {
      // Chat domain not wired: keep an empty list (those rows leak into the "work" list, but nothing crashes)
      setChatWorkspaces({ ids: [], rootWorkspaceId: null })
    }
  }, [])

  /**
   * Fetch the workspace list (including the active workspace id).
   *
   * Placed before `loadDrafts`: workshop changes (build/install/changed plugin storage path) also change plugin workspace rows,
   * and the sidebar must refresh workspaces together with them — otherwise `workspaces` still holds old paths, and opening an old conversation would write the active
   * workspace back to a directory that has been moved away (user's 2026-11-25 plugin storage path migration case).
   */
  const loadWorkspaces = useCallback(async (): Promise<{
    list: WorkspaceRow[]
    activeId: number | null
  }> => {
    try {
      const [list, settings] = await Promise.all([
        harnessApi.harness.getAllWorkspaces(),
        window.api.systemSettings.getAll()
      ])
      const activeId = settings.harness.activeWorkspaceId ?? null
      setWorkspaces(list)
      setActiveWorkspaceId(activeId)
      return { list, activeId }
    } catch (err) {
      console.error('Failed to load workspaces:', err)
      return { list: [], activeId: null }
    }
  }, [])

  /**
   * Request sequence number for the draft / plugin workspace index: only the **last** result is used when refreshing concurrently.
   *
   * Scenario: the `workshop-changed` refresh triggered by a build/install has not returned and the user deletes a draft; the post-delete
   * refresh arrives first and the stale response second, so the deleted row "revives" briefly, and clicking it only yields a directory-not-found error.
   */
  const draftsLoadSeqRef = useRef(0)

  /** Fetch the plugin draft list + plugin workspace index (the work list uses the latter to filter out plugin directory rows) */
  const loadDrafts = useCallback(async (): Promise<void> => {
    const seq = ++draftsLoadSeqRef.current
    setDraftsLoading(true)
    try {
      const state = await harnessApi.workshop.state()
      const list = await harnessApi.workshop.list()
      if (seq !== draftsLoadSeqRef.current) return
      setPluginsPath(state.pluginsPath ?? '')
      setPluginWorkspaces(state.pluginWorkspaces ?? [])
      setDrafts(list)
    } catch {
      if (seq !== draftsLoadSeqRef.current) return
      // Workshop not wired (just after the AI assistant was stopped/reloaded): keep an empty list; the panel is only used in plugin mode anyway
      setDrafts([])
      setPluginWorkspaces([])
    } finally {
      if (seq === draftsLoadSeqRef.current) setDraftsLoading(false)
    }
  }, [])

  useEffect(() => {
    // All three lists must be fetched: plugin mode needs the list, and the work list needs the draft directories / chat workspaces to filter out non-user workspaces
    void loadDrafts().finally(() => setDraftsLoaded(true))
    void loadChatWorkspaces().finally(() => setChatWorkspacesLoaded(true))
    return harnessApi.workshop.onChanged(() => {
      void loadDrafts()
      // After plugin storage path migration / plugin workspace creation, the path in the rows must be refreshed too
      void loadWorkspaces()
    })
  }, [loadDrafts, loadChatWorkspaces, loadWorkspaces])

  /**
   * Switch follows content: opening the workshop page / plugin detail switches to "plugin"
   * (see the explanation at the top of the file — this switch expresses "which kind of content the panel is viewing right now").
   */
  useEffect(() => {
    const handler = (): void => setMode('plugin')
    window.addEventListener(WORKSHOP_FOCUS_EVENT, handler)
    return () => window.removeEventListener(WORKSHOP_FOCUS_EVENT, handler)
  }, [])

  /**
   * Actions on a plugin row (build / accept / install) go through the same hook as the settings page — the hints and busy state stay consistent.
   * The row also supports rename and delete (matching the workspace row's "… + +", user wording 2026-09-27).
   */

  const {
    busyIds: draftBusyIds,
    build: buildDraft,
    verify: verifyDraft,
    publish: publishDraft
  } = useDraftActions({ onChanged: async () => await loadDrafts() })

  /** Delete a plugin (only its source directory + artifacts; plugins already installed in the app are unaffected; same wording as the settings page) */
  const handleRemoveDraft = useCallback(
    (draft: WorkshopDraftSummary): void => {
      modal.confirm({
        title: t('harness.sidebar.pluginDeleteTitle', { name: draft.title }),
        content: t('workshopSettings.remove.body'),
        okText: t('common.action.delete'),
        okButtonProps: { danger: true },
        cancelText: t('common.action.cancel'),
        onOk: async () => {
          const result = await harnessApi.workshop.remove(draft.id)
          if (!result.ok) {
            viewMessage(`workshop-remove-${draft.id}`, 'error', result.error ?? '', 6)
          }
          await loadDrafts()
        }
      })
    },
    [modal, t, viewMessage, loadDrafts]
  )

  /** Open the rename plugin modal */
  const openDraftRename = useCallback((draft: WorkshopDraftSummary): void => {
    setDraftRenameTarget(draft)
    setDraftRenameName(draft.title)
  }, [])

  /** Save the plugin name (changes the display name: draft title + index name; directory name/id unchanged) */
  const handleDraftRenameSave = useCallback(async (): Promise<void> => {
    const name = draftRenameName.trim()
    if (!name || !draftRenameTarget) {
      viewMessage('draft-rename-validate', 'warning', t('harness.sidebar.pluginNameRequired'))
      return
    }
    try {
      setDraftRenameSaving(true)
      const result = await harnessApi.workshop.rename(draftRenameTarget.id, name)
      if (!result.ok) {
        viewMessage('draft-rename-error', 'error', result.error ?? '', 6)
        return
      }
      setDraftRenameTarget(null)
      await loadDrafts()
      viewMessage('draft-rename-done', 'success', t('harness.sidebar.renameSuccess'), 2)
    } catch (error) {
      viewMessage('draft-rename-error', 'error', String(error))
    } finally {
      setDraftRenameSaving(false)
    }
  }, [draftRenameName, draftRenameTarget, viewMessage, loadDrafts, t])

  /** The plugin row's "…": build / accept / install (same menu wording as the settings page) + rename / delete */
  const draftMenuFor = useCallback(
    (draft: WorkshopDraftSummary, sessionRunning = false): MenuProps['items'] => [
      { key: 'build', icon: <RiHammerLine size={14} />, label: t('workshopSettings.action.build') },
      {
        key: 'verify',
        icon: <RiShieldCheckLine size={14} />,
        label: t('workshopSettings.action.verify')
      },
      {
        key: 'publish',
        icon: <RiUploadCloud2Line size={14} />,
        label: draft.installed
          ? t('workshopSettings.action.update')
          : t('workshopSettings.action.publish')
      },
      { type: 'divider' },
      {
        key: 'detail',
        icon: <RiSettings4Line size={14} />,
        label: t('settings.plugins.viewWorkshop')
      },
      { key: 'rename', icon: <RiEditLine size={14} />, label: t('harness.sidebar.pluginRename') },
      { type: 'divider' },
      {
        key: 'remove',
        danger: true,
        icon: <RiDeleteBin6Line size={14} />,
        // Forbid deleting sources while a conversation of this plugin is generating: otherwise the running turn suddenly loses its working directory
        // and all subsequent file tools fail (same rule as the workspace delete's hasRunningTopic)
        disabled: sessionRunning,
        label: sessionRunning
          ? t('harness.sidebar.workspaceHasRunning')
          : t('harness.sidebar.pluginDelete')
      }
    ],
    [t]
  )

  /**
   * Open a plugin's detail in the workshop (the "Plugin workshop" modal on the plugin repository page -> that plugin's drawer).
   *
   * The workshop UI lives in a modal on the `/plugins` route, while the sidebar is on `/harness`: **write the cross-route request first, then navigate**.
   * The old implementation dispatched the "open settings modal" and "expand drawer" CustomEvents before navigating, while the target page was not mounted
   * yet so it never received them; with `scope:'assistant'` it also sent the user to `/more/workshop` (a tab that does not exist) ->
   * falling back to the agent page with a stuck address bar (user's 2026-11-21 observation).
   */
  const openDraft = useCallback(
    (id: string): void => {
      window.dispatchEvent(new CustomEvent(WORKSHOP_FOCUS_EVENT))
      requestWorkshopModal(id)
      navigate('/plugins')
    },
    [navigate]
  )

  const onDraftMenuClick = useCallback(
    (draft: WorkshopDraftSummary, key: string): void => {
      switch (key) {
        case 'build':
          void buildDraft(draft.id)
          break
        case 'verify':
          void verifyDraft(draft.id)
          break
        case 'publish':
          void publishDraft(draft.id, () => {
            void message.success(t('workshopSettings.publish.done'))
          })
          break
        case 'detail':
          openDraft(draft.id)
          break
        case 'rename':
          openDraftRename(draft)
          break
        case 'remove':
          handleRemoveDraft(draft)
          break
        default:
          break
      }
    },
    [
      buildDraft,
      verifyDraft,
      publishDraft,
      openDraftRename,
      handleRemoveDraft,
      message,
      t,
      openDraft
    ]
  )

  /* ── Workspace state ── */
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([])
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<number | null>(null)
  const [expandedWorkspaceId, setExpandedWorkspaceId] = useState<number | null>(null)
  const [hoveredWorkspaceId, setHoveredWorkspaceId] = useState<number | null>(null)
  /** Conversation cache for non-current workspaces (fetched on expand; the current workspace always uses the topics prop for realtime accuracy) */
  const [workspaceTopics, setWorkspaceTopics] = useState<Record<number, HarnessTopicRow[]>>({})
  const [workspaceTopicsLoading, setWorkspaceTopicsLoading] = useState<Record<number, boolean>>({})

  /**
   * The "chat" mode conversation list: **a single flat list**, attached to the root workspace (`<userData>/chat/`).
   *
   * Three things use it, so it must be tracked separately from `workspaceTopics`:
   * - list content (synced by the `topics` prop when the active workspace is the chat root directory; a cache when another mode is active);
   * - paged appends (fetch the next page at the bottom, merge and dedupe);
   * - loading state (show the skeleton only when never loaded, so an empty list does not flash).
   */
  const [chatWorkspaceTopics, setChatWorkspaceTopics] = useState<HarnessTopicRow[]>([])
  const [chatTopicsLoaded, setChatTopicsLoaded] = useState(false)
  const [chatTopicsLoading, setChatTopicsLoading] = useState(false)
  const [chatTopicsPage, setChatTopicsPage] = useState(0)
  const [chatTopicsHasMore, setChatTopicsHasMore] = useState(false)

  /* Search */
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<InputRef | null>(null)
  /**
   * Sidebar search results (mixed "conversation title + message body" for the current workspace):
   * only inputs of >= 2 characters hit the main process; empty/failed results both give feedback in the list area.
   */
  const [searchResults, setSearchResults] = useState<WorkspaceSearchResult | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  useEffect(() => {
    if (searchMode) searchInputRef.current?.focus()
  }, [searchMode])

  /* Rename modal */
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<WorkspaceRow | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)

  /* Conversation rename modal (same interaction as the workspace one: one input line + save) */
  const [topicRenameOpen, setTopicRenameOpen] = useState(false)
  const [topicRenameTarget, setTopicRenameTarget] = useState<HarnessTopicRow | null>(null)
  const [topicRenameName, setTopicRenameName] = useState('')
  const [topicRenameSaving, setTopicRenameSaving] = useState(false)

  /**
   * The "archived" group at the bottom of the sidebar (user 2026-11-25): conversations archived from **all workspaces** are collected here,
   * above "memory" and collapsed by default; opening one is read-only (input hidden) and it does not join the per-workspace conversation list.
   */
  const [archivedTopics, setArchivedTopics] = useState<HarnessTopicRow[]>([])
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [archivedLoading, setArchivedLoading] = useState(false)

  /** Fetch the "archived" list once (after archive / unarchive / delete / rename, refresh through it) */
  const loadArchivedTopics = useCallback(async (): Promise<void> => {
    setArchivedLoading(true)
    try {
      setArchivedTopics(await harnessApi.harness.getArchivedTopics())
    } catch (err) {
      console.error('Failed to load archived topics:', err)
    } finally {
      setArchivedLoading(false)
    }
  }, [])
  useEffect(() => {
    void loadArchivedTopics()
  }, [loadArchivedTopics])

  /** Candidate apps for "open in app" (the file explorer is always included; the rest are probed from local installs) */
  const [openInApps, setOpenInApps] = useState<{ id: string; label: string; icon?: string }[]>([])
  useEffect(() => {
    let alive = true
    harnessApi.harness
      .openInAppTargets()
      .then((targets) => {
        if (alive) setOpenInApps(targets)
      })
      .catch((err) => console.error('Failed to load open-in-app targets:', err))
    return () => {
      alive = false
    }
  }, [])

  // Mnemon memory overview state
  const [memoryExpanded, setMemoryExpanded] = useState(false)
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memorySnap, setMemorySnap] = useState<MnemonSidebarSnapshot | null>(null)
  /**
   * Memory follows the **current conversation** (user wording 2026-09-28: "the plugin's memory is not, like the memory inside work,
   * shown in the sidebar"): a plugin conversation -> that plugin's own memory; a work conversation / blank conversation -> the current workspace.
   * The value is written by useHarnessHandlers when switching conversations (see renderer/memory-scope.ts).
   *
   * The title says **only "Memory"**, with no scope name appended (user wording 2026-09-28: "the (Memory · personal ledger)
   * content is not needed"): this row already lives on the conversation side, and which memory set is read is decided by the current conversation, so it need not be repeated.
   * The Settings -> Memory page is different — that page is outside the conversation context and still shows which plugin it manages.
   */
  const memoryScope = useMemoryScope()

  const loadMnemonSnapshot = useCallback(async () => {
    setMemoryLoading(true)
    try {
      const snap = await harnessApi.harness.mnemonSnapshot(memoryScope)
      if (!snap.configured) {
        setMemorySnap({ configured: false })
      } else {
        setMemorySnap({
          configured: true,
          runtime: snap.runtime
            ? {
                entries: snap.runtime.entries,
                targets: snap.runtime.targets
              }
            : undefined,
          bodies: snap.bodies
            ? { total: snap.bodies.total, activeCount: snap.bodies.activeCount }
            : undefined,
          documents: snap.documents
            ? { total: snap.documents.total, activeCount: snap.documents.activeCount }
            : undefined
        })
      }
    } catch {
      setMemorySnap({ configured: false })
    } finally {
      setMemoryLoading(false)
    }
  }, [memoryScope])

  // Load the overview when the memory panel expands
  const handleToggleMemory = useCallback(async () => {
    const next = !memoryExpanded
    setMemoryExpanded(next)
    if (next) {
      await loadMnemonSnapshot()
    }
  }, [memoryExpanded, loadMnemonSnapshot])

  /**
   * Reload whenever the scope changes (switching to another plugin conversation / returning to a work conversation).
   * Clear before fetching in the expanded state: that is **another directory's** memory, and keeping the previous scope's entries would look like mixed memories.
   */
  const scopeRef = useRef<string | null>(null)
  useEffect(() => {
    if (scopeRef.current === memoryScope) return
    scopeRef.current = memoryScope
    if (!memoryExpanded) return
    setMemorySnap(null)
    void loadMnemonSnapshot()
  }, [memoryScope, memoryExpanded, loadMnemonSnapshot])

  /**
   * Open the "More -> Memory" page (`/more/memory`), not the settings modal.
   *
   * Assistant settings (agents / skills / memory / MCP) moved from the settings modal to a separate "More" page on 2026-11-21:
   * the old implementation sent `open-system-settings` with only `{ tab: 'memory' }`, without `scope: 'assistant'`,
   * so AppShell opened the modal as "non-assistant settings"; but the modal no longer has a memory tab, `memory` could not be resolved and
   * fell back to the first tab (General) — the "manage memory" the user clicked looked like an unrelated settings page.
   * Here we navigate by route directly (same as `/plugins` in this component), no longer going through the settings modal chain.
   */
  const handleOpenMemoryPage = useCallback(() => {
    void navigate('/more/memory')
  }, [navigate])

  // Listen for memory-change events (refresh the overview after the model writes memory in a conversation)
  useEffect(() => {
    const handleRefresh = (): void => {
      if (memoryExpanded) {
        loadMnemonSnapshot()
      }
    }
    window.addEventListener('memory-tree-refresh', handleRefresh)
    return () => window.removeEventListener('memory-tree-refresh', handleRefresh)
  }, [memoryExpanded, loadMnemonSnapshot])

  /* ── Workspaces and conversations ── */

  /**
   * Choose a plugin storage path (the "Choose plugin storage path" button in the empty state shares this route with the top-right +).
   *
   * Why it is placed after loadWorkspaces: after the path is chosen, the plugin workshop moves existing plugins over (workspace rows change),
   * so both the draft list and the workspace list must be refreshed afterwards, and both loaders must already be declared (otherwise the dependency array hits a TDZ).
   */
  const pickPluginsRoot = useCallback(async (): Promise<boolean> => {
    try {
      const result = await harnessApi.workshop.pickRoot()
      if (!result.ok) {
        viewMessage('workshop-root', 'error', result.error ?? '')
        return false
      }
      const data = result.data
      if (!data || data.canceled) return false
      setPluginsPath(data.dir ?? '')
      await Promise.all([loadDrafts(), loadWorkspaces()])
      return true
    } catch (error) {
      viewMessage('workshop-root', 'error', String(error))
      return false
    }
  }, [loadDrafts, loadWorkspaces, viewMessage])

  /** +: when no storage path is set, **first** let the user choose a folder, then show the create dialog (no picker inside the dialog) */
  const handleNewDraft = useCallback(async (): Promise<void> => {
    if (!pluginsPath) {
      const picked = await pickPluginsRoot()
      if (!picked) return
    }
    setNewDraftOpen(true)
  }, [pickPluginsRoot, pluginsPath])

  /**
   * Workspaces whose conversation list **has failed to load**.
   *
   * Only affects one thing: the renderer must no longer treat "never loaded successfully" as "still loading" — otherwise one failed IPC would leave
   * that row sits on the skeleton forever (no request is running and no data will arrive). On failure it falls back to the empty state, so the user can collapse and expand again
   * to retry (`handleToggleWorkspace`).
   */
  const topicFetchFailedRef = useRef<Set<number>>(new Set())

  /** Fetch conversations of a non-current workspace on demand; first page only (same paging rule as useHarness, so the list length does not jump on switching) */
  const loadWorkspaceTopics = useCallback(async (workspaceId: number): Promise<void> => {
    setWorkspaceTopicsLoading((prev) => ({ ...prev, [workspaceId]: true }))
    try {
      const result = await harnessApi.harness.getAllTopicsPaginated(
        workspaceId,
        0,
        TOPICS_PAGE_SIZE
      )
      setWorkspaceTopics((prev) => ({ ...prev, [workspaceId]: result.items }))
      topicFetchFailedRef.current.delete(workspaceId)
    } catch (err) {
      console.error('Failed to load workspace topics:', err)
      topicFetchFailedRef.current.add(workspaceId)
    } finally {
      setWorkspaceTopicsLoading((prev) => ({ ...prev, [workspaceId]: false }))
    }
  }, [])

  /**
   * Whether this workspace's conversation list must **fetch itself**.
   *
   * The active workspace's list normally comes from the `topics` prop (see the effect below and `renderTopicList`),
   * so when a local cache exists or `topics` already belongs to it, no fetch is needed. Conversely, when neither holds, the
   * list has **no data source at all**: no request running and no data coming — that is exactly "the skeleton never moves".
   */
  const needsTopicFetch = useCallback(
    (workspaceId: number): boolean =>
      !Object.prototype.hasOwnProperty.call(workspaceTopics, workspaceId) &&
      topicsWorkspaceId !== workspaceId,
    [workspaceTopics, topicsWorkspaceId]
  )

  /** Workspaces already auto-fetched once (failures are not retried automatically, so a broken IPC does not send a request every frame) */
  const autoLoadedTopicWorkspacesRef = useRef<Set<number>>(new Set())

  /**
   * "expanded but conversation list never loaded" -> fetch immediately.
   *
   * Why this fallback is needed: if the expanded workspace is the **active** one, `handleToggleWorkspace` would skip the request
   * (the active workspace's list is provided by the `topics` prop). Once that assumption fails (e.g. the workspace switch happened outside
   * the chat page, `topics` never covered this workspace, or the expanded state was set directly by startup restore / clicking a plugin row
   * without going through toggle), the list would stay on the loading skeleton forever — the 5 gray rows under the plugin row in the user's 2026-11-22 screenshot
   * were exactly that. Better to hit the local DB one extra time (tens of microseconds) than let the UI hang on a loading state that never ends.
   */
  useEffect(() => {
    const workspaceId = expandedWorkspaceId
    if (workspaceId == null) return
    if (!needsTopicFetch(workspaceId)) return
    // Provider is doing a full-list refresh (workspace switch): wait for it to come back instead of racing another identical query
    if (isRefreshingTopics) return
    if (workspaceTopicsLoading[workspaceId] === true) return
    if (autoLoadedTopicWorkspacesRef.current.has(workspaceId)) return
    autoLoadedTopicWorkspacesRef.current.add(workspaceId)
    void loadWorkspaceTopics(workspaceId)
  }, [
    expandedWorkspaceId,
    needsTopicFetch,
    isRefreshingTopics,
    workspaceTopicsLoading,
    loadWorkspaceTopics
  ])

  /**
   * Single source of truth: the list always renders the workspaceTopics cache.
   * The useHarness `topics` prop only refreshes the cache of the workspace it belongs to to the latest —
   * at the instant of a workspace switch `topics` still belongs to the old workspace, so never render a new workspace from it directly (the list would flash old data).
   */
  useEffect(() => {
    if (topicsWorkspaceId == null) return
    setWorkspaceTopics((prev) => ({ ...prev, [topicsWorkspaceId]: topics }))
    // The "chat" mode list is a flat list under the same root workspace: **merge and dedupe** rather than overwrite —
    // the second page the sidebar paged in itself must not be clobbered by the prop (which only has the first page)
    if (topicsWorkspaceId === chatWorkspaces.rootWorkspaceId) {
      setChatWorkspaceTopics((prev) => mergeTopicRows(prev, topics))
      setChatTopicsLoaded(true)
    }
  }, [topicsWorkspaceId, topics, chatWorkspaces.rootWorkspaceId])

  /**
   * First entry into "chat" mode fetches its conversation list's first page (the active workspace may still be elsewhere at that point,
   * so the `topics` prop is not it). Its loading state follows the same rule as the "work" mode conversation list:
   * show the skeleton only when never loaded.
   */
  const chatRootWorkspaceId = chatWorkspaces.rootWorkspaceId
  useEffect(() => {
    if (chatRootWorkspaceId == null || chatTopicsLoaded) return
    let alive = true
    setChatTopicsLoading(true)
    harnessApi.harness
      .getAllTopicsPaginated(chatRootWorkspaceId, 0, TOPICS_PAGE_SIZE)
      .then((result) => {
        if (!alive) return
        setChatWorkspaceTopics((prev) => mergeTopicRows(prev, result.items))
        setChatTopicsPage(0)
        setChatTopicsHasMore(result.hasMore)
      })
      .catch((err) => console.error('Failed to load chat topics:', err))
      .finally(() => {
        if (!alive) return
        setChatTopicsLoading(false)
        setChatTopicsLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [chatRootWorkspaceId, chatTopicsLoaded])

  /** "Chat" mode scroll pagination: append the next page and dedupe by id (the prop may push the first page back at any time) */
  const loadMoreChatTopics = useCallback(async (): Promise<void> => {
    const workspaceId = chatWorkspaces.rootWorkspaceId
    if (workspaceId == null || chatTopicsLoading || !chatTopicsHasMore) return
    setChatTopicsLoading(true)
    try {
      const nextPage = chatTopicsPage + 1
      const result = await harnessApi.harness.getAllTopicsPaginated(
        workspaceId,
        nextPage,
        TOPICS_PAGE_SIZE
      )
      setChatWorkspaceTopics((prev) => mergeTopicRows(prev, result.items))
      setChatTopicsPage(nextPage)
      setChatTopicsHasMore(result.hasMore)
    } catch (err) {
      console.error('Failed to load more chat topics:', err)
    } finally {
      setChatTopicsLoading(false)
    }
  }, [chatWorkspaces.rootWorkspaceId, chatTopicsLoading, chatTopicsHasMore, chatTopicsPage])

  // First mount: load the workspace list and expand the current workspace
  useEffect(() => {
    loadWorkspaces()
      .then(({ list, activeId }) => {
        setExpandedWorkspaceId(activeId ?? list[0]?.id ?? null)
      })
      .finally(() => setWorkspacesLoaded(true))
  }, [loadWorkspaces])

  // Workspace switch (including external entries such as subagents): sync the active state, expanded state and memory overview
  useEffect(() => {
    const handleWorkspaceChanged = (e: Event): void => {
      const detail = (e as CustomEvent<{ workspaceId?: number }>).detail
      const nextId = detail?.workspaceId ?? null
      if (memoryExpanded) {
        // Expanded state: clear the old workspace snapshot before reloading (memory is isolated per workspace, no stale content)
        setMemorySnap(null)
        loadMnemonSnapshot()
      } else {
        // Collapsed state: refresh the numbers only, do not clear, so the "memory" row does not flash
        loadMnemonSnapshot()
      }
      if (nextId != null) {
        setActiveWorkspaceId(nextId)
        setExpandedWorkspaceId(nextId)
      }
      loadWorkspaces().then()
      // The chat workspace may have just been created on demand by the main process (creating topics / activating conversations does not go through this sidebar):
      // sync its id once so the work list can filter it out and the chat list has a root to attach to
      loadChatWorkspaces().then()
      // The archived list is cross-workspace: realign it after workspace switch / new conversation too
      void loadArchivedTopics()
    }
    window.addEventListener('workspace-changed', handleWorkspaceChanged)
    return () => window.removeEventListener('workspace-changed', handleWorkspaceChanged)
  }, [memoryExpanded, loadMnemonSnapshot, loadWorkspaces, loadChatWorkspaces, loadArchivedTopics])

  /**
   * Switch workspace: write settings + dispatch the event (Index clears the current conversation and refreshes the conversation list).
   *
   * Returns whether the switch actually succeeded: if writing settings fails the caller must **abort** the following "open this conversation" —
   * otherwise the conversation content appears while the AI's working directory still sits in the previous workspace (file tools / file explorer
   * all in the wrong directory) without any indication in the UI.
   */
  const switchWorkspace = useCallback(
    async (ws: WorkspaceRow): Promise<boolean> => {
      try {
        await window.api.systemSettings.update({
          harness: {
            workspacePath: ws.path,
            activeWorkspaceId: ws.id
          } as Parameters<typeof window.api.systemSettings.update>[0]['harness']
        })
        setActiveWorkspaceId(ws.id)
        window.dispatchEvent(
          new CustomEvent('workspace-changed', { detail: { workspaceId: ws.id } })
        )
        return true
      } catch (err) {
        console.error('Failed to switch workspace:', err)
        viewMessage('workspace-switch', 'error', t('harness.sidebar.workspaceSwitchFailed'), 6)
        return false
      }
    },
    [t, viewMessage]
  )

  /**
   * Open a conversation in "chat" mode (or this mode's blank conversation): the main process computes the directory from the topic id (root directory /
   * `chat/<topic id>/`) and writes it as the active workspace.
   *
   * Why not look up the local list first and then switch like a normal workspace: chat workspaces are **created on demand**, and their paths
   * are known only to the main process (resolved per OS). This channel does "create directory + create workspace row + switch active workspace" in one go,
   * and the renderer only places the caret in the input box — this is also the chain behind "clicking any conversation in the chat list can work with files".
   */
  const activateChatTopic = useCallback(
    async (topicId?: number): Promise<{ workspaceId: number; dir: string } | null> => {
      const result =
        topicId != null
          ? await harnessApi.harness.activateChatTopic(topicId)
          : await harnessApi.harness.ensureChatWorkspace()
      if (!result.ok || !result.data) {
        viewMessage('chat-session-dir', 'error', result.error ?? '', 6)
        return null
      }
      const { workspaceId, dir } = result.data
      setActiveWorkspaceId(workspaceId)
      setExpandedWorkspaceId(null)
      // Let Index / useHarness catch up (refresh the conversation list, re-read the workspace path)
      window.dispatchEvent(new CustomEvent('workspace-changed', { detail: { workspaceId } }))
      // The just-created chat workspace must enter the local list immediately (so the work list can filter it out and the list gets a root)
      await Promise.all([loadWorkspaces(), loadChatWorkspaces()])
      return { workspaceId, dir }
    },
    [loadChatWorkspaces, loadWorkspaces, viewMessage]
  )

  /** Expand/collapse a workspace; when expanding, fetch its conversations on demand */
  const handleToggleWorkspace = useCallback(
    (workspaceId: number): void => {
      const next = expandedWorkspaceId === workspaceId ? null : workspaceId
      setExpandedWorkspaceId(next)
      // The active workspace's list is usually provided by the `topics` prop (`needsTopicFetch` blocks duplicate requests);
      // manually expanding again also comes here -> when the previous attempt failed, this is the retry entry point
      if (next != null && needsTopicFetch(next)) {
        autoLoadedTopicWorkspacesRef.current.add(next)
        void loadWorkspaceTopics(next)
      }
    },
    [expandedWorkspaceId, needsTopicFetch, loadWorkspaceTopics]
  )

  /**
   * Draft -> its "plugin workspace" id (a plugin conversation's working directory = the plugin source directory, see main/workshop/workspace.ts).
   * When no conversation has been opened for this plugin there is no such row (returns null, so the plugin row has nothing to expand).
   * The list comes from the main process (`workshop-state.pluginWorkspaces`): the renderer does not build paths itself,
   * so the two sides cannot disagree on "what counts as a plugin directory".
   */
  const pluginWorkspaceIdOf = useCallback(
    (draft: WorkshopDraftSummary): number | null =>
      pluginWorkspaces.find((item) => item.draftId === draft.id)?.workspaceId ?? null,
    [pluginWorkspaces]
  )

  /** Plugin workspace set (the work list must filter these rows out: they belong only to that plugin and do not enter "work" mode) */
  const pluginWorkspaceIds = useMemo(
    () => new Set(pluginWorkspaces.map((item) => item.workspaceId)),
    [pluginWorkspaces]
  )

  /** "Chat" mode workspace set (also filtered out of the "work" list) */
  const chatWorkspaceIds = useMemo(() => new Set(chatWorkspaces.ids), [chatWorkspaces.ids])

  /**
   * The active workspace is a plugin workspace but its draft is gone (the user deleted the sources in plugin mode, or deleted the directory elsewhere):
   * pull the UI back from the "pointing at a deleted directory" state.
   *
   * The main process already cleared `harness.workspacePath` in `workshop-remove` (otherwise after restart the file tools
   * would still target a non-existent directory); here sync the sidebar's active state and return to the blank welcome state. The workspace row and the conversations
   * themselves are kept (deleting sources is not deleting conversations); they reappear after a draft with the same name is recreated.
   */
  useEffect(() => {
    if (!draftsLoaded || activeWorkspaceId == null) return
    const pluginWs = pluginWorkspaces.find((item) => item.workspaceId === activeWorkspaceId)
    if (!pluginWs) return
    if (drafts.some((draft) => draft.id === pluginWs.draftId)) return
    setActiveWorkspaceId(null)
    setExpandedWorkspaceId(null)
    // Also invalidate the remembered "plugin mode current content" if it points at this deleted plugin: otherwise switching back to plugin mode /
    // restoring on restart keeps opening a non-existent plugin directory (one error toast each time, and the content stays elsewhere).
    if (pluginContentRef.current?.pluginId === pluginWs.draftId) rememberPlugin(null)
    window.dispatchEvent(new CustomEvent('workspace-changed', { detail: {} }))
    onNewHarness()
  }, [activeWorkspaceId, drafts, draftsLoaded, onNewHarness, pluginWorkspaces, rememberPlugin])

  /** Whether this row is a non-user workspace (plugin / chat): the work list lists only the user's own */
  const isNonUserWorkspace = useCallback(
    (workspaceId: number): boolean =>
      pluginWorkspaceIds.has(workspaceId) || chatWorkspaceIds.has(workspaceId),
    [pluginWorkspaceIds, chatWorkspaceIds]
  )

  /**
   * Open a conversation under a workspace: switch workspaces first when crossing workspaces.
   *
   * The mode switch follows the content: a plugin workspace conversation = plugin content -> stay on "plugin"; a "chat" workspace conversation
   * -> "chat"; a normal workspace conversation -> "work" (user wording 2026-09-27: "need to see whether the currently selected content
   * is work or plugin").
   *
   * Also record "this side's current content" (memory + persisted): this conversation is the one to restore on next launch
   * — without waiting for the "record by topics" effect below, whose precondition is that the topic list already belongs to that workspace,
   * which lags one beat when crossing workspaces.
   */
  const handleOpenTopic = useCallback(
    async (
      workspaceId: number,
      topic: HarnessTopicRow,
      focusDialogueId?: number
    ): Promise<void> => {
      const isPluginSession = pluginWorkspaceIds.has(workspaceId)
      const isChatSession = !isPluginSession && chatWorkspaceIds.has(workspaceId)
      setMode(isPluginSession ? 'plugin' : isChatSession ? 'chat' : 'work')
      if (isPluginSession) {
        const draftId = pluginWorkspaces.find((item) => item.workspaceId === workspaceId)?.draftId
        if (draftId) rememberPlugin({ pluginId: draftId, workspaceId, topicId: topic.id })
      } else if (isChatSession) {
        rememberChat({ workspaceId, topicId: topic.id })
      } else {
        rememberWork({ workspaceId, topicId: topic.id })
      }
      if (isChatSession) {
        // Chat workspaces are created on demand and their paths are known only to the main process: use their own channel, do not rely on the local list alone
        const activated = await activateChatTopic(topic.id)
        if (!activated) return
      } else {
        const cached = workspaces.find((w) => w.id === workspaceId)
        let target = cached ?? null
        if (!target) {
          // This row is not in the local list yet (the workspace was just created elsewhere): fetch one as a fallback,
          // so that "clicked a conversation but could not switch" does not happen — that is the place this chain most easily fails silently
          const { list } = await loadWorkspaces()
          target = list.find((w) => w.id === workspaceId) ?? null
        }
        if (target) {
          const switched = await switchWorkspace(target)
          if (!switched) return
        } else console.error('Failed to resolve the workspace to switch to:', workspaceId)
      }
      if (isPluginSession) setExpandedWorkspaceId(workspaceId)
      await onSelectTopic(
        topic,
        focusDialogueId != null ? { focusDialogueId } : undefined
      )
      // This conversation is already painted on screen; now bring the main content area back to the chat page (see onOpenHarness:
      // reversing the order would let the already-mounted `/harness` paint the previous conversation first, flashing)
      onOpenHarness()
    },
    [
      activeWorkspaceId,
      workspaces,
      loadWorkspaces,
      activateChatTopic,
      switchWorkspace,
      onSelectTopic,
      onOpenHarness,
      pluginWorkspaceIds,
      pluginWorkspaces,
      chatWorkspaceIds,
      rememberPlugin,
      rememberChat,
      rememberWork
    ]
  )

  /** Create a conversation in the given workspace: switch workspaces first when crossing workspaces */
  const handleCreateSession = useCallback(
    async (ws: WorkspaceRow): Promise<void> => {
      // If the swapped-out conversation is the generating one, hint after creation that "it continues in the background" (no block, see the ref explanation)
      const replacingRunningTopic = currentTopicRunningRef.current
      setExpandedWorkspaceId(ws.id)
      // Fetch once first when the workspace's conversations have never been loaded, to avoid an empty list at the switching instant
      if (!Object.prototype.hasOwnProperty.call(workspaceTopics, ws.id)) {
        loadWorkspaceTopics(ws.id).then()
      }
      if (ws.id !== activeWorkspaceId) {
        const switched = await switchWorkspace(ws)
        if (!switched) return
      }
      // What is created is this workspace's blank conversation: it is work mode's "current content"
      rememberWork({ workspaceId: ws.id, topicId: null })
      if (mode !== 'work') setMode('work')
      if (replacingRunningTopic) viewReplacedRunningTopic()
      onNewHarness()
      // The blank conversation is in place: now bring the main content area back to the chat page (otherwise the previous conversation flashes first, see onOpenHarness)
      onOpenHarness()
    },
    [
      activeWorkspaceId,
      workspaceTopics,
      loadWorkspaceTopics,
      switchWorkspace,
      onNewHarness,
      onOpenHarness,
      rememberWork,
      mode,
      viewReplacedRunningTopic
    ]
  )

  /**
   * "Chat" mode's + (and entering this mode): open a clean blank conversation.
   *
   * Same mechanism as the plugin row's +, only the working directory is the **app-initialized chat directory**:
   * - with no conversation, the active workspace = the "chat" root directory (`<userData>/chat/`);
   * - when opening a conversation, the active workspace = that conversation's own subdirectory (`<userData>/chat/<topic id>/`).
   *
   * Both paths are resolved by the main process (see main/chat/workspace.ts); the renderer only writes settings + dispatches events.
   * The memory scope carries `chat`: this mode has no workspace, and memory should not hang off a workspace either.
   *
   * @param options.topic open this conversation directly (used when switching back into this mode: the conversation still exists, just continue reading it)
   * @param options.focus whether to move the caret into the input box (true when clicking +; false when entering automatically via mode switch)
   * @param options.navigate whether to bring the main content area back to the chat page once content is in place (true only when the user clicks +;
   *   mode switches / startup restore do not navigate, see onOpenHarness)
   */
  const handleChatSession = useCallback(
    async (options?: {
      topic?: HarnessTopicRow
      focus?: boolean
      navigate?: boolean
    }): Promise<void> => {
      const topic = options?.topic
      // When the user clicks + (navigate), the swapped-out conversation may be the generating one: show a hint, do not block
      const replacingRunningTopic = Boolean(options?.navigate) && currentTopicRunningRef.current
      // Directory + workspace row + active workspace: the main process decides by topic id whether to use the root directory or the conversation subdirectory
      const activated = await activateChatTopic(topic?.id)
      if (!activated) return
      // Record "chat mode current content": continue reading it when switching modes back + on next launch
      rememberChat({ workspaceId: activated.workspaceId, topicId: topic?.id ?? null })
      if (topic) {
        await onSelectTopic(topic)
      } else {
        if (replacingRunningTopic) viewReplacedRunningTopic()
        onNewHarness()
      }
      // Focus only, do not write content; do not steal the caret when entering automatically via mode switch
      window.dispatchEvent(
        new CustomEvent('harness-focus-input', {
          detail: { scope: 'chat', focus: options?.focus !== false }
        })
      )
      // The blank conversation / specified conversation is already on screen; switch the route last (otherwise the previous conversation flashes)
      if (options?.navigate) onOpenHarness()
    },
    [
      activateChatTopic,
      onNewHarness,
      onOpenHarness,
      onSelectTopic,
      rememberChat,
      viewReplacedRunningTopic
    ]
  )

  /**
   * The plugin row's +: open a new conversation for this plugin (matching the workspace row's "+ New conversation").
   *
   * **The working directory is this plugin's own source directory** (`<plugin storage path>/<plugin id>/`): first have the main process fetch
   * (creating if needed) its "plugin workspace", then switch to it like a normal workspace — the AI working directory,
   * file explorer, file boundaries and file-change review all follow it. User wording 2026-09-28: "creating a conversation in plugin mode,
   * its workspace is still the workspace selected in the previous work mode, and the file explorer too" = the thing to fix.
   *
   * **Writes nothing to the input box** (user wording 2026-09-28: "what I need is to not display: plugin 'personal ledger'
   * (id: personal-ledger) this thing"): a new conversation is a clean blank conversation; only place the caret in the input box and
   * the user types what they want.
   *
   * **Carries the plugin id**: this conversation's memory uses **this plugin's own** (`<memoryPath>/plugin-<id>/`),
   * with zero overlap with work memory (user wording 2026-09-28: "the memory inside a plugin should be independent; now it directly uses the memory context selected in work
   * before, which causes problems"). The id is written by the input side when **creating the topic** into
   * `harness_topic.memory_scope` (see the harness-focus-input listener in useHarnessHandlers).
   *
   * Also **deliberately does not switch modes** (user wording 2026-09-27: "why does clicking new conversation inside a plugin switch to work"):
   * the user is still picking plugins, so the panel must not jump away; the switch stays on "plugin".
   *
   * @param options.topic open this conversation directly (used when switching back into this mode: the conversation still exists, just continue reading it)
   * @param options.focus whether to move the caret into the input box (true when clicking +; false when entering automatically via mode switch —-
   *   the user only wants to see the plugin side's content, so do not steal focus)
   * @param options.navigate whether to bring the main content area back to the chat page once content is in place (true only when the user clicks a plugin row)
   */
  const handlePluginSession = useCallback(
    async (
      draft: { id: string },
      options?: {
        topic?: HarnessTopicRow
        focus?: boolean
        navigate?: boolean
      }
    ): Promise<void> => {
      // If the swapped-out conversation is the generating one, hint "it continues in the background" once the new conversation is in place (no block)
      const replacingRunningTopic = currentTopicRunningRef.current
      const requestSeq = ++pluginSessionSeqRef.current
      // 1. Plugin workspace (= plugin source directory): create it if absent, use it if present
      const ensured = await harnessApi.workshop.ensureWorkspace(draft.id)
      if (requestSeq !== pluginSessionSeqRef.current) return
      if (!ensured.ok || !ensured.data) {
        viewMessage('plugin-session-ws', 'error', ensured.error ?? '', 6)
        return
      }
      const target = ensured.data
      // 2. Switch over (write settings + dispatch the event: Index swaps the file explorer root and clears the current conversation accordingly)
      try {
        await window.api.systemSettings.update({
          harness: {
            workspacePath: target.path,
            activeWorkspaceId: target.id
          } as Parameters<typeof window.api.systemSettings.update>[0]['harness']
        })
      } catch (err) {
        console.error('Failed to switch to plugin workspace:', err)
        viewMessage('plugin-session-ws', 'error', String(err), 6)
        return
      }
      // The user clicked another plugin in the meantime: the last one wins; do not overwrite it with the old request
      if (requestSeq !== pluginSessionSeqRef.current) return
      setActiveWorkspaceId(target.id)
      setExpandedWorkspaceId(target.id)
      window.dispatchEvent(
        new CustomEvent('workspace-changed', { detail: { workspaceId: target.id } })
      )
      // The just-created plugin workspace must enter the local list immediately (so the draft row can expand and the work list can filter it out)
      await Promise.all([loadWorkspaces(), loadDrafts()])
      if (requestSeq !== pluginSessionSeqRef.current) return
      // Record "plugin mode current content": continue reading it when switching modes back + on next launch
      rememberPlugin({
        pluginId: draft.id,
        workspaceId: target.id,
        topicId: options?.topic?.id ?? null
      })
      // 3. Open the specified conversation directly if any; otherwise open a blank new conversation + carry "which plugin this conversation belongs to"
      //    (which decides the memory set); only focus, write no content
      if (options?.topic) {
        await onSelectTopic(options.topic)
      } else {
        if (replacingRunningTopic) viewReplacedRunningTopic()
        onNewHarness()
      }
      if (options?.focus !== false) {
        window.dispatchEvent(
          new CustomEvent('harness-focus-input', { detail: { pluginId: draft.id, focus: true } })
        )
      } else {
        // Do not steal the caret, but **still carry the scope**: this blank conversation belongs to this plugin (which decides its memory set)
        window.dispatchEvent(
          new CustomEvent('harness-focus-input', { detail: { pluginId: draft.id, focus: false } })
        )
      }
      // The content (blank conversation / specified conversation) is in place; switch the route last — switching first would let `/harness` paint the previous conversation
      if (options?.navigate) onOpenHarness()
    },
    [
      loadDrafts,
      loadWorkspaces,
      onNewHarness,
      onOpenHarness,
      onSelectTopic,
      viewMessage,
      rememberPlugin,
      viewReplacedRunningTopic
    ]
  )

  /** After choosing a folder, create and activate the workspace directly (name taken from the directory name, renameable later) */
  const handleBrowseFolder = useCallback(async (): Promise<void> => {
    const replacingRunningTopic = currentTopicRunningRef.current
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
      setActiveWorkspaceId(id)
      setExpandedWorkspaceId(id)
      window.dispatchEvent(new CustomEvent('workspace-changed', { detail: { workspaceId: id } }))
      // The newly created and activated workspace = work mode's "current content" (blank conversation); the creation action itself also leaves the user on the work side
      rememberWork({ workspaceId: id, topicId: null })
      if (mode !== 'work') setMode('work')
      if (replacingRunningTopic) viewReplacedRunningTopic()
      onNewHarness()
      // The blank conversation is in place; finally bring the main content area back to the chat page (switching the route first would flash the previous conversation)
      onOpenHarness()
      await loadWorkspaces()
    } catch (err) {
      console.error('Failed to create workspace:', err)
      viewMessage('workspace-create-failed', 'error', t('harness.sidebar.workspaceCreateFailed'), 5)
    }
  }, [loadWorkspaces, onNewHarness, onOpenHarness, t, rememberWork, mode, viewReplacedRunningTopic, viewMessage])

  const handleDeleteWorkspace = useCallback(
    (ws: WorkspaceRow): void => {
      modal.confirm({
        title: t('harness.sidebar.workspaceDeleteConfirmTitle'),
        content: t('harness.sidebar.workspaceDeleteConfirmContent', { name: ws.name }),
        okText: t('common.action.delete'),
        okType: 'danger',
        cancelText: t('common.action.cancel'),
        onOk: async () => {
          try {
            await harnessApi.harness.deleteWorkspace(ws.id)
            // Also invalidate the remembered "work mode current content" if it points at the deleted workspace: the restore logic has a fallback,
            // but leaving a memory that points nowhere costs one extra detour on the next launch
            const wasRememberedWork = workContentRef.current?.workspaceId === ws.id
            if (activeWorkspaceId === ws.id) {
              // The deleted one is the current workspace: automatically switch to a remaining user workspace; if none remain, return to the "not configured" state.
              // Plugin / chat workspaces do not count as "the user's" — switching to one would drop the user into a plugin or chat directory unexpectedly
              const remaining = (await harnessApi.harness.getAllWorkspaces()).filter(
                (candidate) => !isNonUserWorkspace(candidate.id)
              )
              if (remaining.length > 0) {
                const next = remaining[0]
                await window.api.systemSettings.update({
                  harness: {
                    workspacePath: next.path,
                    activeWorkspaceId: next.id
                  } as Parameters<typeof window.api.systemSettings.update>[0]['harness']
                })
                setActiveWorkspaceId(next.id)
                setExpandedWorkspaceId(next.id)
                window.dispatchEvent(
                  new CustomEvent('workspace-changed', { detail: { workspaceId: next.id } })
                )
                rememberWork({ workspaceId: next.id, topicId: null })
              } else {
                await window.api.systemSettings.update({
                  harness: {
                    workspacePath: '',
                    activeWorkspaceId: undefined
                  } as Parameters<typeof window.api.systemSettings.update>[0]['harness']
                })
                setActiveWorkspaceId(null)
                setExpandedWorkspaceId(null)
                setWorkspaceTopics({})
                window.dispatchEvent(new CustomEvent('workspace-changed', { detail: {} }))
                rememberWork(null)
              }
              // The original conversation was deleted with the workspace; return to the blank welcome state
              onNewHarness()
            } else if (wasRememberedWork) {
              // The current content is on another side, but the deleted one is exactly what the work side remembered: clear it, do not leave a dangling memory
              rememberWork(null)
            }
            await loadWorkspaces()
          } catch (err) {
            console.error('Failed to delete workspace:', err)
            viewMessage(
              'workspace-delete-failed',
              'error',
              t('harness.sidebar.workspaceDeleteFailed'),
              5
            )
          }
        }
      })
    },
    [
      activeWorkspaceId,
      modal,
      loadWorkspaces,
      onNewHarness,
      t,
      isNonUserWorkspace,
      rememberWork,
      viewMessage
    ]
  )

  /**
   * "Show in folder": have the system file manager open this workspace's directory.
   *
   * Only the workspace id is passed; the main process resolves the directory from the row (the renderer cannot get it and should not pass arbitrary paths);
   * when the directory has been deleted/moved the main process returns a readable reason and this shows it verbatim — the user never sees
   * the English failure string of `shell.openPath`.
   */
  const handleRevealWorkspace = useCallback(
    async (ws: WorkspaceRow): Promise<void> => {
      try {
        const result = await harnessApi.harness.openWorkspaceDir(ws.id)
        if (!result.ok) viewMessage('ws-reveal-in-folder', 'error', result.error ?? '', 6)
      } catch (err) {
        viewMessage('ws-reveal-in-folder', 'error', String(err), 6)
      }
    },
    [viewMessage]
  )

  /* Open the rename modal */
  const openRename = useCallback((ws: WorkspaceRow): void => {
    setRenameTarget(ws)
    setRenameName(ws.name)
    setRenameOpen(true)
  }, [])

  /* Save the rename */
  const handleRenameSave = useCallback(async (): Promise<void> => {
    const name = renameName.trim()
    if (!name || !renameTarget) {
      viewMessage('ws-rename-validate', 'warning', t('harness.sidebar.workspaceNameRequired'))
      return
    }
    try {
      setRenameSaving(true)
      await harnessApi.harness.updateWorkspace(renameTarget.id, { name })
      setRenameOpen(false)
      await loadWorkspaces()
      viewMessage('ws-rename-done', 'success', t('harness.sidebar.renameSuccess'), 2)
    } catch (err) {
      console.error('Failed to rename workspace:', err)
      viewMessage('ws-rename-error', 'error', t('harness.sidebar.renameFailed'))
    } finally {
      setRenameSaving(false)
    }
  }, [renameName, renameTarget, viewMessage, loadWorkspaces, t])

  /* ── Conversation row actions (pin / rename / fork / open in app / archive / delete) ────────
   * User wording 2026-11-25 (mockup): the conversation "…" menu should contain these items, except "Copy Session ID".
   * Neither pin nor archive changes the active time (the main process only writes pinned_at / archived_at): after undoing, the row returns to its original position.
   */

  /** Conversation list refresh: the active workspace goes through the Provider (title/order follow it), other workspaces re-fetch the first page */
  const refreshTopicList = useCallback(
    async (workspaceId: number): Promise<void> => {
      if (workspaceId === topicsWorkspaceId) {
        await onRefreshTopics()
      } else {
        await loadWorkspaceTopics(workspaceId)
      }
    },
    [topicsWorkspaceId, onRefreshTopics, loadWorkspaceTopics]
  )

  /** Pin / unpin */
  const handleToggleTopicPin = useCallback(
    async (workspaceId: number, topic: HarnessTopicRow): Promise<void> => {
      try {
        await harnessApi.harness.setTopicPinned(topic.id, !topic.pinned_at)
        await refreshTopicList(workspaceId)
      } catch (err) {
        console.error('Failed to pin topic:', err)
        viewMessage('topic-pin', 'error', t('harness.sidebar.topicPinFailed'), 5)
      }
    },
    [refreshTopicList, t, viewMessage]
  )

  /** Archive / unarchive (archived conversations go into the "Archived" group, data is not deleted) */
  const handleToggleTopicArchive = useCallback(
    async (workspaceId: number, topic: HarnessTopicRow): Promise<void> => {
      const next = !topic.archived_at
      try {
        await harnessApi.harness.setTopicArchived(topic.id, next)
        await refreshTopicList(workspaceId)
        void loadArchivedTopics()
        // Editing the one currently being viewed: sync the read-only state in the chat page (the input box must come back after unarchiving)
        if (topic.id === currentTopicId) {
          window.dispatchEvent(
            new CustomEvent('harness-topic-archive-changed', {
              detail: { topicId: topic.id, archived: next }
            })
          )
        }
        viewMessage(
          'topic-archive',
          'success',
          next ? t('harness.sidebar.topicArchiveDone') : t('harness.sidebar.topicUnarchiveDone'),
          2
        )
      } catch (err) {
        console.error('Failed to archive topic:', err)
        viewMessage('topic-archive', 'error', t('harness.sidebar.topicArchiveFailed'), 5)
      }
    },
    [currentTopicId, loadArchivedTopics, refreshTopicList, t, viewMessage]
  )

  const openRenameTopic = useCallback((topic: HarnessTopicRow): void => {
    setTopicRenameTarget(topic)
    setTopicRenameName(topic.title)
    setTopicRenameOpen(true)
  }, [])

  const handleRenameTopicSave = useCallback(async (): Promise<void> => {
    const name = topicRenameName.trim()
    if (!name || !topicRenameTarget) {
      viewMessage('topic-rename-validate', 'warning', t('harness.sidebar.topicNameRequired'))
      return
    }
    const topic = topicRenameTarget
    try {
      setTopicRenameSaving(true)
      await harnessApi.harness.updateTopic(topic.id, { title: name })
      setTopicRenameOpen(false)
      await refreshTopicList(topic.workspace_id)
      void loadArchivedTopics()
      viewMessage('topic-rename-done', 'success', t('harness.sidebar.topicRenameSuccess'), 2)
    } catch (err) {
      console.error('Failed to rename topic:', err)
      viewMessage('topic-rename-error', 'error', t('harness.sidebar.topicRenameFailed'))
    } finally {
      setTopicRenameSaving(false)
    }
  }, [topicRenameName, topicRenameTarget, refreshTopicList, loadArchivedTopics, viewMessage, t])

  /**
   * Fork a conversation: the main process copies "topic + all messages" into a new conversation; here refresh the list and **open that new conversation**
   * (through handleOpenTopic: cross-workspace, mode switch, memory scope and route follow the same chain as clicking a conversation row).
   */
  const handleForkTopic = useCallback(
    async (workspaceId: number, topic: HarnessTopicRow): Promise<void> => {
      try {
        const title = t('harness.sidebar.topicForkTitle', { title: topic.title })
        const forked = await harnessApi.harness.forkTopic(topic.id, title)
        if (!forked) {
          viewMessage('topic-fork', 'error', t('harness.sidebar.topicForkFailed'), 5)
          return
        }
        await refreshTopicList(workspaceId)
        await handleOpenTopic(workspaceId, forked)
        viewMessage('topic-fork', 'success', t('harness.sidebar.topicForkDone'), 2)
      } catch (err) {
        console.error('Failed to fork topic:', err)
        viewMessage('topic-fork', 'error', t('harness.sidebar.topicForkFailed'), 5)
      }
    },
    [handleOpenTopic, refreshTopicList, t, viewMessage]
  )

  /** "Open in app": open this conversation's workspace directory with the selected app */
  const handleOpenTopicInApp = useCallback(
    async (workspaceId: number, appId: string): Promise<void> => {
      try {
        const result = await harnessApi.harness.openWorkspaceInApp(workspaceId, appId)
        if (!result.ok) viewMessage('topic-open-in-app', 'error', result.error ?? '', 6)
      } catch (err) {
        viewMessage('topic-open-in-app', 'error', String(err), 6)
      }
    },
    [viewMessage]
  )

  /**
   * Delete a conversation (the flow previously written inline in the row menu, moved out as-is for the menu builder).
   *
   * Deleting the current one resets the chat directory / memory scope; deleting a conversation in a non-active workspace must refresh the local cache
   * — the reasons are in the per-block comments below (user's 2026-10-26 "deleted but still selected in history").
   */
  const handleDeleteTopicRow = useCallback(
    async (workspaceId: number, topic: HarnessTopicRow, running: boolean): Promise<void> => {
      if (running) return
      const isChatTopic = chatWorkspaceIds.has(workspaceId)
      const pluginId = pluginWorkspaces.find((item) => item.workspaceId === workspaceId)?.draftId
      const wasCurrent = currentTopicId === topic.id
      // Register first: otherwise the "remember current content" effect would overwrite it late with the old currentTopicId
      // (see the deletedTopicIdsRef explanation)
      deletedTopicIdsRef.current.add(topic.id)
      await onDeleteTopic(topic.id)
      if (isChatTopic) {
        // Chat mode: remove it from the local list (useHarness does not refresh when it does not belong to the current active workspace),
        // and also delete this conversation's own directory (the main process has two safeguards; failure does not affect deleting the topic)
        setChatWorkspaceTopics((prev) => prev.filter((item) => item.id !== topic.id))
        void harnessApi.harness.removeChatTopicDir(topic.id)
        if (wasCurrent) {
          // Deleting the one **currently being viewed**: `onDeleteTopic → onNewHarness` only cleared the view,
          // the active directory still points at this conversation's subdirectory (now deleted -> the model gets ENOENT on the first file write),
          // and the pending memory scope was cleared to "workspace". Both must be reset in place:
          // the directory back to the chat root, the memory back to chat (the next new topic falls back by workspace kind in the main process;
          // here the UI side is synced back to chat too, so the sidebar memory block shows the right set).
          const activation = await activateChatTopic()
          if (activation) {
            rememberChat({ workspaceId: activation.workspaceId, topicId: null })
          }
          window.dispatchEvent(
            new CustomEvent('harness-focus-input', {
              detail: { scope: 'chat', focus: false }
            })
          )
        }
      } else if (workspaceId !== activeWorkspaceId) {
        await loadWorkspaceTopics(workspaceId)
      }
      // Same for plugin conversations: `onDeleteTopic → onNewHarness` clears the pending scope to workspace,
      // so the next new topic would leak into work memory; put this plugin's scope back (no need to touch the directory,
      // the plugin workspace still points at the plugin source directory, which was not deleted)
      if (!isChatTopic && wasCurrent && pluginId) {
        rememberPlugin({ pluginId, workspaceId, topicId: null })
        window.dispatchEvent(
          new CustomEvent('harness-focus-input', {
            detail: { pluginId, focus: false }
          })
        )
      }
      // The deleted one may be the row in the archived list: refresh that list too
      void loadArchivedTopics()
    },
    [
      activateChatTopic,
      activeWorkspaceId,
      chatWorkspaceIds,
      currentTopicId,
      loadArchivedTopics,
      loadWorkspaceTopics,
      onDeleteTopic,
      pluginWorkspaces,
      rememberChat,
      rememberPlugin
    ]
  )

  /** Shortcut hint text: Ctrl + Alt on Windows/Linux, ⌘ + ⌥ on macOS */
  const shortcutHint = (key: string, shift = false): string => {
    const mod = isMacPlatform ? '⌘' : 'Ctrl'
    const alt = shift ? 'Shift' : isMacPlatform ? '⌥' : 'Alt'
    return `${mod} + ${alt} + ${key}`
  }

  /**
   * The conversation row's "…" menu (order matches the mockup the user gave on 2026-11-25):
   * pin / rename / fork -> open in app ▸ -> archive / delete.
   * The mockup's "Copy Session ID" is **not** implemented per user wording.
   *
   * Every menu item calls `domEvent.stopPropagation()`: the menu lives in **this row's React subtree**
   * (the portal only changes the DOM location; React events still bubble along the component tree), and without stopping them they would also trigger the row's
   * onClick -> open this conversation (user 2026-10-26 "the deleted one is the current conversation… content is still the selected history").
   */
  const topicMenuItems = (
    workspaceId: number,
    topic: HarnessTopicRow,
    running: boolean
  ): NonNullable<MenuProps['items']> => {
    const archived = Boolean(topic.archived_at)
    const pinned = Boolean(topic.pinned_at)
    const stop = (domEvent: { stopPropagation(): void }): void => domEvent.stopPropagation()

    const openInChildren: NonNullable<MenuProps['items']> = openInApps.length
      ? openInApps.map((app) => ({
          key: `open-in:${app.id}`,
          label: app.label,
          // Use the real icon of the app installed on the system (a PNG extracted by the main process via app.getFileIcon); fall back to the generic icon only when unavailable
          icon: app.icon ? (
            <img
              src={app.icon}
              alt=""
              width={16}
              height={16}
              style={{ display: 'block', objectFit: 'contain', borderRadius: 3 }}
            />
          ) : app.id === 'explorer' ? (
            <RiFolderOpenLine size={14} />
          ) : (
            <RiCodeLine size={14} />
          ),
          onClick: ({ domEvent }) => {
            stop(domEvent)
            void handleOpenTopicInApp(workspaceId, app.id)
          }
        }))
      : [
          {
            key: 'open-in:none',
            label: t('harness.sidebar.topicOpenInAppEmpty'),
            disabled: true
          }
        ]

    const items: NonNullable<MenuProps['items']> = []
    if (!archived) {
      items.push({
        key: 'pin',
        label: pinned ? t('harness.sidebar.topicUnpin') : t('harness.sidebar.topicPin'),
        icon: <RiPushpinLine size={14} />,
        onClick: ({ domEvent }) => {
          stop(domEvent)
          void handleToggleTopicPin(workspaceId, topic)
        }
      })
    }
    items.push(
      {
        key: 'rename',
        label: t('common.action.rename'),
        icon: <RiEditLine size={14} />,
        extra: shortcutHint('G'),
        onClick: ({ domEvent }) => {
          stop(domEvent)
          openRenameTopic(topic)
        }
      },
      {
        key: 'fork',
        label: t('harness.sidebar.topicFork'),
        icon: <RiGitBranchLine size={14} />,
        extra: shortcutHint('F'),
        onClick: ({ domEvent }) => {
          stop(domEvent)
          void handleForkTopic(workspaceId, topic)
        }
      },
      { type: 'divider' },
      {
        key: 'open-in',
        label: t('harness.sidebar.topicOpenInApp'),
        icon: <RiExternalLinkLine size={14} />,
        children: openInChildren
      },
      { type: 'divider' }
    )
    items.push(
      archived
        ? {
            key: 'unarchive',
            label: t('harness.sidebar.topicUnarchive'),
            icon: <RiInboxUnarchiveLine size={14} />,
            extra: shortcutHint('A', true),
            onClick: ({ domEvent }) => {
              stop(domEvent)
              void handleToggleTopicArchive(workspaceId, topic)
            }
          }
        : {
            key: 'archive',
            label: running
              ? t('harness.sidebar.topicArchiveBlocked')
              : t('harness.sidebar.topicArchive'),
            icon: <RiArchiveLine size={14} />,
            extra: shortcutHint('A', true),
            disabled: running,
            onClick: ({ domEvent }) => {
              stop(domEvent)
              void handleToggleTopicArchive(workspaceId, topic)
            }
          }
    )
    items.push({
      key: 'delete',
      // Deleting is forbidden while a conversation is generating (including topics still streaming in the background)
      label: running ? t('harness.sidebar.topicDeleteBlocked') : t('harness.sidebar.topicDelete'),
      danger: true,
      disabled: running,
      icon: <RiDeleteBin6Line size={14} />,
      onClick: ({ domEvent }) => {
        stop(domEvent)
        void handleDeleteTopicRow(workspaceId, topic, running)
      }
    })
    return items
  }

  /** The currently selected conversation (may live under any workspace / chat root / plugin workspace) */
  const findTopicById = useCallback(
    (topicId: number): HarnessTopicRow | null => {
      for (const rows of Object.values(workspaceTopics)) {
        const hit = rows.find((topic) => topic.id === topicId)
        if (hit) return hit
      }
      return chatWorkspaceTopics.find((topic) => topic.id === topicId) ?? null
    },
    [workspaceTopics, chatWorkspaceTopics]
  )

  /**
   * Conversation shortcuts (matching the labels in the menu): Ctrl/⌘ + Alt + G rename, Ctrl/⌘ + Alt + F fork,
   * Ctrl/⌘ + Shift + A archive.
   *
   * They act only on **the currently selected conversation**, and only on the chat page — the sidebar is always mounted in the shell, so when the user is on Notes /
   * the settings page these keys must not touch conversations.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Holding the key repeats: fork/archive must not be triggered by auto-repeat
      if (event.repeat) return
      if (!(event.ctrlKey || event.metaKey)) return
      // The app uses hash routing (`#/harness`): the URL pathname is always `/`, only the hash matters
      if (!window.location.hash.startsWith('#/harness')) return
      if (currentTopicId == null) return
      const topic = findTopicById(currentTopicId)
      if (!topic) return
      const key = event.key.toLowerCase()
      if (event.altKey && !event.shiftKey && key === 'g') {
        event.preventDefault()
        openRenameTopic(topic)
      } else if (event.altKey && !event.shiftKey && key === 'f') {
        event.preventDefault()
        void handleForkTopic(topic.workspace_id, topic)
      } else if (!event.altKey && event.shiftKey && key === 'a') {
        event.preventDefault()
        void handleToggleTopicArchive(topic.workspace_id, topic)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [currentTopicId, findTopicById, openRenameTopic, handleForkTopic, handleToggleTopicArchive])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40
    if (!nearBottom) return
    // The "chat" mode list has no workspace layer: scroll pagination uses its own path
    if (mode === 'chat') {
      void loadMoreChatTopics()
      return
    }
    if (isLoadingMoreTopics || !hasMoreTopics) return
    onLoadMoreTopics()
  }, [mode, loadMoreChatTopics, isLoadingMoreTopics, hasMoreTopics, onLoadMoreTopics])

  /* Current conversation list of a workspace: always read the cache (refreshed by the topics prop for its workspace) */
  const topicsOf = useCallback(
    (workspaceId: number): HarnessTopicRow[] => workspaceTopics[workspaceId] ?? [],
    [workspaceTopics]
  )
  /** Whether this workspace's conversations have been loaded (show the spinner only when never loaded, so an empty list does not flash) */
  const hasTopicsLoaded = useCallback(
    (workspaceId: number): boolean =>
      Object.prototype.hasOwnProperty.call(workspaceTopics, workspaceId),
    [workspaceTopics]
  )

  const query = searchQuery.trim().toLowerCase()

  /** Workspaces that truly belong to the user (plugin / chat workspaces do not enter this list, see their modes) */
  const userWorkspaces = workspaces.filter((ws) => !isNonUserWorkspace(ws.id))
  const visibleWorkspaces = query
    ? userWorkspaces.filter(
        (ws) =>
          ws.name.toLowerCase().includes(query) ||
          topicsOf(ws.id).some((t) => t.title.toLowerCase().includes(query))
      )
    : userWorkspaces
  /**
   * Conversation order: pinned first, the rest by most recent activity descending.
   *
   * The main process query sorts this way too (see the mapper's topicOrderBy); sorting again here keeps local optimistic updates
   * (not waiting for IPC after pin/unpin) and paged appends from jumping.
   */
  const sortTopics = (list: HarnessTopicRow[]): HarnessTopicRow[] =>
    [...list].sort((a, b) => {
      const pinnedA = a.pinned_at ? 0 : 1
      const pinnedB = b.pinned_at ? 0 : 1
      if (pinnedA !== pinnedB) return pinnedA - pinnedB
      return String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''))
    })

  const visibleTopicsOf = (workspaceId: number): HarnessTopicRow[] => {
    // Archived conversations do not stay in the workspace list: they are collected in the "Archived" group at the bottom of the sidebar (read-only)
    const list = topicsOf(workspaceId).filter((topic) => !topic.archived_at)
    return sortTopics(query ? list.filter((t) => t.title.toLowerCase().includes(query)) : list)
  }
  /** Draft list in plugin mode (the search box is shared by all three modes: filter by name/id/its own conversation titles) */
  const visibleDrafts = query
    ? drafts.filter((draft) => {
        if (draft.title.toLowerCase().includes(query) || draft.id.toLowerCase().includes(query)) {
          return true
        }
        const wsId = pluginWorkspaceIdOf(draft)
        return wsId != null && topicsOf(wsId).some((t) => t.title.toLowerCase().includes(query))
      })
    : drafts

  /** "Chat" mode conversation list (shared search box: filter by conversation title; pinned rows still come first) */
  const chatVisibleTopics = sortTopics(
    query
      ? chatWorkspaceTopics.filter((topic) => topic.title.toLowerCase().includes(query))
      : chatWorkspaceTopics
  )

  /** Draft status row: the latest result of each of build / accept / install */
  const draftStateOf = (draft: WorkshopDraftSummary): { text: string; color: string } => {
    if (draft.installed) {
      return {
        text: draft.enabled
          ? t('harness.sidebar.pluginState.enabled')
          : t('harness.sidebar.pluginState.disabled'),
        color: draft.enabled ? token.colorSuccess : colorTextTertiary
      }
    }
    if (draft.lastReport) {
      return draft.lastReport.ok
        ? { text: t('harness.sidebar.pluginState.verified'), color: token.colorSuccess }
        : {
            text: t('harness.sidebar.pluginState.verifyFailed', {
              failed: draft.lastReport.failed
            }),
            color: token.colorError
          }
    }
    if (draft.built)
      return { text: t('harness.sidebar.pluginState.built'), color: colorTextTertiary }
    return { text: t('harness.sidebar.pluginState.draft'), color: colorTextTertiary }
  }

  /**
   * Plugin row: clicking a row = open its workshop detail; hover reveals "… (build/accept/install/rename/delete)" and
   * "+ (create a conversation for this plugin)" — one-to-one with the workspace row's two inline actions
   * (user wording 2026-09-27: "plugins do not have features like workspaces do").
   *
   * Once this plugin has had a conversation, **the 16px slot at the row start** becomes the collapse arrow, and it is **always shown**: expanding reveals **its own conversations**
   * (conversations attach under the "plugin workspace" = plugin source directory, see main/workshop/workspace.ts).
   * The only difference from the workspace row is the trigger: that row is clickable across its width (click row = expand),
   * while this row's whole area is "open workshop detail", so collapsing needs its own button and must not steal the existing click semantics.
   *
   * User wording 2026-09-28: "the collapse is displayed twice, it shows a collapse button at first, then hovering shows the collapse button again,
   * keep it at the beginning, consistent with work mode": the collapse arrow used to sit between the title and the status text —
   * at rest it sat next to "Draft/In use", and on hover those two 22px actions pushed the status text away, so the arrow **shifted left by 24px**,
   * the same control appearing in two positions across two states, looking like a second collapse button popped out (measured x 156 -> 132).
   * The workspace row (work mode) already uses **a persistent icon at the row start** as its collapse indicator (folder open/closed); align with it here:
   * the arrow stays in the row-start slot => only the status and hover actions remain right of the title, and neither state shifts.
   * When no conversation has been opened yet (nothing to expand), the row start still shows the plugin icon.
   * User wording 2026-09-28: "the plugin directory does not enter the 'work' list, it belongs only to that plugin".
   */
  const renderDraft = (draft: WorkshopDraftSummary): React.ReactNode => {
    const state = draftStateOf(draft)
    /** This row is running build/accept/install: hide the inline actions first to prevent double clicks */
    const busy = draftBusyIds.has(draft.id)
    /** This plugin's "plugin workspace" (the conversation's working directory); absent until a conversation has been opened */
    const pluginWsId = pluginWorkspaceIdOf(draft)
    const expanded = pluginWsId != null && expandedWorkspaceId === pluginWsId
    /** Whether this plugin's own conversations have one generating (deleting the sources would pull its working directory away) */
    const pluginSessionRunning =
      pluginWsId != null && topicsOf(pluginWsId).some((topic) => loadingTopicIds.has(topic.id))
    return (
      <div key={draft.id} className="mb-0.5">
        <div
          className="group flex items-center gap-2 mx-2 my-0.5 rounded-md cursor-pointer transition-colors"
          style={{
            paddingLeft: 6,
            paddingRight: 8,
            height: 32,
            color: colorText,
            background: expanded ? token.colorFillTertiary : 'transparent'
          }}
          onClick={() => {
            // Clicking a plugin row = open (or switch to) a conversation for this plugin: the content is on the chat page
            // (the route is brought back by handlePluginSession once content is in place, see onOpenHarness)
            void handlePluginSession(draft, { navigate: true })
          }}
          title={t('harness.sidebar.pluginNewSession')}
          onMouseEnter={(e) => {
            if (!expanded) e.currentTarget.style.background = colorFillAlter
          }}
          onMouseLeave={(e) => {
            if (!expanded) e.currentTarget.style.background = 'transparent'
          }}
        >
          {/*
            16px slot at the row start (same slot, same x as the workspace row's folder icon => titles all land at 30px):
            a **persistent collapse arrow** when there are conversations to expand, matching the workspace row's folder in shape and tone
            (closed = tertiary gray, open = secondary gray); before any conversation exists it is still the plugin icon.
          */}
          {pluginWsId != null ? (
            <button
              onClick={(e) => {
                e.stopPropagation()
                handleToggleWorkspace(pluginWsId)
              }}
              title={
                expanded
                  ? t('harness.sidebar.pluginSessionsCollapse')
                  : t('harness.sidebar.pluginSessionsExpand')
              }
              className="flex items-center justify-center shrink-0 rounded"
              style={{
                width: 16,
                height: 16,
                color: expanded ? colorTextSecondary : colorTextTertiary,
                background: 'transparent'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = token.colorFillSecondary)}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              {expanded ? <RiArrowDownSLine size={15} /> : <RiArrowRightSLine size={15} />}
            </button>
          ) : (
            <span
              className="flex items-center justify-center shrink-0"
              style={{ width: 16, color: colorTextSecondary }}
            >
              <RiPuzzleLine size={15} />
            </span>
          )}
          {/* Title size/weight match the workspace row (both are top-level rows of this tree; conversation rows use regular weight) */}
          <span className="flex-1 min-w-0 truncate" style={{ fontSize: 13, fontWeight: 500 }}>
            {draft.title}
          </span>
          {/*
            Status slot: a spinner while build/accept/install runs (previously at the row start, moved aside for the persistent collapse arrow),
            otherwise the status text (on hover it yields to "… +").
          */}
          {busy && (
            <span className="shrink-0 flex items-center justify-center" style={{ width: 20 }}>
              <ChaseDots size={14} color={colorTextTertiary} />
            </span>
          )}
          {!busy && (
            <span
              className="shrink-0 group-hover:hidden"
              style={{ fontSize: 11, color: state.color }}
            >
              {state.text}
            </span>
          )}
          {!busy && (
            <span className="hidden group-hover:flex items-center gap-0.5 shrink-0">
              <Dropdown
                menu={{
                  items: draftMenuFor(draft, pluginSessionRunning),
                  onClick: ({ key, domEvent }) => {
                    domEvent.stopPropagation()
                    onDraftMenuClick(draft, key)
                  }
                }}
                trigger={['click']}
                placement="bottomRight"
              >
                <button
                  onClick={(e) => e.stopPropagation()}
                  title={t('harness.sidebar.pluginActions')}
                  className="flex items-center justify-center rounded"
                  style={{
                    width: 22,
                    height: 22,
                    color: colorTextSecondary,
                    background: 'transparent'
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = token.colorFillSecondary)
                  }
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <RiMoreLine size={15} />
                </button>
              </Dropdown>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  // The route is brought back by handlePluginSession once content is in place (switching first would flash the previous conversation)
                  void handlePluginSession(draft, { navigate: true })
                }}
                title={t('harness.sidebar.pluginNewSession')}
                className="flex items-center justify-center rounded"
                style={{
                  width: 22,
                  height: 22,
                  color: colorTextSecondary,
                  background: 'transparent'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = token.colorFillSecondary)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <RiAddLine size={16} />
              </button>
            </span>
          )}
        </div>

        {/* Expanded = this plugin's own conversations (attached under the plugin workspace, rendered the same as conversations of other workspaces) */}
        {expanded && pluginWsId != null && renderTopicList(pluginWsId)}
      </div>
    )
  }

  /* Hot-memory counts grouped by target */
  const userEntries = memorySnap?.runtime?.entries.filter((e) => e.target === 'user') ?? []
  const memoryEntries = memorySnap?.runtime?.entries.filter((e) => e.target === 'memory') ?? []

  /* Colors of the top-row right action capsule: hand-written colors for the dark shell (same set as the mode switch), antd tokens for light */
  const headerTrack = shellMode ? '#2a2a2d' : colorFillAlter
  // Vertical divider between "search / new" in the top capsule: hand-written color for the dark shell, colorBorder for the light theme
  // (colorBorderSecondary is almost invisible on the light-gray capsule; user 2026-11-26 "the divider in the middle is invisible")
  const headerHairline = shellMode ? '#3a3a40' : token.colorBorder
  const headerHover = shellMode ? '#3a3a40' : token.colorFill

  /**
   * Header icon button.
   *
   * - `compact`: one cell in the right action capsule (26x20, icon 14, radius 5, fitting the 24px capsule inner height);
   * - default: the close button in search mode (26x26, radius 7).
   *
   * Hover only changes the background and icon color, no border/shadow: the top row already has a white thumb, so action buttons stay quiet.
   */
  const iconBtn = (
    title: string,
    onClick: () => void,
    icon: React.ReactNode,
    /** Compact style: for the right action capsule */
    compact = false
  ): React.ReactNode => (
    <button
      title={title}
      onClick={onClick}
      className="flex items-center justify-center transition-colors"
      style={{
        width: 26,
        height: compact ? 20 : 26,
        border: 'none',
        borderRadius: compact ? 5 : 7,
        background: 'transparent',
        color: colorTextSecondary,
        cursor: 'pointer'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = headerHover
        e.currentTarget.style.color = colorText
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = colorTextSecondary
      }}
    >
      {icon}
    </button>
  )

  /** Conversation row */
  const renderTopicRow = (workspaceId: number, topic: HarnessTopicRow): React.ReactNode => {
    const isTopicLoading = loadingTopicIds.has(topic.id)
    /**
     * Which state the row-start indicator slot shows (priority per resolveTopicRunStatus and user wording 2026-11-23):
     * waiting for user confirmation (yellow breathing dot) > in progress (chasing dots) > just finished (green breathing dot, cleared on open).
     */
    const topicStatus = resolveTopicRunStatus({
      awaiting: awaitingTopicIds.has(topic.id),
      running: isTopicLoading,
      completed: completedTopicIds.has(topic.id)
    })
    const selected = workspaceId === activeWorkspaceId && currentTopicId === topic.id
    const archived = Boolean(topic.archived_at)
    return (
      <div
        key={topic.id}
        onClick={() => handleOpenTopic(workspaceId, topic)}
        /* Stable hook: the test harness uses it to tell "which conversation is current" (whether content followed after a mode switch) */
        data-topic-id={topic.id}
        data-topic-selected={selected ? '1' : '0'}
        data-topic-archived={archived ? '1' : '0'}
        data-topic-pinned={topic.pinned_at ? '1' : '0'}
        /* Stable hook: state of the row-start indicator (idle / running / awaiting / completed), asserted by the test harness */
        data-topic-status={topicStatus}
        className="group flex items-center gap-2 mx-2 my-0.5 rounded-md cursor-pointer transition-colors"
        style={{
          // Left padding 6 + 16px row-start indicator slot = aligned with the workspace row icon column (14-30px);
          // with the slot + gap(8) the title lands at 38px, same column as workspace names
          paddingLeft: 6,
          paddingRight: 8,
          height: 30,
          color: selected ? colorText : colorTextSecondary,
          background: selected ? token.colorFill : 'transparent',
          // Archived conversations sit in the "Archived" group: rendered dimmer so they are obviously not in the main list
          opacity: archived ? 0.62 : 1
        }}
        onMouseEnter={(e) => {
          if (!selected) e.currentTarget.style.background = token.colorFillQuaternary
        }}
        onMouseLeave={(e) => {
          if (!selected) e.currentTarget.style.background = 'transparent'
        }}
      >
        {/* Row-start indicator slot: fixed 16px (empty at rest; in progress = chasing dots, awaiting confirmation = yellow breathing dot,
            just finished = green breathing dot), keeping the same column as workspace icons and the title from shifting */}
        <span
          className="flex items-center justify-center shrink-0"
          style={{ width: 16, height: 16 }}
        >
          {topicStatus === 'awaiting' ? (
            <TopicStatusDot color={colorWarning} label={t('harness.sidebar.topicAwaiting')} />
          ) : topicStatus === 'running' ? (
            <ChaseDots size={14} color={colorTextTertiary} />
          ) : topicStatus === 'completed' ? (
            <TopicStatusDot color={colorSuccess} label={t('harness.sidebar.topicCompleted')} />
          ) : null}
        </span>
        {/* Pin marker at the row end (user wording 2026-11-25: "it should go at the back"): time on the left, pin rightmost;
            on hover only the time is replaced by …, the marker itself does not move */}
        <span className="flex-1 min-w-0 truncate" style={{ fontSize: 13 }}>
          {topic.title}
        </span>
        {!isTopicLoading && (
          <span
            className="shrink-0 group-hover:hidden"
            style={{ fontSize: 11, color: colorTextTertiary }}
          >
            {formatRelativeTime(t, topic.updated_at)}
          </span>
        )}
        <Dropdown
          menu={{ items: topicMenuItems(workspaceId, topic, isTopicLoading) }}
          trigger={['click']}
          placement="bottomRight"
        >
          <button
            onClick={(e) => e.stopPropagation()}
            title={
              isTopicLoading ? t('harness.sidebar.topicRunning') : t('harness.sidebar.topicActions')
            }
            className="hidden group-hover:flex items-center justify-center shrink-0 rounded"
            style={{ width: 20, height: 20, color: colorTextTertiary, background: 'transparent' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = token.colorFillSecondary)}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <RiMoreLine size={15} />
          </button>
        </Dropdown>
        {topic.pinned_at ? (
          <RiPushpinFill
            size={12}
            style={{ color: colorTextTertiary, flexShrink: 0 }}
            aria-label={t('harness.sidebar.topicPinned')}
          />
        ) : null}
      </div>
    )
  }

  /** Workspace row + its conversations below */
  const renderWorkspace = (ws: WorkspaceRow): React.ReactNode => {
    const expanded = expandedWorkspaceId === ws.id
    const active = activeWorkspaceId === ws.id
    // Whether any conversation under this workspace is generating (judged on the unfiltered full list, so search does not miss it):
    // if so, deleting this workspace is forbidden, otherwise generating conversations would be deleted along with it
    const hasRunningTopic = topicsOf(ws.id).some((t) => loadingTopicIds.has(t.id))
    const hovered = hoveredWorkspaceId === ws.id
    const showControls = hovered || active

    return (
      <div key={ws.id} className="mb-0.5">
        <div
          onClick={() => handleToggleWorkspace(ws.id)}
          className="flex items-center gap-2 mx-2 rounded-md cursor-pointer transition-colors"
          style={{
            padding: '0 6px',
            height: 32,
            background: expanded ? token.colorFillTertiary : 'transparent'
          }}
          onMouseEnter={(e) => {
            setHoveredWorkspaceId(ws.id)
            if (!expanded) e.currentTarget.style.background = token.colorFillQuaternary
          }}
          onMouseLeave={(e) => {
            setHoveredWorkspaceId(null)
            if (!expanded) e.currentTarget.style.background = 'transparent'
          }}
        >
          <span
            className="flex items-center justify-center shrink-0"
            style={{ width: 16, color: expanded ? colorTextSecondary : colorTextTertiary }}
          >
            {expanded ? <RiFolderOpenLine size={15} /> : <RiFolder2Line size={15} />}
          </span>
          <span
            className="flex-1 min-w-0 truncate"
            style={{ fontSize: 13, color: colorText, fontWeight: 500 }}
          >
            {ws.name}
          </span>

          {/* Shown on hover/active: rename / show in folder / delete menu + new conversation */}
          <span className="flex items-center gap-0.5 shrink-0">
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'rename',
                    label: t('common.action.rename'),
                    icon: <RiEditLine size={14} />,
                    // Same as the conversation row: menu clicks must not bubble to the workspace row's onClick (that would collapse/expand it as a side effect)
                    onClick: ({ domEvent }) => {
                      domEvent.stopPropagation()
                      openRename(ws)
                    }
                  },
                  {
                    key: 'reveal',
                    label: revealWorkspaceLabel,
                    icon: <RiFolderOpenLine size={14} />,
                    onClick: ({ domEvent }) => {
                      domEvent.stopPropagation()
                      void handleRevealWorkspace(ws)
                    }
                  },
                  {
                    key: 'delete',
                    // Forbid deleting while a conversation under this workspace is generating (to avoid deleting in-progress conversations along with it)
                    label: hasRunningTopic
                      ? t('harness.sidebar.workspaceHasRunning')
                      : t('harness.sidebar.workspaceDelete'),
                    danger: true as const,
                    disabled: hasRunningTopic,
                    icon: <RiDeleteBin6Line size={14} />,
                    onClick: ({ domEvent }) => {
                      domEvent.stopPropagation()
                      if (hasRunningTopic) return
                      handleDeleteWorkspace(ws)
                    }
                  }
                ]
              }}
              trigger={['click']}
              placement="bottomRight"
            >
              <button
                onClick={(e) => e.stopPropagation()}
                title={
                  hasRunningTopic
                    ? t('harness.sidebar.workspaceHasRunning')
                    : t('harness.sidebar.workspaceActions')
                }
                className="flex items-center justify-center rounded transition-opacity"
                style={{
                  width: 22,
                  height: 22,
                  color: colorTextSecondary,
                  background: 'transparent',
                  opacity: showControls ? 1 : 0,
                  pointerEvents: showControls ? 'auto' : 'none'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = token.colorFillSecondary)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <RiMoreLine size={15} />
              </button>
            </Dropdown>
            <button
              onClick={(e) => {
                e.stopPropagation()
                handleCreateSession(ws)
              }}
              title={t('harness.sidebar.newSession')}
              className="flex items-center justify-center rounded transition-opacity"
              style={{
                width: 22,
                height: 22,
                color: colorTextSecondary,
                background: 'transparent',
                opacity: showControls ? 1 : 0,
                pointerEvents: showControls ? 'auto' : 'none'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = token.colorFillSecondary)}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <RiAddLine size={16} />
            </button>
          </span>
        </div>

        {expanded && renderTopicList(ws.id)}
      </div>
    )
  }

  /**
   * The conversation list under an expanded workspace.
   *
   * Workspace rows and plugin rows share it (plugin conversations attach under their "plugin workspace"): loading skeleton / empty state /
   * conversation rows / scroll pagination landing all behave the same, so the two places do not diverge over time.
   *
   * The empty state, like loading, is centered in the whole column: no extra left indent, otherwise text-center only centers inside "what is left after the indent"
   * and looks shifted right overall.
   */
  /**
   * Archived row (a row in the "Archived" group at the bottom of the sidebar): title + owning workspace (small text) + … menu.
   * Opening it = read-only view (input hidden, see currentTopicArchived in useHarnessHandlers).
   * The archived list is cross-workspace, so every row carries the workspace name to tell same-named conversations apart.
   */
  const renderArchivedRow = (topic: HarnessTopicRow): React.ReactNode => {
    const selected = activeWorkspaceId === topic.workspace_id && currentTopicId === topic.id
    const workspaceName = workspaces.find((ws) => ws.id === topic.workspace_id)?.name ?? ''
    return (
      <div
        key={topic.id}
        data-archived-topic-id={topic.id}
        onClick={() => void handleOpenTopic(topic.workspace_id, topic)}
        className="group flex items-center gap-2 mx-1 my-0.5 rounded-md cursor-pointer transition-colors"
        style={{
          paddingLeft: 6,
          paddingRight: 6,
          height: 30,
          color: selected ? colorText : colorTextSecondary,
          background: selected ? token.colorFill : 'transparent'
        }}
        onMouseEnter={(e) => {
          if (!selected) e.currentTarget.style.background = token.colorFillQuaternary
        }}
        onMouseLeave={(e) => {
          if (!selected) e.currentTarget.style.background = 'transparent'
        }}
      >
        <RiArchiveLine size={13} style={{ color: colorTextTertiary, flexShrink: 0 }} />
        <span className="flex-1 min-w-0 truncate" style={{ fontSize: 13 }}>
          {topic.title}
        </span>
        {workspaceName ? (
          <span
            className="shrink-0 truncate group-hover:hidden"
            style={{ maxWidth: 92, fontSize: 11, color: colorTextTertiary }}
          >
            {workspaceName}
          </span>
        ) : null}
        <Dropdown
          menu={{ items: topicMenuItems(topic.workspace_id, topic, false) }}
          trigger={['click']}
          placement="bottomRight"
        >
          <button
            onClick={(e) => e.stopPropagation()}
            title={t('harness.sidebar.topicActions')}
            className="hidden group-hover:flex items-center justify-center shrink-0 rounded"
            style={{ width: 20, height: 20, color: colorTextTertiary, background: 'transparent' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = token.colorFillSecondary)}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <RiMoreLine size={15} />
          </button>
        </Dropdown>
      </div>
    )
  }

  const renderTopicList = (workspaceId: number): React.ReactNode => {
    const list = visibleTopicsOf(workspaceId)
    // Only "this workspace's conversations have never loaded" counts as loading: when the cache already has content, render seamlessly.
    // Workspaces whose fetch failed no longer count as loading (otherwise the row would sit on the skeleton forever, see topicFetchFailedRef)
    const loading =
      !hasTopicsLoaded(workspaceId) &&
      !topicFetchFailedRef.current.has(workspaceId) &&
      (workspaceId === activeWorkspaceId || workspaceTopicsLoading[workspaceId] === true)
    return (
      <div className="pb-1">
        {loading && list.length === 0 ? (
          <div className="py-1">
            <SkeletonListRows rows={5} variant="stacked" />
          </div>
        ) : list.length === 0 ? (
          <p className="text-center py-3" style={{ fontSize: 12, color: colorTextTertiary }}>
            {query ? t('harness.sidebar.noMatchTopic') : t('harness.sidebar.emptyTopics')}
          </p>
        ) : (
          <>
            {list.map((topic) => renderTopicRow(workspaceId, topic))}
            {/* Show the bottom spinner only for the current workspace's scroll pagination; full-list refresh (workspace switch) does not show it to avoid flicker */}
            {workspaceId === activeWorkspaceId &&
              isLoadingMoreTopics &&
              !isRefreshingTopics &&
              hasMoreTopics && (
                /* Scroll pagination lands where "more topics grow below", so lay out two rows of topic skeletons instead of a centered spinner */
                <div className="py-1">
                  <SkeletonListRows rows={2} variant="stacked" />
                </div>
              )}
          </>
        )}
      </div>
    )
  }

  /* ── Switching modes = also switching to that mode's "current content" ───────────────────────────
   * User wording 2026-09-28: "when switching to work mode or plugin mode, default to the content of the currently selected item in that mode":
   * whichever kind of content the panel is viewing, the main area shows the currently selected item of that kind —
   * otherwise you get the conflicting state "sidebar lists workspaces while the main area still sits on a plugin conversation".
   */

  /** Whether the current content is on the plugin side (the active workspace is a plugin workspace) — each enter* uses it to decide whether to act */
  const inPluginContent = activeWorkspaceId != null && pluginWorkspaceIds.has(activeWorkspaceId)
  /** Whether the current content is on the "chat" side (the active workspace is a chat workspace) */
  const inChatContent = activeWorkspaceId != null && chatWorkspaceIds.has(activeWorkspaceId)
  /** The current content belongs to the "work" side (the user's own workspace) */
  const inWorkContent = activeWorkspaceId != null && !inPluginContent && !inChatContent

  // Remember the last user workspace visited in work mode (switching back to work mode prefers it rather than always the first one)
  useEffect(() => {
    if (activeWorkspaceId != null && !isNonUserWorkspace(activeWorkspaceId)) {
      lastWorkWorkspaceIdRef.current = activeWorkspaceId
    }
  }, [activeWorkspaceId, isNonUserWorkspace])

  // Remember each mode's current content (switch back on mode switch + restore on next launch)
  // The topic may have just been sent from a "blank conversation", when currentTopicId gets its first value; record it here too.
  // **Record only when the topic list already belongs to the active workspace** (topicsWorkspaceId === activeWorkspaceId):
  // when selecting a conversation across workspaces, topics still belongs to the old workspace, and recording then would attach the topic to the wrong workspace.
  useEffect(() => {
    if (currentTopicId == null || topicsWorkspaceId == null) return
    if (topicsWorkspaceId !== activeWorkspaceId) return
    // Never remember an already-deleted topic (see deletedTopicIdsRef: the effect may run late once when deleting a conversation)
    if (deletedTopicIdsRef.current.has(currentTopicId)) return
    const pluginId =
      pluginWorkspaces.find((item) => item.workspaceId === topicsWorkspaceId)?.draftId ?? null
    if (pluginId) {
      if (pluginContentRef.current?.topicId !== currentTopicId) {
        rememberPlugin({
          pluginId,
          workspaceId: topicsWorkspaceId,
          topicId: currentTopicId
        })
      }
    } else if (chatWorkspaceIds.has(topicsWorkspaceId)) {
      if (chatContentRef.current?.topicId !== currentTopicId) {
        rememberChat({ workspaceId: topicsWorkspaceId, topicId: currentTopicId })
      }
    } else if (workContentRef.current?.topicId !== currentTopicId) {
      rememberWork({ workspaceId: topicsWorkspaceId, topicId: currentTopicId })
    }
  }, [
    currentTopicId,
    topicsWorkspaceId,
    activeWorkspaceId,
    pluginWorkspaces,
    chatWorkspaceIds,
    rememberPlugin,
    rememberChat,
    rememberWork
  ])

  /** Persist the mode too: next launch returns to the same side (content is restored along with it, see restoreLastContent) */
  useEffect(() => {
    persistSelection({ activeMode: mode })
  }, [mode, persistSelection])

  /** Re-read a topic row by id (the id is stored; the title may have changed, so do not render an old snapshot) */
  const fetchTopicRow = useCallback(async (topicId: number): Promise<HarnessTopicRow | null> => {
    try {
      const rows = await harnessApi.harness.getTopicById(topicId)
      return rows[0] ?? null
    } catch {
      return null
    }
  }, [])

  /* ── Conversation search (title + body mixed) ────────────────────────────────────────── */

  /** Which workspace to search: chat mode uses its own root workspace, work mode uses the currently selected workspace */
  const searchWorkspaceId =
    mode === 'chat' ? (chatWorkspaces.rootWorkspaceId ?? null) : topicsWorkspaceId
  const searchNeedle = searchQuery.trim()
  /** Only inputs of >= 2 characters query the main process; 1 character keeps the original local title filter (does not bother the backend) */
  const serverSearchActive = searchMode && mode !== 'plugin' && searchNeedle.length >= 2

  useEffect(() => {
    if (!serverSearchActive) {
      setSearchResults(null)
      setSearchFailed(false)
      setSearchLoading(false)
      return
    }
    let cancelled = false
    setSearchLoading(true)
    setSearchFailed(false)
    // Debounce: consecutive input only queries the last one (body LIKE queries are much heavier than title filtering)
    const timer = window.setTimeout(() => {
      void harnessApi.harness
        .searchWorkspace({
          query: searchNeedle,
          workspaceId: searchWorkspaceId ?? undefined,
          limit: 12
        })
        .then((result) => {
          if (!cancelled) setSearchResults(result)
        })
        .catch(() => {
          if (!cancelled) {
            setSearchResults(null)
            setSearchFailed(true)
          }
        })
        .finally(() => {
          if (!cancelled) setSearchLoading(false)
        })
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [serverSearchActive, searchNeedle, searchWorkspaceId])

  /** Collapse search mode (clicking a result / clicking close both come here, so the next open does not carry a stale query) */
  const resetSearch = useCallback((): void => {
    setSearchMode(false)
    setSearchQuery('')
    setSearchResults(null)
    setSearchFailed(false)
    onSetPendingJumpDialogue?.(null)
  }, [onSetPendingJumpDialogue])

  /**
   * Open a search result: a title hit only switches the conversation; a body hit additionally hands the dialogueId to the message area for locating.
   * Workspace switching / chat mode activation / routing back to the chat page all reuse `handleOpenTopic`.
   */
  const openSearchResult = useCallback(
    async (topicId: number, dialogueId?: number): Promise<void> => {
      const topic = await fetchTopicRow(topicId)
      if (!topic) {
        viewMessage('harness-search-open', 'error', t('harness.sidebar.searchOpenFailed'), 3)
        return
      }
      // The workspace follows the search scope; in edge cases (the chat root workspace is not ready yet) fall back to the topic row's own workspace
      const workspaceId = searchWorkspaceId ?? activeWorkspaceId ?? topic.workspace_id
      resetSearch()
      if (dialogueId != null) onSetPendingJumpDialogue?.(dialogueId)
      await handleOpenTopic(workspaceId, topic, dialogueId)
    },
    [
      activeWorkspaceId,
      fetchTopicRow,
      handleOpenTopic,
      onSetPendingJumpDialogue,
      resetSearch,
      searchWorkspaceId,
      t,
      viewMessage
    ]
  )

  /** Highlight the keyword inside a hit snippet (the backend provides plain-text snippets) */
  const renderSearchSnippet = (snippet: string, needle: string): React.ReactNode => {
    const lower = snippet.toLowerCase()
    const at = lower.indexOf(needle.toLowerCase())
    if (at < 0) return snippet
    const markStyle: React.CSSProperties = {
      background: token.colorPrimaryBg,
      color: colorText,
      borderRadius: 3,
      padding: '0 1px'
    }
    return (
      <>
        {snippet.slice(0, at)}
        <mark style={markStyle}>{snippet.slice(at, at + needle.length)}</mark>
        {snippet.slice(at + needle.length)}
      </>
    )
  }

  /**
   * Search-mode result panel: two groups, conversation-title hits + message-body hits.
   * Click targets that open and locate carry `data-search-*` hooks for E2E harness assertions.
   */
  const renderSearchResults = (): React.ReactNode => {
    if (searchLoading) return <SkeletonListRows rows={4} />
    if (searchFailed) {
      return (
        <p className="text-xs text-center py-8 px-3" style={{ color: colorTextTertiary }}>
          {t('harness.sidebar.searchFailed')}
        </p>
      )
    }
    if (
      !searchResults ||
      (searchResults.topics.length === 0 && searchResults.hits.length === 0)
    ) {
      return (
        <p className="text-xs text-center py-8 px-3" style={{ color: colorTextTertiary }}>
          {t('harness.sidebar.noMatchResult')}
        </p>
      )
    }
    const needle = searchResults.query
    const hoverHandlers = {
      onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) =>
        (e.currentTarget.style.background = token.colorFillQuaternary),
      onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) =>
        (e.currentTarget.style.background = 'transparent')
    }
    const sectionTitle = (text: string): React.ReactNode => (
      <div
        className="px-4 pt-2 pb-1"
        style={{ fontSize: 11, lineHeight: '16px', color: colorTextTertiary }}
      >
        {text}
      </div>
    )
    return (
      <div className="pb-1" data-harness-search-results="1">
        {searchResults.topics.length > 0 && (
          <div>
            {sectionTitle(t('harness.sidebar.searchScopeTopics'))}
            {searchResults.topics.map((item) => (
              <div
                key={`search-topic-${item.id}`}
                data-search-topic-id={item.id}
                className="mx-2 my-0.5 rounded-md cursor-pointer"
                style={{ padding: '6px 8px' }}
                {...hoverHandlers}
                onClick={() => void openSearchResult(item.id)}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="flex-1 min-w-0 truncate"
                    style={{ fontSize: 13, color: colorText }}
                  >
                    {item.title}
                  </span>
                  <span className="shrink-0" style={{ fontSize: 11, color: colorTextTertiary }}>
                    {formatRelativeTime(t, item.updatedAt)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
        {searchResults.hits.length > 0 && (
          <div>
            {sectionTitle(t('harness.sidebar.searchScopeMessages'))}
            {searchResults.hits.map((hit) => (
              <div
                key={`search-hit-${hit.dialogueId}`}
                data-search-dialogue-id={hit.dialogueId}
                data-search-hit-topic-id={hit.topicId}
                className="mx-2 my-0.5 rounded-md cursor-pointer"
                style={{ padding: '6px 8px' }}
                {...hoverHandlers}
                onClick={() => void openSearchResult(hit.topicId, hit.dialogueId)}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="flex-1 min-w-0 truncate"
                    style={{ fontSize: 12, color: colorTextSecondary }}
                  >
                    {hit.topicTitle || t('harness.sidebar.searchUntitledTopic')}
                  </span>
                  <span className="shrink-0" style={{ fontSize: 11, color: colorTextTertiary }}>
                    {formatRelativeTime(t, hit.createdAt)}
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 2,
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: colorTextSecondary,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    wordBreak: 'break-word'
                  }}
                >
                  {renderSearchSnippet(hit.snippet, needle)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  /**
   * Handoff event after the plugin center's "edit in conversation" (`lattice.openSource`) succeeds.
   *
   * The main process has already created/reused the plugin workspace, opened a plugin conversation, and written `activeMode:'plugin'` +
   * `pluginContent` into settings — but it only broadcasts `harness:workshop-changed`, so the sidebar would not remount
   * for it and would not re-read settings. Therefore the renderer dispatches this event after openSource succeeds,
   * and the sidebar switches **directly** by pluginId + topicId (same chain as clicking a conversation in a plugin row:
   * ensureWorkspace -> write active workspace -> workspace-changed -> select topic).
   */
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<{ pluginId?: string; topicId?: number }>).detail
      if (!detail?.pluginId) return
      const pluginId = detail.pluginId
      // Plugin center -> "edit in conversation": this is a user action, so the main content area must follow to the chat page
      // (navigate is left to handlePluginSession to switch after content is in place; switching first would flash the previous conversation)
      setMode('plugin')
      void (async () => {
        const topic = detail.topicId != null ? await fetchTopicRow(detail.topicId) : undefined
        await handlePluginSession(
          { id: pluginId },
          { topic: topic ?? undefined, focus: true, navigate: true }
        )
      })()
    }
    window.addEventListener('lattice-open-source', handler)
    return () => window.removeEventListener('lattice-open-source', handler)
  }, [fetchTopicRow, handlePluginSession])

  /** Switch to the "work" side's content: the last work conversation; otherwise fall back to a user workspace's blank conversation */
  const enterWorkModeContent = useCallback(async (): Promise<void> => {
    if (inWorkContent) return
    // Fetch a fresh workspace list (the local one may have just been refreshed): mode switching uses it to find "the last user workspace"
    const { list } = await loadWorkspaces()
    const userList = list.filter((ws) => !isNonUserWorkspace(ws.id))
    const remembered = workContentRef.current
    if (remembered?.topicId != null) {
      const ws = userList.find((w) => w.id === remembered.workspaceId)
      const topic = ws ? await fetchTopicRow(remembered.topicId) : null
      if (ws && topic) {
        if (activeWorkspaceId !== ws.id) await switchWorkspace(ws)
        setExpandedWorkspaceId(ws.id)
        await onSelectTopic(topic)
        return
      }
      // The conversation was already deleted: fall back to "this workspace's blank conversation"
      rememberWork({ workspaceId: remembered.workspaceId, topicId: null })
    }
    const target =
      userList.find((w) => w.id === lastWorkWorkspaceIdRef.current) ?? userList[0] ?? null
    if (!target) {
      // There is no user workspace at all (only plugin / chat workspaces): return to the "no workspace configured" blank state
      try {
        await window.api.systemSettings.update({
          harness: {
            workspacePath: '',
            activeWorkspaceId: undefined
          } as Parameters<typeof window.api.systemSettings.update>[0]['harness']
        })
      } catch (err) {
        console.error('Failed to clear active workspace:', err)
      }
      setActiveWorkspaceId(null)
      setExpandedWorkspaceId(null)
      window.dispatchEvent(new CustomEvent('workspace-changed', { detail: {} }))
      onNewHarness()
      return
    }
    if (activeWorkspaceId !== target.id) await switchWorkspace(target)
    setExpandedWorkspaceId(target.id)
    onNewHarness()
  }, [
    inWorkContent,
    activeWorkspaceId,
    isNonUserWorkspace,
    loadWorkspaces,
    fetchTopicRow,
    switchWorkspace,
    onSelectTopic,
    onNewHarness,
    rememberWork
  ])

  /**
   * Switch to the "plugin" side's content: the last plugin conversation; if this plugin has had no conversation yet, use the "+" path
   * (fetch the plugin workspace + blank conversation + memory scope) — that is the default selection in plugin mode.
   *
   * Deliberately **relies only on the remembered record** (plugin id + topic id) and does not consult the cached draft/workspace lists:
   * those caches may have just been refreshed (the workspace row was just created, drafts are reloading), and using them as a gate would make "switching back"
   * occasionally degrade into a blank conversation. The workspace is fetched by plugin id from the main process (`ensureWorkspace` in
   * `handlePluginSession`), the topic is read fresh by id — the main process is the source of truth, so switching back reliably hits the same conversation.
   */
  const enterPluginModeContent = useCallback(async (): Promise<void> => {
    if (inPluginContent) return
    const remembered = pluginContentRef.current
    /**
     * The remembered plugin is no longer in the draft list (sources deleted/moved, possibly not via this app):
     * clear this memory first, then fall back to the first available plugin. Otherwise `ensureWorkspace` runs against a non-existent plugin directory
     * and every switch to plugin mode pops "source directory does not exist".
     */
    if (remembered && !drafts.some((draft) => draft.id === remembered.pluginId)) {
      rememberPlugin(null)
    }
    const validRemembered = drafts.some((draft) => draft.id === remembered?.pluginId)
      ? remembered
      : null
    if (validRemembered) {
      const topic =
        validRemembered.topicId != null ? await fetchTopicRow(validRemembered.topicId) : undefined
      if (topic || validRemembered.topicId == null) {
        await handlePluginSession(
          { id: validRemembered.pluginId },
          { focus: false, topic: topic ?? undefined }
        )
        return
      }
      // That conversation was already deleted: fall back to "this plugin's blank conversation"
      rememberPlugin(null)
    }
    const fallback = visibleDrafts[0] ?? drafts[0] ?? null
    if (!fallback) return
    await handlePluginSession(fallback, { focus: false })
  }, [inPluginContent, drafts, visibleDrafts, fetchTopicRow, handlePluginSession, rememberPlugin])

  /**
   * Switch to the "chat" side's content: the last conversation; if none was remembered (or it was deleted), open a clean blank conversation
   * — that is this mode's default landing spot.
   *
   * Same criterion as the plugin side: **trust only the remembered record** (topic id), read the topic fresh by id;
   * the directory is computed fresh by the main process from the topic id (`activateChatTopic`), not from the cached workspace list
   * (which may have just been refreshed; using it as a gate would make "switching back" occasionally degrade into a blank conversation).
   */
  const enterChatModeContent = useCallback(async (): Promise<void> => {
    const remembered = chatContentRef.current
    if (remembered?.topicId != null) {
      const topic = await fetchTopicRow(remembered.topicId)
      if (topic) {
        await handleChatSession({ topic, focus: false })
        return
      }
      // That conversation was already deleted: fall the remembered content back to "blank conversation" rather than null — null would be treated by startup restore as
      // the old config's `'chat'` (= work), landing on the wrong side on next launch (see the history normalization in restoreLastContent)
      rememberChat({ workspaceId: remembered.workspaceId, topicId: null })
    }
    // Already on the chat side and viewing a conversation: do nothing (do not reopen, do not steal the caret)
    if (inChatContent && currentTopicId != null) return
    // All other cases take "this mode's default landing spot": blank conversation + active directory = chat root directory.
    // Even when already on the chat side this must run — the last stop may have been a deleted conversation subdirectory, with the active path still pointing at it,
    // and only this path resets it (otherwise the model's file tools operate on a non-existent directory).
    await handleChatSession({ focus: false })
  }, [inChatContent, currentTopicId, fetchTopicRow, handleChatSession, rememberChat])

  /** Mode switch: switching the mode = switching the content to that side too (user wording 2026-09-28) */
  const switchMode = useCallback(
    (next: SidebarMode): void => {
      if (next === mode) return
      setMode(next)
      if (next === 'plugin') void enterPluginModeContent()
      else if (next === 'chat') void enterChatModeContent()
      else void enterWorkModeContent()
    },
    [mode, enterWorkModeContent, enterPluginModeContent, enterChatModeContent]
  )

  /* ── Startup restore: which side was last active and which conversation each side selected ─────────────────────────
   * User wording 2026-09-28: "remember work mode and plugin mode, the selected conversation, so it can be remembered next time":
   * on launch read back activeMode + workContent / chatContent / pluginContent, and re-select that side's conversation
   * (main area, sidebar selection, memory scope and file explorer root all follow it).
   *
   * Three rules:
   * - **Restore only after all lists are read**: while the workspace list / drafts + plugin workspaces + chat workspaces are not ready,
   *   "is this row still there" misjudges as "deleted" and downgrades the remembered content to a blank conversation;
   * - **Run only once** (hydratedRef), and **do not write settings before it finishes** (the guard in persistSelection):
   *   at mount the initial mode is "work", and persisting before restore would clobber the remembered "plugin";
   * - **Fall back to the default landing spot on a miss**, with no error and no hint: the conversation/workspace/plugin having been deleted is normal,
   *   just fall back to that side's blank conversation (work / chat) or the first plugin (plugin).
   */
  const restoreLastContent = useCallback(async (): Promise<void> => {
    let saved: HarnessSettings | undefined
    try {
      saved = (await window.api.systemSettings.getAll()).harness
    } catch (err) {
      console.error('Failed to read the remembered sidebar selection:', err)
      return
    }
    /**
     * Normalizing the mode on disk.
     *
     * `'chat'` was the name of the "work" position **before** "chat" mode existed (historical value); now it means chat mode
     * — old configs must be read as `'work'`, otherwise the first launch after upgrade lands in "chat" for no reason.
     * "Chat" mode writes to the same keys, but it also records chatContent: that record existing
     * means this `'chat'` is the new semantics (old configs cannot have chatContent).
     */
    const remembered = saved?.activeMode
    const savedMode: SidebarMode =
      remembered === 'plugin'
        ? 'plugin'
        : remembered === 'chat'
          ? saved?.chatContent != null
            ? 'chat'
            : 'work'
          : 'work'
    const work = saved?.workContent ?? null
    const chat = saved?.chatContent ?? null
    const plugin = saved?.pluginContent ?? null
    // Put memory back into memory state first: subsequent mode switches also return to it (the mode-switch path trusts only these refs)
    workContentRef.current = work
    chatContentRef.current = chat
    pluginContentRef.current = plugin
    lastWorkWorkspaceIdRef.current = work?.workspaceId ?? null
    setMode(savedMode)
    // Persist the mode itself once: if the app stays on "work" and never switches, the effect following mode below never runs
    // and activeMode would be missing on disk (next launch still defaults to work, but the persisted state should be complete)
    persistSelection({ activeMode: savedMode })

    if (savedMode === 'plugin') {
      const draft = plugin ? drafts.find((item) => item.id === plugin.pluginId) : null
      if (plugin && draft) {
        const topic = plugin.topicId != null ? await fetchTopicRow(plugin.topicId) : null
        await handlePluginSession(draft, { topic: topic ?? undefined, focus: false })
        return
      }
      // No remembered plugin content (or that plugin was deleted): use the default landing spot of "switch to plugin mode"
      await enterPluginModeContent()
      return
    }

    if (savedMode === 'chat') {
      const topic = chat?.topicId != null ? await fetchTopicRow(chat.topicId) : undefined
      if (topic) {
        await handleChatSession({ topic, focus: false })
        return
      }
      // No remembered chat content (or that conversation was deleted): use the default landing spot of "switch to chat mode"
      await enterChatModeContent()
      return
    }

    const ws = work ? workspaces.find((item) => item.id === work.workspaceId) : null
    if (work && ws) {
      if (activeWorkspaceId !== ws.id) await switchWorkspace(ws)
      setExpandedWorkspaceId(ws.id)
      const topic = work.topicId != null ? await fetchTopicRow(work.topicId) : null
      if (topic) {
        await onSelectTopic(topic)
        return
      }
      // The remembered conversation was already deleted: stay on this workspace's blank conversation
      rememberWork({ workspaceId: ws.id, topicId: null })
      onNewHarness()
      return
    }
    // Work side has no memory / that workspace was deleted: if the current content is on a plugin / chat workspace, switch back via the mode-switch path first
    if (inPluginContent || inChatContent) await enterWorkModeContent()
    else onNewHarness()
  }, [
    drafts,
    workspaces,
    activeWorkspaceId,
    inPluginContent,
    inChatContent,
    fetchTopicRow,
    switchWorkspace,
    onSelectTopic,
    onNewHarness,
    handlePluginSession,
    handleChatSession,
    enterPluginModeContent,
    enterChatModeContent,
    enterWorkModeContent,
    rememberWork,
    persistSelection
  ])

  useEffect(() => {
    if (hydratedRef.current || !workspacesLoaded || !draftsLoaded || !chatWorkspacesLoaded) return
    hydratedRef.current = true
    void restoreLastContent()
  }, [workspacesLoaded, draftsLoaded, chatWorkspacesLoaded, restoreLastContent])

  return (
    <div
      /* Stable hook: this panel has no class name (its width is an inline style, user-resizable),
         and the test harness (test/probe-plugin-workshop-live.mjs) locates the sidebar by it */
      data-harness-sidebar="1"
      className="flex flex-col overflow-hidden h-full"
      style={{
        background: colorBgContainer,
        borderRadius: borderRadiusLG
      }}
    >
      {/* Header: mode switch (chat / work / plugin) + right action capsule (search / new) */}
      <div
        data-harness-sidebar-header="1"
        className="flex items-center"
        style={{ minHeight: 40, padding: '0 12px', gap: 4 }}
      >
        {searchMode ? (
          <div className="flex items-center gap-1 flex-1">
            <Input
              ref={searchInputRef}
              size="small"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                mode === 'plugin'
                  ? t('harness.sidebar.searchDraftPlaceholder')
                  : mode === 'chat'
                    ? t('harness.sidebar.searchTopicPlaceholder')
                    : t('harness.sidebar.searchPlaceholder')
              }
              allowClear
              variant="borderless"
              prefix={<RiSearchLine size={14} style={{ color: colorTextTertiary }} />}
              style={{ flex: 1, background: 'transparent', padding: '0 3px' }}
            />
            {iconBtn(
              t('harness.sidebar.exitSearch'),
              () => {
                setSearchMode(false)
                setSearchQuery('')
              },
              <RiCloseLine size={16} />
            )}
          </div>
        ) : (
          <>
            {/*
              Mode switch: this panel holds three sets of content — "chat" is **a flat conversation list** (that mode has no workspace
              concept and is placed first: user wording 2026-09-29 "chat mode should come first"),
              "work" is workspaces -> conversations, "plugin" is plugin drafts.
              Capsule style + one thumb (transform transition) instead of several buttons changing background color:
              the thumb slides on switch, and its position itself says "which position is active now".
            */}
            <SidebarModeSwitch
              mode={mode}
              onChange={switchMode}
              track={shellMode ? '#2a2a2d' : colorFillAlter}
              thumb={shellMode ? '#ededf0' : token.colorBgElevated}
              active={shellMode ? '#1a1a1c' : colorText}
              inactive={shellMode ? '#8b8b92' : colorTextTertiary}
              hairline={shellMode ? '#3a3a40' : token.colorBorderSecondary}
              t={t}
            />
            <span className="flex-1" />
            {/*
              Right-side actions: search + new, grouped into one 24px-high capsule — same height, same radius and
              same background as the three-position switch on the left, echoing at both ends of the top row; a 1px vertical divider separates "find" from "create".
              "Assistant settings" is not placed here: its entry is the gear in the user area at the bottom left and the "App" menu.
            */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                height: 24,
                padding: 2,
                gap: 1,
                borderRadius: 7,
                background: headerTrack,
                flexShrink: 0
              }}
            >
              {iconBtn(
                t('harness.sidebar.searchTooltip'),
                () => setSearchMode(true),
                <RiSearchLine size={14} />,
                true
              )}
              <span
                aria-hidden
                style={{
                  width: 1,
                  height: 12,
                  margin: '0 1px',
                  background: headerHairline,
                  flexShrink: 0
                }}
              />
              {mode === 'plugin'
                ? /* New plugin: when no storage path is configured, show the folder picker first, then the "New draft" dialog (the dialog has no path picker) */
                  iconBtn(
                    t('harness.sidebar.newDraft'),
                    () => void handleNewDraft(),
                    <RiFoldersLine size={14} />,
                    true
                  )
                : mode === 'chat'
                  ? /* Chat mode: new conversation (this mode has no workspace, so there is no "new workspace" action) */
                    iconBtn(
                      t('harness.sidebar.newSession'),
                      () => {
                        // Once the blank conversation is ready, handleChatSession brings the route back to the chat page
                        void handleChatSession({ navigate: true })
                      },
                      <RiAddLine size={14} />,
                      true
                    )
                  : /* Work mode: new workspace */
                    iconBtn(
                      t('harness.sidebar.newWorkspace'),
                      handleBrowseFolder,
                      <RiFoldersLine size={14} />,
                      true
                    )}
            </div>
          </>
        )}
      </div>

      {/* Workspace -> conversation tree / chat mode's flat conversation list / plugin draft list */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto py-1 history-scrollbar"
        onScroll={handleScroll}
      >
        {serverSearchActive ? (
          renderSearchResults()
        ) : mode === 'plugin' ? (
          draftsLoading && drafts.length === 0 ? (
            <SkeletonListRows rows={3} />
          ) : visibleDrafts.length === 0 ? (
            query ? (
              <p className="text-xs text-center py-8 px-3" style={{ color: colorTextTertiary }}>
                {t('harness.sidebar.noMatchResult')}
              </p>
            ) : pluginsPath ? (
              <p className="text-xs text-center py-8 px-3" style={{ color: colorTextTertiary }}>
                {t('harness.sidebar.noDraft')}
              </p>
            ) : (
              /*
               * No plugin storage path configured yet: the gray empty state keeps the same look as "no workspace configured",
               * but below it **explicitly offers a "Choose plugin storage path" button** (user wording 2026-11-21:
               * the empty state must allow choosing a path directly; previously it could only be guessed from the top-right +). The original behavior of the top-right + stays:
               * when no path is set it still shows the folder picker first, then the new-draft dialog.
               */
              <div className="flex flex-col items-center gap-2.5 px-3 py-8">
                <p className="text-xs text-center" style={{ color: colorTextTertiary }}>
                  {t('harness.sidebar.needPluginsPath')}
                </p>
                <button
                  type="button"
                  onClick={() => void pickPluginsRoot()}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md transition-colors"
                  style={{ color: token.colorPrimary, background: colorFillAlter }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = token.colorPrimaryBg
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = colorFillAlter
                  }}
                >
                  <RiFolderOpenLine size={13} />
                  {t('harness.sidebar.pickPluginsPath')}
                </button>
              </div>
            )
          ) : (
            visibleDrafts.map((draft) => renderDraft(draft))
          )
        ) : mode === 'chat' ? (
          /* Chat mode: **no workspace layer**, just one conversation list (its empty state looks the same as the conversation list under a workspace) */
          !chatTopicsLoaded && chatWorkspaceTopics.length === 0 ? (
            <div className="py-1">
              <SkeletonListRows rows={5} variant="stacked" />
            </div>
          ) : chatVisibleTopics.length === 0 ? (
            <p className="text-xs text-center py-8" style={{ color: colorTextTertiary }}>
              {query ? t('harness.sidebar.noMatchTopic') : t('harness.sidebar.emptyTopics')}
            </p>
          ) : (
            <div className="pb-1">
              {/* The root workspace row is **created on demand** (first entry into this mode does it); without it there is nothing to click.
                  Archived conversations are not here: they are collected in the "Archived" group at the bottom of the sidebar */}
              {chatWorkspaces.rootWorkspaceId != null &&
                chatVisibleTopics
                  .filter((topic) => !topic.archived_at)
                  .map((topic) => renderTopicRow(chatWorkspaces.rootWorkspaceId as number, topic))}
              {chatTopicsHasMore && chatTopicsLoading && (
                <div className="py-1">
                  <SkeletonListRows rows={2} variant="stacked" />
                </div>
              )}
            </div>
          )
        ) : visibleWorkspaces.length === 0 ? (
          <p className="text-xs text-center py-8" style={{ color: colorTextTertiary }}>
            {query ? t('harness.sidebar.noMatchResult') : t('harness.sidebar.noWorkspace')}
          </p>
        ) : (
          visibleWorkspaces.map((ws) => renderWorkspace(ws))
        )}
      </div>

      {/*
        "Archived": conversations archived from **all workspaces** are collected here (user 2026-11-25 "all archived conversations,
        above memory"), right above "memory", collapsed by default. Opening one is a read-only view — the input box is hidden and
        sending is rejected (see currentTopicArchived in useHarnessHandlers).
      */}
      <div
        data-harness-archived-block="1"
        className="border-t flex-shrink-0"
        style={{ borderColor: colorFillAlter }}
      >
        <button
          onClick={() => {
            const next = !archivedOpen
            setArchivedOpen(next)
            if (next) void loadArchivedTopics()
          }}
          aria-expanded={archivedOpen}
          className="flex items-center justify-between w-full px-4 py-2 text-left transition-colors"
          style={{ color: colorTextSecondary }}
          onMouseEnter={(e) => (e.currentTarget.style.background = colorFillAlter)}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <RiArchiveLine size={16} />
            {t('harness.sidebar.topicArchivedTitle')}
            {archivedTopics.length > 0 && (
              <span style={{ fontSize: 12, color: colorTextTertiary }}>
                {archivedTopics.length}
              </span>
            )}
          </span>
          <span className="flex items-center gap-2">
            {archivedOpen ? <RiArrowDownSLine size={16} /> : <RiArrowRightSLine size={16} />}
          </span>
        </button>
        {archivedOpen && (
          <div className="overflow-y-auto history-scrollbar px-2 pb-2" style={{ maxHeight: 260 }}>
            {archivedLoading && archivedTopics.length === 0 ? (
              <div className="px-1 py-2">
                <SkeletonTextLines lines={3} />
              </div>
            ) : archivedTopics.length === 0 ? (
              <p className="text-xs text-center py-3" style={{ color: colorTextTertiary }}>
                {t('harness.sidebar.topicArchivedEmpty')}
              </p>
            ) : (
              archivedTopics.map((topic) => renderArchivedRow(topic))
            )}
          </div>
        )}
      </div>

      {/*
        Mnemon memory overview: persistent in both modes (user wording 2026-09-28 "the plugin's memory is not, like the memory inside
        work, shown in the sidebar") — it shows the **current conversation's** memory set; a plugin conversation shows that plugin's own
        (`<memoryPath>/plugin-<id>/`). The title says only "Memory", with no scope name appended (same-day "the (Memory · personal ledger)
        content is not needed").
      */}
      <div
        data-harness-memory-block="1"
        className="border-t flex-shrink-0"
        style={{ borderColor: colorFillAlter }}
      >
        <button
          onClick={handleToggleMemory}
          className="flex items-center justify-between w-full px-4 py-2 text-left transition-colors"
          style={{ color: colorTextSecondary }}
          onMouseEnter={(e) => (e.currentTarget.style.background = colorFillAlter)}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <RiBrain4Line size={16} />
            {t('harness.sidebar.memory')}
          </span>
          <span className="flex items-center gap-2">
            {memoryExpanded ? <RiArrowDownSLine size={16} /> : <RiArrowRightSLine size={16} />}
          </span>
        </button>

        {memoryExpanded && (
          <div className="overflow-y-auto history-scrollbar px-3 pb-3" style={{ maxHeight: 300 }}>
            {memoryLoading ? (
              <div className="px-1 py-2">
                <SkeletonTextLines lines={5} />
              </div>
            ) : !memorySnap?.configured ? (
              <div className="pt-2">
                <p className="text-xs text-center py-3" style={{ color: colorTextTertiary }}>
                  {t('harness.sidebar.memoryNotConfigured')}
                </p>
                <button
                  onClick={handleOpenMemoryPage}
                  className="flex items-center justify-center gap-1 w-full py-2 rounded text-xs transition-colors"
                  style={{ color: '#1677ff', background: colorFillAlter }}
                >
                  <RiSettings4Line size={13} />
                  {t('harness.sidebar.memoryGoSettings')}
                </button>
              </div>
            ) : (
              <div className="pt-1">
                {/* User profile (USER) — counts only, content not displayed */}
                {memorySnap.runtime && userEntries.length > 0 && (
                  <div className="mb-2">
                    <div
                      className="flex items-center justify-between gap-1.5 mb-1.5 text-xs font-medium"
                      style={{ color: colorTextSecondary }}
                    >
                      <span className="flex items-center gap-1.5">
                        <span
                          className="rounded-sm"
                          style={{ width: 3, height: 12, background: '#1677ff' }}
                        />
                        {t('harness.sidebar.memoryUserProfile')}
                      </span>
                      <span style={{ color: colorTextTertiary, fontWeight: 400 }}>
                        {t('harness.sidebar.memoryCount', { count: userEntries.length })}
                      </span>
                    </div>
                  </div>
                )}

                {/* Project memory (MEMORY) — counts only, content not displayed */}
                {memorySnap.runtime && memoryEntries.length > 0 && (
                  <div className="mb-2">
                    <div
                      className="flex items-center justify-between gap-1.5 mb-1.5 text-xs font-medium"
                      style={{ color: colorTextSecondary }}
                    >
                      <span className="flex items-center gap-1.5">
                        <span
                          className="rounded-sm"
                          style={{ width: 3, height: 12, background: '#52c41a' }}
                        />
                        {t('harness.sidebar.memoryProject')}
                      </span>
                      <span style={{ color: colorTextTertiary, fontWeight: 400 }}>
                        {t('harness.sidebar.memoryCount', { count: memoryEntries.length })}
                      </span>
                    </div>
                  </div>
                )}

                {!memorySnap.runtime ||
                  (memorySnap.runtime.entries.length === 0 && (
                    <p className="text-xs text-center py-3" style={{ color: colorTextTertiary }}>
                      {t('harness.sidebar.memoryEmpty')}
                    </p>
                  ))}

                {/* Stats row (wraps, no squeezing) */}
                <div
                  className="flex flex-wrap gap-x-4 gap-y-1 mt-1 pt-2 text-xs"
                  style={{
                    color: colorTextTertiary,
                    borderTop: `1px solid ${colorFillAlter}`
                  }}
                >
                  <span className="flex items-center gap-1.5">
                    <RiBrain4Line size={13} />
                    {memorySnap.runtime
                      ? t('harness.sidebar.memoryHotCount', {
                          count: memorySnap.runtime.entries.length
                        })
                      : t('harness.sidebar.memoryHotEmpty')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <RiDatabase2Line size={13} />
                    {t('harness.sidebar.memorySpaces', {
                      active: memorySnap.bodies?.activeCount ?? 0,
                      total: memorySnap.bodies?.total ?? 0
                    })}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <RiFileTextLine size={13} />
                    {t('harness.sidebar.memoryDocuments', {
                      count: memorySnap.documents?.total ?? 0
                    })}
                  </span>
                </div>

                {/* Management entry */}
                <button
                  onClick={handleOpenMemoryPage}
                  className="flex items-center justify-center gap-1.5 w-full py-2 mt-2.5 rounded text-xs transition-colors"
                  style={{ color: '#1677ff', background: colorFillAlter }}
                >
                  <RiSettings4Line size={13} />
                  {t('harness.sidebar.memoryManage')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* New draft dialog (plugin mode's +; shares the same component as the workshop on the settings page) */}
      <NewDraftModal
        open={newDraftOpen}
        onClose={() => setNewDraftOpen(false)}
        onCreated={() => void loadDrafts()}
      />

      {/* Rename workspace dialog */}
      <Modal
        title={t('harness.sidebar.renameWorkspace')}
        open={renameOpen}
        onCancel={() => {
          setRenameOpen(false)
          setRenameTarget(null)
        }}
        onOk={handleRenameSave}
        okText={t('common.action.save')}
        cancelText={t('common.action.cancel')}
        confirmLoading={renameSaving}
        width={380}
      >
        <Input
          autoFocus
          placeholder={t('harness.sidebar.workspaceNamePlaceholder')}
          value={renameName}
          onChange={(e) => setRenameName(e.target.value)}
          onPressEnter={handleRenameSave}
        />
      </Modal>

      {/* Rename conversation dialog (same interaction as the workspace one: one input line + save) */}
      <Modal
        title={t('harness.sidebar.topicRenameTitle')}
        open={topicRenameOpen}
        onCancel={() => {
          setTopicRenameOpen(false)
          setTopicRenameTarget(null)
        }}
        onOk={handleRenameTopicSave}
        okText={t('common.action.save')}
        cancelText={t('common.action.cancel')}
        confirmLoading={topicRenameSaving}
        width={380}
      >
        <Input
          autoFocus
          data-topic-field="rename"
          placeholder={t('harness.sidebar.topicNamePlaceholder')}
          value={topicRenameName}
          onChange={(e) => setTopicRenameName(e.target.value)}
          onPressEnter={handleRenameTopicSave}
        />
      </Modal>

      {/* Rename plugin dialog (same interaction as the workspace rename; only the display name changes, directory name/id unchanged) */}
      <Modal
        title={t('harness.sidebar.pluginRename')}
        open={draftRenameTarget !== null}
        onCancel={() => setDraftRenameTarget(null)}
        onOk={handleDraftRenameSave}
        okText={t('common.action.save')}
        cancelText={t('common.action.cancel')}
        confirmLoading={draftRenameSaving}
        width={380}
      >
        <Input
          autoFocus
          data-workshop-field="rename"
          placeholder={t('harness.sidebar.pluginNamePlaceholder')}
          value={draftRenameName}
          onChange={(e) => setDraftRenameName(e.target.value)}
          onPressEnter={handleDraftRenameSave}
        />
        <div style={{ marginTop: 8, fontSize: 12, color: colorTextTertiary }}>
          {t('harness.sidebar.pluginRenameNote', { id: draftRenameTarget?.id ?? '' })}
        </div>
      </Modal>
    </div>
  )
}

// memo: while the chat area streams, the parent re-renders frequently; the sidebar's (including the search box) props are all stable references,
// so it should not re-render along with it
export default React.memo(HarnessSidebar)
