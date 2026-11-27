/**
 * `propose_action` 的纯逻辑：校验动作列表、生成给模型看的确认文本、生成动作卡标题。
 *
 * 动作卡本身由渲染层按工具入参渲染；工具结果只是告诉模型「已展示」。把校验与文案拼装
 * 拆成纯函数，便于离线测试（长度上限、去重、条数上限、回复文本回退）。
 */

/** 单个可选动作（渲染层与工具共用） */
export interface ProposedAction {
  /** 按钮文字（用户点选的就是它） */
  label: string
  /** 可选的一行说明 */
  description?: string
  /** 可选：点选后实际回传的文本（缺省 = label） */
  reply?: string
}

/** 动作条数上限（超过只保留前 N 个，避免卡片过高） */
export const MAX_PROPOSED_ACTIONS = 4
/** 单个 label 上限 */
export const MAX_ACTION_LABEL_CHARS = 60
/** 单个 description 上限 */
export const MAX_ACTION_DESCRIPTION_CHARS = 160
/** reply 上限 */
export const MAX_ACTION_REPLY_CHARS = 200

/** 文案（由 i18n 按界面语言提供） */
export interface ProposeActionTexts {
  shown: string
  item: string
  hint: string
}

type Format = (template: string, values: Record<string, string | number>) => string

/**
 * 规范化动作列表：裁掉空 label、按 label 去重、截断超长字段、限制条数。
 *
 * 返回 `null` 表示没有可用动作（调用方应告诉模型重试）。
 */
export function normalizeProposedActions(raw: unknown): ProposedAction[] | null {
  if (!Array.isArray(raw)) return null
  const actions: ProposedAction[] = []
  const seen = new Set<string>()
  for (const candidate of raw) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const item = candidate as Record<string, unknown>
    const label = typeof item.label === 'string' ? item.label.trim() : ''
    if (!label) continue
    const clipped = label.slice(0, MAX_ACTION_LABEL_CHARS)
    if (seen.has(clipped)) continue
    seen.add(clipped)
    const action: ProposedAction = { label: clipped }
    if (typeof item.description === 'string' && item.description.trim()) {
      action.description = item.description.trim().slice(0, MAX_ACTION_DESCRIPTION_CHARS)
    }
    if (typeof item.reply === 'string' && item.reply.trim()) {
      action.reply = item.reply.trim().slice(0, MAX_ACTION_REPLY_CHARS)
    }
    actions.push(action)
    if (actions.length >= MAX_PROPOSED_ACTIONS) break
  }
  return actions.length > 0 ? actions : null
}

/** 给模型看的结果文本：已展示的动作清单 + 「等用户点选」的提示 */
export function formatProposedActions(
  format: Format,
  texts: ProposeActionTexts,
  actions: ProposedAction[]
): string {
  const header = format(texts.shown, { count: String(actions.length) })
  const items = actions.map((action) =>
    format(texts.item, {
      label: action.label,
      description: action.description ? `— ${action.description}` : ''
    })
  )
  return [header, ...items, '', texts.hint].join('\n')
}
