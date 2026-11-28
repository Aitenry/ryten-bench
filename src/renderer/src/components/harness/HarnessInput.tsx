import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { App, Button, Input, InputNumber, Modal, Popover, Switch, Tooltip, theme } from 'antd'
import type { InputRef } from 'antd'
import {
  RiArrowUpLine,
  RiAttachment2,
  RiCloseLine,
  RiStopFill,
  RiArrowRightSLine,
  RiArrowLeftSLine,
  RiArrowUpSLine,
  RiArrowDownSLine,
  RiSearchLine,
  RiCheckLine,
  RiShieldCheckLine,
  RiShieldKeyholeLine,
  RiShieldFlashLine,
  RiToolsLine,
  RiFileAi2Line,
  RiPlug2Line,
  RiInformationLine
} from '@remixicon/react'
import {
  OpenAIFilled,
  DeepSeekFilled,
  OllamaFilled,
  MistralFilled,
  AnthropicFilled,
  GeminiFilled
} from '@ant-design/icons'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import { Extension } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import HardBreak from '@tiptap/extension-hard-break'
import History from '@tiptap/extension-history'
import Placeholder from '@tiptap/extension-placeholder'
import { baseKeymap } from '@tiptap/pm/commands'
import { keymap } from '@tiptap/pm/keymap'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import FileRef from './FileRefNode'
import HarnessUsageMeter from './HarnessUsageMeter'
import HarnessSlashMenu from './HarnessSlashMenu'
import ToolSourceTag from './ToolSourceTag'
import {
  filterSlashCommands,
  type HarnessSlashCommandDef,
  type HarnessSlashCommandId
} from './slashCommands'
import { useTranslation } from '@renderer/i18n'
import mascot from '@renderer/assets/mascot.png'

import {
  defaultReasoningEffort,
  getProviderColor,
  reasoningEffortLabel
} from '@renderer/utils/providerMeta'
import ProviderMark from '@renderer/components/provider/provider-mark'
import type { Attachment, HarnessToolInfo } from '../../types/harness/types'
import type { PermissionMode } from '../../../../shared/harness/types'
import { harnessApi, type AgentSelectionView } from '../../api/harness'
import {
  MCP_TOOL_GROUP,
  canonicalToolName,
  mcpNamespace,
  mcpServerGroupValue
} from '../../../../shared/harness/mcp'

// TipTap does not load standard key bindings (backspace/delete/enter, etc.) by default, so load
// prosemirror-commands' baseKeymap explicitly.
const BaseKeymap = Extension.create({
  name: 'baseKeymap',
  addProseMirrorPlugins() {
    return [keymap(baseKeymap)]
  }
})

const providerIconMap: Record<string, React.ComponentType<{ style?: React.CSSProperties }> | null> =
  {
    openai: OpenAIFilled,
    deepseek: DeepSeekFilled,
    ollama: OllamaFilled,
    mistral: MistralFilled,
    anthropic: AnthropicFilled,
    'google-genai': GeminiFilled,
    'google-vertexai': GeminiFilled
  }

// Custom caret height (px): ProseMirror's native caret height follows the line height (19px),
// which does not match a normal input (about the font size), so the native caret is hidden and a
// fixed-height caret is drawn. It matches the body/placeholder font size (14px) so that with empty
// content it has the same height and position as the placeholder text. Tweak this value to adjust.
const CARET_HEIGHT = 14

/**
 * Query length limit (in characters) for the `/` command palette.
 *
 * Longer queries are treated as plain text: the user may genuinely want to send a long message
 * starting with `/` (a path, a command example), and the menu must not keep covering the input.
 */
const SLASH_QUERY_MAX_CHARS = 32

/**
 * Parse the command query from the input text.
 *
 * Product decision (2026-11-26): the command palette is **only opened when `/` is typed at the
 * very beginning**. So only the shape "text starts with `/`" is recognized; a `/` in the middle of
 * a sentence or line is always treated as plain text. A query (the part after `/`) containing
 * whitespace means the user has started writing the body, so the menu closes. Returns null when
 * validation fails.
 */
function parseSlashQuery(text: string): string | null {
  if (!text.startsWith('/')) return null
  const rest = text.slice(1)
  if (rest.length > SLASH_QUERY_MAX_CHARS) return null
  if (/[\s\u3000]/.test(rest)) return null
  return rest
}

/**
 * Permission mode (sandbox) option table — one-to-one with the modes in the main process's
 * runtime/permission.ts.
 *
 * There are only three built-in modes (read-only / workspace write / full access): icons come from
 * the shield family, and color encodes only one thing — "broader = more dangerous"
 * (neutral → primary → warning).
 */
const PERMISSION_OPTIONS: {
  mode: PermissionMode
  labelKey:
    | 'harness.permission.readOnly'
    | 'harness.permission.workspaceWrite'
    | 'harness.permission.fullAccess'
  /** One-line description at the panel bottom (omit = this mode has no description row) */
  hintKey?: 'harness.permission.readOnlyHint' | 'harness.permission.fullAccessHint'
  icon: React.ComponentType<{ size?: number | string; style?: React.CSSProperties }>
  /** Color token name (resolved to a theme token in the component) */
  tone: 'neutral' | 'primary' | 'warning'
}[] = [
  {
    mode: 'read-only',
    labelKey: 'harness.permission.readOnly',
    hintKey: 'harness.permission.readOnlyHint',
    icon: RiShieldCheckLine,
    tone: 'neutral'
  },
  {
    mode: 'workspace-write',
    labelKey: 'harness.permission.workspaceWrite',
    icon: RiShieldKeyholeLine,
    tone: 'primary'
  },
  {
    mode: 'danger-full-access',
    labelKey: 'harness.permission.fullAccess',
    hintKey: 'harness.permission.fullAccessHint',
    icon: RiShieldFlashLine,
    tone: 'warning'
  }
]

// Read a pasted File as a dataUrl (image attachments take this path)
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

interface HarnessInputProps {
  inputValue: string
  onInputChange: (value: string) => void
  /**
   * Counter for "an external request wants focus in the input" (plugin row + → `harness-focus-input`).
   * On change, focus the editor and **leave the content untouched** — after clicking "new session"
   * the user can type right away (content is always written by the user themselves; 2026-09-28
   * decision: do not display anything for the plugin "…" item).
   */
  focusInputToken?: number
  textareaRef: React.RefObject<HTMLDivElement | null>
  /** Global input history (browse with ↑/↓, recorded by handleSend, persisted to localStorage) */
  inputHistoryRef: { current: string[] }
  attachments: Attachment[]
  onAttachmentsChange: (attachments: Attachment[]) => void
  isLoading: boolean
  selectedProviderId: number | null
  onSelectProvider: (value: number) => void
  groupedProviderOptions: {
    label: string
    options: {
      value: number
      label: string
      providerType: string
      /** Reasoning effort of the current model (null = not set) */
      reasoningEffort: string | null
      /** Selectable effort levels declared by the model profile (empty array = none recorded) */
      effortLevels: string[]
      /** Whether the current protocol really sends the effort parameter (if unsupported the panel notes it is recorded only) */
      effortControllable: boolean
    }[]
  }[]
  modelSupportsTools: boolean
  modelSupportsVision: boolean
  /**
   * Current topic id (permission mode is stored per topic):
   * null = no conversation yet (first turn of a new chat); switching modes then equals changing the
   * "new session default".
   */
  currentTopicId: number | null
  /**
   * **Draft** team-collaboration value for a blank session: there is no topic to persist to yet, so
   * it is kept on the page (`useHarnessHandlers`) and saved together with the INSERT when the first
   * message creates the topic; once a topic exists this value no longer participates in rendering.
   */
  pendingTeamMode?: boolean
  /** Draft value change callback: the switch in a blank session calls this and no IPC is sent */
  onPendingTeamModeChange?: (enabled: boolean) => void
  /**
   * Whether to show the assistant mascot at the top-right of the input.
   *
   * Only shown in a blank session (welcome page): the mascot is absolutely positioned and sticks
   * out above the input card, so with conversation content it overlaps messages / reasoning
   * (reported 2026-11-23). The page therefore passes this based on `messages.length === 0`.
   */
  showMascot?: boolean
  /**
   * Context window of the current model (provider profile metadata.context_window).
   * The context ring on the bottom-right computes its percentage from it; null = the profile does
   * not specify it, so no ring is drawn (the window size is never guessed).
   */
  modelContextWindow?: number | null
  isDarkMode: boolean
  colorBgLayout: string
  colorBorder: string
  colorText: string
  colorBorderSecondary: string
  onSend: () => void
  onStop: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
  /**
   * Input for subagent sessions: the same component is reused but main-agent-only controls are
   * hidden (attachments / permission mode / model picker / tools and skills / usage bar) — these
   * only apply to main-agent turns.
   */
  simpleMode?: boolean
  /** Custom placeholder (used when continuing a subagent chat; defaults to the main chat copy) */
  placeholder?: string
  /** Goal compose mode: the input card is highlighted and shows a mode label (content still lives in the editor) */
  goalCompose?: boolean
  /** Max rounds for a goal (null = backend default 256; editable only in goal compose mode) */
  goalRoundsLimit?: number | null
  onGoalRoundsLimitChange?: (rounds: number | null) => void
  /** Lock the input while plan review is pending (cannot send or edit) */
  locked?: boolean
  /** Slash command "goal": the page opens the goal editor above the input */
  onGoalCommand?: () => void
  /** Slash command "plan": the page toggles plan mode above the input */
  onPlanCommand?: () => void
  /**
   * Session-level run selection (tools / skills / MCP): owned by the page and sent with agentConfig.
   * Changes are reported back via onAgentSelectionChange; for an existing session the input
   * persists them directly.
   */
  agentSelection?: AgentSelectionView | null
  onAgentSelectionChange?: (selection: AgentSelectionView) => void
}

const HarnessInput: React.FC<HarnessInputProps> = ({
  inputValue,
  onInputChange,
  focusInputToken = 0,
  textareaRef,
  inputHistoryRef,
  attachments,
  onAttachmentsChange,
  isLoading,
  selectedProviderId,
  onSelectProvider,
  groupedProviderOptions,
  modelSupportsVision,
  currentTopicId,
  pendingTeamMode = false,
  onPendingTeamModeChange,
  showMascot = false,
  modelContextWindow = null,
  isDarkMode,
  colorBgLayout,
  colorBorder,
  colorText,
  colorBorderSecondary,
  onSend,
  onStop,
  onKeyDown,
  simpleMode = false,
  onGoalCommand,
  onPlanCommand,
  placeholder,
  goalCompose = false,
  goalRoundsLimit = null,
  onGoalRoundsLimitChange,
  locked = false,
  onAgentSelectionChange = () => {}
}) => {
  const [isDragOver, setIsDragOver] = useState(false)
  // Custom caret element (the native caret is hidden, see updateCaret)
  const caretRef = useRef<HTMLSpanElement | null>(null)
  const { message } = App.useApp()
  const { t } = useTranslation()
  const { token } = theme.useToken()

  // ── Model / reasoning effort panel (model picker at the bottom-left of the input) ──────────
  // The expanded panel has two entry rows, "model" and "reasoning effort"; the list appears one
  // level deeper. Both rows show the current value, so one click on the collapsed state reveals
  // which model is in use and how deep its thinking is.
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuView, setMenuView] = useState<'root' | 'model' | 'effort'>('root')
  const [modelQuery, setModelQuery] = useState('')
  /** Keyboard highlight index in the model list (index into the flattened search results) */
  const [activeIndex, setActiveIndex] = useState(0)
  const [savingEffort, setSavingEffort] = useState(false)

  // ── Team collaboration (opt-in, persisted per topic) ──────────────────────────────────────
  // The entry lives in the "model / reasoning effort" panel (the team switch belongs to the
  // current turn's run configuration rather than the sidebar session menu). When off, the
  // team_task_* tools and the team prompt section are not injected.
  const [teamModeEnabled, setTeamModeEnabled] = useState(false)
  const [teamModeBusy, setTeamModeBusy] = useState(false)

  useEffect(() => {
    // Blank session (no topic yet): the switch reflects the draft value held by the page; nothing is
    // read from the database or subscribed to — the value is saved with the INSERT when the first
    // message creates the topic, see startTurn in useHarnessHandlers.
    if (currentTopicId == null || simpleMode) {
      setTeamModeEnabled(false)
      return
    }
    let cancelled = false
    void harnessApi.harness
      .getTeamMode(currentTopicId)
      .then((view) => {
        if (!cancelled) setTeamModeEnabled(view.enabled)
      })
      .catch(() => {
        /* Read failures are shown as off; the next Runtime turn still follows backend state */
      })
    const unsubscribe = harnessApi.harness.onTeamModeUpdated((view) => {
      if (view.topicId === currentTopicId) setTeamModeEnabled(view.enabled)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [currentTopicId, simpleMode])

  const handleToggleTeamMode = useCallback(
    async (next: boolean): Promise<void> => {
      if (currentTopicId == null) return
      setTeamModeBusy(true)
      try {
        const view = await harnessApi.harness.setTeamMode({
          topicId: currentTopicId,
          enabled: next
        })
        setTeamModeEnabled(view.enabled)
      } catch {
        message.error(t('harness.input.teamModeFailed'))
      } finally {
        setTeamModeBusy(false)
      }
    },
    [currentTopicId, message, t]
  )

  // ── Permission mode (sandbox): read-only / workspace write / full access ──────────────────
  // The mode is stored per topic in the main process (electron-store); the value here is only a
  // cached copy for display. Switching to "full access" requires a risk confirmation first; the
  // other modes take effect immediately.
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const [savingPermission, setSavingPermission] = useState(false)

  // ── Tools / skills: main-agent defaults (moved below the input after leaving settings) ──────
  const [toolsOpen, setToolsOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [toolCatalog, setToolCatalog] = useState<HarnessToolInfo[]>([])
  const [skillCatalog, setSkillCatalog] = useState<
    { id: string; name: string; description: string }[]
  >([])
  const [selectedTools, setSelectedTools] = useState<string[]>([])
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [selectedMcp, setSelectedMcp] = useState<string[]>([])
  /** Available MCP servers (the selection stores per-server groups mcp@<namespace>, expanded by the main process on mount) */
  const [mcpCatalog, setMcpCatalog] = useState<{ value: string; label: string }[]>([])
  /**
   * Ghost selections: old skill / MCP selections whose entries were deleted or renamed in the
   * catalog still remain in the session selection. The badge counts only entries still present in
   * the catalog; otherwise it would read "skills 1" while the panel has no checked row and the
   * choice cannot be cleared. The selection itself is kept — it takes effect again if the catalog
   * restores the same name (the runtime also filters by catalog).
   */
  const visibleSelectedSkills = useMemo(
    () => selectedSkills.filter((id) => skillCatalog.some((skill) => skill.id === id)).length,
    [selectedSkills, skillCatalog]
  )
  const visibleSelectedMcp = useMemo(
    () => selectedMcp.filter((value) => mcpCatalog.some((server) => server.value === value)).length,
    [selectedMcp, mcpCatalog]
  )
  const [mcpOpen, setMcpOpen] = useState(false)
  const [mcpQuery, setMcpQuery] = useState('')
  const mcpSearchRef = useRef<InputRef | null>(null)
  useEffect(() => {
    if (!mcpOpen) return
    const timer = window.setTimeout(() => mcpSearchRef.current?.focus(), 60)
    return () => window.clearTimeout(timer)
  }, [mcpOpen])
  /** Search term in the tools / skills panels (filters that panel only, cleared on close, not saved to settings) */
  const [toolQuery, setToolQuery] = useState('')
  const [skillQuery, setSkillQuery] = useState('')
  /** Move the cursor into the search box every time the panel opens (Popover content stays mounted, so autoFocus only works the first time) */
  const toolSearchRef = useRef<InputRef | null>(null)
  const skillSearchRef = useRef<InputRef | null>(null)
  useEffect(() => {
    if (!toolsOpen) return
    const timer = window.setTimeout(() => toolSearchRef.current?.focus(), 60)
    return () => window.clearTimeout(timer)
  }, [toolsOpen])
  useEffect(() => {
    if (!skillsOpen) return
    const timer = window.setTimeout(() => skillSearchRef.current?.focus(), 60)
    return () => window.clearTimeout(timer)
  }, [skillsOpen])
  /** Report selection changes back to the page (sent with agentConfig) */
  const emitSelection = useCallback(
    (selection: AgentSelectionView): void => {
      onAgentSelectionChange(selection)
    },
    [onAgentSelectionChange]
  )
  const currentTopicIdRef = useRef(currentTopicId)
  currentTopicIdRef.current = currentTopicId

  // Switching topics: fetch the mode for that topic once (a new topic has no record → the main
  // process falls back to the "new session default")
  useEffect(() => {
    let cancelled = false
    void harnessApi.harness
      .getPermission(currentTopicId)
      .then((state) => {
        if (!cancelled) setPermissionMode(state.mode)
      })
      .catch(() => {
        // Silent when the plugin is disabled / the channel is unavailable: the rest of the input works
      })
    return () => {
      cancelled = true
    }
  }, [currentTopicId])

  // Tool / skill / MCP catalogs plus the current session's selection (re-read when switching
  // sessions). Defaults: tools follow the main-agent defaults; skills and MCP start with nothing
  // enabled (2026-11-27 decision).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [main, tools, skills, servers, topicSelection] = await Promise.all([
          harnessApi.mainAgent.get(),
          harnessApi.harness.getTools(),
          harnessApi.harness.listSkills(),
          harnessApi.mcp.list().catch(() => []),
          currentTopicId != null
            ? harnessApi.harness.getTopicAgentSelection(currentTopicId)
            : Promise.resolve(null)
        ])
        if (cancelled) return
        setToolCatalog(tools)
        setSkillCatalog(skills)
        const mcpServerValues = servers.map((server) =>
          mcpServerGroupValue(mcpNamespace(server.config.name))
        )
        setMcpCatalog(
          servers.map((server, index) => ({
            value: mcpServerValues[index],
            label: server.config.name
          }))
        )
        /**
         * Legacy "MCP" select-all marker (the tools panel used to have an `mcp` item, removed
         * 2026-11-27) → migrate to per-server group values for "all current servers", keeping the
         * same coverage; drop it entirely when there are no servers.
         */
        const migrateLegacyMcp = (names: string[]): string[] =>
          names.includes(MCP_TOOL_GROUP)
            ? names.flatMap((name) => (name === MCP_TOOL_GROUP ? mcpServerValues : [name]))
            : names
        setSelectedTools(
          Array.from(
            new Set(
              // Old sessions may store pre-merge web_fetch / web_search: normalize them to the
              // group item first, otherwise the panel check state is off (the group shows
              // unchecked while its tools are actually mounted).
              migrateLegacyMcp(topicSelection?.tools ?? main.tools ?? []).map((name) =>
                canonicalToolName(name)
              )
            )
          )
        )
        setSelectedSkills(topicSelection?.skills ?? [])
        setSelectedMcp(topicSelection?.mcpTools ?? [])
        emitSelection({
          tools: topicSelection?.tools
            ? Array.from(
                new Set(
                  migrateLegacyMcp(topicSelection.tools).map((name) => canonicalToolName(name))
                )
              )
            : null,
          skills: topicSelection?.skills ?? null,
          mcpTools: topicSelection?.mcpTools ?? null
        })
      } catch (err) {
        console.warn('[harness-input] Failed to load tools/skills/mcp:', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currentTopicId, emitSelection])

  // Permission mode broadcast (default changed in settings, or switched in another window) →
  // sync the displayed value
  useEffect(() => {
    try {
      return harnessApi.harness.onPermissionUpdated((state) => {
        if (state.topicId === (currentTopicIdRef.current ?? 0)) setPermissionMode(state.mode)
      })
    } catch (err) {
      // A failed subscription (plugin disabled / preload allowlist) must not let the exception
      // escape the effect: that would unmount the whole render tree
      console.warn('[harness-input] Failed to subscribe to permission mode:', err)
      return
    }
  }, [])

  const applyPermissionMode = useCallback(
    async (mode: PermissionMode): Promise<void> => {
      setSavingPermission(true)
      try {
        const state = await harnessApi.harness.setPermission({
          topicId: currentTopicIdRef.current,
          mode,
          scope: 'topic'
        })
        setPermissionMode(state.mode)
        setPermissionOpen(false)
      } catch {
        message.error(t('harness.permission.switchFailed'))
      } finally {
        setSavingPermission(false)
      }
    },
    [message, t]
  )

  /** Select a mode: full access needs an explicit risk confirmation, others switch directly */
  const selectPermissionMode = useCallback(
    (mode: PermissionMode): void => {
      if (mode === permissionMode) {
        setPermissionOpen(false)
        return
      }
      if (mode === 'danger-full-access') {
        setPermissionOpen(false)
        setConfirmFullAccess(true)
        return
      }
      void applyPermissionMode(mode)
    },
    [permissionMode, applyPermissionMode]
  )

  /** Persist a session-level selection: saved immediately for an existing session; for a new session the main process writes it with the first turn */
  const persistSelection = (selection: AgentSelectionView): void => {
    emitSelection(selection)
    if (currentTopicId == null) return
    void harnessApi.harness
      .setTopicAgentSelection(currentTopicId, selection)
      .catch(() => message.error(t('harness.input.pickerSaveFailed')))
  }

  /** Tools: enabled per session (defaults to following the main agent; changes apply to this session's next turn) */
  const toggleTool = (name: string): void => {
    const next = selectedTools.includes(name)
      ? selectedTools.filter((item) => item !== name)
      : [...selectedTools, name]
    setSelectedTools(next)
    persistSelection({ tools: next, skills: selectedSkills, mcpTools: selectedMcp })
  }

  /** Skills: enabled per session (new skills are off by default and must be checked here) */
  const toggleSkill = (id: string): void => {
    const next = selectedSkills.includes(id)
      ? selectedSkills.filter((item) => item !== id)
      : [...selectedSkills, id]
    setSelectedSkills(next)
    persistSelection({ tools: selectedTools, skills: next, mcpTools: selectedMcp })
  }

  /** MCP: check servers per session (stored as group values, expanded into concrete tools by the main process on mount) */
  const toggleMcp = (value: string): void => {
    const next = selectedMcp.includes(value)
      ? selectedMcp.filter((item) => item !== value)
      : [...selectedMcp, value]
    setSelectedMcp(next)
    persistSelection({ tools: selectedTools, skills: selectedSkills, mcpTools: next })
  }

  /** Flattened options: shared by current-model lookup, keyboard navigation and search results */
  const flatOptions = useMemo(
    () =>
      groupedProviderOptions.flatMap((group) =>
        group.options.map((option) => ({ ...option, groupLabel: group.label }))
      ),
    [groupedProviderOptions]
  )

  const selectedOption = useMemo(
    () => flatOptions.find((option) => option.value === selectedProviderId) ?? null,
    [flatOptions, selectedProviderId]
  )

  /** Effort levels declared by the current model profile (empty = no thinking levels, so the "reasoning effort" row is hidden) */
  const effortLevels = selectedOption?.effortLevels ?? []
  const currentEffort = selectedOption?.reasoningEffort ?? null
  /**
   * Effectively applied level: the explicitly selected one if any, otherwise the model's default
   * "medium thinking" level (same algorithm as the fallback in the main process's thinking-params,
   * so what the UI shows is exactly what gets sent).
   */
  const effectiveEffort = currentEffort ?? defaultReasoningEffort(effortLevels)

  /** Model search: filter by display name and protocol name, keeping the grouping */
  const filteredGroups = useMemo(() => {
    const query = modelQuery.trim().toLowerCase()
    if (!query) return groupedProviderOptions
    return groupedProviderOptions
      .map((group) => ({
        label: group.label,
        options: group.options.filter(
          (option) =>
            option.label.toLowerCase().includes(query) ||
            option.providerType.toLowerCase().includes(query)
        )
      }))
      .filter((group) => group.options.length > 0)
  }, [groupedProviderOptions, modelQuery])

  /** Flatten the search results (the keyboard index uses it, matching render order) */
  const filteredOptions = useMemo(
    () => filteredGroups.flatMap((group) => group.options),
    [filteredGroups]
  )

  const closeMenu = useCallback((): void => {
    setMenuOpen(false)
    setMenuView('root')
    setModelQuery('')
  }, [])

  const openModelList = useCallback((): void => {
    setMenuView('model')
    setModelQuery('')
    // Highlight the current model on open (the query was just cleared, so index into the full list)
    setActiveIndex(
      Math.max(
        0,
        flatOptions.findIndex((o) => o.value === selectedProviderId)
      )
    )
  }, [flatOptions, selectedProviderId])

  const handleMenuOpenChange = useCallback((open: boolean): void => {
    setMenuOpen(open)
    if (open) {
      setMenuView('root')
      setModelQuery('')
    }
  }, [])

  const selectModel = useCallback(
    (value: number): void => {
      onSelectProvider(value)
      closeMenu()
    },
    [onSelectProvider, closeMenu]
  )

  /**
   * Write the reasoning effort into the model's own config column (provider.reasoning_effort); the
   * main process translates it per protocol family. After saving, the providers-changed broadcast
   * refreshes the list. Levels come only from the model profile (the panel no longer offers a
   * "default/unset" item), so only concrete levels are written here.
   */
  const selectEffort = useCallback(
    async (level: string): Promise<void> => {
      if (selectedProviderId == null) return
      setSavingEffort(true)
      try {
        await window.api.providers.update(selectedProviderId, { reasoning_effort: level })
      } catch {
        message.error(t('harness.input.effortSaveFailed'))
      } finally {
        setSavingEffort(false)
        closeMenu()
      }
    },
    [selectedProviderId, message, t, closeMenu]
  )

  /** Model list keyboard handling: ↑/↓ to move, Enter to select, Esc to go back one level */
  const handleModelListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenuView('root')
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (filteredOptions.length === 0) return
        const delta = e.key === 'ArrowDown' ? 1 : -1
        setActiveIndex((prev) => {
          const next = prev + delta
          if (next < 0) return filteredOptions.length - 1
          if (next >= filteredOptions.length) return 0
          return next
        })
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const picked = filteredOptions[activeIndex]
        if (picked) selectModel(picked.value)
      }
    },
    [filteredOptions, activeIndex, selectModel]
  )

  const selectedProviderType = useMemo(() => {
    if (selectedProviderId == null) return ''
    for (const group of groupedProviderOptions) {
      for (const opt of group.options) {
        if (opt.value === selectedProviderId) return opt.providerType
      }
    }
    return ''
  }, [selectedProviderId, groupedProviderOptions])

  const SelectedIcon = providerIconMap[selectedProviderType]
  const selectedColor = getProviderColor(selectedProviderType, isDarkMode)

  // External callbacks go through refs: the editor is created once, so prop changes cannot rebuild it
  const onInputChangeRef = useRef(onInputChange)
  onInputChangeRef.current = onInputChange
  const onKeyDownRef = useRef(onKeyDown)
  onKeyDownRef.current = onKeyDown

  const editorRef = useRef<Editor | null>(null)

  // ── Input history (↑/↓ to switch): globally shared, persisted in localStorage, recorded into
  // inputHistoryRef by handleSend ──
  // historyIndexRef: -1 = not browsing, 0..n-1 = points at a history entry;
  // Trigger: ↑/↓ are only taken over when the input is empty (ed.isEmpty); once the user has typed
  // something, the default caret movement is kept.
  const historyIndexRef = useRef(-1)
  // Refresh the custom caret after switching entries (updateCaret is defined below; calling it via
  // ref avoids declaration-order issues)
  const updateCaretRef = useRef<() => void>(() => {})

  /** Text serialization matching onUpdate: hardBreak→newline, fileRef→path */
  const getEditorText = useCallback((ed: Editor): string => {
    return ed
      .getText({
        blockSeparator: '\n',
        textSerializers: {
          hardBreak: () => '\n',
          fileRef: ({ node }) => node.attrs.path ?? ''
        }
      })
      .replace(/\n+$/, '')
  }, [])

  /** Move the caret line by line, textarea style.
   * Every newline in the input is a hardBreak and the whole document is a single textblock, so
   * ProseMirror's default ↑/↓ is block-level movement (jumping to paragraph start/end); here the
   * caret is positioned per line using screen coordinates. */
  const moveCursorByLine = useCallback((view: EditorView, dir: -1 | 1): boolean => {
    const { state } = view
    if (!state.selection.empty) return false
    const lineHeight = parseFloat(getComputedStyle(view.dom).lineHeight) || 19
    const coords = view.coordsAtPos(state.selection.$head.pos)
    const hit = view.posAtCoords({ left: coords.left, top: coords.top + dir * lineHeight })
    if (!hit) return true // ↑ on the first line / ↓ on the last: consume but do not move, avoiding a jump to paragraph start/end
    // Height difference from the current line is under half a line → still the same line (coords
    // clamped) → do not move
    const hitCoords = view.coordsAtPos(hit.pos)
    if (Math.abs(hitCoords.top - coords.top) < lineHeight * 0.5) return true
    const bias = dir > 0 ? 1 : -1 // ↓ to line start, ↑ to line end (textarea convention)
    view.dispatch(
      state.tr.setSelection(TextSelection.near(state.doc.resolve(hit.pos), bias)).scrollIntoView()
    )
    return true
  }, [])

  /** Switch input history with ↑/↓ (caller guarantees the input is empty); returns whether the key was consumed */
  const navigateHistory = useCallback(
    (dir: -1 | 1): boolean => {
      const ed = editorRef.current
      if (!ed) return false
      const history = inputHistoryRef.current
      if (history.length === 0) return false

      let next = historyIndexRef.current
      if (dir === -1) {
        // ↑: step back one entry at a time when the input is empty (newest → older);
        // pressing ↑ again past the oldest entry cycles back to the empty draft (symmetric with ↓
        // going past the newest entry)
        if (next === -1) {
          next = history.length - 1
        } else {
          next -= 1
          if (next < 0) next = -1
        }
        if (next === historyIndexRef.current) return false
      } else {
        // ↓: move to a newer history entry; past the newest one, return to the empty draft
        if (next === -1) return false
        next += 1
        if (next >= history.length) next = -1
      }

      historyIndexRef.current = next
      const text = next === -1 ? '' : history[next]
      // Restore as plain text: rebuild line by line (hard breaks as hardBreak), fileRef as its path text
      const lines = text.replace(/\r\n?/g, '\n').split('\n')
      const nodes: ProseMirrorNode[] = []
      lines.forEach((line, i) => {
        if (i > 0) nodes.push(ed.schema.nodes.hardBreak.create())
        if (line) nodes.push(ed.schema.text(line))
      })
      // emitUpdate:false: keeps onUpdate from treating it as a user edit and resetting browse state
      ed.commands.setContent(
        {
          type: 'doc',
          content: [{ type: 'paragraph', content: nodes.map((n) => n.toJSON()) }]
        },
        { emitUpdate: false }
      )
      ed.commands.focus('end')
      // setContent does not trigger onUpdate, so sync the parent's inputValue manually
      onInputChangeRef.current(getEditorText(ed))
      requestAnimationFrame(() => updateCaretRef.current())
      return true
    },
    [inputHistoryRef, getEditorText]
  )

  // ── Pasted attachments: convert clipboard files/images into attachments (the same Attachment
  // structure as the upload button) ──
  // Image: read the content as a dataUrl (matching the image branch of select-image-file)
  // Non-image: take the real disk path (matching the non-image branch: the dataUrl is the path);
  //            when no path is available (e.g. a diskless source copied from another app), suggest
  //            dragging or uploading instead.
  const handlePasteFiles = useCallback(
    async (files: File[]) => {
      const added: Attachment[] = []
      for (const file of files) {
        const isImage =
          file.type.startsWith('image/') || /\.(png|jpe?g|gif|bmp|webp|svg|ico)$/i.test(file.name)
        if (isImage) {
          // Same as the upload button: image attachments are rejected for non-vision models
          if (!modelSupportsVision) {
            message.warning(t('harness.input.visionUnsupported'))
            continue
          }
          try {
            const dataUrl = await readFileAsDataUrl(file)
            added.push({
              dataUrl,
              fileName: file.name || t('harness.input.pasteImageFallbackName'),
              isImage: true
            })
          } catch {
            message.error(t('harness.input.imageReadFailed', { name: file.name }))
          }
        } else {
          const realPath = window.api.file.getPathForFile(file)
          if (realPath) {
            added.push({ dataUrl: realPath, fileName: file.name, isImage: false })
          } else {
            message.warning(t('harness.input.filePathUnavailable', { name: file.name }))
          }
        }
      }
      if (added.length > 0) onAttachmentsChange([...attachments, ...added])
    },
    [attachments, onAttachmentsChange, modelSupportsVision, message, t]
  )
  // Same as above: the editor is created once, so handlePaste reads the latest implementation via ref
  const handlePasteFilesRef = useRef(handlePasteFiles)
  handlePasteFilesRef.current = handlePasteFiles

  // ── `/` command palette (goal / plan) ─────────────────────────────────────────────────────
  // Only opened when the input starts with `/`.
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  /** After the user closes it with Esc, do not reopen it until the text no longer starts with `/` */
  const [slashDismissed, setSlashDismissed] = useState(false)
  const slashMenuRef = useRef<HTMLDivElement | null>(null)
  /** Outer composer element (detects whether a click landed inside the input: clicking the input does not close the menu) */
  const composerRef = useRef<HTMLDivElement | null>(null)

  const slashRows = useMemo(() => filterSlashCommands((key) => t(key), slashQuery), [slashQuery, t])
  /** Read the latest state in key handlers (the editor is created once, so closures do not update on re-render) */
  const slashRef = useRef<{
    open: boolean
    index: number
    rows: HarnessSlashCommandDef[]
  }>({ open: false, index: 0, rows: [] })
  slashRef.current = { open: slashOpen, index: slashIndex, rows: slashRows }

  /** Previous query: reset the highlight to the first row when the query changes */
  const previousSlashQueryRef = useRef('')

  useEffect(() => {
    if (simpleMode) {
      setSlashOpen(false)
      return
    }
    // The editor's first inline node must be **text starting with `/`**: a file-reference chip's
    // serialized path also starts with `/` (`/uploads/...`), so looking only at inputValue would
    // mistake "chip at the start" for command input.
    const ed = editorRef.current
    const firstInline = ed?.state.doc.firstChild?.firstChild
    const startsWithSlashText =
      !!firstInline && firstInline.isText && (firstInline.text ?? '').startsWith('/')
    const query = startsWithSlashText ? parseSlashQuery(inputValue) : null
    if (query === null) {
      setSlashOpen(false)
      setSlashDismissed(false)
      previousSlashQueryRef.current = ''
      return
    }
    if (slashDismissed) return
    if (previousSlashQueryRef.current !== query) {
      previousSlashQueryRef.current = query
      setSlashIndex(0)
    }
    setSlashQuery(query)
    setSlashOpen(true)
  }, [inputValue, simpleMode, slashDismissed])

  // Close when clicking outside the menu and the composer
  useEffect(() => {
    if (!slashOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (slashMenuRef.current?.contains(target)) return
      if (composerRef.current?.contains(target)) return
      setSlashOpen(false)
      setSlashDismissed(true)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [slashOpen])

  /**
   * Pick a command: consume the `/` plus the query first (the palette is not a normal message),
   * then run the action.
   *
   * Goal and plan have both moved to the inline area above the input: this only hands the action to
   * the page, and the input no longer owns a goal dialog or a plan badge.
   */
  const pickSlashCommand = useCallback(
    (id: HarnessSlashCommandId): void => {
      setSlashOpen(false)
      setSlashDismissed(false)
      setSlashQuery('')
      setSlashIndex(0)
      previousSlashQueryRef.current = ''
      onInputChangeRef.current('')
      const topicId = currentTopicIdRef.current
      if (topicId == null) {
        message.info(t('harness.input.commands.noTopic'))
        return
      }
      if (id === 'goal') {
        onGoalCommand?.()
        return
      }
      onPlanCommand?.()
    },
    [message, onGoalCommand, onPlanCommand, t]
  )
  // The editor's keydown handler is created once: read the latest implementation via ref
  const pickSlashRef = useRef(pickSlashCommand)
  pickSlashRef.current = pickSlashCommand

  const editor = useEditor(
    {
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        History,
        Placeholder.configure({ placeholder: placeholder ?? t('harness.input.placeholder') }),
        BaseKeymap,
        FileRef
      ],
      content: '',
      editorProps: {
        // Enter sends (Shift+Enter inserts a line break via HardBreak); do not intercept during IME composition
        handleKeyDown: (view, event) => {
          if (event.isComposing || event.keyCode === 229) return false
          // While the `/` palette is open, handle keys first: ↑/↓ move the highlight, Enter / Tab
          // picks, Esc closes. Picking runs a command action rather than sending a message — the
          // palette is not plain text.
          if (slashRef.current.open) {
            const rows = slashRef.current.rows
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              if (rows.length > 0) {
                const delta = event.key === 'ArrowDown' ? 1 : -1
                setSlashIndex((slashRef.current.index + delta + rows.length) % rows.length)
              }
              return true
            }
            if ((event.key === 'Enter' || event.key === 'Tab') && rows.length > 0) {
              event.preventDefault()
              const row = rows[Math.min(slashRef.current.index, rows.length - 1)]
              if (row) pickSlashRef.current(row.id)
              return true
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setSlashOpen(false)
              setSlashDismissed(true)
              return true
            }
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onKeyDownRef.current(event as unknown as React.KeyboardEvent<HTMLDivElement>)
            return true
          }
          // ↑/↓ switch history: an empty input enters browsing (loads the newest entry), and in
          // browse state (content non-empty but not typed by the user) ↑/↓ keep stepping through
          // entries; manual editing leaves browse state. When the content is non-empty and not in
          // browse state, use textarea-style line-by-line caret movement instead (avoiding PM's
          // single-textblock jump to paragraph start/end).
          if (
            !event.shiftKey &&
            !event.altKey &&
            (event.key === 'ArrowUp' || event.key === 'ArrowDown')
          ) {
            const ed = editorRef.current
            if (!ed) return false
            const dir = event.key === 'ArrowUp' ? -1 : 1
            const browsing = historyIndexRef.current !== -1
            const takeHistory = (dir === -1 && (ed.isEmpty || browsing)) || (dir === 1 && browsing)
            if (takeHistory && navigateHistory(dir)) {
              event.preventDefault()
              return true
            }
            // Not in browse state (the user has typed content): move the caret line by line and
            // never switch history. If the view is unavailable (editor destroy race), give up and
            // fall back to default behavior.
            if (ed.isDestroyed) return false
            try {
              if (moveCursorByLine(ed.view, dir)) {
                event.preventDefault()
                return true
              }
            } catch {
              return false
            }
          }
          // With the caret right next to a file-reference chip, Backspace/Delete removes it in one
          // press (ProseMirror selects it first by default)
          if ((event.key === 'Backspace' || event.key === 'Delete') && view.state.selection.empty) {
            const { $from } = view.state.selection
            const node = event.key === 'Backspace' ? $from.nodeBefore : $from.nodeAfter
            if (node && node.isAtom && node.type.name === 'fileRef') {
              event.preventDefault()
              const from = event.key === 'Backspace' ? $from.pos - node.nodeSize : $from.pos
              view.dispatch(view.state.tr.deleteRange(from, from + node.nodeSize))
              return true
            }
          }
          // Left/Right arrows step straight over a chip (ProseMirror selects a selectable atom
          // first by default, requiring two presses; here one press crosses it when the caret is
          // adjacent; Shift+arrow keeps the default selection extension).
          if (
            !event.shiftKey &&
            (event.key === 'ArrowRight' || event.key === 'ArrowLeft') &&
            view.state.selection.empty
          ) {
            const { $from } = view.state.selection
            const node = event.key === 'ArrowRight' ? $from.nodeAfter : $from.nodeBefore
            if (node && node.isAtom && node.type.name === 'fileRef') {
              event.preventDefault()
              const delta = event.key === 'ArrowRight' ? node.nodeSize : -node.nodeSize
              view.dispatch(
                view.state.tr.setSelection(
                  TextSelection.near(view.state.doc.resolve($from.pos + delta))
                )
              )
              return true
            }
          }
          return false
        },
        // Fully take over drop: dragged file references are always inserted as chips by the
        // container's onDrop, avoiding ProseMirror's default text/plain insertion and double inserts.
        handleDrop: () => true,
        // When the clipboard holds files/images, convert them to attachments first (Ctrl+V paste
        // upload); only plain text falls through to text paste.
        // Paste plain text: split on \n and insert line by line (line breaks as hardBreak, keeping
        // the DOM flat).
        // Note: do not use insertContent(array) (it drops hardBreak); use the native tr.insert.
        handlePaste: (_view, event) => {
          const pastedFiles = Array.from(event.clipboardData?.files ?? [])
          if (pastedFiles.length > 0) {
            event.preventDefault()
            void handlePasteFilesRef.current(pastedFiles)
            return true
          }
          const text = event.clipboardData?.getData('text/plain')
          if (text === undefined) return false
          event.preventDefault()
          const ed = editorRef.current
          if (!ed || !text) return true
          const lines = text.replace(/\r\n?/g, '\n').split('\n')
          const content: ProseMirrorNode[] = []
          lines.forEach((line, i) => {
            if (i > 0) content.push(ed.schema.nodes.hardBreak.create())
            if (line) content.push(ed.schema.text(line))
          })
          let tr = ed.state.tr
          if (!ed.state.selection.empty) tr = tr.deleteSelection()
          tr = tr.insert(tr.selection.from, content)
          // Dispatch through the event's own view (the real one) to avoid the editor.view proxy,
          // which may be in a destroy race
          _view.dispatch(tr)
          return true
        }
      },
      onUpdate: ({ editor }) => {
        // textSerializers: hardBreak outputs a newline and fileRef outputs its path, so the sent text
        // matches what is on screen. Note: the v3 serializer argument is a `{ node }` object, not
        // the node itself.
        const text = getEditorText(editor)
        // Manual edit while browsing history: leave browse state (after editing, the content is
        // non-empty and not in browse state, so ↑/↓ no longer switch). Programmatic switches use
        // setContent(emitUpdate:false) and never reach here.
        if (historyIndexRef.current !== -1) {
          historyIndexRef.current = -1
        }
        onInputChangeRef.current(text)
      }
      // deps=[]: the editor is created only once. @tiptap/react v3's useEditor re-schedules a 1ms
      // delayed destroy timer (scheduleDestroy) on every render; if two renders are more than 1ms
      // apart (e.g. heavy work such as evaluating the editor chunk during a page switch occupies the
      // main thread), the timer fires before the next render and destroys the editor, after which any
      // view access throws "The editor view is not available" and the whole React tree unmounts and
      // crashes. Passing an explicit empty dependency array schedules that timer only on real
      // unmount, removing the race at its source.
    },
    []
  )
  editorRef.current = editor ?? null

  // Lock the input while plan review is pending: no editing, no sending; review feedback stays in the plan card.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.setEditable(!locked)
  }, [editor, locked])

  // The placeholder must follow external mode changes (normal chat ↔ goal compose): TipTap's
  // Placeholder reads the string only once at creation, so switching into goal mode needs a manual
  // update plus a decoration redraw.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const extension = editor.extensionManager.extensions.find(
      (item) => item.name === 'placeholder'
    ) as { options?: { placeholder?: string } } | undefined
    if (!extension?.options) return
    extension.options.placeholder = placeholder ?? t('harness.input.placeholder')
    editor.view.dispatch(editor.state.tr)
  }, [editor, placeholder, t])
  /**
   * Safely read the editor view DOM.
   * When the view is not mounted or the editor is destroyed, TipTap v3.30's view returns a Proxy
   * with only a few stub fields, and accessing properties such as dom throws (rather than returning
   * null); this uniformly reduces that to "return null when unavailable".
   */
  const getViewDom = useCallback((ed: Editor): HTMLElement | null => {
    if (ed.isDestroyed) return null
    try {
      return ed.view.dom as HTMLElement
    } catch {
      return null
    }
  }, [])

  // ── Custom caret: follows the collapsed selection, fixed CARET_HEIGHT height ──
  // The native contentEditable caret height equals the line height (19px), while a normal input
  // caret is about the font size (14px); with the native caret hidden via caret-color: transparent,
  // a fixed-height caret is drawn here.
  const updateCaret = useCallback(() => {
    const ed = editorRef.current
    const caret = caretRef.current
    if (!ed || !caret) return
    const el = getViewDom(ed)
    if (!el) return

    const sel = window.getSelection()
    const show =
      document.activeElement === el &&
      !!sel &&
      sel.rangeCount > 0 &&
      sel.isCollapsed &&
      el.contains(sel.getRangeAt(0).commonAncestorContainer)
    if (!show) {
      caret.style.display = 'none'
      return
    }

    const range = sel.getRangeAt(0)
    const wrap = caret.parentElement
    if (!wrap) return
    const wrapRect = wrap.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 19
    // Empty content: position at the top-left of the content area (start of the first line), aligned
    // with the placeholder text (same font size, vertically centered in the line)
    const caretAtContentStart = (): { top: number; left: number } => ({
      top: elRect.top - wrapRect.top + (lineHeight - CARET_HEIGHT) / 2,
      left: elRect.left - wrapRect.left
    })

    // Whether the document is truly "empty" is decided by editor.isEmpty
    const isEmpty = ed.isEmpty

    // For a collapsed range right after an inline atom (chip), Chromium returns a zero-height rect;
    // in that case locate the caret at the right edge of the previous measurable element (the chip)
    const measurePrev = (r: Range): { right: number; top: number; height: number } | null => {
      const node = r.startContainer
      const offset = r.startOffset
      if (node.nodeType !== Node.ELEMENT_NODE) return null
      const children = node.childNodes
      for (let i = offset - 1; i >= 0; i--) {
        const c = children[i]
        if (c.nodeType === Node.TEXT_NODE) {
          if (c.textContent && c.textContent.length > 0) {
            const tr = document.createRange()
            tr.setStart(c, c.textContent.length)
            tr.collapse(true)
            const cr = tr.getBoundingClientRect()
            if (cr.height > 0) return { right: cr.left, top: cr.top, height: cr.height }
          }
        } else if (c instanceof HTMLElement) {
          const cr = c.getBoundingClientRect()
          if (cr.width > 0 || cr.height > 0) {
            return { right: cr.right, top: cr.top, height: cr.height }
          }
        }
      }
      return null
    }

    let top: number
    let left: number
    const rect = range.getBoundingClientRect()
    if (isEmpty) {
      const p = caretAtContentStart()
      top = p.top
      left = p.left
    } else if (rect.height > 0) {
      // Normal path: use the selection rect; the short caret is vertically centered in the line
      top = rect.top - wrapRect.top
      if (rect.height > CARET_HEIGHT) {
        top += (rect.height - CARET_HEIGHT) / 2
      }
      left = rect.left - wrapRect.left
    } else {
      // rect invalid (right next to an atom): use the right edge of the previous measurable element (the chip)
      const prev = measurePrev(range)
      if (prev) {
        top = prev.top - wrapRect.top + (prev.height - CARET_HEIGHT) / 2
        left = prev.right - wrapRect.left
      } else {
        const p = caretAtContentStart()
        top = p.top
        left = p.left
      }
    }
    caret.style.display = 'block'
    caret.style.top = `${Math.round(top)}px`
    caret.style.left = `${Math.round(left)}px`
  }, [getViewDom])
  updateCaretRef.current = updateCaret

  /** Restore plain text into the editor (line→hardBreak, same shape as navigateHistory's restore) */
  const restorePlainText = useCallback((ed: Editor, text: string): void => {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    const nodes: ProseMirrorNode[] = []
    lines.forEach((line, i) => {
      if (i > 0) nodes.push(ed.schema.nodes.hardBreak.create())
      if (line) nodes.push(ed.schema.text(line))
    })
    ed.commands.setContent(
      {
        type: 'doc',
        content: [{ type: 'paragraph', content: nodes.map((n) => n.toJSON()) }]
      },
      { emitUpdate: false }
    )
  }, [])

  // Sync the editor when the parent's inputValue changes (fix: previously only the "became empty →
  // clear editor" direction was handled, so restoring a non-empty cached draft left the editor
  // showing the previous topic's content or blank — a hidden draft that could even be sent blindly):
  // - becomes empty (after sending / on topic switch): clear the editor;
  // - becomes non-empty and differs from the editor content (restoring a cached draft): restore the
  //   editor content.
  useEffect(() => {
    const ed = editorRef.current
    if (!ed || ed.isDestroyed) return
    if (inputValue === '') {
      if (!ed.isEmpty) {
        // emitUpdate: false — clearing is driven by external state, so do not feed it back through onInputChange
        ed.commands.clearContent(false)
        ed.commands.focus()
        // Reset the history browse position when the input is cleared externally (send/new chat/topic switch)
        historyIndexRef.current = -1
      }
    } else if (getEditorText(ed) !== inputValue) {
      restorePlainText(ed, inputValue)
      historyIndexRef.current = -1
    }
    updateCaret()
  }, [inputValue, updateCaret, getEditorText, restorePlainText])

  /**
   * External focus request (plugin row + "new session"): put the caret in the input and **write no
   * content at all**.
   *
   * Why a separate effect: the sync effect above only mirrors "external value → editor" text and
   * never touches focus. This calls only `focus('end')` — on an empty editor that equals "focus and
   * place the caret at the start", so after clicking + the user can just start typing.
   */
  useEffect(() => {
    if (!focusInputToken) return
    const ed = editorRef.current
    if (!ed || ed.isDestroyed) return
    ed.commands.focus('end')
    historyIndexRef.current = -1
    updateCaret()
  }, [focusInputToken, updateCaret])

  // Update the caret position when the selection or window size changes
  useEffect(() => {
    const onSelectionChange = (): void => updateCaret()
    const onResize = (): void => updateCaret()
    document.addEventListener('selectionchange', onSelectionChange)
    window.addEventListener('resize', onResize)
    updateCaret()
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      window.removeEventListener('resize', onResize)
    }
  }, [updateCaret])

  // Update the caret position when the editor scrolls internally
  useEffect(() => {
    const ed = editor
    if (!ed) return
    const dom = getViewDom(ed)
    if (!dom) return
    dom.addEventListener('scroll', updateCaret)
    return () => dom.removeEventListener('scroll', updateCaret)
  }, [editor, updateCaret, getViewDom])

  // ── Insert a file-reference chip at the caret ──
  const insertFileRef = useCallback(
    (path: string) => {
      const ed = editorRef.current
      if (!ed) return
      ed.commands.focus()
      const cleanPath = path.replace(/\/+$/, '')
      const label = cleanPath.split('/').filter(Boolean).pop() || path
      const pos = ed.state.selection.from
      ed.commands.insertContent({ type: 'fileRef', attrs: { path, label } })
      // Explicitly place the caret after the chip (an inline atom has nodeSize 1)
      ed.commands.setTextSelection(pos + 1)
      // Refresh the custom caret: the chip is rendered asynchronously by a React NodeView, so
      // reading the rect immediately after insertion yields the placeholder width (0) and puts the
      // caret too far left; wait for rendering to finish (double rAF) before refreshing.
      updateCaret()
      requestAnimationFrame(() => {
        updateCaret()
        requestAnimationFrame(updateCaret)
      })
    },
    [updateCaret]
  )

  // ── Drag and drop handling ──
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      const path = e.dataTransfer.getData('text/plain')
      if (!path) return
      insertFileRef(path)
    },
    [insertFileRef]
  )

  // ── Clicking blank space in the input focuses it and moves the caret to the end (like a normal input) ──
  const handleContainerClick = useCallback(
    (e: React.MouseEvent) => {
      const ed = editorRef.current
      if (!ed) return
      const dom = getViewDom(ed)
      if (!dom) return
      if (dom.contains(e.target as Node)) return
      ed.commands.focus('end')
    },
    [getViewDom]
  )

  const hasContent = inputValue.trim().length > 0

  // Primary button semantics: generating and the input is empty → stop; otherwise (including text
  // typed while generating) → send. Text typed while generating joins the interjection queue above
  // the input and does not interrupt the current turn.
  const primaryStops = isLoading && !hasContent
  const onPrimary = primaryStops ? onStop : onSend
  const primaryHint = primaryStops
    ? t('harness.input.stopTooltip')
    : isLoading
      ? t('harness.input.queueTooltip')
      : ''
  /**
   * When the primary button is disabled: **only "send" requires content**.
   *
   * Stop does not depend on the input content — clearing the input while generating is exactly the
   * moment the user wants to stop. This used to be `disabled={!hasContent}`, so "generating + empty
   * input" disabled the stop button itself, making it a button that does nothing when clicked
   * (reported 2026-09-29: "while a conversation is running and the input is empty, it cannot be
   * paused"). The "generating with content" case is still send (into the interjection queue) and is
   * unaffected.
   */
  const primaryDisabled = locked || (!primaryStops && !hasContent)

  // Chip theme colors are injected into the FileRef NodeView via CSS variables
  const chipCssVars = useMemo(
    () =>
      ({
        '--file-chip-bg': isDarkMode ? '#1a2744' : '#eff6ff',
        '--file-chip-color': isDarkMode ? '#93c5fd' : '#1d4ed8',
        '--file-chip-border': isDarkMode ? '#1e3a5f' : '#bfdbfe'
      }) as React.CSSProperties,
    [isDarkMode]
  )

  // ── Model / reasoning effort panel ───────────────────────────────────────────────────────
  // The panel lives in the Popover layer (a portal, outside the input container), so theme
  // variables are written directly on the panel root node.
  const menuVars = {
    '--hmm-bg': token.colorBgElevated,
    '--hmm-border': token.colorBorderSecondary,
    '--hmm-text': token.colorText,
    '--hmm-secondary': token.colorTextSecondary,
    '--hmm-tertiary': token.colorTextTertiary,
    '--hmm-hover': token.colorFillTertiary,
    '--hmm-accent': token.colorPrimary
  } as React.CSSProperties

  const providerOptionIcon = (providerType: string, size: number): React.ReactNode => {
    const Icon = providerIconMap[providerType]
    // Only brand icons take the brand color; without an icon, fall back to ProviderMark's own custom-endpoint primary scale
    const color = getProviderColor(providerType, isDarkMode)
    return Icon ? (
      <Icon style={{ fontSize: size, color: color ?? '#888888' }} />
    ) : (
      <ProviderMark providerType={providerType} size={size} color={color} />
    )
  }

  /**
   * Panel header row (subpage: back + title).
   * **The whole row is the back hit area** (2026-09-27 request: do not make only the small arrow
   * clickable), so this is a full-width button and the arrow is just an icon inside it.
   */
  const menuHeader = (title: string, onBack: () => void): React.ReactNode => (
    <button
      type="button"
      className="hmm-head"
      onClick={onBack}
      aria-label={t('harness.input.back')}
    >
      <RiArrowLeftSLine size={16} className="hmm-back-icon" />
      <span className="hmm-title">{title}</span>
    </button>
  )

  /** One reasoning effort row (a level from the table; "default" is no longer an option — whenever levels exist, one is always in effect) */
  const effortItem = (value: string, label: string): React.ReactNode => {
    const active = effectiveEffort === value
    return (
      <button
        key={value}
        type="button"
        className={`hmm-item${active ? ' is-active' : ''}`}
        disabled={savingEffort}
        onClick={() => void selectEffort(value)}
      >
        <span className="hmm-item-label">{label}</span>
        {active ? <RiCheckLine size={14} className="hmm-item-check" /> : null}
      </button>
    )
  }

  const modelMenu = (
    <div className="harness-model-menu" style={menuVars} data-menu-view={menuView}>
      {menuView === 'root' && (
        <>
          <button type="button" className="hmm-row" onClick={openModelList}>
            <span className="hmm-row-label">{t('harness.input.modelLabel')}</span>
            <span className="hmm-row-value">
              {selectedOption?.label ?? t('harness.input.modelPlaceholder')}
            </span>
            <RiArrowRightSLine size={16} className="hmm-row-chev" />
          </button>
          {/* This row exists only when thinking levels do: with no level table the whole row is absent (not greyed out, no "—") */}
          {effortLevels.length > 0 ? (
            <button type="button" className="hmm-row" onClick={() => setMenuView('effort')}>
              <span className="hmm-row-label">{t('harness.input.effortLabel')}</span>
              <span className="hmm-row-value">
                {effectiveEffort ? reasoningEffortLabel(effectiveEffort) : ''}
              </span>
              <RiArrowRightSLine size={16} className="hmm-row-chev" />
            </button>
          ) : null}
          {/* Team collaboration opt-in: with a topic, read and write the topic's value; a blank
              session keeps a draft that is saved when the first message creates the topic. Both
              states look identical (no badge, no extra emphasis). */}
          {simpleMode ? null : (
            <div className="hmm-row hmm-row-switch">
              <span className="hmm-row-label">
                {t('harness.input.teamModeLabel')}
                <Tooltip title={t('harness.input.teamModeHint')}>
                  <RiInformationLine size={13} className="hmm-row-info" />
                </Tooltip>
              </span>
              <span className="hmm-row-control">
                <Switch
                  size="small"
                  checked={currentTopicId == null ? pendingTeamMode : teamModeEnabled}
                  loading={currentTopicId == null ? false : teamModeBusy}
                  disabled={currentTopicId == null ? false : teamModeBusy}
                  aria-label={t('harness.input.teamModeLabel')}
                  onChange={(checked) => {
                    // Blank session with no topic to write yet: only update the draft (no delay, no IPC)
                    if (currentTopicId == null) {
                      onPendingTeamModeChange?.(checked)
                      return
                    }
                    void handleToggleTeamMode(checked)
                  }}
                />
              </span>
            </div>
          )}
        </>
      )}

      {menuView === 'model' && (
        <>
          {menuHeader(t('harness.input.modelLabel'), () => setMenuView('root'))}
          <div className="hmm-search">
            <Input
              size="small"
              autoFocus
              allowClear
              value={modelQuery}
              onChange={(e) => {
                setModelQuery(e.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={handleModelListKeyDown}
              prefix={<RiSearchLine size={13} className="hmm-search-icon" />}
              placeholder={t('harness.input.modelSearchPlaceholder')}
            />
          </div>
          <div className="hmm-list">
            {filteredGroups.length === 0 ? (
              <div className="hmm-empty">{t('harness.input.modelEmpty')}</div>
            ) : (
              filteredGroups.map((group) => (
                <div key={group.label} className="hmm-group">
                  <div className="hmm-group-label">{group.label}</div>
                  {group.options.map((option) => {
                    const active = option.value === selectedProviderId
                    const focused = filteredOptions[activeIndex]?.value === option.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={`hmm-item${active ? ' is-active' : ''}${focused ? ' is-focused' : ''}`}
                        onClick={() => selectModel(option.value)}
                        onMouseEnter={() => setActiveIndex(filteredOptions.indexOf(option))}
                      >
                        {providerOptionIcon(option.providerType, 16)}
                        <span className="hmm-item-label">{option.label}</span>
                        {active ? <RiCheckLine size={14} className="hmm-item-check" /> : null}
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </>
      )}

      {menuView === 'effort' && (
        <>
          {menuHeader(t('harness.input.effortLabel'), () => setMenuView('root'))}
          <div className="hmm-list">
            {effortLevels.map((level) => effortItem(level, reasoningEffortLabel(level)))}
          </div>
          {selectedOption?.effortControllable ? null : (
            <div className="hmm-note">{t('harness.input.effortNotSentHint')}</div>
          )}
        </>
      )}
    </div>
  )

  const effortTriggerText = effectiveEffort ? reasoningEffortLabel(effectiveEffort) : ''

  /** Mode icon coloring: neutral → primary → warning; color carries only the "broader = riskier" signal */
  const permissionToneColor = (tone: 'neutral' | 'primary' | 'warning'): string =>
    tone === 'primary'
      ? token.colorPrimary
      : tone === 'warning'
        ? token.colorWarning
        : token.colorTextTertiary

  const activePermission =
    PERMISSION_OPTIONS.find((option) => option.mode === permissionMode) ?? PERMISSION_OPTIONS[1]
  const ActivePermissionIcon = activePermission.icon

  /** Permission mode panel: three items plus a one-line description of the current mode (no group title, no badges) */
  const permissionMenu = (
    <div className="harness-model-menu harness-permission-menu" style={menuVars}>
      <div className="hmm-list">
        {PERMISSION_OPTIONS.map((option) => {
          const active = option.mode === permissionMode
          const Icon = option.icon
          return (
            <button
              key={option.mode}
              type="button"
              className={`hmm-item${active ? ' is-active' : ''}`}
              disabled={savingPermission}
              onClick={() => selectPermissionMode(option.mode)}
            >
              <Icon size={16} style={{ color: permissionToneColor(option.tone), flexShrink: 0 }} />
              <span className="hmm-item-label">{t(option.labelKey)}</span>
              {active ? <RiCheckLine size={14} className="hmm-item-check" /> : null}
            </button>
          )
        })}
      </div>
      {activePermission.hintKey ? (
        <div className="hmm-note">{t(activePermission.hintKey)}</div>
      ) : null}
    </div>
  )

  /**
   * Multi-select panel for tools / skills: a search box on top and one row per item (a check on the
   * right means selected; picking does not close the panel so several can be picked in a row).
   *
   * Search filters the current panel only (both the display name and the real id match: a tool's
   * name may be an English identifier such as `read_file` while its label is localized, and either
   * input hits), and is cleared when the panel closes. The list can hold dozens of items, so finding
   * one without a search box is hard. Enter = toggle the first match (no need to move hands while
   * checking items with the keyboard).
   */
  const pickerMenu = (
    items: {
      key: string
      label: string
      active: boolean
      onToggle: () => void
      /** Trailing slot (the tools list uses it for the "system / plugin / MCP" source tag; the skills and MCP panels do not) */
      tag?: React.ReactNode
    }[],
    options: {
      empty: string
      placeholder: string
      query: string
      onQueryChange: (next: string) => void
      inputRef: React.RefObject<InputRef | null>
      onClose: () => void
    }
  ): React.ReactNode => {
    const keyword = options.query.trim().toLowerCase()
    const filtered = keyword
      ? items.filter(
          (item) =>
            item.label.toLowerCase().includes(keyword) || item.key.toLowerCase().includes(keyword)
        )
      : items
    return (
      <div className="harness-model-menu" style={{ ...menuVars, width: 260 }}>
        <div className="hmm-search">
          <Input
            ref={options.inputRef}
            size="small"
            allowClear
            value={options.query}
            onChange={(e) => options.onQueryChange(e.target.value)}
            prefix={<RiSearchLine size={13} className="hmm-search-icon" />}
            placeholder={options.placeholder}
            aria-label={options.placeholder}
            onKeyDown={(e) => {
              // Enter / Esc while choosing candidates in an IME belong to the IME, not to "toggle / clear"
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Escape') {
                e.stopPropagation()
                if (options.query) options.onQueryChange('')
                else options.onClose()
                return
              }
              if (e.key === 'Enter' && filtered.length > 0) {
                e.preventDefault()
                filtered[0].onToggle()
              }
            }}
          />
        </div>
        <div className="hmm-list" style={{ maxHeight: 300, overflowY: 'auto' }}>
          {items.length === 0 ? (
            <div className="hmm-empty">{options.empty}</div>
          ) : filtered.length === 0 ? (
            <div className="hmm-empty">{t('harness.input.pickerNoMatch')}</div>
          ) : (
            filtered.map((item) => (
              <button key={item.key} type="button" className="hmm-item" onClick={item.onToggle}>
                <span className="hmm-item-label">{item.label}</span>
                {item.tag}
                {item.active ? <RiCheckLine size={14} className="hmm-item-check" /> : null}
              </button>
            ))
          )}
        </div>
      </div>
    )
  }

  const toolMenu = pickerMenu(
    toolCatalog.map((tool) => ({
      key: tool.name,
      label: tool.label || tool.name,
      // Source tag after the name: system / plugin / MCP (2026-11-27 request: add a tag to tell system tools apart from plugin tools)
      tag: <ToolSourceTag source={tool.source} />,
      active: selectedTools.includes(tool.name),
      onToggle: () => toggleTool(tool.name)
    })),
    {
      empty: t('harness.input.toolsEmpty'),
      placeholder: t('harness.input.toolsSearchPlaceholder'),
      query: toolQuery,
      onQueryChange: setToolQuery,
      inputRef: toolSearchRef,
      onClose: () => setToolsOpen(false)
    }
  )

  const skillMenu = pickerMenu(
    skillCatalog.map((skill) => ({
      key: skill.id,
      label: skill.name,
      active: selectedSkills.includes(skill.id),
      onToggle: () => toggleSkill(skill.id)
    })),
    {
      empty: t('harness.input.skillsEmpty'),
      placeholder: t('harness.input.skillsSearchPlaceholder'),
      query: skillQuery,
      onQueryChange: setSkillQuery,
      inputRef: skillSearchRef,
      onClose: () => setSkillsOpen(false)
    }
  )

  const mcpMenu = pickerMenu(
    mcpCatalog.map((server) => ({
      key: server.value,
      label: server.label,
      active: selectedMcp.includes(server.value),
      onToggle: () => toggleMcp(server.value)
    })),
    {
      empty: t('harness.input.mcpEmpty'),
      placeholder: t('harness.input.mcpSearchPlaceholder'),
      query: mcpQuery,
      onQueryChange: setMcpQuery,
      inputRef: mcpSearchRef,
      onClose: () => setMcpOpen(false)
    }
  )

  /** Selectors below the input card: permission / tools / skills */
  /** Permission mode stays inside the input card (it should not go into the bottom row) */
  const permissionSelector = (
    <>
      {/* Permission mode: how far the model may act (sandbox blocking and approval dialogs are
              decided by it). Placed before the model picker: decide the scope of action first, then
              the model. */}
      <Popover
        open={permissionOpen}
        onOpenChange={setPermissionOpen}
        trigger="click"
        placement="topLeft"
        arrow={false}
        content={permissionMenu}
        styles={{
          container: { padding: 0 },
          content: { padding: 0, background: 'transparent', boxShadow: 'none' }
        }}
      >
        <button
          type="button"
          className="harness-permission-trigger"
          aria-label={t('harness.input.permissionAria')}
          aria-expanded={permissionOpen}
          disabled={savingPermission}
        >
          <ActivePermissionIcon
            size={14}
            style={{ color: permissionToneColor(activePermission.tone) }}
          />
          <span className="harness-permission-trigger-name">{t(activePermission.labelKey)}</span>
          {permissionOpen ? (
            <RiArrowUpSLine size={14} className="harness-permission-trigger-chev" />
          ) : (
            <RiArrowDownSLine size={14} className="harness-permission-trigger-chev" />
          )}
        </button>
      </Popover>
    </>
  )

  /** Selectors below the input card: tools / skills */
  const inputSelectors = (
    <>
      {/* Tools / skills: main-agent defaults (moved here after leaving settings; a pick takes effect next turn) */}
      <Popover
        open={toolsOpen}
        onOpenChange={(open) => {
          setToolsOpen(open)
          // Clear the search term on close: the next open shows the full list
          if (!open) setToolQuery('')
        }}
        trigger="click"
        placement="topLeft"
        arrow={false}
        content={toolMenu}
        styles={{
          container: { padding: 0 },
          content: { padding: 0, background: 'transparent', boxShadow: 'none' }
        }}
      >
        <button
          type="button"
          className="harness-permission-trigger"
          aria-label={t('harness.input.toolsAria')}
          aria-expanded={toolsOpen}
        >
          <RiToolsLine size={14} style={{ color: token.colorTextTertiary }} />
          <span className="harness-permission-trigger-name">{t('harness.input.toolsLabel')}</span>
          <span style={{ fontSize: 11, color: token.colorTextTertiary }}>
            {selectedTools.length}
          </span>
          {toolsOpen ? (
            <RiArrowUpSLine size={14} className="harness-permission-trigger-chev" />
          ) : (
            <RiArrowDownSLine size={14} className="harness-permission-trigger-chev" />
          )}
        </button>
      </Popover>
      <Popover
        open={skillsOpen}
        onOpenChange={(open) => {
          setSkillsOpen(open)
          if (!open) setSkillQuery('')
        }}
        trigger="click"
        placement="topLeft"
        arrow={false}
        content={skillMenu}
        styles={{
          container: { padding: 0 },
          content: { padding: 0, background: 'transparent', boxShadow: 'none' }
        }}
      >
        <button
          type="button"
          className="harness-permission-trigger"
          aria-label={t('harness.input.skillsAria')}
          aria-expanded={skillsOpen}
        >
          <RiFileAi2Line size={14} style={{ color: token.colorTextTertiary }} />
          <span className="harness-permission-trigger-name">{t('harness.input.skillsLabel')}</span>
          <span style={{ fontSize: 11, color: token.colorTextTertiary }}>
            {visibleSelectedSkills}
          </span>
          {skillsOpen ? (
            <RiArrowUpSLine size={14} className="harness-permission-trigger-chev" />
          ) : (
            <RiArrowDownSLine size={14} className="harness-permission-trigger-chev" />
          )}
        </button>
      </Popover>
      <Popover
        open={mcpOpen}
        onOpenChange={(open) => {
          setMcpOpen(open)
          if (!open) setMcpQuery('')
        }}
        trigger="click"
        placement="topLeft"
        arrow={false}
        content={mcpMenu}
        styles={{
          container: { padding: 0 },
          content: { padding: 0, background: 'transparent', boxShadow: 'none' }
        }}
      >
        <button
          type="button"
          className="harness-permission-trigger"
          aria-label={t('harness.input.mcpAria')}
          aria-expanded={mcpOpen}
        >
          <RiPlug2Line size={14} style={{ color: token.colorTextTertiary }} />
          <span className="harness-permission-trigger-name">{t('harness.input.mcpLabel')}</span>
          <span style={{ fontSize: 11, color: token.colorTextTertiary }}>
            {visibleSelectedMcp}
          </span>
          {mcpOpen ? (
            <RiArrowUpSLine size={14} className="harness-permission-trigger-chev" />
          ) : (
            <RiArrowDownSLine size={14} className="harness-permission-trigger-chev" />
          )}
        </button>
      </Popover>
    </>
  )

  return (
    <div
      ref={composerRef}
      /* Outer backing: wraps the input card and the selector row below into one block (the card
      floats on a slightly lighter background) */
      style={{
        ...menuVars,
        position: 'relative',
        background: colorBgLayout,
        borderRadius: 20,
        padding: 6,
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.06)'
      }}
    >
      {/* `/` command palette: pops up flush with the top edge of the input card (left/right aligned
          with it). Only appears when `/` is typed at the start of the input; closes on Esc or an
          outside click. */}
      {!simpleMode && slashOpen ? (
        <div
          style={{
            position: 'absolute',
            left: 6,
            right: 6,
            bottom: '100%',
            zIndex: 60
          }}
        >
          <HarnessSlashMenu
            query={slashQuery}
            activeIndex={slashIndex}
            onActiveIndexChange={setSlashIndex}
            onPick={pickSlashCommand}
            menuRef={slashMenuRef}
          />
        </div>
      ) : null}
      {/* Assistant mascot: sits at the top-right of the input only in a blank session; hidden once
          there is conversation content so it does not cover messages / reasoning (decoration only,
          does not intercept the mouse). */}
      {showMascot && (
        <img
          src={mascot}
          alt=""
          aria-hidden
          draggable={false}
          style={{
            position: 'absolute',
            right: 22,
            top: -67,
            height: 96,
            width: 'auto',
            zIndex: 1,
            pointerEvents: 'none',
            userSelect: 'none',
            filter: 'drop-shadow(0 8px 16px rgba(0, 0, 0, 0.28))'
          }}
        />
      )}
      <div
        className="rounded-2xl input-scrollbar"
        style={{
          position: 'relative',
          background: token.colorBgContainer,
          border: `1px solid ${isDragOver ? '#4d6bfe' : goalCompose ? token.colorPrimaryBorder : colorBorder}`,
          boxShadow: goalCompose
            ? `0 0 0 3px ${token.colorPrimaryBg}, 0 0 28px ${token.colorPrimaryBg}`
            : undefined,
          transition: 'border-color 0.2s, box-shadow 0.2s',
          ...chipCssVars,
          // The trigger is inside the container and the panel is in a portal; both share the same --hmm-* theme variables
          ...menuVars
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* overflow hidden: clips the caret when it scrolls outside the visible editor area */}
        <div
          className={`p-4 relative overflow-hidden${goalCompose ? ' is-goal-compose' : ''}`}
          onClick={handleContainerClick}
          ref={textareaRef}
          style={{ paddingRight: goalCompose ? 132 : undefined }}
        >
          <EditorContent editor={editor} className="harness-input-editor" />
          {goalCompose && !inputValue ? (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 16,
                top: 16,
                zIndex: 1,
                pointerEvents: 'none',
                fontSize: 13.5,
                lineHeight: '19px',
                color: token.colorTextTertiary
              }}
            >
              {t('harness.goalInline.composePlaceholder')}
            </span>
          ) : null}
          {/* Custom caret: fixed height, moves with the caret position, blinking animation */}
          <span
            ref={caretRef}
            className="harness-input-caret"
            style={{
              position: 'absolute',
              width: 2,
              height: CARET_HEIGHT,
              borderRadius: 1,
              background: colorText,
              pointerEvents: 'none',
              display: 'none',
              zIndex: 1
            }}
          />
          <style>{`
          .harness-input-editor .ProseMirror {
            outline: none;
            white-space: pre-wrap;
            word-break: break-word;
            min-height: 24px;
            max-height: 200px;
            overflow-y: auto;
            font-size: 14px;
            line-height: 19px;
            caret-color: transparent;
          }
          .harness-input-editor .ProseMirror p { margin: 0; }
          .is-goal-compose .harness-input-editor .ProseMirror p.is-editor-empty:first-child::before { content: none; }
          .harness-input-editor .ProseMirror p.is-editor-empty:first-child::before {
            content: attr(data-placeholder);
            color: #bfbfbf;
            pointer-events: none;
            float: left;
            height: 0;
          }
          .harness-input-editor .ProseMirror::-webkit-scrollbar { width: 4px; }
          .harness-input-editor .ProseMirror::-webkit-scrollbar-track { background: transparent; }
          .harness-input-editor .ProseMirror::-webkit-scrollbar-thumb {
            background: rgba(128, 128, 128, 0.4);
            border-radius: 2px;
          }
          .file-ref-chip {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            font-size: 13px;
            line-height: 1;
            padding: 2px 4px;
            border-radius: 3px;
            vertical-align: -1px;
            margin: 0 1px;
            white-space: nowrap;
            cursor: default;
            user-select: none;
            background: var(--file-chip-bg);
            color: var(--file-chip-color);
            border: 1px solid var(--file-chip-border);
          }
          .file-ref-chip .file-ref-icon {
            display: inline-flex;
            align-items: center;
            flex-shrink: 0;
            line-height: 0;
          }
          .file-ref-chip .file-ref-label {
            max-width: 160px;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .file-ref-chip .file-ref-close {
            display: inline-flex;
            align-items: center;
            cursor: pointer;
            margin-left: 1px;
            line-height: 0;
            opacity: 0.7;
          }
          .file-ref-chip.ProseMirror-selectednode {
            box-shadow: 0 0 0 1px var(--file-chip-border);
          }
          .harness-input-caret {
            animation: harness-input-caret-blink 1.06s steps(1) infinite;
          }
          /* ── Model / reasoning effort: collapsed single-row trigger ── */
          .harness-model-trigger {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
            max-width: 100%;
            height: 26px;
            padding: 0 8px;
            border: 1px solid transparent;
            border-radius: 8px;
            background: transparent;
            color: var(--hmm-text);
            font-size: 13px;
            line-height: 1;
            cursor: pointer;
            transition: background 0.15s, border-color 0.15s;
          }
          .harness-model-trigger:hover { background: var(--hmm-hover); }
          .harness-model-trigger[aria-expanded='true'] {
            background: var(--hmm-hover);
            border-color: var(--hmm-border);
          }
          /* After the 13px line box is centered by font ascent/descent, the glyphs still sit about
             1px lower than the icons / badges (Segoe UI's ascent is noticeably larger than its
             descent, and the CJK fallback glyphs follow it down). Adding 1px of bottom padding moves
             the whole block up 0.5px when flex-centered: no glyph scaling, no re-render blur, and at
             125% scaling it exactly cancels the one device pixel the user sees. */
          .harness-model-trigger-name,
          .harness-permission-trigger-name,
          .harness-model-trigger-effort {
            padding-bottom: 1px;
          }
          .harness-model-trigger-name {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .harness-model-trigger-effort { color: var(--hmm-tertiary); }
          .harness-model-trigger-chev { color: var(--hmm-tertiary); flex-shrink: 0; }

          /* ── Permission mode (sandbox): same shape as the model trigger; collapsed it shows only the current mode ── */
          .harness-permission-trigger {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
            max-width: 100%;
            height: 26px;
            padding: 0 8px;
            border: 1px solid transparent;
            border-radius: 8px;
            background: transparent;
            color: var(--hmm-text);
            font-size: 13px;
            line-height: 1;
            cursor: pointer;
            transition: background 0.15s, border-color 0.15s;
          }
          .harness-permission-trigger:hover { background: var(--hmm-hover); }
          .harness-permission-trigger[aria-expanded='true'] {
            background: var(--hmm-hover);
            border-color: var(--hmm-border);
          }
          .harness-permission-trigger:disabled { cursor: default; opacity: 0.6; }
          .harness-permission-trigger-name {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .harness-permission-trigger-chev { color: var(--hmm-tertiary); flex-shrink: 0; }
          .harness-permission-menu .hmm-list { max-height: none; }

          /* ── Model / reasoning effort: expanded panel ── */
          .harness-model-menu {
            min-width: 260px;
            padding: 6px;
            border: 1px solid var(--hmm-border);
            border-radius: 14px;
            background: var(--hmm-bg);
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
            font-size: 13px;
          }
          /* The permission panel does not follow the model panel's 260px: all three labels are
             short, so it is fixed at 160px, and the description wraps inside the panel (width does
             not jump with the mode) */
          .harness-model-menu.harness-permission-menu {
            width: 160px;
            min-width: 160px;
          }
          .harness-model-menu .hmm-row {
            display: flex;
            align-items: center;
            gap: 16px;
            width: 100%;
            height: 38px;
            padding: 0 12px;
            border: 0;
            border-radius: 10px;
            background: transparent;
            font-size: 13px;
            text-align: left;
            cursor: pointer;
          }
          .harness-model-menu .hmm-row:hover { background: var(--hmm-hover); }
          /* The team switch row is a config item, not a clickable entry: no hover highlight; the switch handles interaction itself */
          .harness-model-menu .hmm-row.hmm-row-switch { cursor: default; }
          .harness-model-menu .hmm-row.hmm-row-switch:hover { background: transparent; }
          .harness-model-menu .hmm-row-switch .hmm-row-label {
            display: inline-flex;
            align-items: center;
            gap: 5px;
          }
          .harness-model-menu .hmm-row-info { color: var(--hmm-tertiary); }
          .harness-model-menu .hmm-row-control {
            margin-left: auto;
            display: inline-flex;
            align-items: center;
          }
          .harness-model-menu .hmm-row.is-disabled { cursor: default; }
          .harness-model-menu .hmm-row.is-disabled:hover { background: transparent; }
          .harness-model-menu .hmm-row-label { color: var(--hmm-text); }
          .harness-model-menu .hmm-row-value {
            margin-left: auto;
            max-width: 156px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            /* The value is one step dimmer than the label: hierarchy in one row is shown by lightness */
            color: var(--hmm-tertiary);
          }
          .harness-model-menu .hmm-row-chev { flex-shrink: 0; color: var(--hmm-tertiary); }
          .harness-model-menu .hmm-head {
            display: flex;
            align-items: center;
            gap: 4px;
            width: 100%;
            height: 30px;
            /* Leave 3px above the list below (requested; the list's first item has a rounded highlight that would merge if too close) */
            margin: 0 0 3px;
            padding: 0 8px 0 4px;
            border: 0;
            border-radius: 8px;
            background: transparent;
            text-align: left;
            cursor: pointer;
            /* The whole row is clickable to go back: hover tints the whole row instead of only the small arrow */
          }
          .harness-model-menu .hmm-head:hover { background: var(--hmm-hover); }
          .harness-model-menu .hmm-back-icon { flex-shrink: 0; color: var(--hmm-secondary); }
          .harness-model-menu .hmm-title { font-size: 12px; color: var(--hmm-tertiary); }
          .harness-model-menu .hmm-search { padding: 0 4px 6px; }
          .harness-model-menu .hmm-search-icon { color: var(--hmm-tertiary); }
          .harness-model-menu .hmm-list {
            max-height: 264px;
            overflow-y: auto;
            overscroll-behavior: contain;
          }
          .harness-model-menu .hmm-list::-webkit-scrollbar { width: 4px; }
          .harness-model-menu .hmm-list::-webkit-scrollbar-track { background: transparent; }
          .harness-model-menu .hmm-list::-webkit-scrollbar-thumb {
            background: rgba(128, 128, 128, 0.4);
            border-radius: 2px;
          }
          .harness-model-menu .hmm-group-label {
            padding: 6px 10px 2px;
            font-size: 11px;
            color: var(--hmm-tertiary);
          }
          .harness-model-menu .hmm-item {
            display: flex;
            align-items: center;
            gap: 8px;
            width: 100%;
            height: 30px;
            padding: 0 8px;
            border: 0;
            border-radius: 8px;
            background: transparent;
            color: var(--hmm-text);
            font-size: 13px;
            text-align: left;
            cursor: pointer;
          }
          .harness-model-menu .hmm-item:hover,
          .harness-model-menu .hmm-item.is-focused { background: var(--hmm-hover); }
          .harness-model-menu .hmm-item.is-active { color: var(--hmm-accent); }
          .harness-model-menu .hmm-item-label {
            /* A source tag follows the name, so do not claim the remaining width; leave the rest for the trailing check */
            flex: 0 1 auto;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .harness-model-menu .hmm-item-check {
            flex-shrink: 0;
            /* The trailing check hugs the right: name + tag form one left-aligned group (2026-11-27 request: put the tag after the name) */
            margin-left: auto;
            color: var(--hmm-accent);
          }
          .harness-model-menu .hmm-empty,
          .harness-model-menu .hmm-note {
            padding: 8px 10px;
            font-size: 12px;
            line-height: 1.5;
            color: var(--hmm-tertiary);
          }
          @keyframes harness-input-caret-blink {
            0%, 45% { opacity: 1; }
            50%, 95% { opacity: 0; }
          }
        `}</style>
        </div>
        {attachments.length > 0 && (
          <div className="flex gap-2 px-4 pb-3 flex-wrap">
            {attachments.map((att, idx) =>
              att.isImage ? (
                <div key={idx} className="relative group">
                  <img
                    src={att.dataUrl}
                    alt={`upload-${idx}`}
                    className="w-16 h-16 object-cover rounded-lg"
                    style={{ border: `1px solid ${colorBorderSecondary}` }}
                  />
                  <button
                    onClick={() => onAttachmentsChange(attachments.filter((_, i) => i !== idx))}
                    className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <RiCloseLine size={12} />
                  </button>
                </div>
              ) : (
                <div
                  key={idx}
                  className="relative group flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg"
                  style={{
                    background: isDarkMode ? '#1a2744' : '#eff6ff',
                    color: isDarkMode ? '#93c5fd' : '#1d4ed8',
                    border: isDarkMode ? '1px solid #1e3a5f' : '1px solid #bfdbfe'
                  }}
                >
                  <span className="max-w-[120px] truncate">{att.fileName}</span>
                  <button
                    onClick={() => onAttachmentsChange(attachments.filter((_, i) => i !== idx))}
                    className="ml-1 hover:text-red-500"
                    style={{ color: isDarkMode ? '#60a5fa' : '#60a5fa' }}
                  >
                    <RiCloseLine size={14} />
                  </button>
                </div>
              )
            )}
          </div>
        )}
        {goalCompose ? (
          <div
            className="flex items-center justify-between gap-2 px-4 pb-2"
            style={{ color: token.colorTextTertiary, fontSize: 10 }}
          >
            <span>{t('harness.goalInline.composeHint')}</span>
            {/*
             * Goal max rounds (chosen 2026-11-27): a rounds limit for goals was promised, but until
             * now only the backend and i18n entries existed, with no input control. Goal compose
             * mode now offers a number field; empty = default 256. Clicks are stopped from bubbling
             * so clicking the field does not pull focus back to the editor.
             */}
            <span
              className="flex items-center gap-1.5"
              onClick={(event) => event.stopPropagation()}
              style={{ fontSize: 11 }}
            >
              <span>{t('harness.goalInline.roundsLimit')}</span>
              <InputNumber
                size="small"
                min={1}
                max={9999}
                style={{ width: 82 }}
                value={goalRoundsLimit ?? undefined}
                placeholder={t('harness.goalInline.roundsLimitDefault')}
                onChange={(value) =>
                  onGoalRoundsLimitChange?.(typeof value === 'number' ? value : null)
                }
              />
            </span>
          </div>
        ) : null}
        <div className="flex items-center justify-between px-4 pb-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {simpleMode ? null : (
              <Tooltip title={t('harness.input.attachTooltip')}>
                <Button
                  type="dashed"
                  shape="circle"
                  icon={<RiAttachment2 size={16} />}
                  onClick={async () => {
                    const result = await window.api.file.selectImageFile(modelSupportsVision)
                    if (result) {
                      onAttachmentsChange([
                        ...attachments,
                        {
                          dataUrl: result.dataUrl,
                          fileName: result.fileName,
                          isImage: result.isImage
                        }
                      ])
                    }
                  }}
                />
              </Tooltip>
            )}
            {simpleMode ? null : permissionSelector}
            {/* Model picker: collapsed it is one row (model name + reasoning effort); expanded it is
              the two entry rows "model / reasoning effort". The effort is written into the model's
              own config column, and the next request translates it per protocol family into
              provider fields. */}
            {simpleMode ? null : (
              <Popover
                open={menuOpen}
                onOpenChange={handleMenuOpenChange}
                trigger="click"
                placement="topLeft"
                arrow={false}
                content={modelMenu}
                styles={{
                  container: { padding: 0 },
                  content: { padding: 0, background: 'transparent', boxShadow: 'none' }
                }}
              >
                <button
                  type="button"
                  className="harness-model-trigger"
                  aria-label={t('harness.input.modelMenuAria')}
                  aria-expanded={menuOpen}
                >
                  {SelectedIcon ? (
                    <SelectedIcon style={{ fontSize: 14, color: selectedColor }} />
                  ) : selectedProviderType ? (
                    <ProviderMark
                      providerType={selectedProviderType}
                      size={16}
                      color={selectedColor}
                    />
                  ) : null}
                  <span className="harness-model-trigger-name">
                    {selectedOption?.label ?? t('harness.input.modelPlaceholder')}
                  </span>
                  {effortTriggerText ? (
                    <span className="harness-model-trigger-effort">{effortTriggerText}</span>
                  ) : null}
                  {menuOpen ? (
                    <RiArrowUpSLine size={14} className="harness-model-trigger-chev" />
                  ) : (
                    <RiArrowDownSLine size={14} className="harness-model-trigger-chev" />
                  )}
                </button>
              </Popover>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* There is a single primary button whose semantics follow the state: generating with an
              empty input → "stop"; generating with text already typed → "send" (that message joins
              the interjection queue). This way the user can keep sending while generating without
              losing the ability to stop at any moment. The stop case must not be disabled (see
              primaryDisabled): clearing the input while generating is exactly a request to stop. */}
            <Tooltip title={primaryHint}>
              <Button
                type="primary"
                danger={primaryStops}
                shape="circle"
                icon={primaryStops ? <RiStopFill size={16} /> : <RiArrowUpLine size={16} />}
                onClick={onPrimary}
                disabled={primaryDisabled}
              />
            </Tooltip>
          </div>
        </div>

        {/* Full access: the mode itself has no interception, so switching requires an explicit risk confirmation first */}
        <Modal
          open={confirmFullAccess}
          title={t('harness.permission.confirmTitle')}
          okText={t('harness.permission.confirmOk')}
          cancelText={t('harness.permission.confirmCancel')}
          okButtonProps={{ danger: true, loading: savingPermission }}
          onOk={() => {
            setConfirmFullAccess(false)
            void applyPermissionMode('danger-full-access')
          }}
          onCancel={() => setConfirmFullAccess(false)}
          width={440}
        >
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>{t('harness.permission.confirmBody')}</div>
        </Modal>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          padding: '6px 6px 2px'
        }}
      >
        {simpleMode ? null : (
          <>
            {inputSelectors}
            {/* Session usage meter: right-aligned (same row as tools / skills, with symmetrical
            padding). All data comes from harness_dialogue_usage; unavailable items are not drawn. */}
            <HarnessUsageMeter
              topicId={currentTopicId}
              contextWindow={modelContextWindow}
              streaming={isLoading}
            />
          </>
        )}
      </div>
    </div>
  )
}

export default HarnessInput
