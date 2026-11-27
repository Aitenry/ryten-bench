/**
 * 「在应用中打开」的应用探测（main/services/harness/open-in-app-detect.ts）回归测试。
 *
 * 跑法：`node --no-warnings tests/open-in-app-detect.test.mts`
 *
 * 本机是 Windows，跑不了真的 macOS / Linux：探测逻辑拆成了「纯函数 + 注入依赖」，
 * 这里用假 `exists` / `which` / `flatpakApps` / `windowsEntries` 把三端的识别路径都走一遍。
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  detectApps,
  EXPLORER_ID,
  type DetectDeps
} from '../src/main/services/harness/open-in-app-detect.ts'

const HOME = '/home/probe'
const WINDOWS_HOME = 'C:\\Users\\probe'

const deps = (over: Partial<DetectDeps>): DetectDeps => ({
  platform: 'win32',
  env: { PATH: '', HOME, USERPROFILE: WINDOWS_HOME },
  explorerLabel: '文件资源管理器',
  exists: () => false,
  readdir: () => [],
  which: async () => null,
  flatpakApps: async () => [],
  windowsEntries: async () => [],
  ...over
})

const ids = (apps: { id: string }[]): string[] => apps.map((app) => app.id)
let passed = 0
const test = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

/* ── 1. 三端共同：文件管理器永远第一个，文案用主进程给的那份 ───────────────── */
await test('文件管理器排第一，文案来自调用方', async () => {
  const apps = await detectApps(deps({ explorerLabel: '访达' }))
  assert.deepEqual(ids(apps), [EXPLORER_ID])
  assert.equal(apps[0].label, '访达')
})

/* ── 2. Windows：卸载登记（DisplayIcon）优先 ──────────────────────────────── */
await test('Windows：从卸载登记 DisplayIcon 认出装在 D 盘的 IDEA', async () => {
  const ideaExe = 'D:\\Program Files\\IntelliJ IDEA 2024.3.6\\bin\\idea64.exe'
  const apps = await detectApps(
    deps({
      windowsEntries: async () => [
        {
          displayName: 'IntelliJ IDEA 2024.3.6',
          displayIcon: ideaExe,
          installLocation: 'D:\\Program Files\\IntelliJ IDEA 2024.3.6'
        }
      ],
      exists: (path) => path === ideaExe
    })
  )
  assert.deepEqual(ids(apps), [EXPLORER_ID, 'idea'])
  assert.equal(apps[1].command, ideaExe)
})

/* ── 3. Windows：没有 DisplayIcon 时用 InstallLocation + bin/<exe> ─────────── */
await test('Windows：只有 InstallLocation 也能拼出可执行文件', async () => {
  const location = 'D:\\Program Files\\PyCharm 2023.2.3'
  const exe = join(location, 'bin', 'pycharm64.exe')
  const apps = await detectApps(
    deps({
      windowsEntries: async () => [
        { displayName: 'PyCharm 2023.2.3', displayIcon: '', installLocation: location }
      ],
      exists: (path) => path === exe
    })
  )
  assert.deepEqual(ids(apps), [EXPLORER_ID, 'pycharm'])
  assert.equal(apps[1].command, exe)
})

/* ── 4. Windows：登记里没有时退回 PATH ────────────────────────────────────── */
await test('Windows：登记里没有就按 PATH 找启动器', async () => {
  const exe = join('D:\\Tools\\WebStorm\\bin', 'webstorm64.exe')
  const apps = await detectApps(
    deps({
      env: { PATH: 'D:\\Tools\\WebStorm\\bin', USERPROFILE: WINDOWS_HOME },
      exists: (path) => path === exe
    })
  )
  assert.deepEqual(ids(apps), [EXPLORER_ID, 'webstorm'])
  assert.equal(apps[1].command, exe)
})

/* ── 5. macOS：/Applications 与 ~/Applications，启动走 open -a ─────────────── */
await test('macOS：/Applications 与 ~/Applications 都算，启动命令是 open -a', async () => {
  const ideaApp = join('/Applications', 'IntelliJ IDEA.app')
  const codeApp = join(HOME, 'Applications', 'Visual Studio Code.app')
  const apps = await detectApps(
    deps({
      platform: 'darwin',
      explorerLabel: '访达',
      exists: (path) => path === ideaApp || path === codeApp
    })
  )
  assert.deepEqual(ids(apps), [EXPLORER_ID, 'idea', 'vscode'])
  assert.equal(apps[1].command, 'open')
  assert.deepEqual(apps[1].commandArgs, ['-a', ideaApp])
  assert.deepEqual(apps[2].commandArgs, ['-a', codeApp])
})

await test('macOS：社区版 / Insiders 的名字也认', async () => {
  const pycharmCe = join('/Applications', 'PyCharm CE.app')
  const codeInsiders = join('/Applications', 'Visual Studio Code - Insiders.app')
  const apps = await detectApps(
    deps({
      platform: 'darwin',
      exists: (path) => path === pycharmCe || path === codeInsiders
    })
  )
  assert.deepEqual(ids(apps), [EXPLORER_ID, 'pycharm', 'vscode'])
})

await test('macOS：旧版 Toolbox 的 ~/Applications/JetBrains Toolbox 子目录也认', async () => {
  const app = join(HOME, 'Applications', 'JetBrains Toolbox', 'GoLand.app')
  const apps = await detectApps(
    deps({
      platform: 'darwin',
      exists: (path) => path === app
    })
  )
  assert.deepEqual(ids(apps), [EXPLORER_ID, 'goland'])
  assert.deepEqual(apps[1].commandArgs, ['-a', app])
})

/* ── 6. Linux：PATH / Toolbox 脚本 / snap / flatpak ───────────────────────── */
await test('Linux：PATH 上的命令', async () => {
  const apps = await detectApps(
    deps({
      platform: 'linux',
      explorerLabel: '文件管理器',
      which: async (command) => (command === 'code' ? '/usr/bin/code' : null)
    })
  )
  assert.deepEqual(ids(apps), [EXPLORER_ID, 'vscode'])
  assert.equal(apps[1].command, '/usr/bin/code')
  assert.deepEqual(apps[1].commandArgs, undefined)
})

await test('Linux：Toolbox 的启动脚本（不在 PATH 上也认）', async () => {
  const script = join(HOME, '.local', 'share', 'JetBrains', 'Toolbox', 'scripts', 'idea')
  const apps = await detectApps(
    deps({
      platform: 'linux',
      exists: (path) => path === script
    })
  )
  assert.deepEqual(ids(apps), [EXPLORER_ID, 'idea'])
  assert.equal(apps[1].command, script)
})

await test('Linux：snap 安装（/snap/bin）', async () => {
  const snap = join('/snap/bin', 'webstorm')
  const apps = await detectApps(
    deps({
      platform: 'linux',
      exists: (path) => path === snap
    })
  )
  assert.deepEqual(ids(apps), [EXPLORER_ID, 'webstorm'])
  assert.equal(apps[1].command, snap)
})

await test('Linux：flatpak 安装走 flatpak run', async () => {
  const apps = await detectApps(
    deps({
      platform: 'linux',
      flatpakApps: async () => ['com.jetbrains.PyCharm-Professional', 'com.spotify.Client']
    })
  )
  assert.deepEqual(ids(apps), [EXPLORER_ID, 'pycharm'])
  assert.equal(apps[1].command, 'flatpak')
  assert.deepEqual(apps[1].commandArgs, ['run', 'com.jetbrains.PyCharm-Professional'])
})

/* ── 7. 顺序恒为「清单顺序」，不受命中的先后影响 ──────────────────────────── */
await test('多应用时按清单顺序返回（IDEA → PyCharm → … → Cursor）', async () => {
  const apps = await detectApps(
    deps({
      platform: 'linux',
      which: async (command) =>
        ({ code: '/usr/bin/code', cursor: '/usr/bin/cursor', idea: '/opt/idea/bin/idea' })[command] ??
        null
    })
  )
  assert.deepEqual(ids(apps), [EXPLORER_ID, 'idea', 'vscode', 'cursor'])
})

console.log(`\n${passed} 项通过`)
