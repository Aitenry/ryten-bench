/**
 * MCP 资源工具的纯格式化逻辑（无 electron / i18n 依赖，可离线测试）。
 *
 * 工具本身（tools/harness/mcp-resources.ts）只负责取数据与本地化文案，这里负责
 * 「服务器返回的资源记录 → 模型可读文本」以及「图片内容 → data URL」的转换。
 */

/** 一条资源记录（从 SDK 的 Resource 投影而来） */
export interface McpResourceRecord {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

/** 一条资源模板记录 */
export interface McpResourceTemplateRecord {
  uriTemplate: string
  name?: string
  description?: string
  mimeType?: string
}

/** 一条资源内容（text 或 base64 blob） */
export interface McpResourceContent {
  uri?: string
  mimeType?: string
  text?: string
  blob?: string
}

/** 资源工具需要的文案子树（由 i18n 模块按界面语言提供） */
export interface McpResourceTexts {
  listResources: { header: string; empty: string; item: string; nextCursor: string }
  listTemplates: { header: string; empty: string; item: string; nextCursor: string }
  read: { header: string; textPart: string; binaryPart: string; empty: string; imageNote: string }
}

/** 三个资源工具的完整文案（common + 各自子块），结构与 i18n 的 zhCNMcpToolTexts 兼容 */
export interface McpToolTexts extends McpResourceTexts {
  common: { unknownServer: string; noServers: string; failed: string }
}

/** 极简模板替换（`{{name}}`）：与主进程 i18n 的插值语法一致，抽出来避免依赖 electron */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = values[key]
    return value === undefined ? match : String(value)
  })
}

/**
 * 服务器名校验：返回 null 表示可用，否则是给模型看的提示文案。
 *
 * 一台都没连时给「先去设置里连一台」；名字写错时列出当前已连接的服务器名。
 */
export function serverErrorMessage(
  texts: McpToolTexts,
  server: string,
  servers: string[]
): string | null {
  if (servers.length === 0) return texts.common.noServers
  if (!servers.includes(server)) {
    return fill(texts.common.unknownServer, { server, servers: servers.join(', ') })
  }
  return null
}

/** 资源中的图片超过这个 base64 长度就不再内联（保持与工具图像持久化一致的有界性） */
export const MAX_RESOURCE_IMAGE_CHARS = 1_500_000

/** 能安全内联进模型消息的图片类型（与 read_image 的格式白名单一致） */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

type Format = (template: string, values: Record<string, string | number>) => string

/** 列表项的可选后缀：名字/mime 都没有时返回空串 */
function itemSuffix(name?: string, mimeType?: string): string {
  const parts: string[] = []
  if (name) parts.push(name)
  if (mimeType) parts.push(mimeType)
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

/** 资源列表 → 文本 */
export function formatResourceList(
  format: Format,
  texts: McpResourceTexts,
  server: string,
  resources: McpResourceRecord[],
  nextCursor?: string
): string {
  const header = format(texts.listResources.header, { server })
  if (resources.length === 0) {
    return `${header}\n\n${format(texts.listResources.empty, { server })}`
  }
  const lines = resources.map((resource) =>
    format(texts.listResources.item, {
      uri: resource.uri,
      name: itemSuffix(resource.name, resource.mimeType),
      mime: resource.description ? ` — ${resource.description}` : ''
    })
  )
  const tail = nextCursor ? format(texts.listResources.nextCursor, { cursor: nextCursor }) : ''
  return `${header}\n\n${lines.join('\n')}${tail}`
}

/** 资源模板列表 → 文本 */
export function formatTemplateList(
  format: Format,
  texts: McpResourceTexts,
  server: string,
  templates: McpResourceTemplateRecord[],
  nextCursor?: string
): string {
  const header = format(texts.listTemplates.header, { server })
  if (templates.length === 0) {
    return `${header}\n\n${format(texts.listTemplates.empty, { server })}`
  }
  const lines = templates.map((template) =>
    format(texts.listTemplates.item, {
      uriTemplate: template.uriTemplate,
      name: itemSuffix(template.name, template.mimeType),
      mime: template.description ? ` — ${template.description}` : ''
    })
  )
  const tail = nextCursor ? format(texts.listTemplates.nextCursor, { cursor: nextCursor }) : ''
  return `${header}\n\n${lines.join('\n')}${tail}`
}

export interface ReadResourceResult {
  text: string
  /** 图片内容（data URL）：上层用「文本 + 图像」工具结果送进模型 */
  images: Array<{ dataUrl: string; mimeType: string; uri: string }>
}

/**
 * 资源内容 → 文本 + 图片。
 *
 * - text 内容原样拼接；
 * - image/* 的 blob 在长度允许时转成 data URL（走工具图像通道，模型能直接看）；
 * - 其它二进制只给类型与大小（不把 base64 灌进上下文）。
 */
export function formatReadResult(
  format: Format,
  texts: McpResourceTexts,
  uri: string,
  contents: McpResourceContent[]
): ReadResourceResult {
  const header = format(texts.read.header, { uri })
  const parts: string[] = []
  const images: ReadResourceResult['images'] = []

  for (const content of contents) {
    const mimeType = content.mimeType ?? 'application/octet-stream'
    if (typeof content.text === 'string' && content.text.length > 0) {
      parts.push(format(texts.read.textPart, { text: content.text }))
      continue
    }
    if (typeof content.blob === 'string' && content.blob.length > 0) {
      const imageUri = content.uri ?? uri
      if (
        INLINE_IMAGE_TYPES.has(mimeType) &&
        content.blob.length <= MAX_RESOURCE_IMAGE_CHARS
      ) {
        images.push({
          dataUrl: `data:${mimeType};base64,${content.blob}`,
          mimeType,
          uri: imageUri
        })
        parts.push(format(texts.read.imageNote, { uri: imageUri }))
        continue
      }
      parts.push(
        format(texts.read.binaryPart, {
          mimeType,
          bytes: content.blob.length.toLocaleString()
        })
      )
    }
  }

  if (parts.length === 0) {
    return { text: `${header}\n\n${format(texts.read.empty, { uri })}`, images }
  }
  return { text: `${header}\n\n${parts.join('\n\n')}`, images }
}
