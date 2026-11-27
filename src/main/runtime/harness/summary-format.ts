/**
 * 压缩摘要的输出清洗（纯函数，便于单测）。
 *
 * 摘要提示词要求模型先写 `<analysis>` 草稿、再把最终 checkpoint 放进 `<summary>`：
 * - 草稿用来提升召回（先梳理再下结论），**不进入上下文**；
 * - 最终产物只保留 `<summary>` 里的正文。
 *
 * 模型没按格式输出时（老模型 / 网关截断）做降级：删掉 analysis、保留其余文本，
 * 宁可多留一点，也不要因为格式不符把整份摘要丢掉。
 */
export function extractCheckpointText(raw: string): string {
  const text = (raw ?? '').trim()
  if (!text) return ''

  // 先整体剥掉 <analysis> 草稿：否则草稿里若提到 "<summary>" 字样，下面的正则会被带偏
  const withoutAnalysis = text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim()

  const summaryMatch = withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (summaryMatch) return summaryMatch[1].trim()

  // 没有 <summary> 包裹（模型没按格式输出）：清掉残留标签，保留其余内容
  return withoutAnalysis.replace(/<\/?summary>/gi, '').trim()
}
