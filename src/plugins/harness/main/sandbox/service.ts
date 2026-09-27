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
 * 沙箱服务 —— 档位 → 真正的 OS 隔离原语的唯一入口。
 *
 * 平台链（先探测、后选用，**拿不到就故障关闭**，绝不退回「不受限地跑」）：
 *  - win32  → `windows-restricted-token`：自研受限令牌 runner（不用管理员、不建账户）；
 *  - linux  → `linux-bwrap`（系统装了 bubblewrap 时优先）→ `linux-landlock`（自研启动器，
 *             用内核 Landlock，不需要 root、不需要装任何包）；
 *  - darwin → `macos-seatbelt`：系统自带的 sandbox-exec + 自研 SBPL 配置。
 *
 * 为什么探测要跑真命令：能装不代表能用（内核没开 Landlock、工作区在 exFAT 上、企业策略
 * 禁用受限令牌……）。探针跑一次真调用并缓存结论；探测失败 = 不可用 = 拒绝执行。
 *
 * 本文件不 import electron：平台、路径、探针执行器全部经 deps 注入，
 * 因此可以脱离 Electron 用 node 直接加载（离线回归 + 真机验证工装都靠它）。
 */

/** 探测结论 */
export interface SandboxStatus {
  platform: string
  /** 可用后端（不可用时为 null） */
  backend: SandboxBackendName | null
  enforcement: SandboxEnforcement | null
  usable: boolean
  /** 不可用原因（诊断与界面提示用） */
  reason?: string
}

export interface SandboxServiceDeps {
  /** 覆盖平台（工装用来在任意主机上验证各平台链） */
  platform?: string
  /** Windows runner 脚本路径（resources/sandbox/win32-sandbox-runner.cjs） */
  windowsRunnerPath?: string
  /** 运行 runner 的 node/electron 可执行文件（Electron 下是 process.execPath） */
  nodePath?: string
  /** 应用根（打包态是 resources/app.asar）：runner 用它解析 koffi */
  appRoot?: string
  /** 自研 Landlock 启动器路径 */
  landlockLauncherPath?: string
  /** bubblewrap 可执行文件（默认 'bwrap'，按 PATH 查找） */
  bwrapPath?: string
  /** macOS 的 sandbox-exec（默认 'sandbox-exec'） */
  seatbeltPath?: string
  /** 私有临时目录根（默认系统临时目录） */
  tempRoot?: string
  /** 探针执行器（默认 spawnSync；工装可注入确定性实现） */
  runProbe?: (argv: string[], env?: Record<string, string>) => { ok: boolean; detail?: string }
  /** 探针超时（毫秒，必须为正；0 在 Node 里表示「无限等」，这里显式拒绝） */
  probeTimeoutMs?: number
}

/** 探测结论缓存：一次进程生命周期内只探一次 */
type Verdict =
  { backend: SandboxBackendName; enforcement: SandboxEnforcement } | { unavailable: string }

export class SandboxService {
  private deps: SandboxServiceDeps
  private verdict: Verdict | undefined

  constructor(deps: SandboxServiceDeps = {}) {
    this.deps = deps
  }

  /** 接线/覆盖配置（插件 install 时把真实路径注入进来；变更后重新探测） */
  configure(deps: Partial<SandboxServiceDeps>): void {
    this.deps = { ...this.deps, ...deps }
    this.verdict = undefined
  }

  /** 当前实际使用的路径与平台（诊断用） */
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

  /** 沙箱状态（惰性探测 + 缓存） */
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

  /** 清掉探测缓存（设置变更 / 工装重复验证用） */
  reset(): void {
    this.verdict = undefined
  }

  /**
   * 把一条命令包装成受限调用。
   *
   * @throws SandboxUnavailableError 该平台没有可用后端（调用方必须拒绝执行）
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

  /** 撤销工作区上的常驻 ACE（卸载/清理；仅 Windows 后端有这个概念） */
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
      sandboxLog.warn(`[Sandbox] 工作区 ACE 清理失败: ${result.detail ?? 'unknown'}`)
      return false
    }
    return true
  }

  /* ────────────────────────── 内部 ────────────────────────── */

  private platform(): string {
    return this.deps.platform ?? process.platform
  }

  private tempRoot(): string {
    return this.deps.tempRoot ?? tmpdir()
  }

  private nodePath(): string {
    return this.deps.nodePath ?? process.execPath
  }

  /** 解析一次平台链并缓存结论 */
  private resolve(): Verdict {
    if (this.verdict !== undefined) return this.verdict
    this.verdict = this.probeChain()
    const verdict = this.verdict
    if ('unavailable' in verdict) {
      sandboxLog.warn(`[Sandbox] 无可用沙箱后端（${this.platform()}）：${verdict.unavailable}`)
    } else {
      sandboxLog.info(
        `[Sandbox] 后端=${verdict.backend} 强制完整度=${verdict.enforcement}（platform=${this.platform()}）`
      )
    }
    return verdict
  }

  /** 平台链：按顺序探测，第一个通过的就是本进程要用的后端 */
  private probeChain(): Verdict {
    let lastDetail = ''
    for (const candidate of this.candidates()) {
      const result = candidate.probe()
      if (result.ok) return { backend: candidate.backend, enforcement: candidate.enforcement }
      lastDetail = `${candidate.backend}: ${result.detail ?? 'probe failed'}`
      sandboxLog.info(
        `[Sandbox] 候选后端 ${candidate.backend} 不可用：${result.detail ?? 'probe failed'}`
      )
    }
    return { unavailable: lastDetail || `no sandbox backend for platform ${this.platform()}` }
  }

  /** 本平台的候选后端（顺序即优先级） */
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
            // 用最宽松的配置起一个真进程：sandbox-exec 拒绝配置时会非零退出
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
    // linux（含其它 Unix 兜底）
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
        // partial：Landlock 只接受目录级写规则，因此 /dev 目录的写权限被放开
        // （保证 `> /dev/null` 可用；原因见 profiles.ts 的 linuxLandlockArgs 注释）
        enforcement: 'partial',
        probe: () => {
          const launcher = this.deps.landlockLauncherPath
          if (!launcher) return { ok: false, detail: 'landlock launcher not configured' }
          if (!existsSync(launcher))
            return { ok: false, detail: `landlock launcher missing: ${launcher}` }
          // 探针参数与真正下发的形态一致（目录级 --rw /dev + 一次真实 exec）
          return this.probe(['--ro', '/', '--rw', '/dev', '--', 'true'], undefined, launcher)
        }
      }
    ]
  }

  /**
   * Windows runner 探针：在一个临时目录里跑 `cmd /c exit 0`。
   *
   * 这一跑就把「koffi 能加载、令牌能造、ACL 能改（非 NTFS 会在这里失败）、进程能起」
   * 全部验证了——探针过了才认为后端可用。
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
      // 探针只验证「受限进程能起」：不写任何东西，因此用 read-only（零授权、零 ACL 改动）
      return this.probe(confined.argv, confined.env)
    } finally {
      try {
        rmSync(probeWorkspace, { recursive: true, force: true })
      } catch (error) {
        sandboxLog.warn('[Sandbox] 探针临时目录清理失败:', error)
      }
    }
  }

  /** 真跑一次命令看后端能不能用（默认 spawnSync；超时必须为正） */
  private probe(
    argv: readonly string[],
    env?: Record<string, string>,
    executableOverride?: string
  ): { ok: boolean; detail?: string } {
    const [head] = argv
    if (!head) return { ok: false, detail: 'empty argv' }
    // 有 executableOverride 时，argv 整体是**参数**（程序另给）；
    // 没有时 argv[0] 就是程序。曾经写反过：带 override 时把 argv[0] 当程序名丢掉，
    // 于是三个非 Windows 探针都在用错误的参数跑（真机验证抓到的 bug）。
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

/** 解析 resources/sandbox 下的自带资产路径（开发态与打包态都要能找到） */
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
      // 试下一个候选
    }
  }
  return undefined
}

/** 让自研的 Linux 启动器带上可执行位（打包/解包可能丢权限位） */
export function ensureExecutable(path: string): void {
  if (process.platform === 'win32') return
  try {
    const mode = statSync(path).mode
    if ((mode & 0o111) === 0) execFileSync('chmod', ['+x', path])
  } catch (error) {
    sandboxLog.warn(`[Sandbox] 无法给 ${path} 加可执行位:`, error)
  }
}

/** 进程级单例（路径由插件 install 时注入） */
export const sandboxService = new SandboxService()

/** 供工装构造独立实例（不污染单例） */
export function createSandboxService(deps: SandboxServiceDeps): SandboxService {
  return new SandboxService(deps)
}

/** 档位别名：让调用方少 import 一个模块 */
export type { SandboxMode, SandboxPolicy }
