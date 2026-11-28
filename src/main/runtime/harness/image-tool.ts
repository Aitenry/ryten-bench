/**
 * Pure logic for image reading (no electron / database dependency), shared by the `fs-backend`
 * `read_image` tool and the runtime tool nodes.
 *
 * Why a separate module: tool nodes (agent.ts) must recognize the "text + image" tool result and
 * turn images into content blocks the model can see; image format sniffing and dimension parsing are
 * pure byte handling, so extracting them lets offline tests import them directly
 * (tests/read-image.test.mts) without starting Electron.
 *
 * This project has no attachment storage yet, so this module produces data URLs directly (that is
 * the form used in model messages); the file size limit and the format allowlist are enforced here.
 */
import * as fs from 'fs'

/** Per-image read limit (bytes). Anything larger is rejected to avoid stuffing tens of MB into the context. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Supported image MIME types (consistent with the read_image schema description) */
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** An image returned by one tool call (data URL + virtual path, so the model can read/reference it again) */
export interface ToolImage {
  /** `data:image/png;base64,...` */
  dataUrl: string
  /** Virtual path (same as the call argument, so the model can reference it in later rounds) */
  path: string
  mimeType: ImageMimeType
}

/**
 * The "text + image" result a tool may return.
 *
 * Convention: when a tool returns this object, the runtime uses `text` as the tool result text and
 * appends `images` as a user message (image content blocks) immediately after it — OpenAI-compatible
 * tool messages cannot carry images, while user messages can carry images on every provider.
 */
export interface ToolMediaResult {
  readonly __toolMedia: true
  text: string
  images: ToolImage[]
}

/** Whether a tool return value is a "text + image" result */
export function isToolMediaResult(value: unknown): value is ToolMediaResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ToolMediaResult>
  return candidate.__toolMedia === true && typeof candidate.text === 'string' && Array.isArray(candidate.images)
}

/** Build a media result (the only tool-side entry point, so the marker field cannot be misspelled) */
export function toolMedia(text: string, images: ToolImage[]): ToolMediaResult {
  return { __toolMedia: true, text, images }
}

/** Determine the image type from magic bytes (ignore the extension: the extension is only a claim, the bytes are the truth) */
export function sniffImageMime(buf: Buffer): ImageMimeType | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buf.length >= 6) {
    const head = buf.toString('ascii', 0, 6)
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
    if (head.startsWith('GIF8')) return 'image/gif'
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

/** Parse pixel dimensions from the bytes; returns undefined if unparsable (does not affect reading, just one less piece of metadata) */
export function imageDimensions(
  buf: Buffer,
  mimeType: ImageMimeType
): { width: number; height: number } | undefined {
  try {
    if (mimeType === 'image/png') {
      if (buf.length < 24) return undefined
      const width = buf.readUInt32BE(16)
      const height = buf.readUInt32BE(20)
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    if (mimeType === 'image/gif') {
      if (buf.length < 10) return undefined
      const width = buf.readUInt16LE(6)
      const height = buf.readUInt16LE(8)
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    if (mimeType === 'image/jpeg') {
      let offset = 2
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) {
          offset += 1
          continue
        }
        const marker = buf[offset + 1]
        // SOF0..SOF15 (skip non-SOF markers such as DHT/JPG/DAC)
        const isSof =
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        if (isSof) {
          const height = buf.readUInt16BE(offset + 5)
          const width = buf.readUInt16BE(offset + 7)
          return width > 0 && height > 0 ? { width, height } : undefined
        }
        const segmentLength = buf.readUInt16BE(offset + 2)
        if (segmentLength < 2) return undefined
        offset += 2 + segmentLength
      }
      return undefined
    }
    if (mimeType === 'image/webp') {
      const chunk = buf.toString('ascii', 12, 16)
      if (chunk === 'VP8X' && buf.length >= 30) {
        const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
        const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
        return { width, height }
      }
      if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
        const b0 = buf[21]
        const b1 = buf[22]
        const b2 = buf[23]
        const b3 = buf[24]
        const width = 1 + (((b1 & 0x3f) << 8) | b0)
        const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
        return width > 0 && height > 0 ? { width, height } : undefined
      }
      if (chunk === 'VP8 ' && buf.length >= 30) {
        const width = buf.readUInt16LE(26) & 0x3fff
        const height = buf.readUInt16LE(28) & 0x3fff
        return width > 0 && height > 0 ? { width, height } : undefined
      }
      return undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

/** Failure codes of readImageFile (translated into UI language by the caller) */
export type ReadImageFailureCode = 'not-file' | 'too-large' | 'unsupported' | 'read-failed'

export type ReadImageResult =
  | {
      ok: true
      mimeType: ImageMimeType
      /** data:image/...;base64,... */
      dataUrl: string
      bytes: number
      dimensions?: { width: number; height: number }
    }
  | { ok: false; code: ReadImageFailureCode; message: string; bytes?: number }

/**
 * Read an image from disk: stat first to check the size (avoid unbounded buffering), then validate
 * the format from the magic bytes, and finally produce a data URL.
 *
 * @param realPath Already-resolved real path (the caller is responsible for the virtual-path →
 * real-path traversal check)
 */
export function readImageFile(realPath: string, maxBytes = MAX_IMAGE_BYTES): ReadImageResult {
  let stat: fs.Stats
  try {
    stat = fs.statSync(realPath)
  } catch (err) {
    return { ok: false, code: 'read-failed', message: (err as Error).message }
  }
  if (!stat.isFile()) {
    return { ok: false, code: 'not-file', message: realPath }
  }
  if (stat.size > maxBytes) {
    return { ok: false, code: 'too-large', message: realPath, bytes: stat.size }
  }
  let buf: Buffer
  try {
    buf = fs.readFileSync(realPath)
  } catch (err) {
    return { ok: false, code: 'read-failed', message: (err as Error).message }
  }
  const mimeType = sniffImageMime(buf)
  if (!mimeType) {
    return { ok: false, code: 'unsupported', message: realPath, bytes: buf.length }
  }
  return {
    ok: true,
    mimeType,
    dataUrl: `data:${mimeType};base64,${buf.toString('base64')}`,
    bytes: buf.length,
    dimensions: imageDimensions(buf, mimeType)
  }
}
