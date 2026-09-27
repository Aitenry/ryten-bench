#!/usr/bin/env node
/**
 * 构建沙箱自带资产 —— 产出**整个** `resources/sandbox/` 目录；附带 `--selfcheck`：
 * 对**打包产物**里的沙箱做真机自检（CI 与本地都能跑）。
 *
 * 为什么这个目录整体是构建产物（约定，见 .gitignore）：
 * 它是「随应用分发的运行期二进制/脚本」，其**源码**都在会入库的位置：
 *   - Windows 后端：`native/win32-sandbox-runner/win32-sandbox-runner.cjs`（手写，纯 CJS，
 *     被当成独立进程 spawn：`process.execPath` + `ELECTRON_RUN_AS_NODE=1`）；
 *   - Linux 后端：`native/landlock-launcher/ryten-landlock-launcher.c`（自研 Landlock 启动器，
 *     需要按目标架构编译）；
 *   - macOS 后端：无自带文件（运行时拼 SBPL，走系统自带 `sandbox-exec`）。
 * 所以 `resources/sandbox/` 里出现的东西一律可重建；删掉它不会丢源码。
 *
 * 产出：
 *   <out>/win32-sandbox-runner.cjs                      （所有平台都产，Windows 用）
 *   <out>/linux-<arch>/ryten-landlock-launcher          （在 Linux 上编译；静态链接优先）
 * 跑法：
 *   `node native/build-sandbox.mjs [--out <目录>] [--dynamic]`
 *   `node native/build-sandbox.mjs --selfcheck [<打包产物目录>]`（默认自动找 dist/*-unpacked）
 *   - `--out`   指定输出根（Docker/交叉构建用；默认仓库的 `resources/sandbox`）
 *   - `--dynamic` 强制动态链接（默认先试 `-static`：产物不依赖发行版 glibc 版本，
 *     任何发行版（含 Alpine/musl）都能跑，这正是「装完即用」的要求）
 * 接入：`pnpm build:sandbox`（dev / build:win / build:mac / build:linux 都会先跑它）。
 * 跨平台：在 Windows 上无法编译 Linux 目标 → 用 `docker/verify-sandbox.mjs`，
 *   它在容器里为 linux/amd64 与 linux/arm64 各构建一份并顺手把验证跑掉。
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

/** 本文件在 native/ 下，仓库根是再上一层 */
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

/** 目标架构目录名（与 sandbox/service.ts 的解析路径一致） */
function targetDirName() {
  if (process.arch === 'x64') return 'linux-x64'
  if (process.arch === 'arm64') return 'linux-arm64'
  return `linux-${process.arch}`
}

/** Windows runner：所有平台都产（Linux/macOS 打包时也在，便于跨平台组装资源） */
function buildWindowsRunner() {
  if (!existsSync(runnerSource)) {
    throw new Error(`缺少 Windows runner 源码：${runnerSource}`)
  }
  mkdirSync(outRoot, { recursive: true })
  const target = join(outRoot, 'win32-sandbox-runner.cjs')
  copyFileSync(runnerSource, target)
  console.log(`[sandbox] Windows runner → ${target}`)
}

/** Linux Landlock 启动器：需要在 Linux 上编译（这里用 cc；静态优先） */
function compile(compiler, outFile, extraFlags) {
  const args = ['-O2', '-Wall', '-Wextra', ...extraFlags, '-o', outFile, launcherSource]
  console.log(`[sandbox] ${compiler} ${args.join(' ')}`)
  execFileSync(compiler, args, { stdio: 'inherit' })
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

/* ────────────────────────── 打包产物自检（--selfcheck） ────────────────────────── */

let checked = 0
let failed = 0

/** 断言式打印 */
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
 * 退出码的可读形式。
 *
 * 为什么必须写十六进制：受限子进程「在 loader 初始化阶段就死掉」时退出码是
 * `0xC0000142`（`STATUS_DLL_INIT_FAILED`），十进制打印出来只是一串无意义的数字
 * （2026-09-27 CI 上就是 `exit=3221225794`，看不出任何东西）。
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

/** 一次受限执行的可诊断摘要：退出码 + 子进程输出尾部（CI 日志里没有它就查不出任何东西） */
function describeRun(result) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return `${describeExit(result.status)}${output ? ` out=${JSON.stringify(output.slice(-300))}` : ' out=(空)'}`
}

/** 找打包产物根目录（含 resources/sandbox 的那一层），支持 --dir 产物与 macOS .app */
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
 * 受限子进程用的探针脚本（写进工作区，由受限子进程自己执行）。
 *
 * 为什么要有它：`cmd.exe` 的 `>` 重定向里塞绝对路径要处理空格与引号，语法一旦被 cmd 解析坏，
 * 「写入被拒」与「命令根本没解析对」就长得一模一样；探针把**运行**（先打印 start）与
 * **写入结果**（wrote / denied:<code>）分成两行结构化输出，两种失败模式在日志里可区分。
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

/** Windows：用**打包出来的 Electron 二进制**跑 runner（生产调用路径） */
function selfcheckWindows(root, sandboxDir) {
  const runner = join(sandboxDir, 'win32-sandbox-runner.cjs')
  const exeCandidates = ['RytenBench.exe', 'electron.exe']
  const runtime = exeCandidates.map((name) => join(root, name)).find((path) => existsSync(path))
  const appRoot = existsSync(join(root, 'resources', 'app.asar'))
    ? join(root, 'resources', 'app.asar')
    : join(root, 'resources', 'app.asar.unpacked')
  const ws = mkdtempSync(join(tmpdir(), 'ryten-selfcheck-'))
  // 越界目标分两个：homedir 下的绝对路径（探针用）与工作区的 `..` 相对路径
  //（cmd 的 `>` 重定向用：不含空格，不会被引号解析坏）
  const outside = join(homedir(), 'ryten-sandbox-selfcheck.txt')
  const escape = join(tmpdir(), 'ryten-selfcheck-escape.txt')
  const probeScript = join(ws, 'sandbox-probe.cjs')
  writeFileSync(probeScript, PROBE_SOURCE)
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', RYTEN_APP_ROOT: appRoot }
  /** 受限调用：runner 自己把子进程 cwd 设成工作区（与产品 exec.ts 的 cwd=workspaceRoot 一致） */
  const run = (mode, argv) =>
    spawnSync(
      runtime ?? process.execPath,
      [runner, '--workspace', ws, '--temp', tmpdir(), '--mode', mode, '--', ...argv],
      { encoding: 'utf8', env }
    )
  /** 子进程是 cmd.exe —— 产品在 Windows 上就是这么包命令的（`cmd /d /s /c <命令>`） */
  const shell = (mode, command) => run(mode, ['cmd.exe', '/d', '/s', '/c', command])
  /** 子进程是打包后的 Electron 自己（node 模式；GUI 子系统，不需要控制台） */
  const probe = (mode, target, label) =>
    run(mode, [runtime ?? process.execPath, probeScript, target, label])

  console.log(`  运行时：${runtime ?? process.execPath}`)
  for (const path of [outside, escape]) rmSync(path, { force: true })

  // 对照组 1：产物外的目标路径在沙箱外本来可写——否则下面的「拒绝」断言毫无判别力
  try {
    execFileSync(process.execPath, [
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(outside)}, 'x')`
    ])
    expect('对照组：工作区外的目标路径在沙箱外可写（拒绝断言才有意义）', existsSync(outside))
    rmSync(outside, { force: true }) // 后面「越界被拒」要求这个路径不存在
  } catch (error) {
    expect(
      '对照组：工作区外目标可写',
      false,
      error instanceof Error ? error.message : String(error)
    )
  }

  // 对照组 2：同一条 cmd 命令在沙箱外能跑——否则下面的断言只是在说「这台机器跑不了 cmd.exe」
  rmSync(join(ws, 'control.txt'), { force: true })
  const controlShell = spawnSync(
    'cmd.exe',
    ['/d', '/s', '/c', 'echo ran-control& echo x > control.txt'],
    {
      encoding: 'utf8',
      cwd: ws
    }
  )
  expect(
    '对照组：同一条 cmd 命令在沙箱外可跑并写出文件',
    controlShell.status === 0 &&
      (controlShell.stdout ?? '').includes('ran-control') &&
      existsSync(join(ws, 'control.txt')),
    describeRun(controlShell)
  )

  // 对照组 3：cmd 用来越界的 `..` 相对路径在沙箱外可写
  const controlEscape = spawnSync(
    'cmd.exe',
    ['/d', '/s', '/c', 'echo ctrl> ..\\ryten-selfcheck-escape.txt'],
    {
      encoding: 'utf8',
      cwd: ws
    }
  )
  expect('对照组：越界相对路径（..\\）在沙箱外可写', existsSync(escape), describeRun(controlEscape))
  rmSync(escape, { force: true })

  // 工作区内写入：除文件存在外还要求子进程打印了运行探针（证明「写成功」是子进程干的）
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

  // 越界写入：必须看到运行探针，否则「进程根本没起来」也会被算成「被拒绝」= 假绿
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

  // 非控制台子进程（打包后的 Electron 自己）：把「只有控制台子进程起不来」与
  // 「整个受限令牌都不行」分开——CI（windows-latest）上这两种结论的处置完全不同
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

/** Linux：直接跑打包进来的自研启动器（内核 Landlock / bwrap 由 service 在运行期选） */
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
   * 与产品下发的形态一致（`profiles.ts` 的 `linuxLandlockArgs`）：`--ro /` + `--rw /dev`，
   * workspace-write 再加 `/tmp` 与工作区。
   *
   * **cwd 必须是工作区**：产品就是 `spawn(cwd=workspaceRoot)` + `/bin/sh -c <命令>`，
   * 相对路径落在哪里由它决定。2026-09-27 CI 实测的假失败根因：自检没传 cwd，
   * `echo x > inside.txt` 写到了仓库根目录 → 被 `--ro /` **正确拒绝**，
   * 于是「工作区内写入成功」永远是 ✗（而「越界被拒」还因为「只要非零就算拒绝」而假绿）。
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
      { encoding: 'utf8', cwd: ws }
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
    // 打包态只应有一份（extraResources 的 <resourcesPath>/sandbox）：asar 里不该再有，
    // 否则 service.ts 的 resolveSandboxAsset 在打包态会先命中 asar 里那份（路径不确定）
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
