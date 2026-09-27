#!/usr/bin/env node
/**
 * 构建沙箱自带资产 —— 产出**整个** `resources/sandbox/` 目录。
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
 *   - `--out`   指定输出根（Docker/交叉构建用；默认仓库的 `resources/sandbox`）
 *   - `--dynamic` 强制动态链接（默认先试 `-static`：产物不依赖发行版 glibc 版本，
 *     任何发行版（含 Alpine/musl）都能跑，这正是「装完即用」的要求）
 * 接入：`pnpm build:sandbox`（dev / build:win / build:mac / build:linux 都会先跑它）。
 * 跨平台：在 Windows 上无法编译 Linux 目标 → 用 `docker/verify-sandbox.mjs`，
 *   它在容器里为 linux/amd64 与 linux/arm64 各构建一份并顺手把验证跑掉。
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
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
