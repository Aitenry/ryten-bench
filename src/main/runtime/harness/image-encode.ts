/**
 * **Execution-layer** image normalization: decode (Electron nativeImage) → scale/re-encode within
 * budget → data URL.
 *
 * Division of labor with `image-normalize.ts`: that file only holds the pure decisions ("should
 * this be processed, what is the target size") and can be tested offline; this file performs the
 * actual encoding/decoding and is only available in the main process. Both entry points share the
 * same rules:
 * - `read_image` (the model reading an image from disk);
 * - images uploaded/pasted by the user (conversation attachments).
 *
 * Safety valves: on decode failure, an empty encoding, an encoding larger than the original, or an
 * unsupported format (animated GIF etc.), always fall back to the original image.
 */
import { nativeImage } from 'electron'
import { imageDimensions, sniffImageMime, type ImageMimeType } from './image-tool'
import { parseImageDataUrl, planImageNormalization } from './image-normalize'

export interface NormalizedImage {
  dataUrl: string
  mimeType: string
  bytes: number
  width?: number
  height?: number
  /** Whether scaling/re-encoding actually happened (false = returned as-is) */
  normalized: boolean
}

/** Return as-is (keep the original mime and byte count) */
function keepOriginal(dataUrl: string, mimeType: string, bytes: number, dims?: { width: number; height: number }): NormalizedImage {
  return {
    dataUrl,
    mimeType,
    bytes,
    width: dims?.width,
    height: dims?.height,
    normalized: false
  }
}

/**
 * Normalize an image data URL.
 *
 * Non-data URLs (http(s) links) and unparsable content are returned as-is, so callers need no
 * special-casing.
 */
export function normalizeImageDataUrl(dataUrl: string): NormalizedImage {
  const parsed = parseImageDataUrl(dataUrl)
  if (!parsed) return keepOriginal(dataUrl, 'application/octet-stream', 0)

  // Trust the magic bytes: user-supplied extensions are unreliable (same principle as read_image)
  const sniffed = sniffImageMime(parsed.bytes)
  const mimeType = sniffed ?? parsed.mimeType
  const dims =
    sniffed !== null ? imageDimensions(parsed.bytes, sniffed as ImageMimeType) : undefined
  const decision = planImageNormalization({
    width: dims?.width ?? 0,
    height: dims?.height ?? 0,
    bytes: parsed.bytes.length,
    mimeType
  })
  if (decision.action === 'keep') {
    return keepOriginal(dataUrl, mimeType, parsed.bytes.length, dims)
  }

  try {
    const decoded = nativeImage.createFromBuffer(parsed.bytes)
    if (decoded.isEmpty()) return keepOriginal(dataUrl, mimeType, parsed.bytes.length, dims)
    const resized = decoded.resize({
      width: decision.width,
      height: decision.height,
      quality: 'good'
    })
    const outputMime: ImageMimeType = mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    const buffer = outputMime === 'image/jpeg' ? resized.toJPEG(85) : resized.toPNG()
    if (!buffer || buffer.length === 0 || buffer.length >= parsed.bytes.length) {
      return keepOriginal(dataUrl, mimeType, parsed.bytes.length, dims)
    }
    const size = resized.getSize()
    return {
      dataUrl: `data:${outputMime};base64,${buffer.toString('base64')}`,
      mimeType: outputMime,
      bytes: buffer.length,
      width: size.width,
      height: size.height,
      normalized: true
    }
  } catch {
    return keepOriginal(dataUrl, mimeType, parsed.bytes.length, dims)
  }
}
