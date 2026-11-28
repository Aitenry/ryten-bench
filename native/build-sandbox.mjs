#!/usr/bin/env node
/**
 * Build the sandbox's bundled assets — produce the **entire** `resources/sandbox/` directory;
 * also provides `--selfcheck` to run a real-machine self-check of the sandbox inside the
 * **packaged artifact** (works both in CI and locally).
 *
 * Why the whole directory is a build artifact (by convention):
 * It holds the runtime binaries/scripts distributed with the app; their **sources** live in
 * tracked locations:
 *   - Windows backend: `native/win32-sandbox-runner/win32-sandbox-runner.cjs` (hand-written,
 *     plain CJS, spawned as a separate process: `process.execPath` + `ELECTRON_RUN_AS_NODE=1`);
 *   - Linux backend: `native/landlock-launcher/ryten-landlock-launcher.c` (custom Landlock
 *     launcher, which must be compiled for the target architecture);
 *   - macOS backend: no bundled file (SBPL is assembled at runtime via the system `sandbox-exec`).
 * So everything under `resources/sandbox/` is reproducible; deleting it loses no source.
 *
 * Output:
 *   <out>/win32-sandbox-runner.cjs                      (produced on all platforms, used by Windows)
 *   <out>/linux-<arch>/ryten-landlock-launcher          (compiled on Linux; static linking preferred)
 * Usage:
 *   `node native/build-sandbox.mjs [--out <dir>] [--dynamic]`
 *   `node native/build-sandbox.mjs --selfcheck [<packaged artifact dir>]` (defaults to dist/*-unpacked)
 *   - `--out`   output root (for Docker/cross builds; defaults to the repo's `resources/sandbox`)
 *   - `--dynamic` force dynamic linking (by default `-static` is tried first: the artifact then
 *     does not depend on the distro's glibc version, so any distro (including Alpine/musl) can run
 *     it, which is exactly the "works right after install" requirement)
 * Integration: `pnpm build:sandbox` (dev / build:win / build:mac / build:linux all run it first).
 * Cross-platform: Linux targets cannot be compiled on Windows → use `docker/verify-sandbox.mjs`,
 *   which builds one for linux/amd64 and linux/arm64 inside a container and runs the verification.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This file is under native/, so the repo root is one level up. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const runnerSource = join(repoRoot, 'native', 'win32-sandbox-runner', 'win32-sandbox-runner.cjs')
const launcherSource = join(repoRoot, 'native', 'landlock-launcher', 'ryten-landlock-launcher.c')

const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out')
const outRoot =
  outIndex >= 0 && argv[outIndex + 1]
    ? resolve(argv[outIndex + 1])
    : join(repoRoot, 'resources', 'sandbox')
const forceDynamic = argv.includes('--dynamic')

/** Target-architecture directory name (matches the resolution path in sandbox/service.ts). */
function targetDirName() {
  if (process.arch === 'x64') return 'linux-x64'
  if (process.arch === 'arm64') return 'linux-arm64'
  return `linux-${process.arch}`
}

/** Windows runner: produced on every platform (also present in Linux/macOS packaging for cross-platform assembly). */
function buildWindowsRunner() {
  if (!existsSync(runnerSource)) {
    throw new Error(`缺少 Windows runner 源码：${runnerSource}`)
  }
  mkdirSync(outRoot, { recursive: true })
  const target = join(outRoot, 'win32-sandbox-runner.cjs')
  copyFileSync(runnerSource, target)
  console.log(`[sandbox] Windows runner → ${target}`)
}

/** Linux Landlock launcher: must be compiled on Linux (uses cc here; static linking preferred). */
function compile(compiler, outFile, extraFlags) {
  const args = ['-O2', '-Wall', '-Wextra', ...extraFlags, '-o', outFile, launcherSource]
  console.log(`[sandbox] ${compiler} ${args.join(' ')}`)
  // windowsHide: don't flash a console window on the user's desktop during cross-platform
  // builds/self-checks (no effect on non-Windows platforms)
  execFileSync(compiler, args, { stdio: 'inherit', windowsHide: true })
}

function buildLandlockLauncher() {
  const outDir = join(outRoot, targetDirName())
  const outFile = join(outDir, 'ryten-landlock-launcher')
  mkdirSync(outDir, { recursive: true })
  const compiler = process.env.CC || 'cc'
  if (forceDynamic) {
    compile(compiler, outFile, [])
    console.log('[sandbox] 按要求使用动态链接（--dynamic）')
  } else {
    try {
      compile(compiler, outFile, ['-static'])
      console.log('[sandbox] 静态链接成功（不依赖发行版 libc 版本）')
    } catch (error) {
      console.warn(
        '[sandbox] 静态链接失败，回退动态链接：产物需要与目标发行版的 glibc 兼容',
        error instanceof Error ? error.message : error
      )
      compile(compiler, outFile, [])
    }
  }
  chmodSync(outFile, 0o755)
  console.log(`[sandbox] Linux 启动器 → ${outFile}`)
}

/* ────────────────────────── Packaged-artifact self-check (--selfcheck) ────────────────────────── */

let checked = 0
let failed = 0

/** Assertion-style logging */
function expect(label, condition, detail = '') {
  if (condition) {
    checked += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * Human-readable form of an exit code.
 *
 * Why hex is mandatory: when a restricted child process "dies during loader initialization"
 * the exit code is `0xC0000142` (`STATUS_DLL_INIT_FAILED`); printed in decimal it is just a
 * meaningless number (on the 2026-09-27 CI run it was `exit=3221225794`, revealing nothing).
 */
function describeExit(status) {
  if (status === null || status === undefined) return 'exit=null（进程没起来）'
  const unsigned = status >>> 0
  const notable = {
    0xc0000142: 'STATUS_DLL_INIT_FAILED：进程在 DLL/控制台初始化阶段就死了',
    0xc0000135: 'STATUS_DLL_NOT_FOUND',
    0xc0000005: 'STATUS_ACCESS_VIOLATION',
    125: '启动器失败签名退出码（沙箱坏了，命令没执行）',
    127: 'runner 失败签名退出码（沙箱坏了，命令没执行）'
  }[unsigned]
  const code = unsigned >= 0x100 ? `0x${unsigned.toString(16)}` : String(status)
  return `exit=${code}${notable ? ` (${notable})` : ''}`
}

/** Diagnostic summary of one restricted run: exit code + tail of child output (CI logs are undiagnosable without it) */
function describeRun(result) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return `${describeExit(result.status)}${output ? ` out=${JSON.stringify(output.slice(-300))}` : ' out=(空)'}`
}

/** Find packaged-artifact roots (the level containing resources/sandbox); supports --dir artifacts and macOS .app */
function packagedRoots(explicit) {
  if (explicit) return [resolve(explicit)]
  const dist = join(repoRoot, 'dist')
  if (!existsSync(dist)) return []
  const roots = []
  for (const entry of readdirSync(dist, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const base = join(dist, entry.name)
    if (entry.name.endsWith('-unpacked')) roots.push(base)
    else if (entry.name.startsWith('mac')) {
      for (const inner of readdirSync(base, { withFileTypes: true })) {
        if (inner.isDirectory() && inner.name.endsWith('.app')) {
          roots.push(join(base, inner.name, 'Contents'))
        }
      }
    }
  }
  return roots
}

/**
 * Probe script for restricted child processes (written into the workspace and executed by the
 * restricted child itself).
 *
 * Why it exists: putting an absolute path into a `cmd.exe` `>` redirection requires handling
 * spaces and quotes; once cmd mis-parses the syntax, "the write was denied" and "the command
 * was never parsed correctly" look identical. The probe splits **execution** (prints start
 * first) and **write result** (wrote / denied:<code>) into two structured lines, so the two
 * failure modes are distinguishable in the log.
 */
const PROBE_SOURCE = `const fs = require('node:fs')
const [target, label] = process.argv.slice(2)
console.log('probe:' + label + ':start')
try {
  fs.writeFileSync(target, 'x')
  console.log('probe:' + label + ':wrote')
} catch (error) {
  console.log('probe:' + label + ':denied:' + (error.code || 'unknown'))
}
`

/** Windows: run the runner with the **packaged Electron binary** (the production call path) */
function selfcheckWindows(root, sandboxDir) {
  const runner = join(sandboxDir, 'win32-sandbox-runner.cjs')
  const exeCandidates = ['RytenBench.exe', 'electron.exe']
  const runtime = exeCandidates.map((name) => join(root, name)).find((path) => existsSync(path))
  const appRoot = existsSync(join(root, 'resources', 'app.asar'))
    ? join(root, 'resources', 'app.asar')
    : join(root, 'resources', 'app.asar.unpacked')
  const ws = mkdtempSync(join(tmpdir(), 'ryten-selfcheck-'))
  // Two out-of-bounds targets: an absolute path under homedir (for the probe) and a `..`
  // relative path from the workspace (for cmd's `>` redirection: no spaces, so quotes can't break it)
  const outside = join(homedir(), 'ryten-sandbox-selfcheck.txt')
  const escape = join(tmpdir(), 'ryten-selfcheck-escape.txt')
  const probeScript = join(ws, 'sandbox-probe.cjs')
  writeFileSync(probeScript, PROBE_SOURCE)
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', RYTEN_APP_ROOT: appRoot }
  /** Restricted invocation: the runner itself sets the child cwd to the workspace (matching the product's cwd=workspaceRoot in exec.ts) */
  const run = (mode, argv) =>
    spawnSync(
      runtime ?? process.execPath,
      [runner, '--workspace', ws, '--temp', tmpdir(), '--mode', mode, '--', ...argv],
      { encoding: 'utf8', env, windowsHide: true }
    )
  /** Child process is cmd.exe — the product wraps commands exactly this way on Windows (`cmd /d /s /c <command>`) */
  const shell = (mode, command) => run(mode, ['cmd.exe', '/d', '/s', '/c', command])
  /** Child process is the packaged Electron itself (node mode; GUI subsystem, no console needed) */
  const probe = (mode, target, label) =>
    run(mode, [runtime ?? process.execPath, probeScript, target, label])

  console.log(`  运行时：${runtime ?? process.execPath}`)
  for (const path of [outside, escape]) rmSync(path, { force: true })

  // Control group 1: the out-of-artifact target path is writable outside the sandbox — otherwise
  // the "denied" assertions below have no discriminating power
  try {
    execFileSync(
      process.execPath,
      ['-e', `require('fs').writeFileSync(${JSON.stringify(outside)}, 'x')`],
      { windowsHide: true }
    )
    expect('对照组：工作区外的目标路径在沙箱外可写（拒绝断言才有意义）', existsSync(outside))
    rmSync(outside, { force: true }) // a later "out-of-bounds denied" check requires this path to be absent
  } catch (error) {
    expect(
      '对照组：工作区外目标可写',
      false,
      error instanceof Error ? error.message : String(error)
    )
  }

  // Control group 2: the same cmd command runs outside the sandbox — otherwise the assertions
  // below only show that "this machine can't run cmd.exe"
  rmSync(join(ws, 'control.txt'), { force: true })
  const controlShell = spawnSync(
    'cmd.exe',
    ['/d', '/s', '/c', 'echo ran-control& echo x > control.txt'],
    {
      encoding: 'utf8',
      cwd: ws,
      windowsHide: true
    }
  )
  expect(
    '对照组：同一条 cmd 命令在沙箱外可跑并写出文件',
    controlShell.status === 0 &&
      (controlShell.stdout ?? '').includes('ran-control') &&
      existsSync(join(ws, 'control.txt')),
    describeRun(controlShell)
  )

  // Control group 3: the `..` relative path used to escape is writable outside the sandbox
  const controlEscape = spawnSync(
    'cmd.exe',
    ['/d', '/s', '/c', 'echo ctrl> ..\\ryten-selfcheck-escape.txt'],
    {
      encoding: 'utf8',
      cwd: ws,
      windowsHide: true
    }
  )
  expect('对照组：越界相对路径（..\\）在沙箱外可写', existsSync(escape), describeRun(controlEscape))
  rmSync(escape, { force: true })

  // Write inside the workspace: besides the file existing, the child must have printed the run
  // probe (proving the child actually performed the write)
  const inside = shell('workspace-write', 'echo ran-inside& echo x > inside.txt')
  expect(
    'workspace-write：工作区内写入成功（子进程确有运行）',
    inside.status === 0 &&
      (inside.stdout ?? '').includes('ran-inside') &&
      existsSync(join(ws, 'inside.txt')),
    describeRun(inside)
  )

  const again = shell('workspace-write', 'echo ran-again& echo again > again.txt')
  expect(
    'workspace-write：同一工作区再次授权（幂等检查路径）可用',
    again.status === 0 &&
      (again.stdout ?? '').includes('ran-again') &&
      existsSync(join(ws, 'again.txt')),
    describeRun(again)
  )

  // Out-of-bounds write: the run probe must be seen, otherwise "the process never started" also
  // counts as "denied" = falsely green
  const escapeShell = shell(
    'workspace-write',
    'echo ran-escape& echo x > ..\\ryten-selfcheck-escape.txt'
  )
  expect(
    'workspace-write：工作区外写入被内核拒绝且文件不存在',
    (escapeShell.stdout ?? '').includes('ran-escape') &&
      escapeShell.status !== 0 &&
      !existsSync(escape),
    describeRun(escapeShell)
  )

  rmSync(join(ws, 'readonly.txt'), { force: true })
  const readOnly = shell('read-only', 'echo ran-readonly& echo x > readonly.txt')
  expect(
    'read-only：连工作区内都写不了',
    (readOnly.stdout ?? '').includes('ran-readonly') &&
      readOnly.status !== 0 &&
      !existsSync(join(ws, 'readonly.txt')),
    describeRun(readOnly)
  )

  // Non-console child process (the packaged Electron itself): separate "only console child
  // processes fail to start" from "the whole restricted token is unusable" — on CI
  // (windows-latest) these two conclusions require completely different responses
  rmSync(join(ws, 'probe-inside.txt'), { force: true })
  const probeInside = probe('workspace-write', 'probe-inside.txt', 'inside')
  expect(
    'workspace-write：非控制台子进程（打包 Electron 的 node 模式）工作区内写入成功',
    (probeInside.stdout ?? '').includes('probe:inside:wrote') &&
      existsSync(join(ws, 'probe-inside.txt')),
    describeRun(probeInside)
  )

  const probeEscape = probe('workspace-write', outside, 'escape')
  expect(
    'workspace-write：非控制台子进程越界写入被拒绝',
    (probeEscape.stdout ?? '').includes('probe:escape:denied') && !existsSync(outside),
    describeRun(probeEscape)
  )

  const cleanup = shell('cleanup', 'echo unused')
  expect('cleanup：撤销工作区 ACE 成功', cleanup.status === 0, describeRun(cleanup))

  rmSync(ws, { recursive: true, force: true })
  rmSync(escape, { force: true })
  rmSync(outside, { force: true })
}

/** Linux: run the bundled custom launcher directly (the service picks kernel Landlock / bwrap at runtime) */
function selfcheckLinux(sandboxDir) {
  const dir = readdirSync(sandboxDir).find((name) => name.startsWith('linux-'))
  const launcher = dir ? join(sandboxDir, dir, 'ryten-landlock-launcher') : null
  if (!launcher || !existsSync(launcher)) {
    expect('打包产物内含 Linux 启动器', false, launcher ?? '(无 linux-* 目录)')
    return
  }
  expect('打包产物内含 Linux 启动器', true)
  const ws = mkdtempSync(join(tmpdir(), 'ryten-selfcheck-'))
  const outside = join(homedir(), 'ryten-sandbox-selfcheck.txt')
  /**
   * Matches the shape the product passes down (`linuxLandlockArgs` in `profiles.ts`): `--ro /` +
   * `--rw /dev`, plus `/tmp` and the workspace for workspace-write.
   *
   * **cwd must be the workspace**: the product does `spawn(cwd=workspaceRoot)` + `/bin/sh -c <command>`,
   * and where relative paths land depends on it. Root cause of the false failure measured on the
   * 2026-09-27 CI: the self-check did not pass cwd, so `echo x > inside.txt` wrote to the repo root
   * → correctly denied by `--ro /`, making "write inside workspace succeeds" permanently ✗ (while
   * "out-of-bounds denied" was also falsely green because "any non-zero exit counts as denied").
   */
  const run = (rwPaths, command) =>
    spawnSync(
      launcher,
      [
        '--ro',
        '/',
        '--rw',
        '/dev',
        ...rwPaths.flatMap((path) => ['--rw', path]),
        '--',
        '/bin/sh',
        '-c',
        command
      ],
      { encoding: 'utf8', cwd: ws, windowsHide: true }
    )
  const workspaceWrite = ['/tmp', ws]

  const probe = run([], 'true')
  expect('启动器可用（自我限制后 exec 成功）', probe.status === 0, describeRun(probe))

  rmSync(join(ws, 'inside.txt'), { force: true })
  const inside = run(workspaceWrite, 'echo ran-inside; echo x > inside.txt')
  expect(
    'workspace-write：工作区内写入成功（子进程确有运行）',
    inside.status === 0 &&
      (inside.stdout ?? '').includes('ran-inside') &&
      existsSync(join(ws, 'inside.txt')),
    describeRun(inside)
  )

  rmSync(outside, { force: true })
  const escape = run(workspaceWrite, `echo ran-outside; echo x > '${outside}'`)
  expect(
    'workspace-write：工作区外写入被拒绝且文件不存在',
    (escape.stdout ?? '').includes('ran-outside') && escape.status !== 0 && !existsSync(outside),
    describeRun(escape)
  )

  rmSync(join(ws, 'readonly.txt'), { force: true })
  const readOnly = run([], 'echo ran-readonly; echo x > readonly.txt')
  expect(
    'read-only：连工作区内都写不了',
    (readOnly.stdout ?? '').includes('ran-readonly') &&
      readOnly.status !== 0 &&
      !existsSync(join(ws, 'readonly.txt')),
    describeRun(readOnly)
  )

  rmSync(ws, { recursive: true, force: true })
  rmSync(outside, { force: true })
}

function selfcheck(explicitRoot) {
  const roots = packagedRoots(explicitRoot)
  if (roots.length === 0) {
    console.log('[sandbox] 找不到打包产物（先跑一次 electron-builder --dir，或显式给目录）')
    return false
  }
  for (const root of roots) {
    const sandboxDir = join(root, 'resources', 'sandbox')
    console.log(`\n── 自检打包产物：${root}`)
    expect(
      '产物内含 resources/sandbox/win32-sandbox-runner.cjs',
      existsSync(join(sandboxDir, 'win32-sandbox-runner.cjs')),
      sandboxDir
    )
    // In a packaged build there should be exactly one copy (extraResources' <resourcesPath>/sandbox):
    // it must not also exist inside asar, otherwise resolveSandboxAsset in service.ts hits the asar
    // copy first when packaged (indeterminate path)
    const duplicates = [
      join(root, 'resources', 'app.asar.unpacked', 'resources', 'sandbox'),
      join(root, 'Resources', 'app.asar.unpacked', 'resources', 'sandbox')
    ].filter((path) => existsSync(path))
    expect(
      'asar 里没有第二份 sandbox（只走 extraResources）',
      duplicates.length === 0,
      duplicates.join(', ')
    )
    if (!existsSync(sandboxDir)) continue
    if (process.platform === 'win32') selfcheckWindows(root, sandboxDir)
    else if (process.platform === 'linux') selfcheckLinux(sandboxDir)
    else expect('macOS 用系统自带 sandbox-exec，只断言资产存在', true)
  }
  console.log(`\n[sandbox] 自检完成：通过 ${checked} 项，失败 ${failed} 项`)
  return failed === 0
}

const selfcheckIndex = argv.indexOf('--selfcheck')
if (selfcheckIndex >= 0) {
  const next = argv[selfcheckIndex + 1]
  const explicit = next && !next.startsWith('--') ? next : undefined
  const ok = selfcheck(explicit)
  process.exit(ok ? 0 : 1)
}

buildWindowsRunner()
if (process.platform === 'linux') {
  buildLandlockLauncher()
} else if (process.platform === 'darwin') {
  console.log('[sandbox] macOS 用系统自带的 sandbox-exec，无需编译启动器')
} else {
  console.log(
    '[sandbox] 非 Linux 平台跳过启动器编译（交叉构建请用 `node docker/verify-sandbox.mjs`，它在容器内按架构编译）'
  )
}
