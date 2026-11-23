/**
 * 自研结构化输出解析器（替代 `@langchain/core/output_parsers` 的 StructuredOutputParser）。
 *
 * 项目里的用法只有一种：`StructuredOutputParser.fromZodSchema(schema).parse(text)`——
 * 模型输出一段（可能带 markdown 围栏的）JSON，先抽取 JSON，再用 zod 校验。
 * 校验失败抛错，调用方（graph/service/llm-invoke）会退回 json-llm-repair 修复路径。
 */
import type { z } from 'zod'
import { schemaToJsonSchema } from './tools'

/** 从模型输出里抽出第一个完整 JSON 值（对象或数组） */
export function extractJson(text: string): unknown {
  const raw = text.trim()
  if (!raw) throw new Error('Cannot parse structured output: empty content')

  // 1) 整段就是 JSON
  const direct = tryParse(raw)
  if (direct.ok) return direct.value

  // 2) 去掉 markdown 围栏后再试
  const fenced = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g
  for (const match of raw.matchAll(fenced)) {
    const candidate = match[1].trim()
    const parsed = tryParse(candidate)
    if (parsed.ok) return parsed.value
  }

  // 3) 扫描第一个平衡的 {...} / [...]
  const extracted = extractBalancedJson(raw)
  if (extracted !== undefined) {
    const parsed = tryParse(extracted)
    if (parsed.ok) return parsed.value
  }

  throw new Error(`Cannot parse structured output as JSON (first 200 chars): ${raw.slice(0, 200)}`)
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

/** 从任意文本里截出第一个括号平衡的 JSON 片段（正确处理字符串与转义） */
function extractBalancedJson(text: string): string | undefined {
  const start = text.search(/[[{]/)
  if (start < 0) return undefined
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === open) depth++
    else if (char === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/** zod 校验失败时的可读信息 */
function formatZodError(error: unknown): string {
  const issues = (error as { issues?: Array<{ path?: Array<string | number>; message?: string }> })
    ?.issues
  if (!Array.isArray(issues) || issues.length === 0) {
    return error instanceof Error ? error.message : String(error)
  }
  return issues
    .map((issue) => `${issue.path?.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ')
}

/**
 * 结构化输出解析器。
 *
 * `Schema` 只作为类型参数使用（不同模块可能传 zod v3 / v4 的 schema 类型），
 * 运行期按「有 safeParse 就当 zod schema」处理。
 */
export class StructuredOutputParser<Schema = unknown> {
  readonly schema: Schema

  constructor(schema: Schema) {
    this.schema = schema
  }

  static fromZodSchema<S>(schema: S): StructuredOutputParser<S> {
    return new StructuredOutputParser(schema)
  }

  /** 解析并校验（校验失败抛错） */
  parse(text: string): unknown {
    const json = extractJson(text)
    const schema = this.schema as unknown as {
      safeParse?: (value: unknown) => { success: boolean; data?: unknown; error?: unknown }
    }
    if (schema && typeof schema.safeParse === 'function') {
      const result = schema.safeParse(json)
      if (!result.success) {
        throw new Error(
          `Structured output failed schema validation: ${formatZodError(result.error)}`
        )
      }
      return result.data
    }
    return json
  }

  /** 给模型看的格式说明（提示词需要时可用） */
  getFormatInstructions(): string {
    const schema = schemaToJsonSchema(this.schema)
    return `Respond with a single JSON value that validates against this JSON Schema. Output only the JSON, without any prose or markdown fences:\n${JSON.stringify(schema)}`
  }
}

/** 兼容类型导出：调用方常写 `StructuredOutputParser<z.ZodTypeAny>` */
export type { z }
