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
 * 权限闸门（PermissionGate）——「一次工具调用该不该跑」的唯一放行点。
 *
 * 职责边界（刻意切开，见 permission.ts 头部注释）：
 * - **判定规则**在 permission.ts（纯函数，离线可断言）；
 * - **本文件**负责状态与 IO 时序：挂起审批、把被拒绝的调用记成升权凭据、把决定翻译成
 *   模型可见的文本；
 * - **档位来源 / 文案 / 广播**全部经 setter 注入（permission-store.ts 接线），因此本文件
 *   不 import electron / electron-store / i18n，可以直接用 node 跑闭环回归。
 *
 * 三条不变式：
 * 1. **故障关闭**：没有应答者（渲染进程不在、事件通道未接线）时按「拒绝」结算，绝不静默放行；
 * 2. **一次授权只作用于一次调用**：用户点「允许一次」只放行当前这次调用，不写任何持久策略；
 * 3. **升权绑死在被拒绝的那次调用上**：只有刚被拒绝过的同签名调用才允许申请升权，
 *    且目标档位必须严格更宽（见 parseEscalation），否则连弹窗都不弹。
 */

/** 送进渲染层审批弹窗的视图（纯 JSON，可安全过 IPC） */
export interface ApprovalRequestView {
  topicId: number
  requestId: string
  toolName: string
  /** 这次要做什么：命令全文 / 文件路径 / 参数摘要 */
  detail: string
  /** 为什么要你确认（已本地化的原因文本） */
  reason: string
  /** 原因码（前端图标与工装断言用） */
  reasonCode: DenyReason
  /** 升权重试：希望临时用到的更宽档位 */
  requestedMode?: PermissionMode
  /** 升权重试：模型给出的理由 */
  justification?: string
}

/** 用户决定（DSH 语义：只有「允许一次」与「拒绝」两种临时决定，没有「总是允许」） */
export type ApprovalDecision = 'allow-once' | 'deny'

/** 文案来源（接线方按界面语言注入；未接线时用下面的英文兜底） */
export interface GateTexts {
  /** 拒绝时给模型的文本（含协议标记与升权提示） */
  denial(input: {
    mode: PermissionMode
    reason: DenyReason
    evidence?: string
    detail: string
  }): string

  /** 弹窗里的原因说明 */
  reason(code: DenyReason, evidence?: string): string

  /** 升权参数不合法时给模型的文本 */
  escalationUnavailable(error: EscalationError): string
}

/** 默认（英文兜底）文案：没接线也能跑，且离线工装断言的就是这一份 */
const DEFAULT_TEXTS: GateTexts = {
  denial: ({ mode, reason, evidence, detail }) =>
    `${denyMarker(mode)} ${reason}${evidence ? `: ${evidence}` : ''} (${detail})\n${ESCALATION_HINT}`,
  reason: (code, evidence) => (evidence ? `${code}: ${evidence}` : code),
  escalationUnavailable: (error) => `${ESCALATION_UNAVAILABLE} (${error})`
}

/** 放行判定结果 */
export interface AuthorizeResult {
  /** true = 可以执行；false = 用 text 作为工具结果返回给模型 */
  run: boolean
  text?: string
  /** 卡片上的一句话（拦截 / 被拒绝时展示，让用户在聊天里看得见拦了什么） */
  cardMessage?: string
  /** 本次实际生效的档位（升权放行时是更宽的那个） */
  effectiveMode: PermissionMode
  reason?: DenyReason
  /** 是否经过了人工审批（工装断言用） */
  asked?: boolean
}

interface PendingApproval {
  view: ApprovalRequestView
  resolve: (decision: ApprovalDecision) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export interface PermissionGateOptions {
  /** 档位来源（按话题）；未注入时一律缺省档位 */
  modeOf?: (topicId: number) => PermissionMode
  /** 工作区根目录来源（越界判定用）；未注入时任何绝对路径都算越界 */
  workspaceRootOf?: () => string | undefined
  texts?: GateTexts
}

export class PermissionGate {
  /** 新审批广播回调（主进程 IPC 层注入，通知前端弹窗） */
  onApprovalAsked?: (view: ApprovalRequestView) => void

  private modeOf: (topicId: number) => PermissionMode = () => DEFAULT_PERMISSION_MODE
  private workspaceRootOf: () => string | undefined = () => undefined
  private texts: GateTexts = DEFAULT_TEXTS

  /** 挂起的审批（requestId → 记录） */
  private readonly pending = new Map<string, PendingApproval>()
  /** 被拒绝过的调用签名：它是「可以申请升权」的凭据 */
  private readonly deniedCalls = new Set<string>()
  /** 用户已经明确拒绝过的调用签名：同签名不再打扰（防弹窗刷屏） */
  private readonly rejectedCalls = new Set<string>()

  constructor(options?: PermissionGateOptions) {
    if (options?.modeOf) this.modeOf = options.modeOf
    if (options?.workspaceRootOf) this.workspaceRootOf = options.workspaceRootOf
    if (options?.texts) this.texts = options.texts
  }

  /* ── 接线 ── */

  setModeSource(fn: (topicId: number) => PermissionMode): void {
    this.modeOf = fn
  }

  setWorkspaceRootSource(fn: () => string | undefined): void {
    this.workspaceRootOf = fn
  }

  setTexts(texts: GateTexts): void {
    this.texts = texts
  }

  /* ── 查询 ── */

  /** 当前话题的档位（脏值归一到缺省档位） */
  modeFor(topicId: number): PermissionMode {
    return normalizeMode(this.modeOf(topicId))
  }

  /** 当前挂起的审批（前端重载/切话题回来时拉一次） */
  getPending(topicId: number): ApprovalRequestView | null {
    for (const record of this.pending.values()) {
      if (record.view.topicId === topicId) return record.view
    }
    return null
  }

  /** 清空拒绝凭据（切话题/新一轮时调用；一次拒绝不该跨轮无限期生效） */
  reset(): void {
    this.deniedCalls.clear()
    this.rejectedCalls.clear()
  }

  /* ── 放行判定 ── */

  /**
   * 判定一次工具调用，必要时挂起等用户审批。
   *
   * @param input.topicId 话题（审批事件按话题归属到对应界面）
   * @param input.signal  本轮取消信号：取消即撤回审批并按拒绝结算
   */
  async authorize(input: {
    topicId: number
    toolName: string
    args: Record<string, unknown>
    signal?: AbortSignal
    /** 工作区根目录（调用方更清楚，如 Runtime 手上就有）；缺省回落到注入的来源 */
    workspaceRoot?: string
  }): Promise<AuthorizeResult> {
    const { topicId, toolName, args, signal } = input
    const mode = this.modeFor(topicId)
    const signature = callSignature(toolName, args)
    const detail = describeCall(toolName, args)
    const workspaceRoot = input.workspaceRoot ?? this.workspaceRootOf()

    // 0) 用户已经拒绝过这个调用：不再弹窗、不再执行（模型换个参数才可能重新问）
    if (this.rejectedCalls.has(signature)) {
      return {
        run: false,
        text: `${APPROVAL_REJECTED} (${detail})`,
        cardMessage: this.texts.reason('risky-command', detail),
        effectiveMode: mode
      }
    }

    // 1) 带升权参数：只有「刚被拒绝过的同签名调用」才可能通过
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

    // 2) 常规判定
    const verdict = evaluateCall({ mode, toolName, args, workspaceRoot })

    if (verdict.action === 'allow') {
      return { run: true, effectiveMode: mode }
    }

    if (verdict.action === 'deny') {
      // 记成升权凭据：模型可以就这一次调用申请一次更宽档位
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

    // 3) 需要审批：弹窗问人（越界 / 危险命令 / 只读档位下的外部工具）
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

  /* ── 审批生命周期 ── */

  /** 用户裁决：命中挂起审批则结算；不存在返回 false */
  decide(requestId: string, decision: ApprovalDecision): boolean {
    const record = this.pending.get(requestId)
    if (!record) return false
    this.pending.delete(requestId)
    this.detach(record)
    record.resolve(decision === 'allow-once' ? 'allow-once' : 'deny')
    return true
  }

  /** 话题的全部挂起审批按拒绝结算（用户点了停止 / 话题关闭） */
  abortTopic(topicId: number): void {
    for (const [id, record] of [...this.pending]) {
      if (record.view.topicId !== topicId) continue
      this.pending.delete(id)
      this.detach(record)
      record.resolve('deny')
    }
  }

  /** 全部挂起审批按拒绝结算（应用级兜底：渲染进程失效） */
  abortAll(): void {
    for (const [id, record] of [...this.pending]) {
      this.pending.delete(id)
      this.detach(record)
      record.resolve('deny')
    }
  }

  private detach(record: PendingApproval): void {
    if (record.signal && record.onAbort) {
      record.signal.removeEventListener('abort', record.onAbort)
    }
  }

  /**
   * 挂起等一次人工决定。
   *
   * - 没有广播出口（渲染进程不在 / 通道未接线）→ 立即按拒绝结算（故障关闭）；
   * - signal 中止 → 撤回提问并按拒绝结算（迟到的回答会被 decide 忽略，因为记录已删除）；
   * - 无超时（DSH 语义）：决定权完全在用户手里，取消本轮即撤回。
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
        // 广播失败（窗口已销毁 / 序列化异常）：清理并故障关闭
        this.pending.delete(requestId)
        this.detach(record)
        resolve('deny')
      }
    })
  }
}

/** 进程级单例（与 questionService 同款；档位来源由 permission-store.ts 接线） */
export const permissionGate = new PermissionGate()
