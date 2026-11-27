/**
 * read_image 纯逻辑回归：格式嗅探、尺寸解析、大小上限、失败分支与「文本 + 图像」结果契约。
 *
 * 跑法：`node --no-warnings tests/read-image.test.mts`
 *
 * 覆盖：
 * - 按魔数识别 PNG / JPEG / GIF / WebP，未知字节返回 null（不信任扩展名）；
 * - PNG / GIF / JPEG / WebP(VP8X) 的像素尺寸解析；
 * - 读文件：不存在 → read-failed；目录 → not-file；超上限 → too-large（先 stat 再读，
 *   不把大文件读进内存）；非图片 → unsupported；
 * - 正常图片产出 data URL、字节数与尺寸；
 * - toolMedia / isToolMediaResult 的围墙（缺字段、错类型都判 false）。
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  MAX_IMAGE_BYTES,
  imageDimensions,
  isToolMediaResult,
  readImageFile,
  sniffImageMime,
  toolMedia
} from '../src/main/runtime/harness/image-tool.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-read-image-'))
const file = (name: string, bytes: Buffer): string => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, bytes)
  return p
}

// ── 1. 魔数嗅探 ────────────────────────────────────────────────────────
const png = Buffer.alloc(33)
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
png.writeUInt32BE(640, 16)
png.writeUInt32BE(480, 20)

const gif = Buffer.alloc(16)
Buffer.from('GIF89a', 'ascii').copy(gif, 0)
gif.writeUInt16LE(320, 6)
gif.writeUInt16LE(200, 8)

const jpeg = Buffer.from([
  0xff, 0xd8, // SOI
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00,
  0x01, 0x00, 0x00, // APP0, length 16
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xf0, 0x01, 0x40, 0x03, // SOF0: h=240 w=320
  0x01, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01 // 组件
])

const webp = Buffer.alloc(30)
Buffer.from('RIFF', 'ascii').copy(webp, 0)
webp.writeUInt32LE(22, 4)
Buffer.from('WEBP', 'ascii').copy(webp, 8)
Buffer.from('VP8X', 'ascii').copy(webp, 12)
webp.writeUInt32LE(10, 16)
webp[24] = 0x3f // width-1 = 63 → 64
webp[27] = 0x1f // height-1 = 31 → 32

assert.equal(sniffImageMime(png), 'image/png')
assert.equal(sniffImageMime(gif), 'image/gif')
assert.equal(sniffImageMime(jpeg), 'image/jpeg')
assert.equal(sniffImageMime(webp), 'image/webp')
assert.equal(sniffImageMime(Buffer.from('not an image')), null)
assert.equal(sniffImageMime(Buffer.alloc(0)), null)

// ── 2. 尺寸解析 ────────────────────────────────────────────────────────
assert.deepEqual(imageDimensions(png, 'image/png'), { width: 640, height: 480 })
assert.deepEqual(imageDimensions(gif, 'image/gif'), { width: 320, height: 200 })
assert.deepEqual(imageDimensions(jpeg, 'image/jpeg'), { width: 320, height: 240 })
assert.deepEqual(imageDimensions(webp, 'image/webp'), { width: 64, height: 32 })
assert.equal(imageDimensions(Buffer.alloc(4), 'image/png'), undefined)

// ── 3. 读文件失败分支 ──────────────────────────────────────────────────
const missing = readImageFile(path.join(dir, 'nope.png'))
assert.equal(missing.ok, false)
assert.equal(missing.ok === false && missing.code, 'read-failed')

const asDir = readImageFile(dir)
assert.equal(asDir.ok === false && asDir.code, 'not-file')

const textFile = file('note.txt', Buffer.from('hello'))
const notImage = readImageFile(textFile)
assert.equal(notImage.ok === false && notImage.code, 'unsupported')

// 上限：先 stat 再拒绝，不读字节
const bigPath = path.join(dir, 'big.png')
fs.writeFileSync(bigPath, Buffer.alloc(MAX_IMAGE_BYTES + 1, 1))
const big = readImageFile(bigPath)
assert.equal(big.ok === false && big.code, 'too-large')
assert.equal(big.ok === false && big.bytes, MAX_IMAGE_BYTES + 1)

// ── 4. 正常读取 ────────────────────────────────────────────────────────
const pngPath = file('shot.png', png)
const ok = readImageFile(pngPath)
assert.equal(ok.ok, true)
if (ok.ok) {
  assert.equal(ok.mimeType, 'image/png')
  assert.equal(ok.bytes, png.length)
  assert.deepEqual(ok.dimensions, { width: 640, height: 480 })
  assert.ok(ok.dataUrl.startsWith('data:image/png;base64,'))
  const decoded = Buffer.from(ok.dataUrl.split(',')[1], 'base64')
  assert.deepEqual(decoded, png)
}

// ── 5. 「文本 + 图像」结果契约 ─────────────────────────────────────────
const media = toolMedia('read image', [
  { dataUrl: 'data:image/png;base64,AAAA', path: '/uploads/a.png', mimeType: 'image/png' }
])
assert.equal(isToolMediaResult(media), true)
assert.equal(isToolMediaResult({ text: 'x', images: [] }), false)
assert.equal(isToolMediaResult({ __toolMedia: true, text: 'x' }), false)
assert.equal(isToolMediaResult('plain string'), false)
assert.equal(isToolMediaResult(null), false)

fs.rmSync(dir, { recursive: true, force: true })
console.log('read-image: all assertions passed')
