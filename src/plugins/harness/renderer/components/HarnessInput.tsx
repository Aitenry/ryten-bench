import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { App, Button, Input, Modal, Popover, Tooltip, theme } from 'antd'
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
  RiShieldFlashLine
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
import { useTranslation } from '@renderer/i18n'

import {
  defaultReasoningEffort,
  getProviderColor,
  reasoningEffortLabel
} from '@renderer/utils/providerMeta'
import ProviderMark from '@renderer/components/provider/provider-mark'
import type { Attachment } from '../types'
import type { PermissionMode } from '../../shared/types'
import { harnessApi } from '../api'

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
  hintKey:
    | 'harness.permission.readOnlyHint'
    | 'harness.permission.workspaceWriteHint'
    | 'harness.permission.fullAccessHint'
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
    hintKey: 'harness.permission.workspaceWriteHint',
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
  isDarkMode: boolean
  colorBgLayout: string
  colorBorder: string
  colorText: string
  colorBorderSecondary: string
  onSend: () => void
  onStop: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
}

const HarnessInput: React.FC<HarnessInputProps> = ({
  inputValue,
  onInputChange,
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
  isDarkMode,
  colorBgLayout,
  colorBorder,
  colorText,
  colorBorderSecondary,
  onSend,
  onStop,
  onKeyDown
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

  // ── 权限档位（沙箱）：仅可查看 / 工作区内修改 / 完全权限 ──────────────────
  // 档位按话题存在主进程（electron-store），这里只缓存一份用于显示；
  // 切到「完全权限」要先过一次风险确认（DSH 同款），其余档位即点即生效。
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const [savingPermission, setSavingPermission] = useState(false)

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

  // 档位变更广播（设置页改默认值、另一窗口切换）→ 同步当前显示
  useEffect(() => {
    try {
      return harnessApi.harness.onPermissionUpdated((state) => {
        if (state.topicId === (currentTopicIdRef.current ?? 0)) setPermissionMode(state.mode)
      })
    } catch (err) {
      // 订阅失败（插件停用 / preload 白名单未放行）不能让异常从 effect 逃逸：会卸载整棵渲染树
      console.warn('[harness-input] 权限档位订阅失败:', err)
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
    setActiveIndex(Math.max(0, flatOptions.findIndex((o) => o.value === selectedProviderId)))
  }, [flatOptions, selectedProviderId])

  const handleMenuOpenChange = useCallback(
    (open: boolean): void => {
      setMenuOpen(open)
      if (open) {
        setMenuView('root')
        setModelQuery('')
      }
    },
    []
  )

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

  const editor = useEditor(
    {
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        History,
        Placeholder.configure({ placeholder: t('harness.input.placeholder') }),
        BaseKeymap,
        FileRef
      ],
      content: '',
      editorProps: {
        // Enter 发送（Shift+Enter 由 HardBreak 处理换行）；输入法组合期间不拦截
        handleKeyDown: (view, event) => {
          if (event.isComposing || event.keyCode === 229) return false
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
    const color = getProviderColor(providerType, isDarkMode) ?? '#888888'
    return Icon ? (
      <Icon style={{ fontSize: size, color }} />
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
    PERMISSION_OPTIONS.find((option) => option.mode === permissionMode) ??
    PERMISSION_OPTIONS[1]
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
      <div className="hmm-note">{t(activePermission.hintKey)}</div>
    </div>
  )

  return (
    <div
      className="rounded-2xl input-scrollbar"
      style={{
        background: colorBgLayout,
        border: `1px solid ${isDragOver ? '#4d6bfe' : colorBorder}`,
        transition: 'border-color 0.2s',
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
        className="p-4 relative overflow-hidden"
        onClick={handleContainerClick}
        ref={textareaRef}
      >
        <EditorContent editor={editor} className="harness-input-editor" />
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
      <div className="flex items-center justify-between px-4 pb-4">
        <div className="flex min-w-0 items-center gap-2">
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
          {/* 模型选择：收起时一行（模型名 + 推理等级），点开是「模型 / 推理等级」两行入口。
              推理等级直接写进该模型的配置列，下一轮请求即按协议族翻译成各家字段。 */}
          <Popover
            open={menuOpen}
            onOpenChange={handleMenuOpenChange}
            trigger="click"
            placement="topLeft"
            arrow={false}
            content={modelMenu}
            styles={{
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
                <ProviderMark providerType={selectedProviderType} size={14} color={selectedColor} />
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
          {/* 权限档位：模型能在多大范围里动手（沙箱拦截与审批弹窗都按它判定） */}
          <Popover
            open={permissionOpen}
            onOpenChange={setPermissionOpen}
            trigger="click"
            placement="topLeft"
            arrow={false}
            content={permissionMenu}
            styles={{
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
              <span className="harness-permission-trigger-name">
                {t(activePermission.labelKey)}
              </span>
              {permissionOpen ? (
                <RiArrowUpSLine size={14} className="harness-permission-trigger-chev" />
              ) : (
                <RiArrowDownSLine size={14} className="harness-permission-trigger-chev" />
              )}
            </button>
          </Popover>
        </div>
        <div className="flex items-center gap-2">
          {/* 主按钮只有一个，语义随状态切换（与参考项目 deepseek-harness 的 InputBar 同款）：
              生成中且输入框为空 → 「停止」；生成中但已经打了字 → 「发送」（这条进插话队列）。
              这样生成中既能继续发消息，也不会丢掉随时叫停的能力。 */}
          <Tooltip title={primaryHint}>
            <Button
              type="primary"
              danger={primaryStops}
              shape="circle"
              icon={primaryStops ? <RiStopFill size={16} /> : <RiArrowUpLine size={16} />}
              onClick={onPrimary}
              disabled={!hasContent}
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
        <div style={{ fontSize: 13, lineHeight: 1.6 }}>
          {t('harness.permission.confirmBody')}
        </div>
      </Modal>
    </div>
  )
}

export default HarnessInput
