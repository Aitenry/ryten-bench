/**
 * Projection of user images during history replay (pure functions, testable offline).
 *
 * Background: images the user pasted are stored as full data URLs in `harness_dialogue.blocks`.
 * Early replay restored only text, so images "disappeared" from the second round on; replaying
 * everything would make every round of a long conversation carry all the base64 data. The minimal
 * workable projection rules are:
 *
 * - Replay only the most recent {@link MAX_REPLAYED_IMAGES} images, with the total base64 size no
 *   more than {@link MAX_REPLAYED_IMAGE_CHARS};
 * - Images over budget degrade to a one-line explanation (the model knows "there was an image here"
 *   and can ask the user to re-attach it);
 * - In the history character budget, an image counts as {@link IMAGE_BUDGET_CHARS} rather than its
 *   real base64 length (otherwise a single image would eat the whole history budget; real tokens
 *   come from the usage reported by the provider).
 */
import type { MessageContentComplex } from '../../ai/messages'

/** Budget for replayed images */
export const MAX_REPLAYED_IMAGES = 6
export const MAX_REPLAYED_IMAGE_CHARS = 12 * 1024 * 1024
/** Character estimate for one image in the history budget (about 1.2k tokens) */
export const IMAGE_BUDGET_CHARS = 1200

/** Minimal dialogue fields needed for the projection (compatible with HistoryDialogue, avoiding a dependency on database types) */
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

/** Parse a user row's blocks; empty/bad data returns null (treated as having no blocks) */
export function userBlocksOf(d: Pick<ReplayDialogue, 'blocks'>): UserDialogueBlock[] | null {
  if (!d.blocks) return null
  try {
    const parsed: unknown = JSON.parse(d.blocks)
    return Array.isArray(parsed) ? (parsed as UserDialogueBlock[]) : null
  } catch {
    return null
  }
}

/** Images declared in a user row (original order preserved) */
function imagesOf(blocks: UserDialogueBlock[] | null): string[] {
  if (!blocks) return []
  const urls: string[] = []
  for (const block of blocks) {
    if (block?.type === 'image' && typeof block.image_url === 'string') urls.push(block.image_url)
  }
  return urls
}

/** Character count one dialogue contributes to the history budget (images use the estimate, everything else its real length) */
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
    // Tool-result images on assistant rows are also stored as base64 in blocks: count them at the
    // estimate, not at their real length
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
 * Plan which user rows may carry images in this replay: accumulate from newest to oldest until the
 * count or byte budget runs out. Returns the set of these row ids; rows outside the set replay text
 * only.
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

/** Build user message content: text + replayable image blocks; images over budget degrade to a one-line explanation */
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
 * Budget for "tool result images" in history replay (media tools such as read_image).
 *
 * Counted separately from user-pasted images: tool images usually only serve the current task, and
 * replaying too many is both expensive and pointless; only the most recent
 * {@link MAX_REPLAYED_TOOL_IMAGES} are kept. Old tool results replaced by the observation mask no
 * longer replay their images — the caller excludes them through maskedToolKeys
 * (`<dialogueId>:<toolIndex>`).
 */
export const MAX_REPLAYED_TOOL_IMAGES = 4
export const MAX_REPLAYED_TOOL_IMAGE_CHARS = 8 * 1024 * 1024

/** A tool result image waiting to be replayed */
export interface ReplayedToolImage {
  dataUrl: string
  path: string
  /** Name of the tool that produced this image (used by the replay copy) */
  tool: string
}

/**
 * Plan the tool result images to replay for each assistant message (grouped by message id, keeping
 * the original order within a group).
 *
 * Budget is allocated from newest to oldest, so the images kept are always the most recent ones;
 * images over budget are dropped (the corresponding tool result text the model sees still contains
 * the path, so it can read_image again).
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
