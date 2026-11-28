import { randomUUID } from 'crypto'
import {
  APPROVAL_REJECTED,
  DEFAULT_PERMISSION_MODE,
  ESCALATION_HINT,
  ESCALATION_UNAVAILABLE,
  callSignature,
  denyMarker,
  describeCall,
  evaluateCall,
  normalizeMode,
  parseEscalation,
  type DenyReason,
  type EscalationError,
  type PermissionMode
} from './permission'

/**
 * PermissionGate — the single checkpoint for "should this tool call run".
 *
 * Responsibility boundary (deliberately split; see the header comment in permission.ts):
 * - **Decision rules** live in permission.ts (pure functions, assertable offline);
 * - **This file** owns state and IO timing: suspending approvals, recording denied calls as
 *   escalation credentials, and translating decisions into model-visible text;
 * - **Mode source / texts / broadcast** are all injected via setters (wired in
 *   permission-store.ts), so this file does not import electron / electron-store / i18n and can
 *   run a closed-loop regression under plain node.
 *
 * Three invariants:
 * 1. **Fail closed**: with no responder (renderer absent, event channel not wired), settle as
 *    "deny"; never allow silently.
 * 2. **One authorization applies to one call**: clicking "allow once" permits only the current
 *    call and writes no persistent policy.
 * 3. **Escalation is bound to the denied call**: only a same-signature call that was just denied
 *    may request escalation, and the target mode must be strictly wider (see parseEscalation);
 *    otherwise not even a dialog is shown.
 */

/** View sent to the renderer approval dialog (plain JSON, safe over IPC) */
export interface ApprovalRequestView {
  topicId: number
  requestId: string
  toolName: string
  /** What this call will do: full command / file path / argument summary */
  detail: string
  /** Why confirmation is needed (already-localized reason text) */
  reason: string
  /** Reason code (for frontend icons and test assertions) */
  reasonCode: DenyReason
  /** Escalation retry: the wider mode temporarily requested */
  requestedMode?: PermissionMode
  /** Escalation retry: justification given by the model */
  justification?: string
}

/** User decision (only "allow once" and "deny" as temporary decisions; there is no "always allow") */
export type ApprovalDecision = 'allow-once' | 'deny'

/** Text source (the wiring layer injects it per UI language; the English fallbacks below are used when unwired) */
export interface GateTexts {
  /** Text given to the model on denial (including protocol marker and escalation hint) */
  denial(input: {
    mode: PermissionMode
    reason: DenyReason
    evidence?: string
    detail: string
  }): string

  /** Reason shown in the dialog */
  reason(code: DenyReason, evidence?: string): string

  /** Text given to the model when escalation parameters are invalid */
  escalationUnavailable(error: EscalationError): string
}

/** Default (English fallback) texts: works without wiring, and is exactly what offline tests assert */
const DEFAULT_TEXTS: GateTexts = {
  denial: ({ mode, reason, evidence, detail }) =>
    `${denyMarker(mode)} ${reason}${evidence ? `: ${evidence}` : ''} (${detail})\n${ESCALATION_HINT}`,
  reason: (code, evidence) => (evidence ? `${code}: ${evidence}` : code),
  escalationUnavailable: (error) => `${ESCALATION_UNAVAILABLE} (${error})`
}

/** Authorization result */
export interface AuthorizeResult {
  /** true = may execute; false = return text as the tool result to the model */
  run: boolean
  text?: string
  /** One-line message for the card (shown when intercepted / denied so users can see what was blocked) */
  cardMessage?: string
  /** Mode actually in effect for this call (the wider one when an escalation was allowed) */
  effectiveMode: PermissionMode
  reason?: DenyReason
  /** Whether human approval was involved (for test assertions) */
  asked?: boolean
}

interface PendingApproval {
  view: ApprovalRequestView
  resolve: (decision: ApprovalDecision) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export interface PermissionGateOptions {
  /** Mode source (per topic); when not injected, always the default mode */
  modeOf?: (topicId: number) => PermissionMode
  /** Workspace root source (for out-of-bounds checks); when not injected, any absolute path is out of bounds */
  workspaceRootOf?: () => string | undefined
  texts?: GateTexts
}

export class PermissionGate {
  /** New approval broadcast callback (injected by the main-process IPC layer to notify the frontend dialog) */
  onApprovalAsked?: (view: ApprovalRequestView) => void

  /**
   * A suspended approval has been settled (user allowed / denied / turn aborted) → tell the UI
   * that this conversation is no longer waiting.
   *
   * Paired with onApprovalAsked: the sidebar's "waiting for confirmation" dot flips on these two
   * ends; without the settle end it stays lit even after the user clicked "allow once".
   */
  onResolved?: (topicId: number) => void

  private modeOf: (topicId: number) => PermissionMode = () => DEFAULT_PERMISSION_MODE
  private workspaceRootOf: () => string | undefined = () => undefined
  private texts: GateTexts = DEFAULT_TEXTS

  /** Pending approvals (requestId → record) */
  private readonly pending = new Map<string, PendingApproval>()
  /** Signatures of denied calls: the credential for "may request escalation" */
  private readonly deniedCalls = new Set<string>()
  /** Signatures the user explicitly rejected: identical signatures are not asked again (prevents dialog spam) */
  private readonly rejectedCalls = new Set<string>()

  constructor(options?: PermissionGateOptions) {
    if (options?.modeOf) this.modeOf = options.modeOf
    if (options?.workspaceRootOf) this.workspaceRootOf = options.workspaceRootOf
    if (options?.texts) this.texts = options.texts
  }

  /** Settlement broadcast: a failure only means the UI misses one state flip; it must not affect settling the pending approval itself */
  private notifyResolved(topicId: number): void {
    try {
      this.onResolved?.(topicId)
    } catch {
      // Broadcast outlet failed (window destroyed etc.): ignore; settlement has already completed
    }
  }

  /* ── Wiring ── */

  setModeSource(fn: (topicId: number) => PermissionMode): void {
    this.modeOf = fn
  }

  setWorkspaceRootSource(fn: () => string | undefined): void {
    this.workspaceRootOf = fn
  }

  setTexts(texts: GateTexts): void {
    this.texts = texts
  }

  /* ── Queries ── */

  /** Current mode for the topic (dirty values normalize to the default mode) */
  modeFor(topicId: number): PermissionMode {
    return normalizeMode(this.modeOf(topicId))
  }

  /** Currently pending approval (polled once when the frontend reloads or returns to a topic) */
  getPending(topicId: number): ApprovalRequestView | null {
    for (const record of this.pending.values()) {
      if (record.view.topicId === topicId) return record.view
    }
    return null
  }

  /** Clears escalation credentials (called on topic switch / new turn; one denial should not last indefinitely across turns) */
  reset(): void {
    this.deniedCalls.clear()
    this.rejectedCalls.clear()
  }

  /* ── Authorization ── */

  /**
   * Evaluates one tool call, suspending for user approval when necessary.
   *
   * @param input.topicId topic (approval events are routed to the matching UI by topic)
   * @param input.signal  cancellation signal for this turn: cancelling withdraws the approval and settles as deny
   */
  async authorize(input: {
    topicId: number
    toolName: string
    args: Record<string, unknown>
    signal?: AbortSignal
    /** Workspace root (the caller usually knows it better, e.g. the Runtime has one); defaults to the injected source */
    workspaceRoot?: string
  }): Promise<AuthorizeResult> {
    const { topicId, toolName, args, signal } = input
    const mode = this.modeFor(topicId)
    const signature = callSignature(toolName, args)
    const detail = describeCall(toolName, args)
    const workspaceRoot = input.workspaceRoot ?? this.workspaceRootOf()

    // 0) The user already rejected this call: no dialog, no execution (the model may ask again only with different arguments)
    if (this.rejectedCalls.has(signature)) {
      return {
        run: false,
        text: `${APPROVAL_REJECTED} (${detail})`,
        cardMessage: this.texts.reason('risky-command', detail),
        effectiveMode: mode
      }
    }

    // 1) Escalation parameters present: only a same-signature call that was just denied can pass
    const wantsEscalation =
      args.sandbox_permissions !== undefined || args.justification !== undefined
    if (wantsEscalation) {
      const parsed = parseEscalation(args, mode, this.deniedCalls.has(signature))
      if (!parsed.ok) {
        return {
          run: false,
          text: this.texts.escalationUnavailable(parsed.error),
          cardMessage: this.texts.escalationUnavailable(parsed.error),
          effectiveMode: mode
        }
      }
      const { request } = parsed
      const approved = await this.ask(
        {
          topicId,
          toolName,
          detail,
          reason: this.texts.reason('risky-command', request.justification),
          reasonCode: 'risky-command',
          requestedMode: request.mode,
          justification: request.justification
        },
        signal
      )
      if (approved !== 'allow-once') {
        this.rejectedCalls.add(signature)
        return {
          run: false,
          text: `${APPROVAL_REJECTED} (${detail})`,
          cardMessage: this.texts.reason('risky-command', detail),
          effectiveMode: mode,
          asked: true
        }
      }
      return { run: true, effectiveMode: request.mode, asked: true }
    }

    // 2) Regular evaluation
    const verdict = evaluateCall({ mode, toolName, args, workspaceRoot })

    if (verdict.action === 'allow') {
      return { run: true, effectiveMode: mode }
    }

    if (verdict.action === 'deny') {
      // Record as an escalation credential: the model may request a wider mode once for this call
      this.deniedCalls.add(signature)
      const text = this.texts.denial({
        mode,
        reason: verdict.reason ?? 'risky-command',
        evidence: verdict.evidence,
        detail
      })
      return {
        run: false,
        text,
        cardMessage: this.texts.reason(verdict.reason ?? 'risky-command', verdict.evidence),
        effectiveMode: mode,
        reason: verdict.reason
      }
    }

    // 3) Approval required: ask the user (out-of-bounds / dangerous command / external tool under read-only)
    const approved = await this.ask(
      {
        topicId,
        toolName,
        detail,
        reason: this.texts.reason(verdict.reason ?? 'risky-command', verdict.evidence),
        reasonCode: verdict.reason ?? 'risky-command'
      },
      signal
    )
    if (approved === 'allow-once') {
      return { run: true, effectiveMode: mode, asked: true, reason: verdict.reason }
    }
    this.rejectedCalls.add(signature)
    return {
      run: false,
      text: `${APPROVAL_REJECTED} (${detail})`,
      cardMessage: this.texts.reason(verdict.reason ?? 'risky-command', verdict.evidence),
      effectiveMode: mode,
      reason: verdict.reason,
      asked: true
    }
  }

  /* ── Approval lifecycle ── */

  /** User decision: settles the matching pending approval; returns false when none exists */
  decide(requestId: string, decision: ApprovalDecision): boolean {
    const record = this.pending.get(requestId)
    if (!record) return false
    this.pending.delete(requestId)
    this.detach(record)
    record.resolve(decision === 'allow-once' ? 'allow-once' : 'deny')
    this.notifyResolved(record.view.topicId)
    return true
  }

  /** Settles all pending approvals of a topic as deny (user pressed stop / topic closed) */
  abortTopic(topicId: number): void {
    let settled = false
    for (const [id, record] of [...this.pending]) {
      if (record.view.topicId !== topicId) continue
      this.pending.delete(id)
      this.detach(record)
      record.resolve('deny')
      settled = true
    }
    if (settled) this.notifyResolved(topicId)
  }

  /** Settles all pending approvals as deny (application-level fallback: renderer failure) */
  abortAll(): void {
    const topics = new Set<number>()
    for (const [id, record] of [...this.pending]) {
      this.pending.delete(id)
      this.detach(record)
      record.resolve('deny')
      topics.add(record.view.topicId)
    }
    for (const topicId of topics) this.notifyResolved(topicId)
  }

  private detach(record: PendingApproval): void {
    if (record.signal && record.onAbort) {
      record.signal.removeEventListener('abort', record.onAbort)
    }
  }

  /**
   * Suspends until one human decision arrives.
   *
   * - No broadcast outlet (renderer absent / channel not wired) → settle as deny immediately (fail closed);
   * - signal aborted → withdraw the question and settle as deny (a late answer is ignored by decide because the record is gone);
   * - No timeout: the decision is entirely the user's; cancelling the turn withdraws it.
   */
  private ask(
    view: Omit<ApprovalRequestView, 'requestId'>,
    signal?: AbortSignal
  ): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      if (!this.onApprovalAsked) {
        resolve('deny')
        return
      }
      const requestId = `ap-${randomUUID()}`
      const record: PendingApproval = { view: { ...view, requestId }, resolve, signal }
      const onAbort = (): void => {
        this.pending.delete(requestId)
        resolve('deny')
        this.notifyResolved(view.topicId)
      }
      record.onAbort = onAbort
      if (signal) {
        if (signal.aborted) {
          resolve('deny')
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pending.set(requestId, record)
      try {
        this.onApprovalAsked(record.view)
      } catch {
        // Broadcast failed (window destroyed / serialization error): clean up and fail closed
        this.pending.delete(requestId)
        this.detach(record)
        resolve('deny')
      }
    })
  }
}

/** Process-level singleton (mode source wired by permission-store.ts) */
export const permissionGate = new PermissionGate()
