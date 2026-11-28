/**
 * Image normalization decisions (pure logic, no electron dependency, testable offline).
 *
 * Current minimal normalization at the `read_image` layer (this project has no attachment storage
 * yet):
 *
 * - longest side above {@link DEFAULT_IMAGE_LIMITS.maxDimension} → scale down proportionally to the
 *   limit;
 * - dimensions are within limits but encoded bytes exceed the budget → re-encode at the same size
 *   (usually screenshots saved as BMP/PNG);
 * - GIF always stays as-is (re-encoding would lose animation); other uncertain cases (decode failure
 *   etc.) also stay as-is.
 *
 * Decisions and execution are separated: this module only answers "should this be scaled/re-encoded
 * and what is the target size", while the actual decoding/encoding is done by fs-backend with
 * Electron `nativeImage`.
 */

/** Single-side pixel limit (same default as normalizedImageMaxDimension) */
export const DEFAULT_MAX_DIMENSION = 2048
/** Target byte cap for the normalized encoding */
export const DEFAULT_MAX_BYTES = 1_500_000

export interface ImageFacts {
  width: number
  height: number
  /** Original encoded byte count (not decoded pixel memory) */
  bytes: number
  mimeType: string
}

export interface NormalizeLimits {
  maxDimension: number
  maxBytes: number
}

export const DEFAULT_IMAGE_LIMITS: NormalizeLimits = {
  maxDimension: DEFAULT_MAX_DIMENSION,
  maxBytes: DEFAULT_MAX_BYTES
}

export type NormalizeDecision =
  | { action: 'keep' }
  | {
      action: 'resize' | 'reencode'
      width: number
      height: number
      reason: 'dimension' | 'bytes'
    }

/** Pixel dimensions after proportional scaling (rounded down, at least 1px; never upscales) */
export function scaleToFit(
  width: number,
  height: number,
  maxDimension: number
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0 }
  }
  const longest = Math.max(width, height)
  if (longest <= maxDimension) return { width: Math.round(width), height: Math.round(height) }
  const scale = maxDimension / longest
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale))
  }
}

/**
 * Decide whether this image needs processing.
 *
 * Note: unknown dimensions (width=0 when decoding fails) always keep, letting the caller fall back
 * to the original image.
 */
export function planImageNormalization(
  facts: ImageFacts,
  limits: NormalizeLimits = DEFAULT_IMAGE_LIMITS
): NormalizeDecision {
  const { width, height, bytes, mimeType } = facts
  if (mimeType === 'image/gif') return { action: 'keep' }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { action: 'keep' }
  }
  const maxDimension = Math.max(1, Math.floor(limits.maxDimension))
  const maxBytes = Math.max(1, Math.floor(limits.maxBytes))
  if (Math.max(width, height) > maxDimension) {
    const scaled = scaleToFit(width, height, maxDimension)
    return { action: 'resize', ...scaled, reason: 'dimension' }
  }
  if (bytes > maxBytes) {
    return { action: 'reencode', width: Math.round(width), height: Math.round(height), reason: 'bytes' }
  }
  return { action: 'keep' }
}

/** Parse the MIME and raw bytes out of a data URL (returns null on failure) */
export function parseImageDataUrl(
  dataUrl: string
): { mimeType: string; bytes: Buffer } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl ?? '')
  if (!match || !match[2]) return null
  try {
    const bytes = Buffer.from(match[3], 'base64')
    if (bytes.length === 0) return null
    return { mimeType: (match[1] || 'application/octet-stream').toLowerCase(), bytes }
  } catch {
    return null
  }
}
