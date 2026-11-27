/**
 * `list_subagent_models` 的纯格式化逻辑（无 DB / electron，可离线测试）。
 *
 * 用途：`agent_create` / 子代理配置里的 `model` 字段要求 `provider:model` 形式的**已启用路由**。
 * 模型看不到供应商配置，所以这里把启用中的路由 + 能力摘要排成一段文本给它挑选。
 */

/** 一条可用的模型路由（工具层从 provider 配置/模型档案投影） */
export interface ModelRouteEntry {
  /** `provider:model`（resolveSubAgentModelSpec 认的格式） */
  spec: string
  /** 供应商配置的展示名 */
  name: string
  /** 供应商类型（如 openai / anthropic） */
  providerType: string
  model: string
  isDefault: boolean
  /** 能力摘要（来自模型档案；未收录时为 undefined） */
  capabilities?: {
    image?: boolean
    tools?: boolean
    reasoning?: boolean
  }
}

/** 文案（由 i18n 按界面语言提供） */
export interface ModelRoutesTexts {
  header: string
  empty: string
  item: string
  capabilities: string
  defaultTag: string
  hint: string
  none: string
  image: string
  tools: string
  reasoning: string
}

type Format = (template: string, values: Record<string, string | number>) => string

/** 能力标签拼接；没有任何已知能力时返回 none 文案 */
export function capabilityLabels(texts: ModelRoutesTexts, entry: ModelRouteEntry): string {
  const labels: string[] = []
  if (entry.capabilities?.image) labels.push(texts.image)
  if (entry.capabilities?.tools) labels.push(texts.tools)
  if (entry.capabilities?.reasoning) labels.push(texts.reasoning)
  return labels.length > 0 ? labels.join(' · ') : texts.none
}

/** 排成给模型看的清单（默认路由置顶） */
export function formatModelRoutes(
  format: Format,
  texts: ModelRoutesTexts,
  entries: ModelRouteEntry[]
): string {
  const header = format(texts.header, { count: String(entries.length) })
  if (entries.length === 0) {
    return `${header}\n\n${texts.empty}\n\n${texts.hint}`
  }
  const sorted = [...entries].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return a.spec.localeCompare(b.spec)
  })
  const items = sorted.map((entry) =>
    format(texts.item, {
      spec: entry.spec,
      name: entry.name,
      model: entry.model,
      capabilities: capabilityLabels(texts, entry),
      defaultTag: entry.isDefault ? ` ${texts.defaultTag}` : ''
    })
  )
  return [header, ...items, '', texts.hint].join('\n')
}
