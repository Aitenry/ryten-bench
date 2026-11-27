/**
 * 图像的**执行层**规范化：解码（Electron nativeImage）→ 按预算缩放/重编码 → data URL。
 *
 * 与 `image-normalize.ts` 的分工：那边只有「要不要处理、目标尺寸多少」的纯决策（可离线
 * 测试）；这里做真正的编解码，只在主进程可用。两条入口共用同一套规则：
 * - `read_image`（模型读磁盘图片）；
 * - 用户上传/粘贴的图片（对话附件）。
 *
 * 安全阀：解码失败、编码为空、编码后反而更大、格式不受支持（GIF 动画等）时一律退回原图。
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
  /** 是否真的做了缩放/重编码（false = 原样返回） */
  normalized: boolean
}

/** 原样返回（保留原 mime 与字节数） */
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
 * 规范化一个图片 data URL。
 *
 * 对非 data URL（http(s) 链接）与无法解析的内容原样返回，调用方无需特判。
 */
export function normalizeImageDataUrl(dataUrl: string): NormalizedImage {
  const parsed = parseImageDataUrl(dataUrl)
  if (!parsed) return keepOriginal(dataUrl, 'application/octet-stream', 0)

  // 以魔数为准：用户上传的扩展名不可信（与 read_image 同一原则）
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
