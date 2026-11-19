import React, { useState } from 'react'
import { Trans, useTranslation } from '@renderer/i18n'
import {
  RiArrowRightSLine,
  RiErrorWarningLine,
  RiFileEditLine,
  RiPencilLine,
  RiTerminalBoxLine
} from '@remixicon/react'
import { ShinyIcon } from '@renderer/components/effects/ShinyText'

import { useWorkspaceBridge } from '../../contexts/workspace-bridge'
import { formatBytes, TOOL_CARD_ICONS, toolIconFor } from '../../utils/toolIcons'
import { MONO_FONT, TruncatedTooltipText } from './TruncatedTooltipText'
import type { ToolCall, ToolCard, ToolCardKind } from '../../../shared/types'

/**
 * 内置工具的结果卡片（read_file / write_file / edit_file / ls / glob / grep / execute）。
 *
 * 与旧实现的区别（2026-09-19）：这些工具的结果**不再进入 IPC/数据库**，聊天里只留
 * 这张卡片；要看内容就点卡片——文件类工具在右侧面板打开真实文件，ls 定位目录，
 * glob/grep/execute 打开结果详情页签（主进程按 topicId+callId 按需返回）。
 *
 * 因此卡片必须自己把「这次调用干了什么、结果多大」讲清楚：
 * 路径/模式/命令一行，右侧是行数/字节/条目数/命中数/退出码，失败时显示原因。
 *
 * 2026-09-23 追加（用户报「明明编辑了文件，聊天里找不到编辑卡片」）：**写改类卡片
 * 必须一眼可辨**——它们此前和 read_file 一样是「眼睛 + 路径」，扫一眼分不出哪张是改动。
 * 现在 write_file / edit_file 用铅笔系图标 + 琥珀色强调（错误仍是红色），
 * 并在左侧加一条 2px 强调边，扫读时改动卡片自己会跳出来。
 *
 * 同日再追加（用户原话「并且编辑后，需要在卡片显示差异：+12 -6」）：写改卡片的右侧
 * 多一段差异规模「+N −M」（见 DiffStat）——处数/字节数说的是「做了什么」，
 * 差异规模说的是「这个文件实际变了多少行」，两件事都要看得见。
 */

export interface ToolCardStyle {
  isDarkMode: boolean
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  colorFillAlter: string
  colorBorderSecondary: string
}

/** 工具进行中（参数构建中 / 执行中）时能立刻显示的参数摘要 */
function inputSummary(name: string, input: Record<string, unknown> | undefined): string {
  const value = (key: string): string =>
    typeof input?.[key] === 'string' ? (input[key] as string) : ''
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return value('file_path')
    case 'ls':
      return value('path')
    case 'glob':
    case 'grep':
      return value('pattern')
    case 'execute':
      return value('command')
    default:
      return ''
  }
}

/** 人类可读字节数：见 utils/toolIcons（卡片与详情页签共用） */

/**
 * 写改类卡片的强调色（左侧 2px 边 + 图标）。
 * 琥珀色是全局唯一「未保存 / 待处理」语义色（页签的未保存圆点、状态条的「磁盘已变化」
 * 都是它），写改卡片复用它，用户不需要再学一套新颜色。
 */
const MUTATE_COLOR = '#c98a2b'
/** 写改工具：完成态必须与 read_file 一眼可分（此前全都是同一个眼睛图标） */
const MUTATE_TOOLS = new Set(['write_file', 'edit_file'])

/** 卡片外壳：图标 + 主文本（单行截断 + 悬停全文）+ 右侧元信息 + 悬停动作提示 */
const CardShell: React.FC<{
  style: ToolCardStyle
  isNested: boolean
  icon: React.ReactNode
  primary: string
  meta?: React.ReactNode
  /** 有 onClick 即表示可点开：悬停变底色并显示右侧箭头 */
  onClick?: () => void
  actionTitle?: string
  primaryColor?: string
  /** 工具名（落在 data 属性上，供离线工装清点「哪些工具的卡片真的渲染了」） */
  toolName?: string
  /** 这张卡片是不是「进行中」形态（工装按 data-tool-progress 清点进行中的卡片） */
  progress?: boolean
  /** 主文本是否带光泽扫过（进行中卡片才需要：与左侧图标的亮面同步） */
  shinyText?: boolean
  /** 写改类卡片：左侧 2px 强调边（扫读时自己跳出来） */
  mutate?: boolean
}> = ({
  style,
  isNested,
  icon,
  primary,
  meta,
  onClick,
  actionTitle,
  primaryColor,
  toolName,
  progress = false,
  shinyText = false,
  mutate = false
}) => {
  const [hover, setHover] = useState(false)
  const bg = style.isDarkMode ? 'rgba(255,255,255,0.04)' : '#f9fafb'
  const hoverBg = style.isDarkMode ? 'rgba(255,255,255,0.08)' : '#f1f2f4'
  const fontSize = isNested ? '12px' : '13px'
  return (
    <div
      data-tool-card={toolName}
      data-tool-progress={progress ? '1' : undefined}
      data-tool-mutate={mutate ? '1' : '0'}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={onClick ? actionTitle : undefined}
      style={{
        background: hover && onClick ? hoverBg : bg,
        border: 'var(--ant-line-width) var(--ant-line-type) var(--ant-color-border)',
        // 只加左侧一条强调边：区分写改卡片，又不改变卡片本身的形状语言
        borderLeft: mutate ? `2px solid ${MUTATE_COLOR}` : undefined,
        marginBottom: isNested ? '4px' : '6px',
        borderRadius: '8px',
        padding: '9px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'background 0.15s'
      }}
    >
      {icon}
      <TruncatedTooltipText
        text={primary}
        /**
         * 进行中卡片：主文本与左侧图标**同一套亮面**（同一个基色，光泽同步扫过）。
         * 2026-09-27 用户报「只有图标会显示亮面的动效，而文字没有」——此前这里没传
         * `shinyBaseColor`，`TruncatedTooltipText` 就不挂 `.shiny-text`，文字自然是静的。
         * 完成态卡片不传（`shinyText` 缺省 false）：静止的卡片不该一直闪。
         */
        shinyBaseColor={shinyText ? style.colorTextSecondary : undefined}
        style={{ color: primaryColor ?? style.colorText, fontSize }}
      />
      {meta}
      {onClick ? (
        <RiArrowRightSLine
          size={isNested ? 14 : 16}
          style={{
            color: style.colorTextTertiary,
            opacity: hover ? 1 : 0,
            transition: 'opacity 0.15s',
            // 进展开的入口不能被文字/元信息挤扁（收缩压力大时它会被压成一条线）
            flexShrink: 0
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * 右侧元信息：数字用等宽字形（与「任务段步数胶囊」同一套排版口径）。
 *
 * `shrinkable`（2026-09-27 用户报「这个内容还是超出，没有出现省略号」）：
 * 失败原因这类**长度不可控**的元信息必须能收缩并出省略号。
 * 此前这里是 `flexShrink: 0` + `whiteSpace: nowrap` —— 既不许它变窄、又没有省略号，
 * 一条长原因（沙箱拦截那种整句说明）就把卡片内容顶出容器，再被卡片的 `overflow: hidden` 裁掉：
 * 用户看到的就是「内容超出，却没有省略号」。原生 `title` 保证裁掉的部分仍能看到全文
 * （卡片本身的 `title` 是给「点开」这种动作提示用的，两者可能同时存在，靠嵌套元素分开）。
 */
const Meta: React.FC<{
  isNested: boolean
  color: string
  /** true = 允许收缩 + 省略号（长度不可控的内容用它，如失败原因） */
  shrinkable?: boolean
  children: React.ReactNode
}> = ({ isNested, color, shrinkable = false, children }) => (
  <span
    data-tool-meta={shrinkable ? 'shrinkable' : 'fixed'}
    title={shrinkable ? String(children ?? '') : undefined}
    style={{
      color,
      fontSize: isNested ? '11px' : '12px',
      whiteSpace: 'nowrap',
      ...(shrinkable
        ? {
            // 收缩到内容宽度以下必须有 min-width: 0；裁剪交给省略号
            flex: '0 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }
        : { flexShrink: 0 })
    }}
  >
    {children}
  </span>
)

/**
 * 计数用的等宽字形包裹。
 *
 * 必须显式渲染 children：`<Trans components={{ mono: ... }}>` 是把占位组件**克隆**
 * 出来并把插值文本作为 children 塞进去的，一个忽略 children 的组件会把数字吞掉
 * （实测：`const Mono = () => <span/>` → 卡片上只剩「项」，数字不见）。
 */
const Mono: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <span style={{ fontFamily: MONO_FONT }}>{children}</span>
)

/**
 * 差异规模语义色：新增绿 / 删除红（与差异视图历史列表、资源管理器徽标同一套）。
 * 深色下用同一族色的亮档——`#4a8f5b` / `#b3452f` 在深底上会糊成一团灰，
 * 这两档就是 FileExplorer 的改动徽标在深色下用的那两个值。
 */
const DIFF_ADDED_COLOR = { light: '#4a8f5b', dark: '#9ecf8a' }
const DIFF_REMOVED_COLOR = { light: '#b3452f', dark: '#e08a70' }

/**
 * 写改卡片上的差异规模「+N −M」。
 *
 * 用户 2026-09-23 要求（原话）：「并且编辑后，需要在卡片显示差异：+12 -6」。
 *
 * 它与卡片上原有的数字**不是一回事，两个都要**：
 *  - 「N 处」= 这次替换了几处（edit_file 的返回值口径）；
 *  - 「+N −M」= 这个文件实际变了多少行（与改动记录、差异视图同一份数字，见主进程 line-diff）。
 * 一次 replace_all 替换 3 处却动了 40 行时，只看处数会让人以为这是个小改动。
 *
 * 数字缺失（老数据里落的卡片、写失败）或两边都是 0（内容其实没变）时**整块不渲染**：
 * 宁可这一行短一点，也不摆一个「+0 −0」让人读不通。
 */
const DiffStat: React.FC<{ added?: number; removed?: number; isDarkMode: boolean }> = ({
  added,
  removed,
  isDarkMode
}) => {
  if (typeof added !== 'number' || typeof removed !== 'number' || added + removed === 0) return null
  return (
    <span data-diff-stat style={{ fontFamily: MONO_FONT, marginLeft: 6 }}>
      <span style={{ color: isDarkMode ? DIFF_ADDED_COLOR.dark : DIFF_ADDED_COLOR.light }}>
        +{added}
      </span>
      <span
        style={{
          color: isDarkMode ? DIFF_REMOVED_COLOR.dark : DIFF_REMOVED_COLOR.light,
          marginLeft: 4
        }}
      >
        −{removed}
      </span>
    </span>
  )
}

/** 卡片右侧元信息（按工具语义给出「结果有多大」） */
const ToolCardMeta: React.FC<{
  tool: ToolCall
  card: ToolCard
  isNested: boolean
  color: string
  isDarkMode: boolean
}> = ({ tool, card, isNested, color, isDarkMode }) => {
  const { t } = useTranslation()
  // 失败且有失败原因：原因优先（egress 文本比「exit 1」更能说明问题）。
  // 没有 message 的失败态（如 execute 非零退出）继续走下面的按工具元信息——退出码不能丢。
  // 失败原因长度不可控（沙箱拦截那种整句说明），必须可收缩 + 出省略号（见 Meta 的 shrinkable）。
  if (card.status === 'error' && card.message) {
    return (
      <Meta isNested={isNested} color={color} shrinkable>
        {card.message}
      </Meta>
    )
  }
  switch (tool.name) {
    case 'read_file': {
      const lines = card.range
        ? t('harness.assistantMessage.toolLineRange', {
            start: card.range.start,
            end: card.range.end,
            total: card.range.total
          })
        : card.lines !== undefined
          ? t('harness.assistantMessage.toolLines', { count: card.lines })
          : undefined
      return (
        <Meta isNested={isNested} color={color}>
          {lines}
          {card.truncated ? t('harness.assistantMessage.toolTruncated') : ''}
        </Meta>
      )
    }
    case 'write_file':
      // `card.message` 这条兜底（失败但没投影出字节数）长度不可控，同失败原因一样要能收缩
      return (
        <Meta isNested={isNested} color={color} shrinkable={card.bytes === undefined}>
          {card.bytes !== undefined ? formatBytes(card.bytes) : card.message}
          <DiffStat added={card.added} removed={card.removed} isDarkMode={isDarkMode} />
        </Meta>
      )
    case 'edit_file':
      return (
        <Meta isNested={isNested} color={color} shrinkable={card.count === undefined}>
          {card.count !== undefined ? (
            <Trans
              i18nKey="harness.assistantMessage.toolReplacements"
              count={card.count}
              components={{ mono: <Mono /> }}
            />
          ) : (
            card.message
          )}
          <DiffStat added={card.added} removed={card.removed} isDarkMode={isDarkMode} />
        </Meta>
      )
    case 'ls':
      return (
        <Meta isNested={isNested} color={color}>
          <Trans
            i18nKey="harness.assistantMessage.itemCount"
            count={card.count ?? 0}
            components={{ mono: <Mono /> }}
          />
        </Meta>
      )
    case 'glob':
      return (
        <Meta isNested={isNested} color={color}>
          <Trans
            i18nKey="harness.assistantMessage.itemCount"
            count={card.count ?? 0}
            components={{ mono: <Mono /> }}
          />
        </Meta>
      )
    case 'grep':
      return (
        <Meta isNested={isNested} color={color}>
          <Trans
            i18nKey="harness.assistantMessage.matchCount"
            count={card.count ?? 0}
            components={{ mono: <Mono /> }}
          />
          {card.fileCount !== undefined
            ? ` · ${t('harness.assistantMessage.toolFileCount', { count: card.fileCount })}`
            : ''}
        </Meta>
      )
    case 'execute':
      return (
        <Meta isNested={isNested} color={card.exitCode ? '#ef4444' : color}>
          {card.exitCode !== undefined
            ? t('harness.assistantMessage.toolExitCode', { code: card.exitCode })
            : undefined}
        </Meta>
      )
    default:
      return null
  }
}

/** 完成态卡片：按工具语义决定点击行为 */
export const ToolResultCard: React.FC<{
  tool: ToolCall
  /** 当前话题 id（结果详情按 topicId + callId 取回） */
  topicId: number | null
  isNested?: boolean
  style: ToolCardStyle
}> = ({ tool, topicId, isNested = false, style }) => {
  const { t } = useTranslation()
  const bridge = useWorkspaceBridge()
  const card = tool.card
  if (!card) return null

  const size = isNested ? 14 : 16
  const kind: ToolCardKind = card.kind ?? (tool.name === 'execute' ? 'command' : 'file')
  /**
   * 写改类卡片：图标与颜色都换成「我改了这个文件」的一套。
   * 此前它们落进 `kind === 'file'` 分支，跟 read_file 共用同一个眼睛图标 + 次要色，
   * 于是聊天里**看不出哪张卡片是改动**——用户的原话就是「明明编辑了文件，找不到编辑卡片」。
   */
  const isMutate = MUTATE_TOOLS.has(tool.name) && card.status !== 'error'
  const MutateIcon = tool.name === 'write_file' ? RiFileEditLine : RiPencilLine
  const Icon =
    card.status === 'error' ? RiErrorWarningLine : isMutate ? MutateIcon : TOOL_CARD_ICONS[kind]
  const iconColor =
    card.status === 'error' ? '#ef4444' : isMutate ? MUTATE_COLOR : style.colorTextSecondary
  /** 主文本：路径 / 模式 / 命令 */
  const primary =
    kind === 'command'
      ? card.command || ''
      : kind === 'search'
        ? card.pattern || ''
        : card.path || ''

  const callId = tool.id
  const canDetail = Boolean(card.detail && callId && topicId != null)

  let onClick: (() => void) | undefined
  let actionTitle: string | undefined
  if (kind === 'file' && card.path && bridge) {
    onClick = () => bridge.openFile(card.path as string)
    actionTitle = t('harness.assistantMessage.toolOpenFile')
  } else if (kind === 'dir' && card.path && bridge) {
    // 目录：优先在资源管理器里定位（能一眼看到同级内容）；
    // 不在工作区内（如 /memories/...）时退回结果详情页签
    onClick = () => {
      if (!bridge.revealPath(card.path as string) && canDetail) {
        bridge.openToolDetail({
          topicId: topicId as number,
          callId: callId as string,
          kind,
          title: primary
        })
      }
    }
    actionTitle = t('harness.assistantMessage.toolRevealDir')
  } else if (canDetail && bridge) {
    onClick = () =>
      bridge.openToolDetail({
        topicId: topicId as number,
        callId: callId as string,
        kind,
        title: primary,
        exitCode: card.exitCode
      })
    actionTitle = t('harness.assistantMessage.toolViewDetail')
  }

  return (
    <CardShell
      style={style}
      isNested={isNested}
      icon={<Icon size={size} style={{ color: iconColor, flexShrink: 0 }} />}
      primary={primary}
      meta={
        <ToolCardMeta
          tool={tool}
          card={card}
          isNested={isNested}
          color={style.colorTextTertiary}
          isDarkMode={style.isDarkMode}
        />
      }
      onClick={onClick}
      actionTitle={actionTitle}
      toolName={tool.name}
      mutate={isMutate}
    />
  )
}

/** 进行中卡片（参数构建中 / 执行中）：同款外形，仅状态后缀 + 光泽扫过 */
export const ToolProgressCard: React.FC<{
  tool: ToolCall
  progress: 'preparing' | 'executing'
  isNested?: boolean
  style: ToolCardStyle
}> = ({ tool, progress, isNested = false, style }) => {
  const { t } = useTranslation()
  const size = isNested ? 14 : 16
  const summary = inputSummary(tool.name, tool.input as Record<string, unknown> | undefined)
  const status =
    progress === 'preparing'
      ? ` · ${t('harness.assistantMessage.toolPreparing')}`
      : ` · ${t('harness.assistantMessage.toolExecuting')}`
  // MCP / mnemon 这类运行期才知道名字的工具走前缀兜底；仍认不出退到终端图标（与旧行为一致）
  const Icon = toolIconFor(tool.name) || RiTerminalBoxLine
  return (
    <CardShell
      style={style}
      isNested={isNested}
      progress
      shinyText
      toolName={tool.name}
      icon={<ShinyIcon icon={Icon} size={size} baseColor={style.colorTextSecondary} />}
      primary={`${summary || tool.name || t('harness.assistantMessage.toolCallFallback')}${status}`}
      primaryColor={style.colorText}
    />
  )
}
