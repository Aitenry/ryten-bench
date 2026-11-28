import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandboxLog } from './log'
import {
  linuxBwrapArgv,
  linuxLandlockArgv,
  macosSeatbeltArgv,
  windowsCleanupArgv,
  windowsRunnerArgv
} from './profiles'
import {
  SandboxUnavailableError,
  type ConfinedArgv,
  type SandboxBackendName,
  type SandboxEnforcement,
  type SandboxMode,
  type SandboxPolicy
} from './types'

/**
 * Sandbox service — the single entry point from mode to the real OS isolation primitive.
 *
 * Platform chain (probe first, then select, **fail closed if nothing is available**; never fall
 * back to running unconfined):
 *  - win32  → `windows-restricted-token`: in-house restricted-token runner (no admin, no accounts);
 *  - linux  → `linux-bwrap` (preferred when bubblewrap is installed) → `linux-landlock` (in-house
 *             launcher using the kernel Landlock, no root, no packages required);
 *  - darwin → `macos-seatbelt`: the system sandbox-exec plus an in-house SBPL profile.
 *
 * Why probing must run real commands: being installed does not mean it works (kernel without
 * Landlock, workspace on exFAT, enterprise policy disabling restricted tokens...). The probe runs
 * one real call and caches the verdict; probe failure = unavailable = refuse to execute.
 *
 * This file does not import electron: platform, paths and the probe executor are all injected via
 * deps, so it can be loaded directly with node outside Electron (both the offline regression and
 * the on-device verification harness rely on it).
 */

/** Probe verdict */
export interface SandboxStatus {
  platform: string
  /** Available backend (null when unavailable) */
  backend: SandboxBackendName | null
  enforcement: SandboxEnforcement | null
  usable: boolean
  /** Reason for unavailability (for diagnostics and UI hints) */
  reason?: string
}

export interface SandboxServiceDeps {
  /** Override the platform (the harness uses it to verify each platform chain on any host) */
  platform?: string
  /** Windows runner script path (resources/sandbox/win32-sandbox-runner.cjs) */
  windowsRunnerPath?: string
  /** node/electron executable used to run the runner (process.execPath under Electron) */
  nodePath?: string
  /** App root (resources/app.asar when packaged): the runner uses it to resolve koffi */
  appRoot?: string
  /** In-house Landlock launcher path */
  landlockLauncherPath?: string
  /** bubblewrap executable (default 'bwrap', looked up on PATH) */
  bwrapPath?: string
  /** macOS sandbox-exec (default 'sandbox-exec') */
  seatbeltPath?: string
  /** Private temp directory root (defaults to the system temp directory) */
  tempRoot?: string
  /** Probe executor (default spawnSync; the harness can inject a deterministic implementation) */
  runProbe?: (argv: string[], env?: Record<string, string>) => { ok: boolean; detail?: string }
  /** Probe timeout (ms, must be positive; 0 means "wait forever" in Node, so it is explicitly rejected here) */
  probeTimeoutMs?: number
}

/** Verdict cache: probe only once per process lifetime */
type Verdict =
  { backend: SandboxBackendName; enforcement: SandboxEnforcement } | { unavailable: string }

export class SandboxService {
  private deps: SandboxServiceDeps
  private verdict: Verdict | undefined

  constructor(deps: SandboxServiceDeps = {}) {
    this.deps = deps
  }

  /** Wire in/override config (the plugin injects real paths on install; re-probe after changes) */
  configure(deps: Partial<SandboxServiceDeps>): void {
    this.deps = { ...this.deps, ...deps }
    this.verdict = undefined
  }

  /** Paths and platform actually in use (for diagnostics) */
  describe(): {
    platform: string
    tempRoot: string
    windowsRunnerPath?: string
    landlockLauncherPath?: string
  } {
    return {
      platform: this.platform(),
      tempRoot: this.tempRoot(),
      windowsRunnerPath: this.deps.windowsRunnerPath,
      landlockLauncherPath: this.deps.landlockLauncherPath
    }
  }

  /** Sandbox status (lazy probe + cache) */
  status(): SandboxStatus {
    const verdict = this.resolve()
    if ('unavailable' in verdict) {
      return {
        platform: this.platform(),
        backend: null,
        enforcement: null,
        usable: false,
        reason: verdict.unavailable
      }
    }
    return {
      platform: this.platform(),
      backend: verdict.backend,
      enforcement: verdict.enforcement,
      usable: true
    }
  }

  /** Clear the probe cache (for settings changes / repeated harness verification) */
  reset(): void {
    this.verdict = undefined
  }

  /**
   * Wrap a command into a confined invocation.
   *
   * @throws SandboxUnavailableError no backend is available on this platform (the caller must refuse to execute)
   */
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    if (policy.mode === 'danger-full-access') {
      throw new Error('sandbox.confine: danger-full-access must not be confined')
    }
    const verdict = this.resolve()
    if ('unavailable' in verdict) {
      throw new SandboxUnavailableError(policy.mode, verdict.unavailable)
    }
    const tempRoot = policy.tempRoot ?? this.tempRoot()
    const resolved: SandboxPolicy = { ...policy, tempRoot }
    switch (verdict.backend) {
      case 'windows-restricted-token': {
        const runnerPath = this.deps.windowsRunnerPath
        if (!runnerPath)
          throw new SandboxUnavailableError(policy.mode, 'windows runner path missing')
        return windowsRunnerArgv(
          resolved,
          { nodePath: this.nodePath(), runnerPath, appRoot: this.deps.appRoot },
          argv
        )
      }
      case 'linux-bwrap':
        return linuxBwrapArgv(resolved, this.deps.bwrapPath ?? 'bwrap', argv)
      case 'linux-landlock': {
        const launcher = this.deps.landlockLauncherPath
        if (!launcher) throw new SandboxUnavailableError(policy.mode, 'landlock launcher missing')
        return linuxLandlockArgv(resolved, launcher, argv)
      }
      case 'macos-seatbelt':
        return macosSeatbeltArgv(resolved, this.deps.seatbeltPath ?? 'sandbox-exec', argv)
      default:
        throw new SandboxUnavailableError(policy.mode, `unknown backend ${String(verdict.backend)}`)
    }
  }

  /** Revoke the persistent ACE on the workspace (uninstall/cleanup; only the Windows backend has this concept) */
  cleanupWorkspace(policy: SandboxPolicy): boolean {
    if (this.platform() !== 'win32') return false
    const runnerPath = this.deps.windowsRunnerPath
    if (!runnerPath || !existsSync(runnerPath)) return false
    const confined = windowsCleanupArgv(
      { ...policy, tempRoot: policy.tempRoot ?? this.tempRoot() },
      { nodePath: this.nodePath(), runnerPath, appRoot: this.deps.appRoot }
    )
    const result = this.probe(confined.argv, confined.env)
    if (!result.ok) {
      sandboxLog.warn(`[Sandbox] Failed to clean workspace ACE: ${result.detail ?? 'unknown'}`)
      return false
    }
    return true
  }

  /* ────────────────────────── Internals ────────────────────────── */

  private platform(): string {
    return this.deps.platform ?? process.platform
  }

  private tempRoot(): string {
    return this.deps.tempRoot ?? tmpdir()
  }

  private nodePath(): string {
    return this.deps.nodePath ?? process.execPath
  }

  /** Resolve the platform chain once and cache the verdict */
  private resolve(): Verdict {
    if (this.verdict !== undefined) return this.verdict
    this.verdict = this.probeChain()
    const verdict = this.verdict
    if ('unavailable' in verdict) {
      sandboxLog.warn(`[Sandbox] No sandbox backend available (${this.platform()}): ${verdict.unavailable}`)
    } else {
      sandboxLog.info(
        `[Sandbox] backend=${verdict.backend} enforcement=${verdict.enforcement} (platform=${this.platform()})`
      )
    }
    return verdict
  }

  /** Platform chain: probe in order; the first that passes is the backend this process will use */
  private probeChain(): Verdict {
    let lastDetail = ''
    for (const candidate of this.candidates()) {
      const result = candidate.probe()
      if (result.ok) return { backend: candidate.backend, enforcement: candidate.enforcement }
      lastDetail = `${candidate.backend}: ${result.detail ?? 'probe failed'}`
      sandboxLog.info(
        `[Sandbox] Candidate backend ${candidate.backend} unavailable: ${result.detail ?? 'probe failed'}`
      )
    }
    return { unavailable: lastDetail || `no sandbox backend for platform ${this.platform()}` }
  }

  /** Candidate backends for this platform (order is priority) */
  private candidates(): {
    backend: SandboxBackendName
    enforcement: SandboxEnforcement
    probe: () => { ok: boolean; detail?: string }
  }[] {
    const platform = this.platform()
    if (platform === 'win32') {
      return [
        {
          backend: 'windows-restricted-token',
          enforcement: 'partial',
          probe: () => this.probeWindowsRunner()
        }
      ]
    }
    if (platform === 'darwin') {
      return [
        {
          backend: 'macos-seatbelt',
          enforcement: 'full',
          probe: () => {
            // Start a real process with the most permissive profile: sandbox-exec exits non-zero when it rejects the profile
            const result = this.probe(
              ['-p', '(version 1)(allow default)', '--', 'true'],
              undefined,
              this.deps.seatbeltPath ?? 'sandbox-exec'
            )
            return result
          }
        }
      ]
    }
    // linux (and other Unix as a fallback)
    return [
      {
        backend: 'linux-bwrap',
        enforcement: 'full',
        probe: () =>
          this.probe(
            [
              '--ro-bind',
              '/',
              '/',
              '--dev',
              '/dev',
              '--unshare-pid',
              '--proc',
              '/proc',
              '--die-with-parent',
              '--',
              'true'
            ],
            undefined,
            this.deps.bwrapPath ?? 'bwrap'
          )
      },
      {
        backend: 'linux-landlock',
        // partial: Landlock only accepts directory-level write rules, so write permission on the
        // /dev directory is opened (to keep `> /dev/null` working; see linuxLandlockArgs in profiles.ts)
        enforcement: 'partial',
        probe: () => {
          const launcher = this.deps.landlockLauncherPath
          if (!launcher) return { ok: false, detail: 'landlock launcher not configured' }
          if (!existsSync(launcher))
            return { ok: false, detail: `landlock launcher missing: ${launcher}` }
          // Probe arguments match the real invocation shape (directory-level --rw /dev plus one real exec)
          return this.probe(['--ro', '/', '--rw', '/dev', '--', 'true'], undefined, launcher)
        }
      }
    ]
  }

  /**
   * Windows runner probe: run `cmd /c exit 0` in a temporary directory.
   *
   * That single run verifies everything — "koffi loads, the token can be created, the ACL can be
   * changed (fails here on non-NTFS), the process starts" — and only a passing probe counts the
   * backend as available.
   */
  private probeWindowsRunner(): { ok: boolean; detail?: string } {
    const runnerPath = this.deps.windowsRunnerPath
    if (!runnerPath) return { ok: false, detail: 'windows runner path not configured' }
    if (!existsSync(runnerPath))
      return { ok: false, detail: `windows runner missing: ${runnerPath}` }
    const probeWorkspace = mkdtempSync(join(this.tempRoot(), 'ryten-sandbox-probe-'))
    try {
      const confined = windowsRunnerArgv(
        { mode: 'read-only', workspaceRoot: probeWorkspace, tempRoot: this.tempRoot() },
        { nodePath: this.nodePath(), runnerPath, appRoot: this.deps.appRoot },
        ['cmd', '/d', '/s', '/c', 'exit 0']
      )
      // The probe only verifies "a confined process can start": it writes nothing, hence read-only (zero grants, zero ACL changes)
      return this.probe(confined.argv, confined.env)
    } finally {
      try {
        rmSync(probeWorkspace, { recursive: true, force: true })
      } catch (error) {
        sandboxLog.warn('[Sandbox] Failed to clean probe temp directory:', error)
      }
    }
  }

  /** Actually run a command to see whether the backend works (default spawnSync; the timeout must be positive) */
  private probe(
    argv: readonly string[],
    env?: Record<string, string>,
    executableOverride?: string
  ): { ok: boolean; detail?: string } {
    const [head] = argv
    if (!head) return { ok: false, detail: 'empty argv' }
    // With executableOverride, all of argv is **arguments** (the program is given separately);
    // without it, argv[0] is the program. This was once reversed: with an override, argv[0] was
    // dropped as the program name, so all three non-Windows probes ran with wrong arguments
    // (a bug caught by on-device verification).
    const program = executableOverride ?? head
    const args = executableOverride ? [...argv] : argv.slice(1)
    if (this.deps.runProbe) return this.deps.runProbe([program, ...args], env)
    const timeout = this.deps.probeTimeoutMs ?? 5000
    if (!Number.isFinite(timeout) || timeout <= 0)
      return { ok: false, detail: 'invalid probe timeout' }
    try {
      const result = spawnSync(program, args, {
        timeout,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ...(env ?? {}) }
      })
      if (result.error) return { ok: false, detail: result.error.message }
      if (result.status === 0) return { ok: true }
      return { ok: false, detail: `exit ${String(result.status)}` }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** Resolve a bundled asset path under resources/sandbox (must work in both dev and packaged mode) */
export function resolveSandboxAsset(
  fileName: string,
  candidates: { devRoot: string; resourcesPath: string }
): string | undefined {
  const paths = [
    join(candidates.devRoot, 'resources', 'sandbox', fileName),
    join(candidates.resourcesPath, 'sandbox', fileName)
  ]
  for (const candidate of paths) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Try the next candidate
    }
  }
  return undefined
}

/** Give the in-house Linux launcher its executable bit (packing/unpacking can drop permission bits) */
export function ensureExecutable(path: string): void {
  if (process.platform === 'win32') return
  try {
    const mode = statSync(path).mode
    // windowsHide has no effect outside Windows; it is passed only to uphold the rule that no child process flashes a console window
    if ((mode & 0o111) === 0) execFileSync('chmod', ['+x', path], { windowsHide: true })
  } catch (error) {
    sandboxLog.warn(`[Sandbox] Failed to make ${path} executable:`, error)
  }
}

/** Process-level singleton (paths are injected when the plugin installs) */
export const sandboxService = new SandboxService()

/** Let the harness construct an independent instance (without polluting the singleton) */
export function createSandboxService(deps: SandboxServiceDeps): SandboxService {
  return new SandboxService(deps)
}

/** Mode re-exports: saves callers an extra module import */
export type { SandboxMode, SandboxPolicy }
