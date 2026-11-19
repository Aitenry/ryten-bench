import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import logger from 'electron-log'
import { mainFormat, mainMessages } from '../../../../main/i18n'
import { questionService } from './ask'
import type { AskOption, AskQuestion } from './ask'

/**
 * 模型调用共享恢复逻辑（正文 model 节点与早期对话压缩摘要共用）
 *
 * - **失败分类只看 HTTP 状态码**（接口返回什么就是什么，不猜报文里的字眼）：
 *   4xx 是「这次请求本身有问题」，重发不会变好 → 不重试、直接报错；
 *   408 / 429 / 5xx 与「拿不到状态码的网络失败」→ 值得重试；
 * - **重试次数就是唯一的刹车**：可重试失败最多 MODEL_RETRY_LIMIT 次，之后要么弹一次
 *   「换模型继续」，要么按原错误收尾。曾经的问题（2026-09-23「模型不可用时报了错还一直重试」）
 *   一半出在这里不看预算，另一半出在 LangChain 自带的 6 次静默重发（见 provider/service.ts）；
 * - 用户取消（signal aborted）不重试；目标自动续跑轮（goal-round）不弹换模型。
 */

/** 可重试失败的自动重试上限与重试间隔 */
export const MODEL_RETRY_LIMIT = 2
export const MODEL_RETRY_DELAY_MS = 800

/** 换模型询问所需的上下文（模型调用方能提供的身份信息） */
export interface ModelRecoveryContext {
  topicId: number
  /** 调用来源：'user'（缺省）/ 'goal-round'（自动续跑轮，不询问换模型） */
  turnSource?: string
  /** 是否允许弹窗询问（子代理等场景禁止；缺省允许） */
  askEnabled?: boolean
  signal?: AbortSignal
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** 失败分类（只由状态码与取消信号得出） */
export type ModelErrorKind =
  | 'aborted'
  | 'auth'
  | 'not-found'
  | 'rejected'
  | 'rate-limit'
  | 'timeout'
  | 'server'
  | 'network'
  | 'unknown'

/** 分类结果（raw 保留供应商原文，日志与失败文案都要用） */
export interface ModelErrorInfo {
  kind: ModelErrorKind
  /** 接口返回的 HTTP 状态码（拿不到就是 undefined） */
  status?: number
  /**
   * 瞬时失败（408/429/5xx、连接类失败）：值得恢复——按预算原地重试，
   * 预算用尽还可以问用户要不要换模型继续。
   * 永久性失败（其余 4xx）为 false：重发同一个请求不会变好，直接报错，不弹窗。
   */
  transient: boolean
  /** 本次失败允许的重试次数（永久性失败 0，可重试失败 MODEL_RETRY_LIMIT） */
  retryLimit: number
  /** 本次失败耗时（只用于报错文案里的「等待 N 秒」） */
  elapsedMs: number
  raw: Error
}

/**
 * 取 HTTP 状态码：错误对象上的字段优先（openai/anthropic 等 SDK 都会挂 status），
 * 其次才从报文里读 `status_code=500` / `HTTP 500` 这类**显式状态码写法**——
 * 这一步只取数字，不做任何关键字匹配。
 */
function extractHttpStatus(error: Error, message: string): number | undefined {
  const carrier = error as unknown as {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
    cause?: { status?: unknown; statusCode?: unknown }
  }
  const candidates = [
    carrier.status,
    carrier.statusCode,
    carrier.response?.status,
    carrier.cause?.status,
    carrier.cause?.statusCode
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && candidate >= 100 && candidate < 600) return candidate
  }
  const fromMessage =
    /status[\s_-]?code[\s=:]+(\d{3})/i.exec(message) ?? /\bHTTP[\s:=]+(\d{3})\b/i.exec(message)
  return fromMessage ? Number(fromMessage[1]) : undefined
}

/**
 * 分类一次模型请求失败（纯函数）。
 *
 * | 状态码 | kind | 重试预算 |
 * |---|---|---|
 * | 401 / 403 | auth | 0（检查 API Key） |
 * | 404 | not-found | 0（检查模型名与接口地址） |
 * | 408 / 504 / 524 | timeout | MODEL_RETRY_LIMIT |
 * | 429 | rate-limit | MODEL_RETRY_LIMIT |
 * | 5xx | server | MODEL_RETRY_LIMIT |
 * | 其余 4xx | rejected | 0（请求本身有问题） |
 * | 无状态码（连接/网络类） | network | MODEL_RETRY_LIMIT |
 */
export function classifyModelError(error: Error, elapsedMs = 0): ModelErrorInfo {
  const message = error.message || String(error)
  const base = { elapsedMs, raw: error }
  if (error.name === 'AbortError' || (error as { code?: unknown }).code === 'ABORT_ERR') {
    return { ...base, kind: 'aborted', transient: false, retryLimit: 0 }
  }

  const status = extractHttpStatus(error, message)
  const info = (kind: ModelErrorKind, transient: boolean, retryLimit: number): ModelErrorInfo => ({
    ...base,
    kind,
    status,
    transient,
    retryLimit
  })

  if (status == null) return info('network', true, MODEL_RETRY_LIMIT)
  if (status === 401 || status === 403) return info('auth', false, 0)
  if (status === 404) return info('not-found', false, 0)
  if (status === 408 || status === 504 || status === 524) {
    return info('timeout', true, MODEL_RETRY_LIMIT)
  }
  if (status === 429) return info('rate-limit', true, MODEL_RETRY_LIMIT)
  if (status >= 500) return info('server', true, MODEL_RETRY_LIMIT)
  if (status >= 400) return info('rejected', false, 0)
  // 2xx/3xx 走到这里说明不是 HTTP 层失败（协议/解析类），按可重试处理
  return info('unknown', true, MODEL_RETRY_LIMIT)
}

/** 分类后的收尾说明（拼在供应商原文之前，解释「为什么停了」） */
function describeFailure(info: ModelErrorInfo, attempts: number): string {
  const m = mainMessages().modelFailure
  // 状态码可能来自错误对象也可能来自报文，也可能根本没有：统一在这里拼成
  // 「（HTTP 500）」整段，免得文案里留下空的括号
  const status = info.status != null ? `（HTTP ${info.status}）` : ''
  switch (info.kind) {
    case 'auth':
      return mainFormat(m.auth, { status })
    case 'not-found':
      return mainFormat(m.notFound, { status })
    case 'rejected':
      return mainFormat(m.rejected, { status })
    case 'timeout':
      return mainFormat(m.timeout, {
        status,
        seconds: Math.max(1, Math.round(info.elapsedMs / 1000)),
        count: attempts
      })
    case 'rate-limit':
      return mainFormat(m.rateLimit, { count: attempts })
    case 'server':
      return mainFormat(m.server, { status, count: attempts })
    case 'network':
      return mainFormat(m.network, { count: attempts })
    default:
      return m.other
  }
}

/** 收尾错误：message 是「分类说明：供应商原文」，kind/status 供上层判断 */
export class ModelRequestError extends Error {
  readonly kind: ModelErrorKind
  readonly status?: number

  constructor(info: ModelErrorInfo, attempts: number) {
    super(
      mainFormat(mainMessages().modelFailure.withReason, {
        summary: describeFailure(info, attempts),
        reason: info.raw.message
      })
    )
    this.name = 'ModelRequestError'
    this.kind = info.kind
    this.status = info.status
    this.cause = info.raw
  }
}

/** 一次带恢复语义的模型调用 */
export interface ModelCallRecovery<T> {
  /** 发起一次调用：重试时按同一份消息/参数重发（不重跑工具、不重放副作用由调用方保证） */
  call: () => Promise<T>
  ctx: ModelRecoveryContext
  /** 日志前缀，如 '[Agent]' / '[Compaction]' */
  label: string
  /** 重试进度：attempt 是第几次重试，retries 是本次失败允许的上限 */
  onRetry?: (attempt: number, retries: number) => void
  /** 换模型成功：调用方在此重新绑定新模型 */
  onSwitch?: (model: BaseChatModel) => void
  /** 时钟（工装注入假时钟用；缺省 Date.now） */
  now?: () => number
  /** 重试间隔（工装注入零延迟用；缺省 MODEL_RETRY_DELAY_MS） */
  retryDelayMs?: number
}

/**
 * 带「状态码分类 + 限次重试 + 换模型兜底」的模型调用。
 * 永久性失败（其余 4xx、取消）立即抛出，不重试也不弹窗；
 * 可重试失败（408/429/5xx/连接类）最多重试 MODEL_RETRY_LIMIT 次，之后（允许询问时）
 * 经 questionService.ask 挂起等待用户换模型，选好则在原调用位置继续。
 */
export async function invokeWithModelRecovery<T>(req: ModelCallRecovery<T>): Promise<T> {
  const now = req.now ?? Date.now
  const retryDelayMs = req.retryDelayMs ?? MODEL_RETRY_DELAY_MS
  let attempt = 0
  let switchOffered = false
  for (;;) {
    const startedAt = now()
    try {
      return await req.call()
    } catch (err) {
      const raw = err instanceof Error ? err : new Error(String(err))
      const info = classifyModelError(raw, now() - startedAt)
      if (info.kind === 'aborted' || req.ctx.signal?.aborted) throw err

      if (info.transient && attempt < info.retryLimit) {
        attempt += 1
        req.onRetry?.(attempt, info.retryLimit)
        logger.error(
          `${req.label} 模型请求失败（第 ${attempt}/${info.retryLimit} 次重试，仅重试本次调用，不重跑工具）:`,
          raw
        )
        await sleep(retryDelayMs)
        if (req.ctx.signal?.aborted) {
          const abortErr = new Error('Model request aborted')
          abortErr.name = 'AbortError'
          throw abortErr
        }
        continue
      }

      if (!info.transient) {
        logger.error(
          `${req.label} 模型请求失败且不可重试（${info.kind}${info.status != null ? ` / HTTP ${info.status}` : ''}），直接报错:`,
          raw
        )
      } else {
        logger.error(
          `${req.label} 模型请求重试耗尽（${info.kind}，重试 ${attempt} 次仍失败），向上抛错:`,
          raw
        )
      }

      // 换模型询问：只给「值得恢复」的失败一次机会（永久性错误换模型也解决不了当前这次请求的语义问题）
      if (
        info.transient &&
        !switchOffered &&
        req.ctx.askEnabled !== false &&
        req.ctx.topicId > 0 &&
        req.ctx.turnSource !== 'goal-round'
      ) {
        switchOffered = true
        const newModel = await askUserToSwitchModel(req.ctx, raw)
        if (newModel) {
          req.onSwitch?.(newModel)
          attempt = 0
          logger.info(`${req.label} 已切换用户选择的新模型，重置重试计数，在原位置继续执行`)
          continue
        }
        logger.warn(`${req.label} 用户放弃切换模型，按原错误结束本轮:`, raw.message)
      }
      throw new ModelRequestError(info, attempt)
    }
  }
}

/**
 * 向用户询问是否换模型继续，返回新模型实例；用户放弃返回 null。
 * 失败信息（kind='model-recovery'）经 ask 挂起通道广播，由前端专用
 * ModelRecoveryModal 展示；答案回写后在此解析为已启用供应商。
 * 信号中止（用户停止）时抛 AskAbortedError。
 */
export async function askUserToSwitchModel(
  ctx: ModelRecoveryContext,
  lastError: Error
): Promise<BaseChatModel | null> {
  const { getEnabledProviders } = await import('../../../../main/database/mapper/provider')
  const providers = await getEnabledProviders()
  // 界面文案按当前语言取一次：放弃项既要展示又要参与回填比较，
  // 必须用**同一次**取值，否则弹窗期间切语言会导致比较不上
  const m = mainMessages().modelRecovery
  const seen = new Set<string>()
  const options: AskOption[] = []
  for (const p of providers) {
    let label = `${p.name} · ${p.model}`
    // 同名（name/model 相同）但供应商/端点不同的行：追加 provider 类型保证选项值唯一
    if (seen.has(label)) label = `${label}（${p.provider}）`
    seen.add(label)
    options.push({
      label,
      description: mainFormat(m.providerDescription, {
        provider: `${p.provider}${p.base_url ? ` · ${p.base_url}` : ''}`
      }),
      group: p.provider
    })
  }
  options.push({
    label: m.abandonLabel,
    description: m.abandonDescription
  })
  const questions: AskQuestion[] = [
    {
      id: 'switch-model',
      kind: 'model-recovery',
      header: m.header,
      question: mainFormat(m.question, { count: MODEL_RETRY_LIMIT }),
      error: lastError.message,
      abandonLabel: m.abandonLabel,
      options
    }
  ]
  const answer = await questionService.ask(ctx.topicId, questions, ctx.signal)
  const selected = answer.answers?.[0]?.selected?.[0] ?? ''
  if (!selected || selected === m.abandonLabel) return null
  // 答案解析（前端专用弹窗查询同一数据源后按 provider id 提交；兼容按 label 提交的旧路径）
  let providerId: number | undefined
  const selectedId = Number(selected)
  if (Number.isInteger(selectedId) && selectedId > 0) {
    providerId = providers.some((p) => p.id === selectedId) ? selectedId : undefined
  }
  if (providerId == null) {
    for (const p of providers) {
      const base = `${p.name} · ${p.model}`
      if (selected === base || selected === `${base}（${p.provider}）`) {
        providerId = p.id
        break
      }
    }
  }
  if (providerId == null) {
    logger.warn(
      `[ModelRecovery] 用户提交的模型选择无法匹配任何供应商（selected=${selected}），按放弃处理`
    )
    return null
  }
  const { getProviderService } = await import('../../../../main/provider/service')
  const newModel = await getProviderService().createModel(providerId)
  logger.info(`[ModelRecovery] 用户已选择切换模型（providerId=${providerId}），在原位置继续执行`)
  return newModel
}
