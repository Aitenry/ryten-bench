/**
 * 历史回放中的用户图片投影（纯函数，可离线测试）。
 *
 * 背景：用户贴的图片以整段 data URL 存在 `harness_dialogue.blocks` 里。早期回放只还原
 * 文本，图片从第二轮起就"消失"；而直接全量回放又会让长会话的每一轮请求都携带所有
 * base64。这里给出最小可行的投影规则（对应 DSH 的请求期图像投影，附件存储与 offload
 * 尚未落地，见 docs/dsh-capability-gap-2026-11.md）：
 *
 * - 只回放最近 {@link MAX_REPLAYED_IMAGES} 张图片，且 base64 总量不超过
 *   {@link MAX_REPLAYED_IMAGE_CHARS}；
 * - 超出预算的图片退化成一句说明（模型知道"这里原本有图"，可以请用户重新附上）；
 * - 历史字符预算里一张图按 {@link IMAGE_BUDGET_CHARS} 估算，而不是按 base64 真实长度
 *   （否则一张图就会把整个历史预算吃光；真实 token 以 provider 回传的 usage 为准）。
 */
import type { MessageContentComplex } from '../../ai/messages'

/** 回放图片的预算 */
export const MAX_REPLAYED_IMAGES = 6
export const MAX_REPLAYED_IMAGE_CHARS = 12 * 1024 * 1024
/** 历史预算里一张图的字符估算（约 1.2k token） */
export const IMAGE_BUDGET_CHARS = 1200

/** 投影所需的最小对话字段（与 HistoryDialogue 结构兼容，避免依赖数据库类型） */
export interface ReplayDialogue {
  id: number
  role: string
  content: string
  blocks?: string | null
}

interface UserDialogueBlock {
  type?: string
  image_url?: string
  [key: string]: unknown
}

/** 解析用户行的 blocks；空/坏数据返回 null（按无 blocks 处理） */
export function userBlocksOf(d: Pick<ReplayDialogue, 'blocks'>): UserDialogueBlock[] | null {
  if (!d.blocks) return null
  try {
    const parsed: unknown = JSON.parse(d.blocks)
    return Array.isArray(parsed) ? (parsed as UserDialogueBlock[]) : null
  } catch {
    return null
  }
}

/** 用户行里声明的图片（保持原始顺序） */
function imagesOf(blocks: UserDialogueBlock[] | null): string[] {
  if (!blocks) return []
  const urls: string[] = []
  for (const block of blocks) {
    if (block?.type === 'image' && typeof block.image_url === 'string') urls.push(block.image_url)
  }
  return urls
}

/** 单条对话计入历史预算的字符数（图片按估算值，其余按真实长度） */
export function dialogueBudgetChars(d: ReplayDialogue): number {
  if (!d.blocks) return d.content.length
  const blocks = userBlocksOf(d)
  if (!blocks) return d.content.length + d.blocks.length
  let chars = 0
  for (const block of blocks) {
    if (block?.type === 'image' && typeof block.image_url === 'string') {
      chars += IMAGE_BUDGET_CHARS
      continue
    }
    // 助手行的工具结果图像同样以 base64 存在 blocks 里：按估算值计，不按真实长度
    if (block?.type === 'tool' && block.tool && typeof block.tool === 'object') {
      const tool = block.tool as { images?: unknown }
      if (Array.isArray(tool.images) && tool.images.length > 0) {
        const stripped = {
          ...block,
          tool: { ...(block.tool as Record<string, unknown>), images: undefined }
        }
        chars += JSON.stringify(stripped).length + tool.images.length * IMAGE_BUDGET_CHARS
        continue
      }
    }
    chars += JSON.stringify(block).length
  }
  return d.content.length + chars
}

/**
 * 规划本次回放允许带图的用户行：从新到旧累加，直到数量或字节预算用尽。
 * 返回这些行的 id 集合；集合外的行只回放文本。
 */
export function planReplayImages(selected: ReplayDialogue[]): Set<number> {
  const allowed = new Set<number>()
  let images = 0
  let chars = 0
  for (let i = selected.length - 1; i >= 0; i--) {
    const d = selected[i]
    if (d.role !== 'user') continue
    const urls = imagesOf(userBlocksOf(d))
    if (urls.length === 0) continue
    let fits = true
    for (const url of urls) {
      if (
        images + 1 > MAX_REPLAYED_IMAGES ||
        chars + url.length > MAX_REPLAYED_IMAGE_CHARS
      ) {
        fits = false
        break
      }
      images += 1
      chars += url.length
    }
    if (fits) allowed.add(d.id)
  }
  return allowed
}

/** 构造用户消息内容：文本 + 可回放的图片块；超出预算的图片退化为一句说明 */
export function userMessageContent(
  d: ReplayDialogue,
  allowImages: boolean
): string | MessageContentComplex[] {
  const urls = imagesOf(userBlocksOf(d))
  if (urls.length === 0) return d.content
  if (!allowImages) {
    return `${d.content}\n\n[Earlier image attachment omitted from replay to keep the context bounded; ask the user to re-attach it if it is still needed.]`
  }
  const content: MessageContentComplex[] = [{ type: 'text', text: d.content }]
  for (const url of urls) {
    content.push({ type: 'image_url', image_url: { url } })
  }
  return content
}

/**
 * 历史回放里「工具结果图像」的预算（read_image 等媒体工具）。
 *
 * 与用户贴图分开计：工具图像通常只服务当前任务，回放太多既贵又没意义；只保留最近
 * {@link MAX_REPLAYED_TOOL_IMAGES} 张。被观测清理（observation mask）替换掉的旧工具
 * 结果不再回放图像——调用方通过 maskedToolKeys（`<dialogueId>:<toolIndex>`）排除。
 */
export const MAX_REPLAYED_TOOL_IMAGES = 4
export const MAX_REPLAYED_TOOL_IMAGE_CHARS = 8 * 1024 * 1024

/** 一张待回放的工具结果图像 */
export interface ReplayedToolImage {
  dataUrl: string
  path: string
  /** 产生这张图的工具名（回放文案用） */
  tool: string
}

/**
 * 规划每条助手消息要回放的工具结果图像（按消息 id 分组，组内保持原始顺序）。
 *
 * 从新到旧分配预算，保证保留的总是最近出现的那几张；超出预算的图像直接丢弃
 * （模型看到的对应工具结果文本里仍有路径，可以重新 read_image）。
 */
export function planReplayToolImages(
  selected: ReplayDialogue[],
  maskedToolKeys: Set<string> = new Set()
): Map<number, ReplayedToolImage[]> {
  const byDialogue = new Map<number, ReplayedToolImage[]>()
  let images = 0
  let chars = 0

  for (let i = selected.length - 1; i >= 0; i--) {
    const d = selected[i]
    if (d.role !== 'assistant') continue
    const blocks = userBlocksOf(d)
    if (!blocks) continue
    const toolBlocks = blocks.filter((block) => block?.type === 'tool')
    for (let ti = toolBlocks.length - 1; ti >= 0; ti--) {
      if (maskedToolKeys.has(`${d.id}:${ti}`)) continue
      const tool = toolBlocks[ti].tool as
        | { name?: unknown; images?: unknown }
        | undefined
      if (!tool || !Array.isArray(tool.images) || tool.images.length === 0) continue
      const toolName = typeof tool.name === 'string' ? tool.name : 'tool'
      for (let ii = tool.images.length - 1; ii >= 0; ii--) {
        const image = tool.images[ii] as { dataUrl?: unknown; path?: unknown } | null
        if (!image || typeof image.dataUrl !== 'string') continue
        if (
          images + 1 > MAX_REPLAYED_TOOL_IMAGES ||
          chars + image.dataUrl.length > MAX_REPLAYED_TOOL_IMAGE_CHARS
        ) {
          continue
        }
        images += 1
        chars += image.dataUrl.length
        const row = byDialogue.get(d.id) ?? []
        row.unshift({
          dataUrl: image.dataUrl,
          path: typeof image.path === 'string' ? image.path : '',
          tool: toolName
        })
        byDialogue.set(d.id, row)
      }
    }
  }
  return byDialogue
}
