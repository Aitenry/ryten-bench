/**
 * 图像规范化决策回归（`runtime/harness/image-normalize.ts`，纯逻辑）。
 *
 * 跑法：`node --no-warnings tests/image-normalize.test.mts`
 *
 * 覆盖：
 * - 小图/小字节 → 保持原样；
 * - 长边超限 → 等比缩放到上限（横图 / 竖图 / 方图，向内取整）；
 * - 尺寸不大但字节超预算 → 同尺寸重编码；
 * - GIF 永远保持原样（不丢动画）；
 * - 尺寸未知（解码失败）→ 保持原样；
 * - scaleToFit 的边界（不放大、非法尺寸、恰好等于上限）。
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_IMAGE_LIMITS,
  parseImageDataUrl,
  planImageNormalization,
  scaleToFit
} from '../src/main/runtime/harness/image-normalize.ts'

const facts = (width: number, height: number, bytes = 100_000, mimeType = 'image/png') => ({
  width,
  height,
  bytes,
  mimeType
})

// ── 1. keep ───────────────────────────────────────────────────────────
assert.deepEqual(planImageNormalization(facts(800, 600)), { action: 'keep' })
assert.deepEqual(planImageNormalization(facts(2048, 1024)), { action: 'keep' })
// 尺寸未知（解码失败）保持原样
assert.deepEqual(planImageNormalization(facts(0, 0)), { action: 'keep' })
assert.deepEqual(planImageNormalization(facts(Number.NaN, 100)), { action: 'keep' })

// ── 2. dimension resize（等比，向内取整） ────────────────────────────
assert.deepEqual(planImageNormalization(facts(4000, 3000)), {
  action: 'resize',
  width: 2048,
  height: 1536,
  reason: 'dimension'
})
assert.deepEqual(planImageNormalization(facts(3000, 4000)), {
  action: 'resize',
  width: 1536,
  height: 2048,
  reason: 'dimension'
})
assert.deepEqual(planImageNormalization(facts(5000, 5000)), {
  action: 'resize',
  width: 2048,
  height: 2048,
  reason: 'dimension'
})

// ── 3. bytes reencode（尺寸不变） ────────────────────────────────────
assert.deepEqual(planImageNormalization(facts(1000, 800, DEFAULT_IMAGE_LIMITS.maxBytes + 1)), {
  action: 'reencode',
  width: 1000,
  height: 800,
  reason: 'bytes'
})

// ── 4. GIF 不处理（动画） ────────────────────────────────────────────
assert.deepEqual(planImageNormalization(facts(4000, 3000, 5_000_000, 'image/gif')), {
  action: 'keep'
})

// ── 5. scaleToFit 边界 ───────────────────────────────────────────────
assert.deepEqual(scaleToFit(1024, 768, 2048), { width: 1024, height: 768 })
assert.deepEqual(scaleToFit(2048, 2048, 2048), { width: 2048, height: 2048 })
assert.deepEqual(scaleToFit(4096, 1024, 2048), { width: 2048, height: 512 })
assert.deepEqual(scaleToFit(0, 100, 2048), { width: 0, height: 0 })
assert.deepEqual(scaleToFit(-5, 100, 2048), { width: 0, height: 0 })


// ── 6. data URL 解析 ─────────────────────────────────────────────────
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
const parsedUrl = parseImageDataUrl(`data:image/png;base64,${pngBytes.toString('base64')}`)
assert.ok(parsedUrl)
if (parsedUrl) {
  assert.equal(parsedUrl.mimeType, 'image/png')
  assert.deepEqual(parsedUrl.bytes, pngBytes)
}
// 非 base64 / 空内容 / 非 data URL 都返回 null（调用方原样保留）
assert.equal(parseImageDataUrl('data:image/png,raw'), null)
assert.equal(parseImageDataUrl('data:image/png;base64,'), null)
assert.equal(parseImageDataUrl('https://example.com/a.png'), null)
assert.equal(parseImageDataUrl(''), null)

console.log('image-normalize: all assertions passed')
