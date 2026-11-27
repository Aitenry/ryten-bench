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
  if (d.role !== 'user' || !d.blocks) return d.content.length + (d.blocks?.length ?? 0)
  const blocks = userBlocksOf(d)
  if (!blocks) return d.content.length + d.blocks.length
  let chars = 0
  for (const block of blocks) {
    if (block?.type === 'image' && typeof block.image_url === 'string') {
      chars += IMAGE_BUDGET_CHARS
    } else {
      chars += JSON.stringify(block).length
    }
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
