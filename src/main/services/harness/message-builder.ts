import { HumanMessage } from '@langchain/core/messages'

/**
 * 上传文件信息（已复制到 agent 文件系统中的路径）
 */
export interface UploadedFileRef {
  fileName: string
  /** agent 文件系统中的虚拟路径，如 /uploads/report.pdf */
  virtualPath: string
}

/**
 * 构建 HumanMessage，支持多模态（图片 + 文本）
 *
 * 文档附件不直接嵌入内容，而是告知 agent 文件路径，让 agent 通过
 * read_file 工具按需读取。DeepAgents 框架内置了上下文管理：
 * - 大文件读取结果 > 20K token 自动写入 /large_tool_results/
 * - 上下文超 85% 时旧工具调用替换为文件指针
 * - 最终回退到摘要压缩
 */
export function buildHumanMessage(
  text: string,
  images?: string[],
  documents?: UploadedFileRef[]
): HumanMessage {
  let fullText = text

  // 告知 agent 上传文件的位置，让 agent 自行用 read_file 按需读取
  if (documents && documents.length > 0) {
    const fileList = documents.map((doc) => `- \`${doc.virtualPath}\` (${doc.fileName})`).join('\n')
    fullText += `\n\n## Uploaded files\nThe following files are now available in your filesystem. Use the read_file tool to read them as needed:\n${fileList}`
  }

  if (!images || images.length === 0) {
    return new HumanMessage(fullText)
  }

  // 多模态消息：文本 + 图片
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
