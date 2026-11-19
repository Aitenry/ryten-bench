import { DEFAULT_DENIAL_SIGNATURES, type ConfinedArgv, type SandboxPolicy } from './types'

/**
 * 各平台后端的 **argv 构造**（纯函数，零平台依赖，可离线断言）。
 *
 * 三层里这一层最容易出错也最值得测：argv 错一个参数，沙箱要么形同虚设、要么根本起不来。
 * 因此每个后端都在这里把「策略 → 命令行」拼好，真机执行只在 Windows 工装里跑
 * （本机就是 Windows），Linux/macOS 的 argv 由离线工装逐条钉住。
 */

/* ────────────────────────── Windows：自研受限令牌 runner ────────────────────────── */

export interface WindowsRunnerOptions {
  /** node/electron 可执行文件（Electron 下用 process.execPath + ELECTRON_RUN_AS_NODE=1） */
  nodePath: string
  /** runner 脚本路径（resources/sandbox/win32-sandbox-runner.cjs） */
  runnerPath: string
  /** 应用根（打包态是 resources/app.asar）：runner 用它解析 koffi */
  appRoot?: string
  /** 是否在命令结束后撤销工作区上的常驻 ACE（默认保留以复用；卸载/清理时置 true） */
  revokeWorkspaceAfterRun?: boolean
}

/**
 * 包装成 Windows runner 调用。
 *
 * `danger-full-access` 不走沙箱（档位语义就是「不拦」），调用方必须先判掉它——
 * 这里显式抛错，避免「不小心把完全权限也塞进沙箱」这类静默错误。
 */
export function windowsRunnerArgv(
  policy: SandboxPolicy,
  options: WindowsRunnerOptions,
  argv: readonly string[]
): ConfinedArgv {
  if (policy.mode === 'danger-full-access') {
    throw new Error('windowsRunnerArgv: danger-full-access must not be confined')
  }
  const runnerArgs = [
    options.runnerPath,
    '--workspace',
    policy.workspaceRoot,
    '--temp',
    policy.tempRoot ?? '',
    '--mode',
    policy.mode,
    ...(options.revokeWorkspaceAfterRun ? ['--revoke-workspace'] : []),
    '--',
    ...argv
  ]
  return {
    argv: [options.nodePath, ...runnerArgs],
    backend: 'windows-restricted-token',
    // 受限令牌必须保留 Everyone 才能过进程初始化，且 NTFS 硬链接能别名已授权文件：
    // 自评 partial，不宣称绝对边界
    enforcement: 'partial',
    denialSignatures: DEFAULT_DENIAL_SIGNATURES,
    runnerFailure: { signature: 'ryten-sandbox-run:', exitCode: 127 },
    // Electron 的二进制在 node 模式下才当普通 Node 用；RYTEN_APP_ROOT 让 runner 解析到 koffi
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      ...(options.appRoot ? { RYTEN_APP_ROOT: options.appRoot } : {})
    }
  }
}

/** 撤销工作区常驻 ACE 的 argv（卸载/清理入口用，不执行任何命令） */
export function windowsCleanupArgv(
  policy: SandboxPolicy,
  options: Pick<WindowsRunnerOptions, 'nodePath' | 'runnerPath' | 'appRoot'>
): ConfinedArgv {
  return {
    argv: [
      options.nodePath,
      options.runnerPath,
      '--workspace',
      policy.workspaceRoot,
      '--temp',
      policy.tempRoot ?? '',
      '--mode',
      'cleanup'
    ],
    backend: 'windows-restricted-token',
    enforcement: 'partial',
    denialSignatures: DEFAULT_DENIAL_SIGNATURES,
    runnerFailure: { signature: 'ryten-sandbox-run:', exitCode: 127 },
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      ...(options.appRoot ? { RYTEN_APP_ROOT: options.appRoot } : {})
    }
  }
}

/* ────────────────────────── macOS：sandbox-exec（系统自带） ────────────────────────── */

/** 把路径转义成 SBPL 字符串字面量 */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/** 生成 Seatbelt 配置：默认放行，禁掉一切写入，再按档位放开可写目录 */
export function macosSeatbeltProfile(policy: SandboxPolicy): string {
  const writable = policy.mode === 'workspace-write' ? [policy.workspaceRoot] : []
  const forms = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    // 必需 sink：/dev/null 等设备写入是进程初始化的一部分
    `(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))`
  ]
  if (writable.length > 0) {
    forms.push(
      `(allow file-write* ${writable.map((root) => `(subpath ${sbplString(root)})`).join(' ')})`
    )
  }
  return forms.join('')
}

/** 包装成 `sandbox-exec -p <profile> -- argv` */
export function macosSeatbeltArgv(
  policy: SandboxPolicy,
  sandboxExecPath: string,
  argv: readonly string[]
): ConfinedArgv {
  if (policy.mode === 'danger-full-access') {
    throw new Error('macosSeatbeltArgv: danger-full-access must not be confined')
  }
  return {
    argv: [sandboxExecPath, '-p', macosSeatbeltProfile(policy), '--', ...argv],
    backend: 'macos-seatbelt',
    enforcement: 'full',
    denialSignatures: ['operation not permitted', 'permission denied'],
    runnerFailure: { signature: 'sandbox-exec: ' }
  }
}

/* ────────────────────────── Linux：bubblewrap ────────────────────────── */

/** 生成 bwrap 参数：根只读绑定，workspace-write 时再绑定工作区与 /tmp */
export function linuxBwrapArgs(policy: SandboxPolicy): string[] {
  const args = [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--unshare-pid',
    '--proc',
    '/proc',
    '--die-with-parent'
  ]
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

/** 包装成 `bwrap ... -- argv` */
export function linuxBwrapArgv(
  policy: SandboxPolicy,
  bwrapPath: string,
  argv: readonly string[]
): ConfinedArgv {
  if (policy.mode === 'danger-full-access') {
    throw new Error('linuxBwrapArgv: danger-full-access must not be confined')
  }
  return {
    argv: [bwrapPath, ...linuxBwrapArgs(policy), '--', ...argv],
    backend: 'linux-bwrap',
    enforcement: 'full',
    denialSignatures: ['read-only file system', 'permission denied'],
    runnerFailure: { signature: 'bwrap: ' }
  }
}

/* ────────────────────────── Linux：自研 Landlock 启动器 ────────────────────────── */

/**
 * 生成 Landlock 启动器参数（--ro / --rw / --）。
 *
 * **为什么 /dev 是目录而不是 /dev/null**（2026-09-27 在 Docker + WSL2 内核 5.15 / Landlock ABI 1 实测）：
 * Landlock 只接受**目录**上的写规则——对普通文件或字符设备调用 `landlock_add_rule` 会返回
 * `EINVAL`（实测 `/dev/null` 与普通文件都是 `Invalid argument`）。而 `> /dev/null` 是命令行的
 * 基本操作（静音输出、hook、npm…），不能不可用。因此这里放开 `/dev` **目录**的写权限；
 * 代价是 /dev 下的设备节点写权限一并放开（普通用户对这些节点本身没有 DAC 权限，
 * 容器里 /dev 通常也只有少量节点）——这正是 Landlock 腿自评 **partial** 的原因。
 * bubblewrap 腿没有这个问题：它用 `--dev /dev` 换掉整个 /dev，只保留 null/zero/full/random/urandom/tty。
 */
export function linuxLandlockArgs(policy: SandboxPolicy): string[] {
  const readOnly = ['/']
  const readWrite = ['/dev']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  const args: string[] = []
  for (const path of readOnly) args.push('--ro', path)
  for (const path of readWrite) args.push('--rw', path)
  return args
}

/** 包装成 `ryten-landlock-launcher --ro / --rw ... -- argv` */
export function linuxLandlockArgv(
  policy: SandboxPolicy,
  launcherPath: string,
  argv: readonly string[]
): ConfinedArgv {
  if (policy.mode === 'danger-full-access') {
    throw new Error('linuxLandlockArgv: danger-full-access must not be confined')
  }
  return {
    argv: [launcherPath, ...linuxLandlockArgs(policy), '--', ...argv],
    backend: 'linux-landlock',
    // partial：/dev 目录写权限被放开（原因见 linuxLandlockArgs 注释）。
    // 想拿更严的边界就用 bubblewrap 腿（它换掉整个 /dev）。
    enforcement: 'partial',
    denialSignatures: ['permission denied'],
    runnerFailure: { signature: 'ryten-landlock-launcher:', exitCode: 125 }
  }
}
