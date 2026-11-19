/**
 * 沙箱服务的**纯类型与词汇**（零 import，可被 node 直接加载做离线回归）。
 *
 * 沙箱分三层，本文件属于最下面一层：
 *  1. **策略/审批层**（runtime/permission*.ts）：档位选择、危险操作拦截、审批弹窗、升权重试；
 *  2. **执行层**（sandbox/service.ts）：把「档位」翻译成各平台真正的隔离原语，
 *     并在拿不到原语时**故障关闭**（拒绝执行，绝不静默放行）；
 *  3. **各平台后端**（sandbox/backends/*）：Windows 受限令牌 + ACL、Linux Landlock / bwrap、
 *     macOS sandbox-exec —— 全部自研，不依赖任何第三方沙箱包。
 */

/** 沙箱档位（与权限档位同一套词汇，真源在这里） */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** 一次调用的隔离策略 */
export interface SandboxPolicy {
  mode: SandboxMode
  /** 工作区根目录（workspace-write 下唯一可写的用户目录） */
  workspaceRoot: string
  /** 私有临时目录根（其下每次运行建随机子目录并单独授权）；缺省用系统临时目录 */
  tempRoot?: string
}

/** 强制执行完整度：partial = 有已知缺口（Windows 的 Everyone / 硬链接边界） */
export type SandboxEnforcement = 'full' | 'partial'

/** 后端标识（诊断与工装断言用） */
export type SandboxBackendName =
  'windows-restricted-token' | 'linux-bwrap' | 'linux-landlock' | 'macos-seatbelt'

/** 被包装好的 argv（调用方直接 spawn 它） */
export interface ConfinedArgv {
  argv: string[]
  backend: SandboxBackendName
  enforcement: SandboxEnforcement
  /** 该后端「写被拒绝」时会在 stderr 里出现的文本（大小写不敏感） */
  denialSignatures: readonly string[]
  /** 后端自身失败的特征（沙箱坏了 ≠ 命令失败了） */
  runnerFailure: { signature: string; exitCode?: number }
  /** 需要合并进 spawn 环境变量的条目（如 Electron 的 node 模式开关） */
  env?: Record<string, string>
}

/** 沙箱不可用（拿不到任何可用后端）——调用方必须拒绝执行 */
export class SandboxUnavailableError extends Error {
  readonly mode: SandboxMode
  readonly reason: string

  constructor(mode: SandboxMode, reason: string) {
    super(`sandbox unavailable for mode "${mode}": ${reason}`)
    this.name = 'SandboxUnavailableError'
    this.mode = mode
    this.reason = reason
  }
}

/* ────────────────────────── 协议字符串（不跟随界面语言） ────────────────────────── */

/** 沙箱不可用标记：模型读到它就知道「不是命令失败，而是没有沙箱可用」 */
export const SANDBOX_UNAVAILABLE_MARKER = '[sandbox: unavailable — the command was not run]'

/** 被沙箱拒绝标记（写越界时由工具层附加在输出尾部） */
export function sandboxDenyMarker(mode: SandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`
}

/** 升权提示（与 runtime/permission.ts 的提示同形，供工具层拼接） */
export const SANDBOX_ESCALATION_HINT =
  '[sandbox: escalation available — retry this exact call once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]'

/* ────────────────────────── 输出分类 ────────────────────────── */

/** 大小写不敏感的包含判断（一遍扫描，够用且无正则开销） */
function containsFold(haystack: string, needle: string): boolean {
  if (!needle) return false
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

/** 这段输出是不是「沙箱把写拒了」（各后端的方言都在 denialSignatures 里） */
export function isSandboxDenial(
  output: string,
  signatures: readonly string[] = DEFAULT_DENIAL_SIGNATURES
): boolean {
  if (!output) return false
  return signatures.some((signature) => containsFold(output, signature))
}

/**
 * 后端自身失败（沙箱坏了：命令根本没跑）——绝不能被当成命令失败，反之亦然。
 *
 * **先按退出码判定**：退出码为 0 的运行绝不可能是后端故障——后端的信息性提示
 * （例如 Landlock ABI 过旧时的 `[ryten-sandbox] partial enforcement ...`）可能出现在
 * 成功运行的 stderr 里，只按签名匹配会把它误判成故障、进而把「写被拒」也吃掉
 * （2026-09-27 容器验证实测踩到）。退出码非 0 时才看签名。
 */
export function isRunnerFailure(
  output: string,
  exitCode: number | null,
  rule: { signature: string; exitCode?: number }
): boolean {
  if (exitCode === 0) return false
  if (rule.exitCode !== undefined && exitCode === rule.exitCode) return true
  return containsFold(output, rule.signature)
}

/**
 * 各平台「写被拒」的 stderr 方言。
 *
 * Windows：cmd 说 "Access is denied."，.NET/pwsh 说 "Access to the path ... is denied."，
 * Node 说 "EPERM: operation not permitted" / "permission denied"。
 * Linux（Landlock / bwrap）："Permission denied"、"Read-only file system"。
 * macOS（Seatbelt）："Operation not permitted"。
 */
export const DEFAULT_DENIAL_SIGNATURES: readonly string[] = [
  'access is denied',
  'access to the path',
  'permission denied',
  'operation not permitted',
  'read-only file system',
  '拒绝访问'
]
