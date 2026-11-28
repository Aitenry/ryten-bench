/**
 * **Pure types and vocabulary** for the sandbox service (zero imports, loadable by node directly
 * for offline regression).
 *
 * The sandbox has three layers; this file belongs to the bottom one:
 *  1. **Policy/approval layer** (runtime/permission*.ts): mode selection, dangerous-operation
 *     interception, approval dialogs, escalation retries;
 *  2. **Execution layer** (sandbox/service.ts): translates the "mode" into each platform's real
 *     isolation primitive, and **fails closed** when no primitive is available (refuses to
 *     execute, never silently allows);
 *  3. **Platform backends** (sandbox/backends/*): Windows restricted token + ACL, Linux Landlock /
 *     bwrap, macOS sandbox-exec — all in-house, relying on no third-party sandbox package.
 */

/** Sandbox modes (same vocabulary as permission modes; the source of truth is here) */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Isolation policy for one invocation */
export interface SandboxPolicy {
  mode: SandboxMode
  /** Workspace root (the only writable user directory under workspace-write) */
  workspaceRoot: string
  /** Private temp directory root (each run creates a random subdirectory under it and grants it separately); defaults to the system temp directory */
  tempRoot?: string
}

/** Enforcement completeness: partial = known gaps (Windows Everyone / hard-link boundary) */
export type SandboxEnforcement = 'full' | 'partial'

/** Backend identifier (for diagnostics and harness assertions) */
export type SandboxBackendName =
  'windows-restricted-token' | 'linux-bwrap' | 'linux-landlock' | 'macos-seatbelt'

/** Wrapped argv (the caller spawns it directly) */
export interface ConfinedArgv {
  argv: string[]
  backend: SandboxBackendName
  enforcement: SandboxEnforcement
  /** Text that appears on stderr when this backend rejects a write (case-insensitive) */
  denialSignatures: readonly string[]
  /** Signature of backend failure itself (a broken sandbox is not a failed command) */
  runnerFailure: { signature: string; exitCode?: number }
  /** Entries to merge into the spawn environment (e.g. Electron's node-mode switch) */
  env?: Record<string, string>
}

/** Sandbox unavailable (no usable backend) — the caller must refuse to execute */
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

/* ────────────────────────── Protocol strings (not localized) ────────────────────────── */

/** Sandbox-unavailable marker: reading it tells the model "not a command failure, but no sandbox available" */
export const SANDBOX_UNAVAILABLE_MARKER = '[sandbox: unavailable — the command was not run]'

/** Sandbox-denial marker (appended to the output tail by the tool layer on an out-of-scope write) */
export function sandboxDenyMarker(mode: SandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`
}

/** Escalation hint (same shape as the hint in runtime/permission.ts, for the tool layer to concatenate) */
export const SANDBOX_ESCALATION_HINT =
  '[sandbox: escalation available — retry this exact call once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]'

/* ────────────────────────── Output classification ────────────────────────── */

/** Case-insensitive containment check (single scan, sufficient and without regex overhead) */
function containsFold(haystack: string, needle: string): boolean {
  if (!needle) return false
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

/** Whether this output means "the sandbox rejected the write" (each backend's dialect is in denialSignatures) */
export function isSandboxDenial(
  output: string,
  signatures: readonly string[] = DEFAULT_DENIAL_SIGNATURES
): boolean {
  if (!output) return false
  return signatures.some((signature) => containsFold(output, signature))
}

/**
 * Backend failure itself (the sandbox broke: the command never ran) — it must never be treated as
 * a command failure, and vice versa.
 *
 * **Judge by exit code first**: a run with exit code 0 can never be a backend failure — backend
 * informational hints (e.g. `[ryten-sandbox] partial enforcement ...` when the Landlock ABI is too
 * old) may appear on the stderr of a successful run, and signature-only matching would misjudge
 * that as a failure and then also swallow a "write denied" (hit during container verification on
 * 2026-09-27). Only check the signature when the exit code is non-zero.
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
 * Per-platform stderr dialects for "write denied".
 *
 * Windows: cmd says "Access is denied.", .NET/pwsh says "Access to the path ... is denied.",
 * Node says "EPERM: operation not permitted" / "permission denied".
 * Linux (Landlock / bwrap): "Permission denied", "Read-only file system".
 * macOS (Seatbelt): "Operation not permitted".
 */
export const DEFAULT_DENIAL_SIGNATURES: readonly string[] = [
  'access is denied',
  'access to the path',
  'permission denied',
  'operation not permitted',
  'read-only file system',
  '拒绝访问'
]
