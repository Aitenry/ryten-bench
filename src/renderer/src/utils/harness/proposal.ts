/**
 * `propose_action` 的渲染层纯逻辑（无 React / electron 依赖，便于单元测试）。
 *
 * 用户 2026-11-27 口径：确认不再作为消息流里的卡片，而是在输入区出现一条**预填 AI 推荐
 * 内容**的单行输入条；消息流零留痕。这里只负责「哪条提议还算待确认」「推荐内容是什么」。
 */

export interface ProposalActionItem {
  label: string
  description?: string
  reply?: string
}

export interface PendingProposalView {
  /** 稳定 key：消息 id + 块下标（没有 tool id 时用它判断「是不是同一条提议」） */
  key: string
  question: string
  actions: ProposalActionItem[]
  /** 默认回填进输入条的内容：第一个动作的 reply（没有则 label） */
  recommendedText: string
}

/** 渲染层消息的最小结构（只取判定所需字段，避免测试依赖完整 Message 类型） */
export interface ProposalMessageLike {
  role: string
  id?: string
  blocks?: Array<{
    type?: string
    tool?: {
      name?: string
      status?: string
      id?: string
      input?: unknown
    }
  }>
}

function normalizeActions(raw: unknown): ProposalActionItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (action): action is ProposalActionItem =>
        typeof action === 'object' &&
        action !== null &&
        typeof (action as { label?: unknown }).label === 'string' &&
        ((action as { label: string }).label ?? '').trim().length > 0
    )
    .map((action) => ({
      label: action.label.trim(),
      description:
        typeof action.description === 'string' && action.description.trim()
          ? action.description.trim()
          : undefined,
      reply:
        typeof action.reply === 'string' && action.reply.trim() ? action.reply.trim() : undefined
    }))
    .slice(0, 4)
}

/** 默认回填内容：第一个动作的 reply → label（保持用户可编辑的完整句子） */
export function recommendedProposalText(actions: readonly ProposalActionItem[]): string {
  const first = actions[0]
  if (!first) return ''
  return (first.reply ?? first.label).trim()
}

/**
 * 找当前待确认的 propose_action：
 * - 只看**最后一条用户消息之后的最新一条助手消息**（旧提议一律过期）；
 * - 取该消息里最后一个已完成的 `propose_action` 工具块，且动作至少 1 条；
 * - 没有则返回 null（输入条不出现）。
 */
export function findPendingProposal(
  messages: readonly ProposalMessageLike[]
): PendingProposalView | null {
  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      lastUserIndex = i
      break
    }
  }
  // 最新一条助手消息才可能承载「本轮刚结束的提议」
  for (let i = messages.length - 1; i > lastUserIndex; i -= 1) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    const blocks = message.blocks ?? []
    for (let b = blocks.length - 1; b >= 0; b -= 1) {
      const block = blocks[b]
      if (block.type !== 'tool') continue
      const tool = block.tool
      if (!tool || tool.name !== 'propose_action') continue
      if ((tool.status ?? 'completed') !== 'completed') continue
      const input = (tool.input ?? {}) as { question?: unknown; actions?: unknown }
      const actions = normalizeActions(input.actions)
      if (actions.length === 0) return null
      return {
        // tool id 理论上唯一；仍拼上消息 id + 块下标：同一会话里复用同一 call id（脚本/重放）
        // 时也不会被上次 ✕ 的 dismissed key 误伤
        key: `${tool.id ?? 'no-id'}:${message.id ?? i}:${b}`,
        question: typeof input.question === 'string' ? input.question.trim() : '',
        actions,
        recommendedText: recommendedProposalText(actions)
      }
    }
    // 最新一条助手消息里没有待确认提议 → 不再往前找
    return null
  }
  return null
}
