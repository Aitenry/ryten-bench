import { HumanMessage } from '../../ai/messages'

/**
 * Uploaded file info (path already copied into the agent filesystem)
 */
export interface UploadedFileRef {
  fileName: string
  /** Virtual path in the agent filesystem, e.g. /uploads/report.pdf */
  virtualPath: string
}

/**
 * Build a HumanMessage, with multimodal (image + text) support.
 *
 * Document attachments are not embedded directly; the agent is told the file path and reads them
 * on demand with the read_file tool. Context management is built in:
 * - read results for large files over 20K tokens are written to /large_tool_results/
 * - once context exceeds 85%, old tool calls are replaced with file pointers
 * - finally falls back to summary compression
 */
export function buildHumanMessage(
  text: string,
  images?: string[],
  documents?: UploadedFileRef[]
): HumanMessage {
  let fullText = text

  // Tell the agent where uploaded files live so it can read them on demand with read_file
  if (documents && documents.length > 0) {
    const fileList = documents.map((doc) => `- \`${doc.virtualPath}\` (${doc.fileName})`).join('\n')
    fullText += `\n\n## Uploaded files\nThe following files are now available in your filesystem. Use the read_file tool to read them as needed:\n${fileList}`
  }

  if (!images || images.length === 0) {
    return new HumanMessage(fullText)
  }

  // Multimodal message: text + images
  const content: { type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }[] = [
    { type: 'text', text: fullText }
  ]

  for (const img of images) {
    content.push({
      type: 'image_url',
      image_url: { url: img }
    })
  }

  return new HumanMessage({ content })
}
