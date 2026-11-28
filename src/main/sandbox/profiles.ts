import { DEFAULT_DENIAL_SIGNATURES, type ConfinedArgv, type SandboxPolicy } from './types'

/**
 * **argv construction** for each platform backend (pure functions, zero platform dependencies,
 * assertable offline).
 *
 * Of the three layers this one is the most error-prone and the most worth testing: one wrong argv
 * argument and the sandbox is either useless or fails to start at all. So every backend assembles
 * "policy -> command line" here, real execution only runs in the Windows harness (this machine is
 * Windows), and Linux/macOS argv are pinned one by one by the offline harness.
 */

/* ────────────────────────── Windows: in-house restricted-token runner ────────────────────────── */

export interface WindowsRunnerOptions {
  /** node/electron executable (under Electron use process.execPath + ELECTRON_RUN_AS_NODE=1) */
  nodePath: string
  /** runner script path (resources/sandbox/win32-sandbox-runner.cjs) */
  runnerPath: string
  /** App root (resources/app.asar when packaged): the runner uses it to resolve koffi */
  appRoot?: string
  /** Whether to revoke the persistent workspace ACE after the command ends (default is to keep it for reuse; set true on uninstall/cleanup) */
  revokeWorkspaceAfterRun?: boolean
}

/**
 * Wrap into a Windows runner invocation.
 *
 * `danger-full-access` does not go through the sandbox (the mode means "don't block"), so callers
 * must rule it out first — the error here is explicit, preventing silent mistakes such as
 * "accidentally feeding full permissions into the sandbox".
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
    // The restricted token must keep Everyone to pass process initialization, and NTFS hard links
    // can alias authorized files: self-assessed as partial, no absolute boundary claimed
    enforcement: 'partial',
    denialSignatures: DEFAULT_DENIAL_SIGNATURES,
    runnerFailure: { signature: 'ryten-sandbox-run:', exitCode: 127 },
    // The Electron binary only behaves as plain Node in node mode; RYTEN_APP_ROOT lets the runner resolve koffi
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      ...(options.appRoot ? { RYTEN_APP_ROOT: options.appRoot } : {})
    }
  }
}

/** argv that revokes the persistent workspace ACE (used by uninstall/cleanup; runs no command) */
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

/* ────────────────────────── macOS: sandbox-exec (bundled with the system) ────────────────────────── */

/** Escape a path as an SBPL string literal */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/** Build a Seatbelt profile: allow by default, deny all writes, then open writable directories per mode */
export function macosSeatbeltProfile(policy: SandboxPolicy): string {
  const writable = policy.mode === 'workspace-write' ? [policy.workspaceRoot] : []
  const forms = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    // Required sinks: writes to devices like /dev/null are part of process initialization
    `(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))`
  ]
  if (writable.length > 0) {
    forms.push(
      `(allow file-write* ${writable.map((root) => `(subpath ${sbplString(root)})`).join(' ')})`
    )
  }
  return forms.join('')
}

/** Wrap into `sandbox-exec -p <profile> -- argv` */
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

/* ────────────────────────── Linux: bubblewrap ────────────────────────── */

/** Build bwrap arguments: read-only bind of the root, plus workspace and /tmp bindings under workspace-write */
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

/** Wrap into `bwrap ... -- argv` */
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

/* ────────────────────────── Linux: in-house Landlock launcher ────────────────────────── */

/**
 * Build the Landlock launcher arguments (--ro / --rw / --).
 *
 * **Why /dev is a directory rather than /dev/null** (measured on 2026-09-27 with Docker + WSL2
 * kernel 5.15 / Landlock ABI 1): Landlock only accepts write rules on **directories** — calling
 * `landlock_add_rule` on a regular file or character device returns `EINVAL` (`/dev/null` and
 * regular files both yielded `Invalid argument`). Yet `> /dev/null` is basic command-line usage
 * (muting output, hooks, npm...), so it cannot be unavailable. Hence write permission on the
 * `/dev` **directory** is opened here; the cost is that write access to device nodes under /dev
 * opens as well (regular users have no DAC permission on those nodes anyway, and /dev in
 * containers usually holds only a few nodes) — which is exactly why the Landlock leg is
 * self-assessed as **partial**. The bubblewrap leg has no such issue: it replaces the whole /dev
 * with `--dev /dev`, keeping only null/zero/full/random/urandom/tty.
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

/** Wrap into `ryten-landlock-launcher --ro / --rw ... -- argv` */
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
    // partial: write permission on the /dev directory is opened (see the linuxLandlockArgs comment).
    // For a stricter boundary use the bubblewrap leg (it replaces the whole /dev).
    enforcement: 'partial',
    denialSignatures: ['permission denied'],
    runnerFailure: { signature: 'ryten-landlock-launcher:', exitCode: 125 }
  }
}
