/**
 * In-house structured output parser.
 *
 * There is only one usage in the project: `StructuredOutputParser.fromZodSchema(schema).parse(text)` —
 * the model outputs a JSON snippet (possibly wrapped in markdown fences); the JSON is extracted first
 * and then validated with zod. Validation failures throw, and the callers (graph/service/llm-invoke)
 * fall back to the json-llm-repair path.
 */
import type { z } from 'zod'
import { schemaToJsonSchema } from './tools'

/** Extract the first complete JSON value (object or array) from the model output */
export function extractJson(text: string): unknown {
  const raw = text.trim()
  if (!raw) throw new Error('Cannot parse structured output: empty content')

  // 1) The whole input is JSON
  const direct = tryParse(raw)
  if (direct.ok) return direct.value

  // 2) Retry after stripping the markdown fences
  const fenced = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g
  for (const match of raw.matchAll(fenced)) {
    const candidate = match[1].trim()
    const parsed = tryParse(candidate)
    if (parsed.ok) return parsed.value
  }

  // 3) Scan for the first balanced {...} / [...]
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

/** Extract the first brace-balanced JSON fragment from arbitrary text (handles strings and escapes) */
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

/** Readable information for a zod validation failure */
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
 * Structured output parser.
 *
 * `Schema` is used only as a type parameter (different modules may pass zod v3 / v4 schema types);
 * at runtime, anything that has `safeParse` is treated as a zod schema.
 */
export class StructuredOutputParser<Schema = unknown> {
  readonly schema: Schema

  constructor(schema: Schema) {
    this.schema = schema
  }

  static fromZodSchema<S>(schema: S): StructuredOutputParser<S> {
    return new StructuredOutputParser(schema)
  }

  /** Parse and validate (throws on validation failure) */
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

  /** Format instructions for the model (available when the prompt needs them) */
  getFormatInstructions(): string {
    const schema = schemaToJsonSchema(this.schema)
    return `Respond with a single JSON value that validates against this JSON Schema. Output only the JSON, without any prose or markdown fences:\n${JSON.stringify(schema)}`
  }
}

/** Compatibility type export: callers often write `StructuredOutputParser<z.ZodTypeAny>` */
export type { z }
