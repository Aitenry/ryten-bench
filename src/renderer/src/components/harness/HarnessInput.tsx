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
import { mcpNamespace, mcpServerGroupValue } from '../../../../shared/harness/mcp'

// TipTap 默认不加载标准键位绑定（退格/删除/回车等），必须显式加载 prosemirror-commands 的 baseKeymap
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

// 自定义光标高度（px）：ProseMirror 的原生光标高度跟随行高（19px），
// 与普通输入框（≈字号高度）不一致，故隐藏原生光标、绘制固定高度光标。
// 与正文/占位符字号一致（14px），保证空内容时与提示文字同高同位。
// 如需微调高度改这里即可。
const CARET_HEIGHT = 14

/**
 * 「/」命令面的查询词上限（字符）。
 *
 * 超过就当普通文本：用户可能真的想发一条以 `/` 开头的长消息（路径、命令示例），
 * 菜单不能一直压在输入框上方。
 */
const SLASH_QUERY_MAX_CHARS = 32

/**
 * 从输入文本解析命令查询词。
 *
 * 用户口径（2026-11-26）：**只有在一开始输入 `/` 才会唤起**命令面。
 * 因此只认「文本以 `/` 开头」这一种形态；`/` 出现在句中/行中一律按普通文字处理。
 * 查询词（`/` 之后的部分）含空白即视为用户开始写正文，菜单收起；
 * 未通过校验返回 null。
 */
function parseSlashQuery(text: string): string | null {
  if (!text.startsWith('/')) return null
  const rest = text.slice(1)
  if (rest.length > SLASH_QUERY_MAX_CHARS) return null
  if (/[\s\u3000]/.test(rest)) return null
  return rest
}

/**
 * 权限档位（沙箱）选项表 —— 与主进程 runtime/permission.ts 的档位一一对应。
 *
 * 只有三个内置档位、且与 DSH 的预设同名同义（仅可查看 / 工作区内修改 / 完全权限）：
 * 图标沿用盾牌家族，颜色只在「更宽 = 更危险」这一条信息上变化（中性 → 主色 → 警示）。
 */
const PERMISSION_OPTIONS: {
  mode: PermissionMode
  labelKey:
    | 'harness.permission.readOnly'
    | 'harness.permission.workspaceWrite'
    | 'harness.permission.fullAccess'
  /** 面板底部的一句话说明（不给 = 该档位不显示说明行） */
  hintKey?: 'harness.permission.readOnlyHint' | 'harness.permission.fullAccessHint'
  icon: React.ComponentType<{ size?: number | string; style?: React.CSSProperties }>
  /** 颜色令牌名（在组件里按主题 token 取色） */
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

// 读取粘贴 File 内容为 dataUrl（图片附件走此路径）
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
   * 「外部请求把焦点放进输入框」的计数器（插件行的 ＋ → `harness-focus-input`）。
   * 变化时聚焦编辑器并**不改内容**——用户点完「新建会话」直接就能打字
   * （内容一律由用户自己写：用户口径 2026-09-28「不要显示：给插件「…」这个玩意」）。
   */
  focusInputToken?: number
  textareaRef: React.RefObject<HTMLDivElement | null>
  /** 全局输入历史（↑/↓ 键切换浏览，handleSend 记录，localStorage 持久化） */
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
      /** 当前模型的推理等级（null = 未设置） */
      reasoningEffort: string | null
      /** 该模型档案声明的可选档位（空数组 = 档案未收录） */
      effortLevels: string[]
      /** 当前协议是否真的会下发档位参数（未适配时面板里提示「仅记录」） */
      effortControllable: boolean
    }[]
  }[]
  modelSupportsTools: boolean
  modelSupportsVision: boolean
  /**
   * 当前话题 id（权限档位按话题存）：
   * null = 还没有会话（新对话第一轮），此时切换档位等同于改「新会话默认值」。
   */
  currentTopicId: number | null
  /**
   * 是否显示输入框右上角的助手形象（mascot）。
   *
   * 只在空白会话（欢迎页）里显示：那条形象是绝对定位、向上探出输入卡片的，
   * 有对话内容时会压在消息 / 思考过程上（用户 2026-11-23 报的问题），
   * 所以由页面按 `messages.length === 0` 传进来。
   */
  showMascot?: boolean
  /**
   * 当前模型的上下文窗口（供应商档案 metadata.context_window）。
   * 底栏右侧的上下文圆环按它算百分比；null = 档案没填，圆环不画（不猜窗口大小）。
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
   * 子代理会话的输入框：复用同一个组件，但隐藏主代理专属控件
   * （附件 / 权限档位 / 模型选择 / 工具技能 / 用量条）——这些只作用于主代理轮次。
   */
  simpleMode?: boolean
  /** 自定义 placeholder（子代理续聊用；缺省用主对话文案） */
  placeholder?: string
  /** 目标输入态：输入卡片高亮并显示模式标签（内容仍由当前编辑器承载） */
  goalCompose?: boolean
  /** 目标轮次上限（null = 用后端默认 256；只在目标输入态可改） */
  goalRoundsLimit?: number | null
  onGoalRoundsLimitChange?: (rounds: number | null) => void
  /** 计划评审挂起时锁住输入框（不发送、不可编辑） */
  locked?: boolean
  /** 斜杠命令「目标」：由页面打开输入框上方的目标编辑区 */
  onGoalCommand?: () => void
  /** 斜杠命令「计划」：由页面切换输入框上方的计划模式 */
  onPlanCommand?: () => void
  /**
   * 会话级运行选择（工具 / 技能 / MCP）：页面持有，发送时随 agentConfig 下发。
   * 变化时通过 onAgentSelectionChange 回传，已存在会话由输入框直接落库。
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
  // 自定义光标元素（原生光标已隐藏，见 updateCaret）
  const caretRef = useRef<HTMLSpanElement | null>(null)
  const { message } = App.useApp()
  const { t } = useTranslation()
  const { token } = theme.useToken()

  // ── 模型 / 推理等级面板（输入框左下角的模型选择）──────────────────────────
  // 展开面板是一层「模型 / 推理等级」两行入口，点进去才是列表：
  // 两行都带当前值，收起时点一下就能同时看到「当前用的是哪个模型、多深的思考」。
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuView, setMenuView] = useState<'root' | 'model' | 'effort'>('root')
  const [modelQuery, setModelQuery] = useState('')
  /** 模型列表的键盘高亮下标（搜索结果扁平化后的下标） */
  const [activeIndex, setActiveIndex] = useState(0)
  const [savingEffort, setSavingEffort] = useState(false)

  // ── Agent Teams 团队协作（opt-in，按话题持久化）────────────────────────────
  // 入口放在「模型 / 推理等级」面板里（用户口径：团队协作开关属于本轮运行配置，
  // 不再散落在侧栏会话菜单）；关闭时不注入 team_task_* 工具与团队提示词段。
  const [teamModeEnabled, setTeamModeEnabled] = useState(false)
  const [teamModeBusy, setTeamModeBusy] = useState(false)

  useEffect(() => {
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
        /* 读取失败按关闭展示；下一轮 Runtime 仍按后端状态执行 */
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

  // ── 权限档位（沙箱）：仅可查看 / 工作区内修改 / 完全权限 ──────────────────
  // 档位按话题存在主进程（electron-store），这里只缓存一份用于显示；
  // 切到「完全权限」要先过一次风险确认（DSH 同款），其余档位即点即生效。
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const [savingPermission, setSavingPermission] = useState(false)

  // ── 工具 / 技能：主智能体默认配置（设置页移除后放到输入框下方）──────────────
  const [toolsOpen, setToolsOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [toolCatalog, setToolCatalog] = useState<HarnessToolInfo[]>([])
  const [skillCatalog, setSkillCatalog] = useState<
    { id: string; name: string; description: string }[]
  >([])
  const [selectedTools, setSelectedTools] = useState<string[]>([])
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [selectedMcp, setSelectedMcp] = useState<string[]>([])
  /** 可选 MCP 服务器（选择项存服务器分组 mcp@<命名空间>，主进程挂载时展开） */
  const [mcpCatalog, setMcpCatalog] = useState<{ value: string; label: string }[]>([])
  /**
   * 幽灵选中：技能 / MCP 目录里被删掉或改名的旧选择仍留在会话选择里。
   * 徽标只统计「目录里还存在」的项，否则会出现「技能 1」但面板里没有任何勾选行、
   * 也无法取消的情况。选择本身保留——目录恢复同名项时会重新生效（运行时同样按目录过滤）。
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
  /** 工具 / 技能面板里的搜索词（只在面板内过滤，关掉清空；不进设置） */
  const [toolQuery, setToolQuery] = useState('')
  const [skillQuery, setSkillQuery] = useState('')
  /** 面板每次打开都把光标放进搜索框（Popover 的内容挂着不卸载，autoFocus 只有第一次有效） */
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
  /** 选择变化回传页面（发送时随 agentConfig 下发） */
  const emitSelection = useCallback(
    (selection: AgentSelectionView): void => {
      onAgentSelectionChange(selection)
    },
    [onAgentSelectionChange]
  )
  const currentTopicIdRef = useRef(currentTopicId)
  currentTopicIdRef.current = currentTopicId

  // 切话题：拉一次该话题的档位（新话题没有记录 → 主进程回落到「新会话默认值」）
  useEffect(() => {
    let cancelled = false
    void harnessApi.harness
      .getPermission(currentTopicId)
      .then((state) => {
        if (!cancelled) setPermissionMode(state.mode)
      })
      .catch(() => {
        // 插件停用 / 通道不可用时静默：输入框其余功能不受影响
      })
    return () => {
      cancelled = true
    }
  }, [currentTopicId])

  // 工具 / 技能 / MCP 目录 + 当前会话的选择（切会话时重新读）。
  // 默认语义：工具跟随主智能体默认；技能与 MCP 默认一个都不启用（用户口径 2026-11-27）。
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
        setMcpCatalog(
          servers.map((server) => ({
            value: mcpServerGroupValue(mcpNamespace(server.config.name)),
            label: server.config.name
          }))
        )
        setSelectedTools(topicSelection?.tools ?? main.tools ?? [])
        setSelectedSkills(topicSelection?.skills ?? [])
        setSelectedMcp(topicSelection?.mcpTools ?? [])
        emitSelection({
          tools: topicSelection?.tools ?? null,
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

  // 档位变更广播（设置页改默认值、另一窗口切换）→ 同步当前显示
  useEffect(() => {
    try {
      return harnessApi.harness.onPermissionUpdated((state) => {
        if (state.topicId === (currentTopicIdRef.current ?? 0)) setPermissionMode(state.mode)
      })
    } catch (err) {
      // 订阅失败（插件停用 / preload 白名单未放行）不能让异常从 effect 逃逸：会卸载整棵渲染树
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

  /** 选中档位：完全权限需要显式确认风险，其余直接切换 */
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

  /** 会话级选择写回：已存在会话立即落库；新会话由主进程随首轮写入 */
  const persistSelection = (selection: AgentSelectionView): void => {
    emitSelection(selection)
    if (currentTopicId == null) return
    void harnessApi.harness
      .setTopicAgentSelection(currentTopicId, selection)
      .catch(() => message.error(t('harness.input.pickerSaveFailed')))
  }

  /** 工具：按会话启用（默认跟随主智能体，改动后该会话按新清单运行） */
  const toggleTool = (name: string): void => {
    const next = selectedTools.includes(name)
      ? selectedTools.filter((item) => item !== name)
      : [...selectedTools, name]
    setSelectedTools(next)
    persistSelection({ tools: next, skills: selectedSkills, mcpTools: selectedMcp })
  }

  /** 技能：按会话启用（新增技能默认不启用，需在这里勾选） */
  const toggleSkill = (id: string): void => {
    const next = selectedSkills.includes(id)
      ? selectedSkills.filter((item) => item !== id)
      : [...selectedSkills, id]
    setSelectedSkills(next)
    persistSelection({ tools: selectedTools, skills: next, mcpTools: selectedMcp })
  }

  /** MCP：按会话勾选服务器（存分组值，主进程挂载时展开成具体工具） */
  const toggleMcp = (value: string): void => {
    const next = selectedMcp.includes(value)
      ? selectedMcp.filter((item) => item !== value)
      : [...selectedMcp, value]
    setSelectedMcp(next)
    persistSelection({ tools: selectedTools, skills: selectedSkills, mcpTools: next })
  }

  /** 扁平化选项：查找当前模型、键盘导航、搜索结果共用一份 */
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

  /** 当前模型档案声明的推理档位（空 = 没有思考档位，面板里不显示「推理等级」这一行） */
  const effortLevels = selectedOption?.effortLevels ?? []
  const currentEffort = selectedOption?.reasoningEffort ?? null
  /**
   * 实际生效的档位：显式选过就用它，没选过就是该模型的「中等思考」默认档
   * （与主进程 thinking-params 的兜底同一份算法，所以界面显示的就是真正会下发的档位）。
   */
  const effectiveEffort = currentEffort ?? defaultReasoningEffort(effortLevels)

  /** 模型搜索：按展示名与协议名过滤，保留分组结构 */
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

  /** 搜索结果扁平化（键盘下标用它，与渲染顺序一致） */
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
    // 打开时高亮当前模型（搜索词刚被清空，所以按全量列表定位）
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
   * 写入推理等级：落到该模型自己的配置列（provider.reasoning_effort），
   * 由主进程按协议族翻译成各家字段。保存后 providers-changed 广播会让列表刷新。
   * 档位只来自模型档案（面板里不再有「默认/未设置」项），所以这里只写具体档位。
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

  /** 模型列表键盘操作：↑/↓ 移动、Enter 选中、Esc 退回上一级 */
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

  // 外部回调走 ref：editor 只创建一次，避免 props 变化导致重建
  const onInputChangeRef = useRef(onInputChange)
  onInputChangeRef.current = onInputChange
  const onKeyDownRef = useRef(onKeyDown)
  onKeyDownRef.current = onKeyDown

  const editorRef = useRef<Editor | null>(null)

  // ── 输入历史（↑/↓ 切换）：全局共享、localStorage 持久化，由 handleSend 记录到 inputHistoryRef ──
  // historyIndexRef：-1 = 未浏览，0..n-1 = 指向历史条目；
  // 触发条件：仅当输入内容为空（ed.isEmpty）时才接管 ↑/↓，用户输入内容后保留默认光标移动
  const historyIndexRef = useRef(-1)
  // 浏览切换后刷新自定义光标（updateCaret 定义在下方，经 ref 调用避免声明顺序问题）
  const updateCaretRef = useRef<() => void>(() => {})

  /** 与 onUpdate 一致的文本序列化：hardBreak→换行、fileRef→路径 */
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

  /** textarea 风格逐行移动光标。
   * 输入框全部换行都是 hardBreak，整篇只是一个 textblock，ProseMirror 默认 ↑/↓
   * 是 block 级移动（直接跳段落开头/结尾），这里按屏幕坐标逐行定位光标。 */
  const moveCursorByLine = useCallback((view: EditorView, dir: -1 | 1): boolean => {
    const { state } = view
    if (!state.selection.empty) return false
    const lineHeight = parseFloat(getComputedStyle(view.dom).lineHeight) || 19
    const coords = view.coordsAtPos(state.selection.$head.pos)
    const hit = view.posAtCoords({ left: coords.left, top: coords.top + dir * lineHeight })
    if (!hit) return true // 首行 ↑ / 末行 ↓ 越界：接管但不动，避免跳到段落开头/结尾
    // 目标与当前行高度差小于半行 → 仍是同一行（坐标被 clamp）→ 不移动
    const hitCoords = view.coordsAtPos(hit.pos)
    if (Math.abs(hitCoords.top - coords.top) < lineHeight * 0.5) return true
    const bias = dir > 0 ? 1 : -1 // ↓ 到行首、↑ 到行尾（textarea 惯例）
    view.dispatch(
      state.tr.setSelection(TextSelection.near(state.doc.resolve(hit.pos), bias)).scrollIntoView()
    )
    return true
  }, [])

  /** ↑/↓ 切换输入历史（调用方已确保输入内容为空）；返回是否已接管按键 */
  const navigateHistory = useCallback(
    (dir: -1 | 1): boolean => {
      const ed = editorRef.current
      if (!ed) return false
      const history = inputHistoryRef.current
      if (history.length === 0) return false

      let next = historyIndexRef.current
      if (dir === -1) {
        // ↑：空输入时逐条回退（最近一条 → 更早）；
        // 最旧一条再按 ↑ 循环回空草稿（与 ↓ 越过最新一条回到空草稿对称）
        if (next === -1) {
          next = history.length - 1
        } else {
          next -= 1
          if (next < 0) next = -1
        }
        if (next === historyIndexRef.current) return false
      } else {
        // ↓：回到更新的历史；越过最新一条后回到空草稿
        if (next === -1) return false
        next += 1
        if (next >= history.length) next = -1
      }

      historyIndexRef.current = next
      const text = next === -1 ? '' : history[next]
      // 恢复为纯文本：按行重建（硬换行用 hardBreak），fileRef 以路径文本还原
      const lines = text.replace(/\r\n?/g, '\n').split('\n')
      const nodes: ProseMirrorNode[] = []
      lines.forEach((line, i) => {
        if (i > 0) nodes.push(ed.schema.nodes.hardBreak.create())
        if (line) nodes.push(ed.schema.text(line))
      })
      // emitUpdate:false：避免 onUpdate 把它当成用户编辑而重置浏览态
      ed.commands.setContent(
        {
          type: 'doc',
          content: [{ type: 'paragraph', content: nodes.map((n) => n.toJSON()) }]
        },
        { emitUpdate: false }
      )
      ed.commands.focus('end')
      // setContent 不触发 onUpdate，手动同步父组件 inputValue
      onInputChangeRef.current(getEditorText(ed))
      requestAnimationFrame(() => updateCaretRef.current())
      return true
    },
    [inputHistoryRef, getEditorText]
  )

  // ── 粘贴附件：剪贴板中的文件/图片转为附件（上传按钮同一套 Attachment 结构）──
  // 图片：读内容为 dataUrl（与 select-image-file 的图片分支一致）
  // 非图片：取真实磁盘路径（与 select-image-file 的非图片分支一致：dataUrl 即路径），
  //         取不到路径（如其他应用复制的无磁盘来源文件）时提示改用拖拽/上传
  const handlePasteFiles = useCallback(
    async (files: File[]) => {
      const added: Attachment[] = []
      for (const file of files) {
        const isImage =
          file.type.startsWith('image/') || /\.(png|jpe?g|gif|bmp|webp|svg|ico)$/i.test(file.name)
        if (isImage) {
          // 与上传按钮一致：非视觉模型禁止粘贴图片附件
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
  // 同上：editor 只创建一次，handlePaste 经 ref 取最新实现
  const handlePasteFilesRef = useRef(handlePasteFiles)
  handlePasteFilesRef.current = handlePasteFiles

  // ── 「/」命令面（目标 / 计划）────────────────────────────────────────────
  // 只有输入框开头是 `/` 时才唤起；行内容参考 DSH 的输入框命令菜单。
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  /** 用户按 Esc 关掉后，直到文本不再以 `/` 开头前不自动重新唤起 */
  const [slashDismissed, setSlashDismissed] = useState(false)
  const slashMenuRef = useRef<HTMLDivElement | null>(null)
  /** 输入区外层（判断点击是否落在输入框内部：点输入框不关菜单） */
  const composerRef = useRef<HTMLDivElement | null>(null)

  const slashRows = useMemo(() => filterSlashCommands((key) => t(key), slashQuery), [slashQuery, t])
  /** 键盘处理里读最新状态（editor 只创建一次，闭包不会跟着重渲染更新） */
  const slashRef = useRef<{
    open: boolean
    index: number
    rows: HarnessSlashCommandDef[]
  }>({ open: false, index: 0, rows: [] })
  slashRef.current = { open: slashOpen, index: slashIndex, rows: slashRows }

  /** 上一次的查询词：查询变化时把高亮拉回第一行 */
  const previousSlashQueryRef = useRef('')

  useEffect(() => {
    if (simpleMode) {
      setSlashOpen(false)
      return
    }
    // 编辑器第一个行内节点必须是**以 `/` 开头的文字**：文件引用 chip 的序列化路径
    // 也以 `/` 开头（`/uploads/...`），只看 inputValue 会把「chip 在开头」误判成命令输入。
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

  // 点菜单和输入区以外的地方关闭（与 DSH 的命令菜单同一手感）
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
   * 选中一条命令：先消费掉 `/` + 查询词（命令面不是普通消息），再执行动作。
   *
   * 目标 / 计划都已移到输入框上方的内联区域：这里只把动作交给页面，
   * 输入框本身不再拥有目标弹窗或计划徽标。
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
  // editor 的 keydown 只创建一次：经 ref 取最新实现
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
        // Enter 发送（Shift+Enter 由 HardBreak 处理换行）；输入法组合期间不拦截
        handleKeyDown: (view, event) => {
          if (event.isComposing || event.keyCode === 229) return false
          // 「/」命令面打开时先接管按键：↑/↓ 移动高亮，回车 / Tab 选中，Esc 收起。
          // 选中走命令动作而不是发送消息——命令面不是普通文本。
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
          // ↑/↓ 切换历史输入：空输入可进入浏览（加载最近一条），
          // 浏览态（内容非空但非用户输入）可继续 ↑/↓ 逐条切换；
          // 用户手动编辑后退出浏览态；内容非空且不在浏览态时，
          // 改走 textarea 风格逐行移动光标（避免 PM 单 textblock 直接跳段落开头/结尾）
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
            // 非浏览态（用户输入内容后）：逐行移动光标，不再触发任何历史切换
            // 视图不可用（编辑器销毁竞态）时放弃接管，退回默认行为
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
          // 光标紧贴文件引用 chip 时，退格/删除一次删掉（ProseMirror 默认是先选中再删）
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
          // 左右方向键直接跨过 chip（ProseMirror 对 selectable atom 默认是先选中再跳，
          // 需要按两下；这里在光标紧贴 chip 时一次跨过；Shift+方向键保留默认的选区扩展）
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
        // 完全接管 drop：拖入的文件引用统一由容器 onDrop 插入 chip，
        // 避免 ProseMirror 默认把 text/plain 当文本插入造成双重插入
        handleDrop: () => true,
        // 剪切板含文件/图片时优先转附件（Ctrl+V 粘贴上传），无文件才走纯文本粘贴
        // 粘贴纯文本：按 \n 拆行插入（换行用 hardBreak，保持 DOM 扁平）
        // 注意：不能使用 insertContent(数组)（会丢弃 hardBreak），必须走原生 tr.insert
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
          // 用事件自带的 view（真实视图）分发，避免绕经可能在销毁竞态中的 editor.view 代理
          _view.dispatch(tr)
          return true
        }
      },
      onUpdate: ({ editor }) => {
        // textSerializers：hardBreak 输出换行、fileRef 输出路径，保证发送文本与所见一致
        // 注意：v3 的 serializer 参数是 { node } 对象，不是节点本身
        const text = getEditorText(editor)
        // 浏览历史时手动编辑：退出浏览态（编辑后内容非空且不在浏览态，↑/↓ 不再触发）。
        // 程序化切换走 setContent(emitUpdate:false)，不会进入这里
        if (historyIndexRef.current !== -1) {
          historyIndexRef.current = -1
        }
        onInputChangeRef.current(text)
      }
      // deps=[]：编辑器只创建一次。@tiptap/react v3 的 useEditor 每次渲染都会重新挂起
      // 一个 1ms 延迟销毁定时器（scheduleDestroy），若两次渲染间隔超过 1ms（如切页时
      // 编辑器 chunk 求值等重活占用主线程），定时器会先于下一次渲染触发把编辑器销毁，
      // 之后任何 view 访问都会抛「The editor view is not available」→ React 整树卸载崩溃。
      // 显式传空依赖数组让该定时器只在真正卸载时挂起，从源头消除竞态。
    },
    []
  )
  editorRef.current = editor ?? null

  // 计划评审挂起时锁住输入框：不可编辑、不可发送，评审反馈只在计划卡内。
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.setEditable(!locked)
  }, [editor, locked])

  // placeholder 也要跟着外部模式变化（普通对话 ↔ 目标输入）：TipTap 的 Placeholder
  // 只在创建时取一次字符串，目标选中态切换时需要手动更新并重绘装饰。
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
   * 安全读取编辑器视图 DOM。
   * TipTap v3.30 的 view 在视图未挂载/编辑器已销毁时返回一个仅含少量桩字段的 Proxy，
   * 访问 dom 等属性会直接抛错（而非返回 null）；这里统一收敛成「拿不到就返回 null」。
   */
  const getViewDom = useCallback((ed: Editor): HTMLElement | null => {
    if (ed.isDestroyed) return null
    try {
      return ed.view.dom as HTMLElement
    } catch {
      return null
    }
  }, [])

  // ── 自定义光标：跟随 collapsed selection 的位置，固定 CARET_HEIGHT 高度 ──
  // 原生 contentEditable 光标高度 = 行高（19px），普通输入框光标 ≈ 字号（14px），
  // 用 caret-color: transparent 隐藏原生光标后，在此绘制固定高度光标。
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
    // 空内容时定位到内容区左上角（首行行首），与占位符文字（同字号、垂直居中于行）对齐
    const caretAtContentStart = (): { top: number; left: number } => ({
      top: elRect.top - wrapRect.top + (lineHeight - CARET_HEIGHT) / 2,
      left: elRect.left - wrapRect.left
    })

    // 真正的"空文档"以 editor.isEmpty 为准
    const isEmpty = ed.isEmpty

    // 紧贴 inline atom（chip）后的 collapsed range，Chromium 会返回 0 高 rect，
    // 此时用 selection 前一个可测量元素（chip）的右缘定位光标
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
      // 正常路径：用 selection rect，短光标垂直居中于行内
      top = rect.top - wrapRect.top
      if (rect.height > CARET_HEIGHT) {
        top += (rect.height - CARET_HEIGHT) / 2
      }
      left = rect.left - wrapRect.left
    } else {
      // rect 失效（紧贴 atom）：用前一个可测量元素（chip）的右缘
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

  /** 把纯文本恢复到编辑器（行→hardBreak，与 navigateHistory 的恢复方式同构） */
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

  // 父组件 inputValue 变化时同步编辑器（修复：此前只做「变空清空编辑器」单方向，
  // 恢复会话缓存的非空草稿时编辑器仍显示上一话题内容/空白——隐藏草稿不可见且可被盲发）：
  // - 变空（发送后/切话题清空）：清空编辑器；
  // - 变非空且与编辑器内容不同（恢复缓存草稿）：恢复编辑器内容
  useEffect(() => {
    const ed = editorRef.current
    if (!ed || ed.isDestroyed) return
    if (inputValue === '') {
      if (!ed.isEmpty) {
        // emitUpdate: false —— 清空是外部状态驱动的结果，不要再回灌一次 onInputChange
        ed.commands.clearContent(false)
        ed.commands.focus()
        // 外部清空输入（发送/新对话/切话题）时重置历史浏览位置
        historyIndexRef.current = -1
      }
    } else if (getEditorText(ed) !== inputValue) {
      restorePlainText(ed, inputValue)
      historyIndexRef.current = -1
    }
    updateCaret()
  }, [inputValue, updateCaret, getEditorText, restorePlainText])

  /**
   * 外部请求聚焦（插件行的 ＋「新建会话」）：把光标放进输入框，**不写任何内容**。
   *
   * 为什么单独一个 effect：上面那个同步 effect 只管「外部值 → 编辑器」的文字同步，
   * 不会动焦点。这里只调 `focus('end')`——空编辑器上等价于「聚焦并把光标放到开头」，
   * 用户点完 ＋ 直接敲键盘就能写。
   */
  useEffect(() => {
    if (!focusInputToken) return
    const ed = editorRef.current
    if (!ed || ed.isDestroyed) return
    ed.commands.focus('end')
    historyIndexRef.current = -1
    updateCaret()
  }, [focusInputToken, updateCaret])

  // 光标位置随选区/窗口尺寸变化而更新
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

  // 编辑器内部滚动时更新光标位置
  useEffect(() => {
    const ed = editor
    if (!ed) return
    const dom = getViewDom(ed)
    if (!dom) return
    dom.addEventListener('scroll', updateCaret)
    return () => dom.removeEventListener('scroll', updateCaret)
  }, [editor, updateCaret, getViewDom])

  // ── 在光标位置插入文件引用 chip ──
  const insertFileRef = useCallback(
    (path: string) => {
      const ed = editorRef.current
      if (!ed) return
      ed.commands.focus()
      const cleanPath = path.replace(/\/+$/, '')
      const label = cleanPath.split('/').filter(Boolean).pop() || path
      const pos = ed.state.selection.from
      ed.commands.insertContent({ type: 'fileRef', attrs: { path, label } })
      // 显式把光标放到 chip 之后（inline atom 的 nodeSize 为 1）
      ed.commands.setTextSelection(pos + 1)
      // 刷新自定义光标：chip 是 React NodeView 异步渲染的，插入后立即读 rect
      // 会拿到占位宽度（0）导致光标位置偏前，必须等渲染完成（双 rAF）再刷新
      updateCaret()
      requestAnimationFrame(() => {
        updateCaret()
        requestAnimationFrame(updateCaret)
      })
    },
    [updateCaret]
  )

  // ── 拖拽处理 ──
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

  // ── 点击输入区空白处聚焦并移光标到末尾（与普通输入框一致）──
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

  // 主按钮语义：生成中且输入框为空 → 停止；其余（含生成中已输入内容）→ 发送。
  // 生成中输入的这条会进入输入框上方的插话队列，不打断当前回合。
  const primaryStops = isLoading && !hasContent
  const onPrimary = primaryStops ? onStop : onSend
  const primaryHint = primaryStops
    ? t('harness.input.stopTooltip')
    : isLoading
      ? t('harness.input.queueTooltip')
      : ''
  /**
   * 主按钮什么时候不可点：**只有「发送」需要内容**。
   *
   * 停止不依赖输入框内容——生成中把输入框清空，恰恰是用户想叫停的那一刻。
   * 这里曾经写成 `disabled={!hasContent}`，于是「生成中 + 输入框为空」时停止按钮自己也被禁掉，
   * 变成一个点了没反应的按钮（用户 2026-09-29 报的「会话进行中时，输入框里面没有内容，
   * 但是不能暂停」）。生成中带内容的那一档仍然是发送（进插话队列），不受影响。
   */
  const primaryDisabled = locked || (!primaryStops && !hasContent)

  // chip 主题色经 CSS 变量注入 FileRef NodeView
  const chipCssVars = useMemo(
    () =>
      ({
        '--file-chip-bg': isDarkMode ? '#1a2744' : '#eff6ff',
        '--file-chip-color': isDarkMode ? '#93c5fd' : '#1d4ed8',
        '--file-chip-border': isDarkMode ? '#1e3a5f' : '#bfdbfe'
      }) as React.CSSProperties,
    [isDarkMode]
  )

  // ── 模型 / 推理等级面板 ─────────────────────────────────────────────────
  // 面板挂在 Popover 的浮层里（portal，不在输入框容器内），主题变量直接写在面板根节点上。
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
    // 品牌图标才吃品牌色；没有图标的降级走 ProviderMark 自己的「自定义端点」主色阶
    const color = getProviderColor(providerType, isDarkMode)
    return Icon ? (
      <Icon style={{ fontSize: size, color: color ?? '#888888' }} />
    ) : (
      <ProviderMark providerType={providerType} size={size} color={color} />
    )
  }

  /**
   * 面板标题行（二级页：返回 + 标题）。
   * **整行都是返回热区**（用户 2026-09-27：不要只有前面那个小箭头能点），
   * 所以这里是一个占满整行的 button，箭头只是它里面的图标。
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

  /** 推理等级一行（档位表里的某一档；「默认」不再是可选项——有档位就必有一档在用） */
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
          {/* 有思考档位才给这一行：模型没有档位表时整行不存在（不是灰掉、也不是显示「—」） */}
          {effortLevels.length > 0 ? (
            <button type="button" className="hmm-row" onClick={() => setMenuView('effort')}>
              <span className="hmm-row-label">{t('harness.input.effortLabel')}</span>
              <span className="hmm-row-value">
                {effectiveEffort ? reasoningEffortLabel(effectiveEffort) : ''}
              </span>
              <RiArrowRightSLine size={16} className="hmm-row-chev" />
            </button>
          ) : null}
          {/* Agent Teams opt-in：按话题持久化，关闭时不注入团队工具/提示词 */}
          {currentTopicId != null ? (
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
                  checked={teamModeEnabled}
                  loading={teamModeBusy}
                  disabled={teamModeBusy}
                  onChange={(checked) => void handleToggleTeamMode(checked)}
                />
              </span>
            </div>
          ) : null}
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

  /** 档位图标配色：中性 → 主色 → 警示，颜色只承载「更宽 = 风险更高」这一条信息 */
  const permissionToneColor = (tone: 'neutral' | 'primary' | 'warning'): string =>
    tone === 'primary'
      ? token.colorPrimary
      : tone === 'warning'
        ? token.colorWarning
        : token.colorTextTertiary

  const activePermission =
    PERMISSION_OPTIONS.find((option) => option.mode === permissionMode) ?? PERMISSION_OPTIONS[1]
  const ActivePermissionIcon = activePermission.icon

  /** 权限档位面板：三项 + 当前档位的一句话说明（不加分组标题、不加徽章） */
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
   * 工具 / 技能的多选面板：顶部搜索框 + 一行一项（右侧打勾表示已选，点完不收起，方便连续勾）。
   *
   * 搜索只过滤当前面板（展示名和真实 id 都认：工具名是 `read_file` 这种英文标识、展示名是
   * 「读取文件」，两种输入都能命中），关掉面板即清空。清单可能有几十项，没有搜索框找一项很难。
   * 回车 = 勾/取消勾第一个命中项（键盘连续勾选时不用来回换手）。
   */
  const pickerMenu = (
    items: { key: string; label: string; active: boolean; onToggle: () => void }[],
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
              // 中文输入法选词时的回车 / Esc 是给输入法的，不能当成「勾选 / 清空」
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

  /** 输入卡片下方的选择器：权限 / 工具 / 技能（用户口径：这些都放在输入框底部） */
  /** 权限档位留在输入卡片内（用户口径：权限不要放到下面那排） */
  const permissionSelector = (
    <>
      {/* 权限档位：模型能在多大范围里动手（沙箱拦截与审批弹窗都按它判定）。
              排在模型选择前面：先定「能动多大范围」，再看「用哪个模型」。 */}
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

  /** 输入卡片下方的选择器：工具 / 技能 */
  const inputSelectors = (
    <>
      {/* 工具 / 技能：主智能体的默认选择（设置页移除后搬到这里，选完下一轮即生效） */}
      <Popover
        open={toolsOpen}
        onOpenChange={(open) => {
          setToolsOpen(open)
          // 关掉就清空搜索词：下次打开是完整清单
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
      /* 外层托底：把输入卡片和下面那排选择器包成一块（参考形态：卡片浮在浅一档的底上） */
      style={{
        ...menuVars,
        position: 'relative',
        background: colorBgLayout,
        borderRadius: 20,
        padding: 6,
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.06)'
      }}
    >
      {/* 「/」命令面：贴着输入卡片上沿弹出（左侧/右侧与卡片对齐）。
          只在输入框开头输入 `/` 时出现；Esc / 点击外部收起。 */}
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
      {/* 助手形象：只在空白会话里趴在输入框右上角；有对话内容就收起，
          免得压在消息 / 思考过程上（不拦截鼠标，纯装饰） */}
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
          // 触发条在容器内、面板在 portal 里，两边共用同一套 --hmm-* 主题变量
          ...menuVars
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* overflow hidden：光标滚出编辑区可视范围时被裁切 */}
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
          {/* 自定义光标：固定高度、随光标位置移动、闪烁动画 */}
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
          /* ── 模型 / 推理等级：收起态一行触发条 ── */
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
          /* 13px 文本的行盒按字体 ascent/descent 居中后，字面仍比图标 / 徽章低约 1px
             （Segoe UI 的 ascent 明显大于 descent，中文回退字形也跟着偏下）。
             补 1px 下内边距，flex 居中时整块上移 0.5px：不缩放字形、不触发重绘模糊，
             在 125% 缩放下正好把用户看到的那 1 个设备像素抵消掉。 */
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

          /* ── 权限档位（沙箱）：与模型触发条同形，收起时只显示当前档位 ── */
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

          /* ── 模型 / 推理等级：展开面板 ── */
          .harness-model-menu {
            min-width: 260px;
            padding: 6px;
            border: 1px solid var(--hmm-border);
            border-radius: 14px;
            background: var(--hmm-bg);
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
            font-size: 13px;
          }
          /* 权限面板不跟着模型面板走 260px：三项都是短标签，固定 160px，
             说明行在面板内换行（宽度不随档位变化而跳） */
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
          /* 团队协作开关行是配置项不是可点入口：不显示 hover 高亮，开关自己承担交互 */
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
            /* 值比标签低一档：同一行里靠明度分主次（对齐参考设计稿） */
            color: var(--hmm-tertiary);
          }
          .harness-model-menu .hmm-row-chev { flex-shrink: 0; color: var(--hmm-tertiary); }
          .harness-model-menu .hmm-head {
            display: flex;
            align-items: center;
            gap: 4px;
            width: 100%;
            height: 30px;
            /* 与下面的列表留 3px（用户指定；列表首项自身有圆角高亮，贴太紧会连成一片） */
            margin: 0 0 3px;
            padding: 0 8px 0 4px;
            border: 0;
            border-radius: 8px;
            background: transparent;
            text-align: left;
            cursor: pointer;
            /* 整行可点返回：悬停给整行底色，而不是只亮那个小箭头 */
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
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .harness-model-menu .hmm-item-check { flex-shrink: 0; color: var(--hmm-accent); }
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
             * 目标轮次上限（用户 2026-11-27 已选）：README 一直承诺「目标弹窗可设轮次上限」，
             * 此前只有后端/词条、没有输入控件。目标输入态顺手给一个数字框，空 = 默认 256。
             * 停止点击冒泡，避免点数字框时把焦点抢回编辑器。
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
            {/* 模型选择：收起时一行（模型名 + 推理等级），点开是「模型 / 推理等级」两行入口。
              推理等级直接写进该模型的配置列，下一轮请求即按协议族翻译成各家字段。 */}
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
            {/* 主按钮只有一个，语义随状态切换（与参考项目 deepseek-harness 的 InputBar 同款）：
              生成中且输入框为空 → 「停止」；生成中但已经打了字 → 「发送」（这条进插话队列）。
              这样生成中既能继续发消息，也不会丢掉随时叫停的能力。
              「停止」档不能禁用（见 primaryDisabled）：生成中清空输入框正是要叫停。 */}
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

        {/* 完全权限：档位本身没有拦截，切换前必须过一次显式风险确认（DSH 同款） */}
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
            {/* 会话用量状态条：靠右（与工具 / 技能同一行，右侧留白与左侧对称）。
            数据全部来自 harness_dialogue_usage，拿不到的项目不画。 */}
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
