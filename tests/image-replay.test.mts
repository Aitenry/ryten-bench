/**
 * 历史回放图片投影的回归测试（纯逻辑，不需要 Electron）。
 *
 * 跑法：`node --no-warnings tests/image-replay.test.mts`
 *
 * 覆盖：
 * - 图片只回放最近 N 张（超出预算的退化为文本说明）；
 * - base64 字节预算生效（即使张数没超）；
 * - 历史字符预算里图片按固定估算计入，而不是按 base64 真实长度；
 * - 无图片的行按纯文本回放，坏 blocks 不抛错。
 */
import assert from 'node:assert/strict'
import {
  IMAGE_BUDGET_CHARS,
  MAX_REPLAYED_IMAGES,
  MAX_REPLAYED_TOOL_IMAGES,
  dialogueBudgetChars,
  planReplayImages,
  planReplayToolImages,
  userMessageContent,
  type ReplayDialogue
} from '../src/main/runtime/harness/image-replay.ts'

const DATA_URL = `data:image/png;base64,${'A'.repeat(1000)}`
const imageBlocks = JSON.stringify([{ type: 'image', image_url: DATA_URL }])

const userRow = (id: number, blocks: string | null = imageBlocks): ReplayDialogue => ({
  id,
  role: 'user',
  content: `question ${id}`,
  blocks
})

// ── 1. 只回放最近 N 张 ────────────────────────────────────────────────
const rows = Array.from({ length: MAX_REPLAYED_IMAGES + 2 }, (_, i) => userRow(i + 1))
const allowed = planReplayImages(rows)
assert.equal(allowed.size, MAX_REPLAYED_IMAGES)
// 新的进预算、老的被排除
assert.equal(allowed.has(MAX_REPLAYED_IMAGES + 2), true)
assert.equal(allowed.has(1), false)

// ── 2. 字节预算：张数没超但 base64 太大时同样退化 ─────────────────────
const huge = `data:image/png;base64,${'B'.repeat(5 * 1024 * 1024)}`
const hugeRows: ReplayDialogue[] = [1, 2, 3, 4].map((id) => ({
  id,
  role: 'user',
  content: `q${id}`,
  blocks: JSON.stringify([{ type: 'image', image_url: huge }])
}))
const hugeAllowed = planReplayImages(hugeRows)
// 5MB × 3 = 15MB > 12MB 上限 → 最多 2 张
assert.equal(hugeAllowed.size, 2)
assert.equal(hugeAllowed.has(4), true)
assert.equal(hugeAllowed.has(3), true)
assert.equal(hugeAllowed.has(1), false)

// ── 3. 历史字符预算：图片按估算值而不是 base64 长度 ──────────────────
const bigRow: ReplayDialogue = {
  id: 9,
  role: 'user',
  content: 'look',
  blocks: JSON.stringify([{ type: 'image', image_url: `data:image/png;base64,${'C'.repeat(500_000)}` }])
}
const budget = dialogueBudgetChars(bigRow)
assert.ok(budget < 3000, `image budget should be small, got ${budget}`)
assert.ok(budget >= IMAGE_BUDGET_CHARS + 'look'.length)
// 非用户行仍按原始 blocks 长度计数
assert.equal(
  dialogueBudgetChars({ id: 1, role: 'assistant', content: 'x', blocks: 'abcdef' }),
  7
)

// ── 4. 内容构造与退化文案 ─────────────────────────────────────────────
const withImage = userMessageContent(userRow(1), true)
assert.ok(Array.isArray(withImage))
assert.deepEqual(withImage[0], { type: 'text', text: 'question 1' })
assert.deepEqual(withImage[1], { type: 'image_url', image_url: { url: DATA_URL } })

const omitted = userMessageContent(userRow(2), false)
assert.equal(typeof omitted, 'string')
assert.ok((omitted as string).includes('omitted from replay'))
assert.ok((omitted as string).startsWith('question 2'))

const plain = userMessageContent({ id: 3, role: 'user', content: 'no image' }, true)
assert.equal(plain, 'no image')

// 坏 blocks：不抛错，当纯文本处理
const broken: ReplayDialogue = { id: 4, role: 'user', content: 'broken', blocks: '{not json' }
assert.equal(planReplayImages([broken]).size, 0)
assert.equal(userMessageContent(broken, true), 'broken')
assert.equal(dialogueBudgetChars(broken), 'broken'.length + '{not json'.length)


// ── 5. 工具结果图像（read_image）的回放规划与预算 ─────────────────────
const toolRow = (id: number, count = 1, name = 'read_image'): ReplayDialogue => ({
  id,
  role: 'assistant',
  content: `answer ${id}`,
  blocks: JSON.stringify([
    { type: 'text', text: `answer ${id}` },
    {
      type: 'tool',
      tool: {
        name,
        input: { file_path: '/shot.png' },
        output: 'read image',
        images: Array.from({ length: count }, (_, index) => ({
          dataUrl: `data:image/png;base64,${String(index).repeat(100)}`,
          path: `/shot-${index}.png`
        }))
      }
    }
  ])
})

// 字符预算：助手行的工具图像按估算值计，不按 base64 真实长度
const toolBudget = dialogueBudgetChars(toolRow(1))
assert.ok(toolBudget < 3000, `tool image budget should be small, got ${toolBudget}`)
assert.ok(toolBudget >= IMAGE_BUDGET_CHARS)

// 只回放最近 N 张（从新到旧），且组内保持原始顺序
const toolRows = [1, 2, 3, 4, 5, 6].map((id) => toolRow(id))
const plannedTools = planReplayToolImages(toolRows)
assert.equal(
  [...plannedTools.values()].reduce((sum, row) => sum + row.length, 0),
  MAX_REPLAYED_TOOL_IMAGES
)
assert.equal(plannedTools.has(6), true)
assert.equal(plannedTools.has(5), true)
assert.equal(plannedTools.has(1), false)

// 被观测清理（masked）的工具块不回放图像
const maskedPlanned = planReplayToolImages([toolRow(1), toolRow(2)], new Set(['2:0']))
assert.equal(maskedPlanned.has(2), false)
assert.equal(maskedPlanned.get(1)?.length, 1)

// 同一条消息里的两张图保持原始顺序
const twoImages = planReplayToolImages([toolRow(9, 2)])
assert.deepEqual(
  twoImages.get(9)?.map((image) => image.path),
  ['/shot-0.png', '/shot-1.png']
)
assert.equal(twoImages.get(9)?.[0].tool, 'read_image')

// 没有图像的助手行不产生回放项
const noImages: ReplayDialogue = {
  id: 10,
  role: 'assistant',
  content: 'plain',
  blocks: JSON.stringify([{ type: 'tool', tool: { name: 'read_file', output: 'x' } }])
}
assert.equal(planReplayToolImages([noImages]).size, 0)

console.log('image-replay: all assertions passed')
