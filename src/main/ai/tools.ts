/**
 * In-house tool contract and factory.
 *
 * Tools in this project have exactly one shape: name + description + zod schema +
 * `invoke(args, config)`. This module only implements that:
 * - `tool(func, fields)`: wraps a plain function into a structured tool the model can call,
 *   validating arguments with zod before invocation;
 * - `jsonSchemaOf(tool)`: converts a zod schema into the JSON Schema each protocol expects
 *   (so the model can see the parameters);
 * - argument validation failures throw `ToolInputError`, and the error text is returned to the
 *   model directly (matching the previous implementation).
 */
import { z } from 'zod'

/** Tool invocation runtime config (signal / configurable injected during graph execution) */
export type ToolRunnableConfig = {
  signal?: AbortSignal
  configurable?: Record<string, unknown>
  [key: string]: unknown
}

/** Unified contract for in-project tools (plugin-contributed tools also satisfy this shape) */
export interface StructuredToolInterface<Args = unknown> {
  name: string
  description: string
  /** Argument schema (zod schema or JSON Schema object); the permission gate uses it to decide whether this is a "definition-type tool" */
  schema?: unknown
  invoke(args: Args, config?: ToolRunnableConfig): Promise<unknown>
  /** JSON Schema cache (internal use; external tools may omit it) */
  getJsonSchema?(): Record<string, unknown>
  /**
   * Parallel execution classifier.
   *
   * Must be a **purely synchronous** decision: only calls that return true may run in parallel
   * with other safe calls in the same batch; omission, false, or a thrown error all mean
   * exclusive treatment (acting as an ordering barrier). Only read-only/idempotent tools
   * (read, glob, web_fetch, …) should be marked safe; never mark write operations with side effects.
   */
  isConcurrencySafe?(args: Args): boolean
  /**
   * Cooperative timeout for a single call (milliseconds; 0/omitted = no deadline).
   *
   * Only bounds **host waiting**; it does not force-terminate I/O the tool is already doing
   * (tools must still observe the abort signal themselves). On timeout a clear result is
   * returned to the model and the turn continues. This field is not sent to the model
   * (the JSON Schema is derived solely from the tool's schema).
   */
  timeoutMs?: number
}

/** Argument validation failure (the message is returned to the model as the tool result so it can correct its arguments) */
export class ToolInputError extends Error {
  readonly toolName: string
  readonly issues: z.core.$ZodIssue[]

  constructor(toolName: string, issues: z.core.$ZodIssue[]) {
    super(formatIssues(toolName, issues))
    this.name = 'ToolInputError'
    this.toolName = toolName
    this.issues = issues
  }
}

function formatIssues(toolName: string, issues: z.core.$ZodIssue[]): string {
  const lines = issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `- ${path}: ${issue.message}`
  })
  return `Tool "${toolName}" input validation failed:\n${lines.join('\n')}`
}

type ToolFunction<Args> = (args: Args, config: ToolRunnableConfig) => unknown | Promise<unknown>

/** Tool definition fields */
export interface ToolDefinition<Schema = unknown> {
  name: string
  description?: string
  schema?: Schema
  /** Parallel execution classifier (see StructuredToolInterface.isConcurrencySafe) */
  isConcurrencySafe?: (args: unknown) => boolean
  /** Single-call timeout (milliseconds; see StructuredToolInterface.timeoutMs) */
  timeoutMs?: number
}

/** zod schema check: accepts both the project's zod v4 main entry and the zod/v4 subpath */
function isZodSchema(value: unknown): value is z.ZodType {
  if (!value || typeof value !== 'object') return false
  const candidate = value as {
    safeParse?: unknown
    parse?: unknown
    _zod?: unknown
    _def?: unknown
  }
  return typeof candidate.safeParse === 'function' && typeof candidate.parse === 'function'
}

/** zod schema → JSON Schema (draft-07; input view, optional parameters stay non-required) */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  try {
    const json = z.toJSONSchema(schema, {
      target: 'draft-7',
      io: 'input',
      // Unrepresentable zod constructs (transform, etc.) do not error; treat them as a permissive
      // schema so the whole tool round stays usable
      unrepresentable: 'any'
    }) as Record<string, unknown>
    // `$schema` is meaningless to the model, and some gateways 400 on unknown fields: never persist it
    delete json.$schema
    return json
  } catch {
    // Fallback: permissive empty object (arguments are passed through to the tool's own validation)
    return { type: 'object', additionalProperties: true }
  }
}

/** Read the JSON Schema from a tool instance (supports zod / ready-made JSON Schema / custom implementations) */
export function jsonSchemaOf(tool: StructuredToolInterface): Record<string, unknown> {
  if (typeof tool.getJsonSchema === 'function') {
    try {
      return tool.getJsonSchema()
    } catch {
      return { type: 'object', additionalProperties: true }
    }
  }
  return schemaToJsonSchema(tool.schema)
}

/** Any schema → JSON Schema */
export function schemaToJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema) return { type: 'object', properties: {} }
  if (isZodSchema(schema)) return zodToJsonSchema(schema)
  if (typeof schema === 'object') {
    const candidate = schema as Record<string, unknown>
    // Already a JSON Schema: pass it through directly (drop $schema to stay consistent with the zod path)
    if (candidate.type || candidate.properties || candidate.anyOf || candidate.oneOf) {
      const cloned: Record<string, unknown> = { ...candidate }
      delete cloned.$schema
      return cloned
    }
  }
  return { type: 'object', additionalProperties: true }
}

/**
 * Structured tool implementation: holds a zod schema and validates arguments before invoking.
 */
class DynamicStructuredTool<Args> implements StructuredToolInterface<Args> {
  readonly name: string
  readonly description: string
  readonly schema?: unknown
  readonly isConcurrencySafe?: (args: Args) => boolean
  readonly timeoutMs?: number
  private readonly func: ToolFunction<Args>
  private cachedJsonSchema?: Record<string, unknown>

  constructor(func: ToolFunction<Args>, fields: ToolDefinition) {
    this.func = func
    this.name = fields.name
    this.description = fields.description ?? ''
    this.schema = fields.schema
    this.isConcurrencySafe = fields.isConcurrencySafe as ((args: Args) => boolean) | undefined
    this.timeoutMs = fields.timeoutMs
  }

  getJsonSchema(): Record<string, unknown> {
    this.cachedJsonSchema ??= schemaToJsonSchema(this.schema)
    return this.cachedJsonSchema
  }

  async invoke(args: Args, config?: ToolRunnableConfig): Promise<unknown> {
    const parsed = this.parseArgs(args)
    return await this.func(parsed, config ?? {})
  }

  /** Validate arguments with the zod schema; non-zod schemas are passed through unchanged */
  private parseArgs(args: Args): Args {
    if (!isZodSchema(this.schema)) return args
    const result = this.schema.safeParse(args ?? {})
    if (!result.success) {
      throw new ToolInputError(this.name, result.error.issues)
    }
    return result.data as Args
  }
}

/** Create a structured tool (argument types are inferred automatically for zod schemas) */
export function tool<T extends z.ZodType>(
  func: ToolFunction<z.infer<T>>,
  fields: ToolDefinition<T>
): StructuredToolInterface<z.infer<T>>
export function tool<Args = Record<string, unknown>>(
  func: ToolFunction<Args>,
  fields: ToolDefinition
): StructuredToolInterface<Args>
export function tool(
  func: ToolFunction<unknown>,
  fields: ToolDefinition
): StructuredToolInterface<unknown> {
  return new DynamicStructuredTool(func, fields)
}
