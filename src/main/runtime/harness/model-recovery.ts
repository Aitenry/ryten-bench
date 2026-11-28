import type { BaseChatModel } from '../../ai/chat-model'
import logger from 'electron-log'
import { mainFormat, mainMessages } from '../../i18n'
import { questionService } from './ask'
import type { AskOption, AskQuestion } from './ask'

/**
 * Shared recovery logic for model calls (used by the main model node and early
 * conversation compaction summaries)
 *
 * - **Failure classification only looks at HTTP status codes** (whatever the API returns,
 *   without guessing from the message wording): 4xx means "this request itself is broken";
 *   resending will not help → do not retry, fail immediately; 408 / 429 / 5xx and "network
 *   failures with no status code" are worth retrying;
 * - **The retry count is the only brake**: retryable failures are tried at most
 *   MODEL_RETRY_LIMIT times, after which either one "switch model and continue" prompt is
 *   shown, or the original error is reported. The old problem (2026-09-23: "the model was
 *   unavailable and it kept retrying after reporting an error") was half caused by not
 *   checking the budget here, and half by the silent 6 retries of the earlier implementation
 *   (see the compatibility field notes in provider/service.ts);
 * - User cancellation (signal aborted) is not retried; automatic goal-round continuations do
 *   not prompt to switch models.
 */

/** Automatic retry limit and delay for retryable failures */
export const MODEL_RETRY_LIMIT = 2
export const MODEL_RETRY_DELAY_MS = 800

/** Context needed for the switch-model prompt (identity information the model caller can provide) */
export interface ModelRecoveryContext {
  topicId: number
  /** Call source: 'user' (default) / 'goal-round' (automatic continuation, which never asks to switch models) */
  turnSource?: string
  /** Whether prompting is allowed (forbidden for subagents etc.; allowed by default) */
  askEnabled?: boolean
  signal?: AbortSignal
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Failure classification (derived only from status codes and the cancellation signal) */
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

/** Classification result (raw keeps the provider's original text, used by logs and failure messages) */
export interface ModelErrorInfo {
  kind: ModelErrorKind
  /** HTTP status code returned by the API (undefined when unavailable) */
  status?: number
  /**
   * Transient failure (408/429/5xx, connection failures): worth recovering — retried in place
   * within the budget, and once the budget is exhausted the user may be asked whether to
   * switch models and continue.
   * Permanent failures (the other 4xx) are false: resending the same request will not help, so
   * fail immediately without a prompt.
   */
  transient: boolean
  /** Retries allowed for this failure (0 for permanent failures, MODEL_RETRY_LIMIT for retryable ones) */
  retryLimit: number
  /** Time spent on this failure (only used for the "waited N seconds" wording in error messages) */
  elapsedMs: number
  raw: Error
}

/**
 * Extracts the HTTP status code: fields on the error object take precedence (openai/anthropic
 * and other SDKs all attach status), then explicit status-code forms such as `status_code=500`
 * / `HTTP 500` are read from the message — this step only takes the number and does no keyword
 * matching.
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
 * Classifies one model request failure (pure function).
 *
 * | Status code | kind | retry budget |
 * |---|---|---|
 * | 401 / 403 | auth | 0 (check the API key) |
 * | 404 | not-found | 0 (check the model name and endpoint) |
 * | 408 / 504 / 524 | timeout | MODEL_RETRY_LIMIT |
 * | 429 | rate-limit | MODEL_RETRY_LIMIT |
 * | 5xx | server | MODEL_RETRY_LIMIT |
 * | other 4xx | rejected | 0 (the request itself is broken) |
 * | no status code (connection/network) | network | MODEL_RETRY_LIMIT |
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
  // Reaching here with 2xx/3xx means it is not an HTTP-layer failure (protocol/parsing); treat it as retryable
  return info('unknown', true, MODEL_RETRY_LIMIT)
}

/** Post-classification explanation (prepended to the provider's original text, explaining "why it stopped") */
function describeFailure(info: ModelErrorInfo, attempts: number): string {
  const m = mainMessages().modelFailure
  // The status code may come from the error object or the message, or not exist at all:
  // assemble the whole "HTTP <code>" segment here so the message never leaves empty parentheses
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

/** Final error: message is "classification explanation: provider original text"; kind/status are for upper layers */
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

/** One model call with recovery semantics */
export interface ModelCallRecovery<T> {
  /** Starts one call: retries resend the same messages/parameters (the caller guarantees tools are not re-run and side effects are not replayed) */
  call: () => Promise<T>
  ctx: ModelRecoveryContext
  /** Log prefix, e.g. '[Agent]' / '[Compaction]' */
  label: string
  /** Retry progress: attempt is the retry number, retries is the limit allowed for this failure */
  onRetry?: (attempt: number, retries: number) => void
  /** Model switch succeeded: the caller rebinds the new model here */
  onSwitch?: (model: BaseChatModel) => void
  /** Clock (used by tests to inject a fake clock; defaults to Date.now) */
  now?: () => number
  /** Retry delay (tests inject zero delay; defaults to MODEL_RETRY_DELAY_MS) */
  retryDelayMs?: number
}

/**
 * Model call with "status-code classification + bounded retries + switch-model fallback".
 * Permanent failures (the other 4xx, cancellation) throw immediately, with no retry and no
 * prompt; retryable failures (408/429/5xx/connection) are retried at most MODEL_RETRY_LIMIT
 * times and afterwards (when prompting is allowed) suspend through questionService.ask,
 * waiting for the user to switch models; if one is chosen, execution continues at the original
 * call site.
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
          `${req.label} Model request failed (retry ${attempt}/${info.retryLimit}, retrying this call only, not re-running tools):`,
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
          `${req.label} Model request failed and is not retryable (${info.kind}${info.status != null ? ` / HTTP ${info.status}` : ''}), failing immediately:`,
          raw
        )
      } else {
        logger.error(
          `${req.label} Model request retries exhausted (${info.kind}, still failing after ${attempt} retries), propagating the error:`,
          raw
        )
      }

      // Switch-model prompt: offer it only once, and only for failures "worth recovering"
      // (switching models cannot fix the semantic problem of the current request either)
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
          logger.info(`${req.label} Switched to the user-selected model, retry count reset, continuing in place`)
          continue
        }
        logger.warn(`${req.label} User abandoned model switch, ending this turn with the original error:`, raw.message)
      }
      throw new ModelRequestError(info, attempt)
    }
  }
}

/**
 * Asks the user whether to switch models and continue; returns the new model instance, or null
 * when the user declines.
 * Failure information (kind='model-recovery') is broadcast through the ask suspension channel
 * and shown by the dedicated frontend ModelRecoveryModal; once the answer is written back it is
 * resolved here into an enabled provider.
 * Throws AskAbortedError when the signal is aborted (user stop).
 */
export async function askUserToSwitchModel(
  ctx: ModelRecoveryContext,
  lastError: Error
): Promise<BaseChatModel | null> {
  const { getEnabledProviders } = await import('../../database/mapper/provider')
  const providers = await getEnabledProviders()
  // Read the UI texts once for the current language: the abandon option is both displayed and
  // used for answer comparison, so it must come from the **same** read; otherwise switching
  // language while the dialog is open makes the comparison fail
  const m = mainMessages().modelRecovery
  const seen = new Set<string>()
  const options: AskOption[] = []
  for (const p of providers) {
    let label = `${p.name} · ${p.model}`
    // Rows with the same name (same name/model) but a different provider/endpoint: append the provider type to keep option values unique
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
  // Answer parsing (the dedicated frontend modal queries the same data source and submits by
  // provider id; supports the legacy path of submitting by label)
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
      `[ModelRecovery] User-submitted model choice matched no provider (selected=${selected}), treating as abandoned`
    )
    return null
  }
  const { getProviderService } = await import('../../provider/service')
  const newModel = await getProviderService().createModel(providerId)
  logger.info(`[ModelRecovery] User chose to switch models (providerId=${providerId}), continuing in place`)
  return newModel
}
