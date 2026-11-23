/**
 * 自研工具契约与工厂（替代 `@langchain/core/tools`）。
 *
 * 项目里工具只有一种形态：名字 + 描述 + zod schema + `invoke(args, config)`。
 * 这里只实现这些：
 * - `tool(func, fields)`：把普通函数包成模型可调用的结构化工具，调用前用 zod 校验参数；
 * - `jsonSchemaOf(tool)`：把 zod schema 转成各家协议要的 JSON Schema（供模型看参数）；
 * - 参数校验失败抛 `ToolInputError`，错误文本直接回给模型（与旧实现一致）。
 */
import { z } from 'zod'

/** 工具调用运行配置（图执行时注入 signal / configurable） */
export type ToolRunnableConfig = {
  signal?: AbortSignal
  configurable?: Record<string, unknown>
  [key: string]: unknown
}

/** 项目内工具的统一契约（插件贡献的工具也满足这个形状） */
export interface StructuredToolInterface<Args = unknown> {
  name: string
  description: string
  /** 参数 schema（zod schema 或 JSON Schema 对象）；权限闸门据此判断是否为「定义类工具」 */
  schema?: unknown
  invoke(args: Args, config?: ToolRunnableConfig): Promise<unknown>
  /** JSON Schema 缓存（内部用；外部工具可不实现） */
  getJsonSchema?(): Record<string, unknown>
}

/** 参数校验失败（消息会作为工具结果回给模型，让它自己纠正参数） */
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

/** 工具定义字段 */
export interface ToolDefinition<Schema = unknown> {
  name: string
  description?: string
  schema?: Schema
}

/** zod schema 判定：同时兼容项目的 zod v4 主入口与 zod/v4 子路径 */
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

/** zod schema → JSON Schema（draft-07；取 input 视角，可选参数保持非必填） */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  try {
    const json = z.toJSONSchema(schema, {
      target: 'draft-7',
      io: 'input',
      // 无法表达的 zod 构造（transform 等）不报错，按宽松 schema 处理，避免整轮工具不可用
      unrepresentable: 'any'
    }) as Record<string, unknown>
    // `$schema` 对模型没有意义，个别网关还会因未知字段 400：统一不落盘
    delete json.$schema
    return json
  } catch {
    // 兜底：宽松空对象（参数原样透传给工具自己的校验）
    return { type: 'object', additionalProperties: true }
  }
}

/** 从工具实例取 JSON Schema（zod / 现成 JSON Schema / 自定义实现都支持） */
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

/** 任意 schema → JSON Schema */
export function schemaToJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema) return { type: 'object', properties: {} }
  if (isZodSchema(schema)) return zodToJsonSchema(schema)
  if (typeof schema === 'object') {
    const candidate = schema as Record<string, unknown>
    // 已经是 JSON Schema：直接透传（去掉 $schema 保持与 zod 路径一致）
    if (candidate.type || candidate.properties || candidate.anyOf || candidate.oneOf) {
      const cloned: Record<string, unknown> = { ...candidate }
      delete cloned.$schema
      return cloned
    }
  }
  return { type: 'object', additionalProperties: true }
}

/**
 * 结构化工具实现：持有 zod schema，invoke 时先校验再执行。
 */
class DynamicStructuredTool<Args> implements StructuredToolInterface<Args> {
  readonly name: string
  readonly description: string
  readonly schema?: unknown
  private readonly func: ToolFunction<Args>
  private cachedJsonSchema?: Record<string, unknown>

  constructor(func: ToolFunction<Args>, fields: ToolDefinition) {
    this.func = func
    this.name = fields.name
    this.description = fields.description ?? ''
    this.schema = fields.schema
  }

  getJsonSchema(): Record<string, unknown> {
    this.cachedJsonSchema ??= schemaToJsonSchema(this.schema)
    return this.cachedJsonSchema
  }

  async invoke(args: Args, config?: ToolRunnableConfig): Promise<unknown> {
    const parsed = this.parseArgs(args)
    return await this.func(parsed, config ?? {})
  }

  /** 用 zod schema 校验参数；非 zod schema 原样透传 */
  private parseArgs(args: Args): Args {
    if (!isZodSchema(this.schema)) return args
    const result = this.schema.safeParse(args ?? {})
    if (!result.success) {
      throw new ToolInputError(this.name, result.error.issues)
    }
    return result.data as Args
  }
}

/** 创建结构化工具（zod schema 时参数类型自动推导） */
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
