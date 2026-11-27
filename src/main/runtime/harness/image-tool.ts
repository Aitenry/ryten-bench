/**
 * 图片读取的纯逻辑（不依赖 electron / 数据库），供 `fs-backend` 的 `read_image` 工具与
 * 运行时工具节点共用。
 *
 * 为什么单独成模块：工具节点（agent.ts）要识别「文本 + 图像」这种工具结果，并把图像
 * 转成模型可看的内容块；而图片格式嗅探、尺寸解析是纯字节处理，抽出来才能被离线测试
 * 直接导入（tests/read-image.test.mts），不必启动 Electron。
 *
 * 与 DSH 的对应关系（对照 packages/fs/tool-fs 的 read_image）：DSH 把字节交给附件存储
 * 做规范化与内容寻址；本项目当前没有附件存储，所以这里直接产出 data URL（模型消息里
 * 用的就是这种形态），文件大小上限与格式白名单由本模块兜底。
 */
import * as fs from 'fs'

/** 单张图片读取上限（字节）。超过直接拒绝，避免把几十 MB 的图塞进上下文。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** 支持的图片 MIME 类型（与 read_image 的 schema 描述保持一致） */
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** 一次工具调用返回的图像（data URL + 虚拟路径，路径供模型再次读取/引用） */
export interface ToolImage {
  /** `data:image/png;base64,...` */
  dataUrl: string
  /** 虚拟路径（与调用参数一致，方便模型在后续轮次引用） */
  path: string
  mimeType: ImageMimeType
}

/**
 * 工具可以返回的「文本 + 图像」结果。
 *
 * 约定：工具返回该对象时，运行时把 `text` 作为工具结果文本，把 `images` 追加成一条
 * 紧随其后的用户消息（图像内容块）——OpenAI 兼容协议的工具消息不能带图，而用户消息
 * 在所有 provider 上都能承载图片。
 */
export interface ToolMediaResult {
  readonly __toolMedia: true
  text: string
  images: ToolImage[]
}

/** 判断工具返回值是否为「文本 + 图像」结果 */
export function isToolMediaResult(value: unknown): value is ToolMediaResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ToolMediaResult>
  return candidate.__toolMedia === true && typeof candidate.text === 'string' && Array.isArray(candidate.images)
}

/** 构造媒体结果（工具侧唯一入口，保证标记字段不会写错） */
export function toolMedia(text: string, images: ToolImage[]): ToolMediaResult {
  return { __toolMedia: true, text, images }
}

/** 按魔数判断图片类型（不看扩展名：扩展名只是声明，字节才是事实） */
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

/** 从字节里解析像素尺寸；无法解析时返回 undefined（不影响读取，只是少一条元信息） */
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
        // SOF0..SOF15（跳过 DHT/JPG/DAC 等非 SOF 标记）
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

/** readImageFile 的失败原因（由调用方翻译成界面语言） */
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
 * 读取一张磁盘图片：先 stat 判大小（避免无界缓冲），再按魔数校验格式，最后产出 data URL。
 *
 * @param realPath 已解析过的真实路径（调用方负责虚拟路径 → 真实路径的越界校验）
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
