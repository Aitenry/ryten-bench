import * as fs from 'fs'
import * as path from 'path'
import { builtinModules } from 'node:module'
import type {
  WorkshopCheck,
  WorkshopMainSmoke,
  WorkshopReport,
  WorkshopRendererProbe
} from '../../shared/workshop'
import { distDir, draftDir, reportPath, writeJson, RESERVED_DRAFT_IDS } from './paths'
import { listDraftFiles, readDraftManifest, readDraftMeta } from './store'
import {
  buildDraft,
  bundleMainSpecs,
  bundleRendererSpecs,
  relativeSpecifiersInBundle
} from './build'
import { missingClasses, scanDraftCandidates } from './css'
import { isWorkshopConfigured, workshopHostOrNull, type WorkshopHost } from './host'

/**
 * 验收电池：把「这个插件装上去能不能用」变成一组可复现的检查。
 *
 * 检查按「越靠前越致命」排（`fatal: true` 的失败合计进 `report.ok`）：
 *
 * | id | 检查 | 说明 |
 * |----|------|------|
 * | `pkg.manifest` | 清单字段齐备（id/name/version 与目录一致，builtin=false） | 致命 |
 * | `pkg.build` | 构建产物（esbuild 诊断） | 致命 |
 * | `pkg.entries` | plugin.json / main.cjs / renderer.mjs 真实存在且非空 | 致命 |
 * | `pkg.identity` | id 不是保留 id / 内置 id / 别人占用的命名空间 | 致命 |
 * | `pkg.host-main` | 主进程引的 `@host/**` 都在宿主运行时表里、裸依赖能解析 | 致命 |
 * | `pkg.host-ui` | 渲染层引的宿主模块都在宿主 UI 表里 | 致命 |
 * | `pkg.chunks` | 产物里没有相对说明符（blob import 会取不到） | 致命 |
 * | `main.smoke` | **真的 require 产物 + 真实 install(ctx) 契约**，含草稿自带冒烟用例 | 致命 |
 * | `renderer.probe` | 在真渲染进程里 import + install（没窗口时 skip） | 非致命 |
 * | `style.coverage` | className 用到的类名在 plugin.css 里都有规则 | 非致命 |
 * | `risk.scan` | 危险 API 清单（发布前给用户/模型看） | 非致命 |
 *
 * 致命项全过 = 装上去能用；非致命项失败 = 能跑但不对（样式塌了 / 有风险调用）。
 */

/** 宿主主进程上下文的**记录版**：与 `src/main/plugins/context.ts` 同形，但不碰 ipcMain */
interface RecordingContext {
  id: string
  namespace: string
  channels: Record<string, (...args: never[]) => unknown>
  events: string[]
  contributions: { key: string; value: unknown }[]
  effects: number
  rolledBack: number
  disposed: boolean
  /** effect 的 undo 栈（LIFO 回滚） */
  undos: Array<() => void>
  dispose(): void
}

function createRecordingContext(id: string): RecordingContext {
  const record: RecordingContext = {
    id,
    namespace: id.startsWith('plugin.') ? id.slice('plugin.'.length) : id,
    channels: {},
    events: [],
    contributions: [],
    effects: 0,
    rolledBack: 0,
    disposed: false,
    undos: [],
    dispose() {
      if (record.disposed) return
      record.disposed = true
      while (record.undos.length > 0) {
        const undo = record.undos.pop()!
        try {
          undo()
          record.rolledBack += 1
        } catch {
          // 回滚失败不阻断其余回滚（与宿主 dispose 的语义一致）
        }
      }
    }
  }
  return record
}

/** 交给产物 `install(ctx)` 的上下文对象（记录版） */
function contextFacade(record: RecordingContext): Record<string, unknown> {
  return {
    id: record.id,
    namespace: record.namespace,
    registerIpc(handlers: Record<string, (...args: never[]) => unknown>) {
      for (const [channel, handler] of Object.entries(handlers ?? {})) {
        record.channels[channel] = handler
      }
      return () => {
        for (const channel of Object.keys(handlers ?? {})) delete record.channels[channel]
      }
    },
    registerEvent(...channels: string[]) {
      for (const channel of channels) if (typeof channel === 'string') record.events.push(channel)
    },
    effect(register: () => void | (() => void)) {
      record.effects += 1
      const undo = register()
      if (typeof undo === 'function') record.undos.push(undo)
    },
    contribute(key: string, value: unknown) {
      record.contributions.push({ key, value })
    },
    contributions() {
      return []
    }
  }
}

/** 冒烟用例（`workshop.smoke.mjs`）的结构 */
interface SmokeCases {
  channels: Record<string, { args?: unknown[]; expect?: unknown }>
}

/**
 * 读草稿里的冒烟用例。
 *
 * 只支持 `export default { … }` 的**表达式**形态（模板生成的就是它），用 `new Function` 求值。
 * 草稿代码本来就以同等信任级别在主进程里跑（install 也是它写的），这里额外要求
 * 「整份文件就是一个 default 导出表达式」，避免顺手执行别的东西。
 */
function loadSmokeCases(draftRoot: string): { cases: SmokeCases | null; error?: string } {
  const file = path.join(draftRoot, 'workshop.smoke.mjs')
  if (!fs.existsSync(file)) return { cases: null }
  const source = fs.readFileSync(file, 'utf-8')
  const body = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .trim()
  const match = /^export\s+default\s+([\s\S]+?);?$/.exec(body)
  if (!match) {
    return { cases: null, error: 'workshop.smoke.mjs 只支持 `export default { … }` 一个导出表达式' }
  }
  try {
    const value = new Function(`return (${match[1]});`)() as SmokeCases
    if (!value || typeof value !== 'object' || typeof value.channels !== 'object') {
      return { cases: null, error: 'workshop.smoke.mjs 的 default 需要形如 { channels: { … } }' }
    }
    return { cases: value }
  } catch (err) {
    return { cases: null, error: `workshop.smoke.mjs 求值失败：${(err as Error).message}` }
  }
}

/** 断言：函数（返回 true/字符串）或 JSON 深比较 */
async function runExpect(
  expect: unknown,
  value: unknown
): Promise<{ ok: boolean; detail?: string }> {
  if (expect === undefined) return { ok: true }
  if (typeof expect === 'function') {
    try {
      const result = await (expect as (v: unknown) => unknown)(value)
      if (result === true || result === undefined) return { ok: true }
      if (typeof result === 'string') return { ok: false, detail: result }
      return { ok: false, detail: `expect 返回了 ${JSON.stringify(result)}` }
    } catch (err) {
      return { ok: false, detail: `expect 抛错：${(err as Error).message}` }
    }
  }
  const same = JSON.stringify(expect) === JSON.stringify(value)
  return same
    ? { ok: true }
    : { ok: false, detail: `期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(value)}` }
}

/** 清单检查（工坊自己的一份：提示要能直接落到「改哪个字段」） */
function checkManifest(manifest: Record<string, unknown> | null, id: string): WorkshopCheck {
  const base: WorkshopCheck = {
    id: 'pkg.manifest',
    title: '清单 plugin.json',
    status: 'pass',
    fatal: true
  }
  if (!manifest) {
    return {
      ...base,
      status: 'fail',
      detail: 'plugin.json 缺失或不是合法 JSON',
      hint: '补一份 plugin.json（字段见 WORKSHOP.md 第 3 节）'
    }
  }
  const problems: string[] = []
  if (typeof manifest.id !== 'string' || manifest.id !== id) {
    problems.push(`id 必须是 '${id}'（当前 ${JSON.stringify(manifest.id)}）`)
  }
  if (typeof manifest.name !== 'string' || manifest.name.trim() === '')
    problems.push('缺 name（展示名）')
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    problems.push('version 必须是 semver（如 "0.1.0"）')
  }
  if (manifest.builtin === true) problems.push('builtin 必须是 false（工坊做的是第三方插件）')
  if (problems.length > 0) {
    return {
      ...base,
      status: 'fail',
      detail: problems.join('；'),
      hint: '按 WORKSHOP.md 第 3 节改 plugin.json（entry 由构建写入，不要手写）'
    }
  }
  const extras: string[] = []
  if (Array.isArray(manifest.routes) && manifest.routes.length > 0)
    extras.push(`${manifest.routes.length} 条路由`)
  if (manifest.menu) extras.push('侧栏菜单')
  return {
    ...base,
    detail: `${String(manifest.name)} v${String(manifest.version)}${extras.length ? `（${extras.join('、')}）` : ''}`
  }
}

/** 危险 API 清单：命中只提示，不阻断（插件在主进程本来就有完整权限） */
const RISK_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /child_process|execSync\(|spawnSync\(|\bspawn\(/, label: '起子进程（child_process）' },
  { re: /fs\.rmSync\([^)]*recursive:\s*true/, label: '递归删目录（fs.rmSync recursive）' },
  { re: /process\.exit\(/, label: '直接退出应用（process.exit）' },
  { re: /\beval\(|new Function\(/, label: '动态求值（eval / new Function）' },
  { re: /["'](node:)?net["']|["'](node:)?http["']/, label: '原始网络访问（net / http）' },
  { re: /shell\.openExternal|shell\.openPath/, label: '调起系统程序（shell.openExternal）' },
  { re: /webContents\.(send|executeJavaScript)/, label: '直接操作渲染进程（webContents）' },
  { re: /ipcMain\.(handle|on)\(/, label: '绕过 ctx.registerIpc 直接注册通道' }
]

function riskScan(outDir: string): string[] {
  const findings = new Set<string>()
  for (const file of fs.readdirSync(outDir)) {
    if (!/\.(cjs|mjs)$/.test(file)) continue
    let code: string
    try {
      code = fs.readFileSync(path.join(outDir, file), 'utf-8')
    } catch {
      continue
    }
    for (const { re, label } of RISK_PATTERNS) {
      if (re.test(code)) findings.add(`${label}（${file}）`)
    }
  }
  return [...findings]
}

/** 贡献项的可读标签（工具贡献显示工具名，purge 类贡献显示 label） */
function contributionLabels(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const item = value as { name?: unknown; label?: unknown }
  if (typeof item.name === 'string') return [item.name]
  if (typeof item.label === 'string') return [item.label]
  return []
}

/**
 * 主进程冒烟：把产物里的 `main.cjs` 真的 require 进来，用记录版上下文跑一遍 `install`。
 *
 * 为什么必须真跑（而不是只看静态产物）：插件最常见的三类装载失败——
 * ① 引了宿主运行时表里没有的 `@host/**` 键；② 通道名没落在自己的命名空间；
 * ③ install 第一行就抛（读文件/读设置/用错 API）——**只有真的 require 一次**才会暴露，
 * 而它们的表现都是「插件装上了但功能全哑」。
 *
 * 安全性：跑完立刻 dispose（效果 LIFO 回滚）并清 require 缓存；上下文是记录版，
 * 不碰 ipcMain 与真实贡献注册表，因此不会改变应用的真实状态。
 */
async function runMainSmoke(
  id: string,
  outDir: string,
  draftRoot: string,
  host: WorkshopHost
): Promise<{ check: WorkshopCheck; smoke: WorkshopMainSmoke }> {
  const startedAt = Date.now()
  const smoke: WorkshopMainSmoke = {
    channels: [],
    events: [],
    contributions: [],
    effects: 0,
    cases: [],
    durationMs: 0
  }
  const base: WorkshopCheck = {
    id: 'main.smoke',
    title: '主进程冒烟（真实装载）',
    status: 'pass',
    fatal: true
  }
  const entry = path.join(outDir, 'main.cjs')
  if (!fs.existsSync(entry)) {
    return { check: { ...base, status: 'fail', detail: '产物里没有 main.cjs' }, smoke }
  }

  const record = createRecordingContext(id)
  const facade = contextFacade(record)
  let install: unknown
  try {
    const requireFn = host.loader.require as (request: string) => unknown
    const loaded = requireFn(entry) as { install?: unknown } | ((ctx: unknown) => void)
    install = typeof loaded === 'function' ? loaded : loaded?.install
  } catch (err) {
    return {
      check: {
        ...base,
        status: 'fail',
        detail: `require 失败：${(err as Error).message}`,
        hint: '通常是引了宿主没有的模块（见 pkg.host-main）或产物语法问题'
      },
      smoke
    }
  }

  if (typeof install !== 'function') {
    return {
      check: {
        ...base,
        status: 'fail',
        detail: 'main.cjs 没有导出 install(ctx)',
        hint: '主进程入口需要 `export function install(ctx)`'
      },
      smoke
    }
  }

  try {
    ;(install as (ctx: unknown) => void)(facade)
  } catch (err) {
    record.dispose()
    clearRequireCache(entry)
    return {
      check: {
        ...base,
        status: 'fail',
        detail: `install(ctx) 抛出：${(err as Error).message}`,
        hint: 'install 里有立即抛错的代码（读文件/读设置/参数校验）；挪进 handler 里或加兜底'
      },
      smoke
    }
  }

  smoke.channels = Object.keys(record.channels).sort()
  smoke.events = [...record.events].sort()
  smoke.effects = record.effects
  smoke.contributions = record.contributions.map((c) => ({
    key: c.key,
    labels: contributionLabels(c.value)
  }))

  const problems: string[] = []
  const prefix = `plugin:${record.namespace}:`
  const badChannels = smoke.channels.filter((channel) => !channel.startsWith(prefix))
  if (badChannels.length > 0)
    problems.push(`通道没有落在 ${prefix} 前缀内：${badChannels.join('、')}`)

  // 冒烟用例：用真实 handler 调用，参数与断言都来自草稿
  const loadedCases = loadSmokeCases(draftRoot)
  if (loadedCases.error) {
    smoke.cases.push({ name: 'workshop.smoke.mjs', ok: false, detail: loadedCases.error })
    problems.push(loadedCases.error)
  } else if (loadedCases.cases) {
    for (const [channel, test] of Object.entries(loadedCases.cases.channels ?? {})) {
      const caseStarted = Date.now()
      const handler = record.channels[channel] as ((...args: unknown[]) => unknown) | undefined
      if (typeof handler !== 'function') {
        smoke.cases.push({
          name: channel,
          ok: false,
          detail: `通道不存在（插件注册的是：${smoke.channels.join('、') || '（无）'}）`,
          durationMs: Date.now() - caseStarted
        })
        continue
      }
      try {
        const value = await Promise.resolve(handler(...(test?.args ?? [])))
        const verdict = await runExpect(test?.expect, value)
        smoke.cases.push({
          name: channel,
          ok: verdict.ok,
          detail: verdict.ok ? undefined : verdict.detail,
          durationMs: Date.now() - caseStarted
        })
      } catch (err) {
        smoke.cases.push({
          name: channel,
          ok: false,
          detail: `调用抛出：${(err as Error).message}`,
          durationMs: Date.now() - caseStarted
        })
      }
    }
    const failedCases = smoke.cases.filter((c) => !c.ok)
    if (failedCases.length > 0) {
      problems.push(
        `冒烟用例 ${failedCases.length}/${smoke.cases.length} 条失败：` +
          failedCases.map((c) => `${c.name}（${c.detail ?? '断言不通过'}）`).join('；')
      )
    }
  }

  // 回收：LIFO 回滚 + dispose 幂等
  record.dispose()
  if (smoke.effects > 0 && record.rolledBack < smoke.effects) {
    problems.push(
      `有 ${smoke.effects - record.rolledBack} 个 effect 没有返回回滚函数（插件停用时不会撤销）`
    )
  }
  try {
    record.dispose()
  } catch (err) {
    problems.push(`重复 dispose 抛错：${(err as Error).message}`)
  }
  clearRequireCache(entry)

  smoke.durationMs = Date.now() - startedAt
  const detailParts = [`通道 ${smoke.channels.length} 个`]
  if (smoke.events.length > 0) detailParts.push(`事件通道 ${smoke.events.length} 个`)
  if (smoke.contributions.length > 0) {
    detailParts.push(
      `贡献 ${smoke.contributions.map((c) => `${c.key}:${c.labels.join('/') || '（无标签）'}`).join('、')}`
    )
  }
  if (smoke.effects > 0)
    detailParts.push(`可逆效果 ${smoke.effects} 个（已回滚 ${record.rolledBack}）`)
  if (smoke.cases.length > 0) {
    detailParts.push(
      `冒烟用例 ${smoke.cases.filter((c) => c.ok).length}/${smoke.cases.length} 通过`
    )
  }

  return {
    check: {
      ...base,
      status: problems.length === 0 ? 'pass' : 'fail',
      detail: problems.length === 0 ? detailParts.join('，') : problems.join('；'),
      hint:
        problems.length === 0
          ? undefined
          : '按点名改：通道前缀必须 plugin:<id>: / 每个通道要有函数 / effect 要返回回滚函数 / 冒烟用例断言'
    },
    smoke
  }
}

/** 清掉产物模块的 require 缓存（避免这份临时模块留在进程里干扰真实装载） */
function clearRequireCache(entry: string): void {
  try {
    // CJS 产物里有 require；离线 ESM 工装里没有（ReferenceError 被这里吞掉）
    if (typeof require === 'function' && require.cache) delete require.cache[entry]
  } catch {
    // 忽略
  }
}

export interface VerifyOptions {
  /** 跳过构建，直接验收现有产物（默认重新构建：验收的永远是当前源码） */
  skipBuild?: boolean
  /** 是否跑渲染层实时探针（默认跑；宿主没接线/没窗口时自动 skip） */
  probeRenderer?: boolean
  /** 构建期 dev 模式（不压缩 + inline sourcemap） */
  dev?: boolean
}

/** 跑一遍完整验收，写 reports/<id>.json 并返回结构化报告 */
export async function verifyDraft(id: string, opts: VerifyOptions = {}): Promise<WorkshopReport> {
  const startedAt = Date.now()
  const checks: WorkshopCheck[] = []
  const host = workshopHostOrNull()
  const push = (check: WorkshopCheck): void => {
    checks.push(check)
  }

  const bail = (title: string, detail: string, build: WorkshopReport['build']): WorkshopReport => {
    push({ id: 'env.host', title, status: 'fail', fatal: true, detail })
    const report: WorkshopReport = {
      id,
      at: Date.now(),
      durationMs: Date.now() - startedAt,
      ok: false,
      checks,
      build
    }
    return report
  }

  if (!isWorkshopConfigured() || !host) {
    return bail('工坊接线', '插件工坊尚未接线（宿主未注入工坊能力）', {
      ok: false,
      durationMs: 0,
      files: [],
      errors: ['插件工坊尚未接线'],
      warnings: []
    })
  }

  const draftRoot = draftDir(id)
  if (!fs.existsSync(draftRoot)) {
    const report = bail('草稿存在', `草稿 '${id}' 不存在`, {
      ok: false,
      durationMs: 0,
      files: [],
      errors: [`草稿 '${id}' 不存在`],
      warnings: []
    })
    writeJson(reportPath(id), report)
    return report
  }

  // ── 构建（默认每次重建：验收的对象永远是当前源码）─────────────────────
  const buildResult = opts.skipBuild ? null : await buildDraft(id, { dev: opts.dev })
  const build: WorkshopReport['build'] = buildResult
    ? buildResult.info
    : { ok: true, durationMs: 0, files: [], errors: [], warnings: [] }
  const manifest = readDraftManifest(id)
  const meta = readDraftMeta(id)
  const outDir = distDir(id)

  push(checkManifest(manifest, id))

  if (!build.ok) {
    push({
      id: 'pkg.build',
      title: '构建产物',
      status: 'fail',
      fatal: true,
      detail: build.errors.join(' / ') || '构建失败',
      hint: '先修构建错误（宿主说明符 / 第三方依赖 / 语法），再跑验收',
      durationMs: build.durationMs
    })
    const report: WorkshopReport = {
      id,
      at: Date.now(),
      durationMs: Date.now() - startedAt,
      ok: false,
      checks,
      build
    }
    writeJson(reportPath(id), report)
    return report
  }

  push({
    id: 'pkg.build',
    title: '构建产物',
    status: 'pass',
    detail: `${build.files.length} 个文件，共 ${Math.round(
      build.files.reduce((sum, f) => sum + f.size, 0) / 1024
    )}KB，${build.durationMs}ms`,
    durationMs: build.durationMs
  })

  // ── 入口 ────────────────────────────────────────────────────────────────
  const entryFiles = ['plugin.json', 'main.cjs', 'renderer.mjs']
  const missingEntries = entryFiles.filter(
    (file) =>
      !fs.existsSync(path.join(outDir, file)) || fs.statSync(path.join(outDir, file)).size === 0
  )
  push({
    id: 'pkg.entries',
    title: '入口文件',
    status: missingEntries.length === 0 ? 'pass' : 'fail',
    fatal: true,
    detail:
      missingEntries.length === 0
        ? entryFiles
            .map((f) => `${f} ${Math.round(fs.statSync(path.join(outDir, f)).size / 1024)}KB`)
            .join('、')
        : `缺失/空文件：${missingEntries.join('、')}`,
    hint:
      missingEntries.length > 0
        ? '渲染层入口必须是 renderer/plugin.tsx（或 .ts/.jsx/.js）'
        : undefined
  })

  // ── 身份（保留 id / 内置 id / 命名空间占用）─────────────────────────────
  const identityProblems: string[] = []
  if (RESERVED_DRAFT_IDS.has(id)) identityProblems.push(`'${id}' 是宿主保留 id`)
  if (host.isBundledPlugin(id))
    identityProblems.push(`'${id}' 是随应用分发的内置插件 id，不能被覆盖`)
  if (host.usedNamespaces(id).includes(id)) {
    identityProblems.push(`通道命名空间 plugin:${id}: 已被别的插件占用`)
  }
  push({
    id: 'pkg.identity',
    title: '插件身份',
    status: identityProblems.length === 0 ? 'pass' : 'fail',
    fatal: true,
    detail:
      identityProblems.length === 0
        ? `id=${id}，命名空间 plugin:${id}: 可用`
        : identityProblems.join('；'),
    hint: identityProblems.length > 0 ? '换一个草稿 id（保留 id 与内置插件 id 不能用）' : undefined
  })

  // ── 主进程宿主说明符 ────────────────────────────────────────────────────
  const mainSpecs = bundleMainSpecs(outDir)
  const hostMainKeys = new Set(host.hostMainKeys())
  const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])
  const missingMainHost = mainSpecs.filter(
    (spec) => spec.startsWith('@host/') && !hostMainKeys.has(spec)
  )
  const unresolvable = mainSpecs.filter((spec) => {
    if (spec.startsWith('@host/') || builtins.has(spec)) return false
    try {
      host.loader.resolve(spec)
      return false
    } catch {
      return true
    }
  })
  push({
    id: 'pkg.host-main',
    title: '主进程宿主依赖',
    status: missingMainHost.length === 0 && unresolvable.length === 0 ? 'pass' : 'fail',
    fatal: missingMainHost.length > 0,
    detail:
      missingMainHost.length > 0
        ? `不在宿主运行时表里：${missingMainHost.join('、')}`
        : unresolvable.length > 0
          ? `宿主应用根解析不到：${unresolvable.join('、')}`
          : mainSpecs.length === 0
            ? '没有引用宿主模块'
            : `${mainSpecs.length} 个：${mainSpecs.join('、')}`,
    hint:
      missingMainHost.length > 0
        ? '把模块加进 src/main/plugins/runtime.ts 的宿主运行时表，或改用表里已有的键（见 WORKSHOP.md 第 5 节）'
        : unresolvable.length > 0
          ? '宿主没装这个依赖：改用宿主已有的模块（electron / electron-log / zod/v4 / @langchain/core/tools 等）'
          : undefined
  })

  // ── 渲染层宿主说明符（宿主 UI 表）───────────────────────────────────────
  const rendererSpecs = bundleRendererSpecs(outDir)
  // `!` 前缀 = 产物里没改写干净的裸说明符（构建器漏改）：那是硬错误，不受「表里有没有」影响
  const leftover = rendererSpecs.filter((spec) => spec.startsWith('!'))
  const uiKeys = host.hostUiKeys()
  const bridgeKey = (spec: string): string => spec
  if (uiKeys === null) {
    push({
      id: 'pkg.host-ui',
      title: '渲染层宿主依赖',
      status: 'skip',
      detail: '宿主 UI 表尚未上报（渲染层还没起来）：打开一次应用界面后重跑验收即可覆盖这一项',
      hint: `产物里引用了 ${rendererSpecs.length} 个宿主键：${rendererSpecs.join('、') || '（无）'}`
    })
  } else {
    const known = new Set(uiKeys)
    const missingUi = rendererSpecs.filter(
      (spec) => !spec.startsWith('!') && !known.has(bridgeKey(spec))
    )
    const problems = [
      ...(leftover.length > 0 ? [`产物里还有未改写的宿主说明符：${leftover.join('、')}`] : []),
      ...(missingUi.length > 0 ? [`宿主 UI 表里没有：${missingUi.map(bridgeKey).join('、')}`] : [])
    ]
    push({
      id: 'pkg.host-ui',
      title: '渲染层宿主依赖',
      status: problems.length === 0 ? 'pass' : 'fail',
      fatal: true,
      detail:
        problems.length > 0
          ? problems.join('；')
          : rendererSpecs.length === 0
            ? '没有引用宿主模块'
            : `${rendererSpecs.length} 个键：${rendererSpecs.join('、')}`,
      hint:
        missingUi.length > 0
          ? '宿主 UI 表（src/renderer/src/plugin-host/host-ui.ts）没有这些模块：改用表里已有的键'
          : leftover.length > 0
            ? '构建器的说明符改写漏了（rewriteHostSpecifiersInBundle）：请反馈给宿主维护者'
            : undefined
    })
  }

  // ── 产物内的相对说明符（blob import 前提）───────────────────────────────
  const relativeSpecs = relativeSpecifiersInBundle(outDir)
  push({
    id: 'pkg.chunks',
    title: 'chunk 说明符绝对化',
    status: relativeSpecs.length === 0 ? 'pass' : 'fail',
    fatal: true,
    detail:
      relativeSpecs.length === 0
        ? '产物内没有相对说明符'
        : `仍有相对说明符：${relativeSpecs.join('、')}`,
    hint: relativeSpecs.length > 0 ? '这是构建器的问题（absolutizeChunkSpecifiers）' : undefined
  })

  // ── 主进程冒烟 ──────────────────────────────────────────────────────────
  const smokeResult = await runMainSmoke(id, outDir, draftRoot, host)
  push(smokeResult.check)

  // ── 渲染层实时探针 ──────────────────────────────────────────────────────
  let rendererProbe: WorkshopRendererProbe
  if (opts.probeRenderer === false || !host.probeRenderer) {
    rendererProbe = { status: 'skip', detail: '本次未启用渲染层探针' }
  } else {
    try {
      rendererProbe = await host.probeRenderer(id)
    } catch (err) {
      rendererProbe = { status: 'fail', detail: `探针异常：${(err as Error).message}` }
    }
  }
  push({
    id: 'renderer.probe',
    title: '渲染层装载探针',
    status:
      rendererProbe.status === 'pass' ? 'pass' : rendererProbe.status === 'skip' ? 'skip' : 'fail',
    detail: rendererProbe.detail,
    hint:
      rendererProbe.status === 'fail'
        ? '渲染模块能在宿主环境里 import + install 才会真的出界面：检查 @host/** 引用与顶层代码'
        : undefined,
    durationMs: rendererProbe.durationMs
  })

  // ── 样式覆盖 ────────────────────────────────────────────────────────────
  const cssFile = path.join(outDir, 'plugin.css')
  const css = fs.existsSync(cssFile) ? fs.readFileSync(cssFile, 'utf-8') : ''
  const scanned = scanDraftCandidates(draftRoot)
  const missing = missingClasses(css, scanned.strict)
  push({
    id: 'style.coverage',
    title: '样式覆盖',
    status: missing.length === 0 ? 'pass' : 'fail',
    fatal: false,
    detail:
      scanned.strict.length === 0
        ? '没有用到 class 名（全内联样式）'
        : missing.length === 0
          ? `${scanned.strict.length} 个类名全部有规则（plugin.css ${Math.round(Buffer.byteLength(css) / 1024)}KB）`
          : `plugin.css 里缺 ${missing.length} 个类名的规则：${missing.join('、')}`,
    hint:
      missing.length > 0
        ? "类名必须是字面量才能被 Tailwind 扫到（'p-' + n 扫不到）；也可以把 workshop.json 的 css 改成 'file' 手写 plugin.css"
        : undefined
  })

  // ── 风险扫描 ────────────────────────────────────────────────────────────
  const findings = riskScan(outDir)
  push({
    id: 'risk.scan',
    title: '危险 API 扫描',
    status: findings.length === 0 ? 'pass' : 'warn',
    fatal: false,
    detail: findings.length === 0 ? '没有命中危险 API 清单' : findings.join('、'),
    hint: findings.length > 0 ? '插件在主进程拥有完整权限：发布前确认这些调用是必要的' : undefined
  })

  const ok = checks.every((c) => !(c.fatal && c.status === 'fail'))
  const report: WorkshopReport = {
    id,
    version: typeof manifest?.version === 'string' ? manifest.version : undefined,
    at: Date.now(),
    durationMs: Date.now() - startedAt,
    ok,
    checks,
    build,
    main: smokeResult.smoke,
    renderer: rendererProbe
  }
  if (meta) report.version = report.version ?? ''
  writeJson(reportPath(id), report)
  return report
}

/** 读一份已保存的验收报告（面板用） */
export function readReport(id: string): WorkshopReport | null {
  try {
    return JSON.parse(fs.readFileSync(reportPath(id), 'utf-8')) as WorkshopReport
  } catch {
    return null
  }
}

/** 报告 → 给模型看的紧凑文本（工具返回值；面板走结构化数据） */
export function formatReport(report: WorkshopReport): string {
  const tag: Record<WorkshopCheck['status'], string> = {
    pass: 'PASS',
    fail: 'FAIL',
    warn: 'WARN',
    skip: 'SKIP'
  }
  const failed = report.checks.filter((c) => c.status === 'fail')
  const lines: string[] = [
    `插件 '${report.id}' 验收${report.ok ? '通过' : '未通过'}：` +
      `${report.checks.filter((c) => c.status === 'pass').length}/${report.checks.length} 项通过` +
      `${failed.length > 0 ? `，${failed.length} 项失败` : ''}（${report.durationMs}ms）`
  ]
  for (const check of report.checks) {
    lines.push(
      `- [${tag[check.status]}] ${check.id} ${check.title}${check.detail ? `：${check.detail}` : ''}`
    )
    if (check.hint && check.status !== 'pass') lines.push(`  建议：${check.hint}`)
  }
  if (report.main && report.main.channels.length > 0) {
    lines.push(`主进程通道：${report.main.channels.join('、')}`)
  }
  if (report.renderer?.registrations?.length) {
    lines.push(`渲染层注册：${report.renderer.registrations.join('、')}`)
  }
  return lines.join('\n')
}

/** 草稿文件数（工具摘要里显示体量） */
export function draftFileCount(id: string): number {
  return listDraftFiles(id).length
}
