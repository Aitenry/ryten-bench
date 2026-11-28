/**
 * Pure formatting logic for the MCP resource tools (no electron / i18n dependencies, so it can be
 * tested offline).
 *
 * The tools themselves (tools/harness/mcp-resources.ts) only fetch data and localize the text;
 * this module handles the conversion from "resource records returned by the server → model-readable
 * text" and from "image content → data URL".
 */

/** One resource record (projected from the SDK's Resource) */
export interface McpResourceRecord {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

/** One resource template record */
export interface McpResourceTemplateRecord {
  uriTemplate: string
  name?: string
  description?: string
  mimeType?: string
}

/** One piece of resource content (text or base64 blob) */
export interface McpResourceContent {
  uri?: string
  mimeType?: string
  text?: string
  blob?: string
}

/** Text subtree needed by the resource tools (supplied by the i18n module per UI language) */
export interface McpResourceTexts {
  listResources: { header: string; empty: string; item: string; nextCursor: string }
  listTemplates: { header: string; empty: string; item: string; nextCursor: string }
  read: { header: string; textPart: string; binaryPart: string; empty: string; imageNote: string }
}

/** Full text set of the three resource tools (common + per-tool blocks), structurally compatible with the i18n zhCNMcpToolTexts */
export interface McpToolTexts extends McpResourceTexts {
  common: { unknownServer: string; noServers: string; notSelected: string; failed: string }
}

/** Minimal template substitution (`{{name}}`): same interpolation syntax as main-process i18n, extracted here to avoid an electron dependency */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = values[key]
    return value === undefined ? match : String(value)
  })
}

/**
 * Server name validation: returns null when usable, otherwise a hint text shown to the model.
 *
 * Three cases are handled separately:
 *  - nothing connected: "connect a server in settings first";
 *  - wrong name: list the currently connected server names;
 *  - connected but not in this turn's allowed set (`allowed`): list the servers actually usable
 *    this turn — when A is selected but the model tries to read B, don't let it think B is down;
 *    tell it which one to use instead.
 */
export function serverErrorMessage(
  texts: McpToolTexts,
  server: string,
  connected: string[],
  allowed?: string[]
): string | null {
  if (connected.length === 0) return texts.common.noServers
  if (!connected.includes(server)) {
    return fill(texts.common.unknownServer, { server, servers: connected.join(', ') })
  }
  if (allowed && !allowed.includes(server)) {
    return fill(texts.common.notSelected, { server, servers: allowed.join(', ') || '—' })
  }
  return null
}

/** Images in a resource are no longer inlined beyond this base64 length (bounded like tool image persistence) */
export const MAX_RESOURCE_IMAGE_CHARS = 1_500_000

/** Image types that can be safely inlined into model messages (same format allowlist as read_image) */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

type Format = (template: string, values: Record<string, string | number>) => string

/** Optional suffix for a list item: empty string when neither name nor mime is present */
function itemSuffix(name?: string, mimeType?: string): string {
  const parts: string[] = []
  if (name) parts.push(name)
  if (mimeType) parts.push(mimeType)
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

/** Resource list → text */
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

/** Resource template list → text */
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
  /** Image content (data URL): the upper layer sends it to the model as a "text + image" tool result */
  images: Array<{ dataUrl: string; mimeType: string; uri: string }>
}

/**
 * Resource content → text + images.
 *
 * - text content is concatenated as-is;
 * - image/* blobs are converted to data URLs when length allows (via the tool image channel, so the
 *   model can look at them directly);
 * - other binary content reports only type and size (base64 is never poured into the context).
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
