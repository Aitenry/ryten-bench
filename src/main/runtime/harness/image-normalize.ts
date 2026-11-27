/**
 * 图像规范化决策（纯逻辑，无 electron 依赖，可离线测试）。
 *
 * 对照 DSH 的附件规范化（normalized attachment）：DSH 会把上传/读取的图片按像素预算
 * 等比缩放、必要时重编码，再按路由预算生成请求版本。本项目当前没有附件存储，先在
 * `read_image` 这一层做**最小规范化**：
 *
 * - 长边超过 {@link DEFAULT_IMAGE_LIMITS.maxDimension} → 等比缩到上限；
 * - 尺寸不大但编码字节超预算 → 同尺寸重编码（通常是截图存成 BMP/PNG 的情况）；
 * - GIF 一律保持原样（重编码会丢动画）；其它不确定情况（解码失败等）也保持原样。
 *
 * 决策与执行分离：本模块只回答「要不要缩放/重编码、目标尺寸多少」，真正的解码/编码
 * 由 fs-backend 用 Electron `nativeImage` 完成。
 */

/** 单边像素上限（与 DSH 的 normalizedImageMaxDimension 默认值一致） */
export const DEFAULT_MAX_DIMENSION = 2048
/** 规范化后编码字节的目标上限 */
export const DEFAULT_MAX_BYTES = 1_500_000

export interface ImageFacts {
  width: number
  height: number
  /** 原始编码字节数（不是解码后的像素内存） */
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

/** 等比缩放后的像素尺寸（向内取整，至少 1px；不放大） */
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
 * 决定这张图是否需要处理。
 *
 * 注意：不认识的尺寸（解码失败时 width=0）一律 keep，由调用方退回原图。
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
