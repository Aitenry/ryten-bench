import * as fs from 'fs'
import * as path from 'path'
import { builtinModules } from 'node:module'
import type {
  WorkshopCheck,
  WorkshopMainSmoke,
  WorkshopReport,
  WorkshopRendererProbe
} from '../../shared/harness/workshop'
import { distDir, draftDir, reportPath, writeJson, RESERVED_DRAFT_IDS } from './paths'
import { listDraftFiles, readDraftManifest, readDraftMeta } from './store'
import {
  buildDraft,
  bundleMainSpecs,
  bundleRendererSpecs,
  relativeSpecifiersInBundle
} from './build'
import { missingClasses, scanDraftCandidates } from './css'
import { scanWorkshopLayouts } from './layout'
import { isWorkshopConfigured, workshopHostOrNull, type WorkshopHost } from './host'
import { sanitizePluginCss } from '../../shared/plugin/css-safety'

/**
 * Acceptance battery: turns "does this plugin work once installed" into a set of
 * reproducible checks.
 *
 * Checks are ordered most-fatal-first (failures with `fatal: true` are counted into
 * `report.ok`):
 *
 * | id | Check | Notes |
 * |----|-------|-------|
 * | `pkg.manifest` | Manifest fields complete (id/name/version match the directory) | Fatal |
 * | `pkg.build` | Build output (esbuild diagnostics) | Fatal |
 * | `pkg.entries` | plugin.json / main.cjs / renderer.mjs exist and are non-empty | Fatal |
 * | `pkg.identity` | id is not reserved / not another plugin's namespace | Fatal |
 * | `pkg.host-main` | `@host/**` imported by the main process are in the host runtime table; bare deps resolve | Fatal |
 * | `pkg.host-ui` | Host modules imported by the renderer are in the host UI table | Fatal |
 * | `pkg.chunks` | Output has no relative specifiers (blob import would fail to fetch them) | Fatal |
 * | `main.smoke` | **Really require the output + real install(ctx) contract**, including the draft's smoke cases | Fatal |
 * | `renderer.probe` | import + install in the real renderer process (skipped when there is no window) | Non-fatal |
 * | `style.coverage` | Every className used has a rule in plugin.css | Non-fatal |
 * | `layout.scan` | Layout and theme anti-patterns (full-page scrollbar / stacked tabs / `dark:` variant / modal without max height) | Non-fatal |
 * | `risk.scan` | Dangerous-API list (shown to the user/model before publishing) | Non-fatal |
 *
 * All fatal checks passing = usable once installed; a non-fatal failure = runs but is wrong
 * (broken styling / risky calls).
 */

/**
 * **Recording version** of the host main-process context: same shape as
 * `src/main/plugins/context.ts` but does not touch ipcMain.
 */
interface RecordingContext {
  id: string
  namespace: string
  channels: Record<string, (...args: never[]) => unknown>
  events: string[]
  contributions: { key: string; value: unknown }[]
  effects: number
  rolledBack: number
  disposed: boolean
  /** effect undo stack (LIFO rollback) */
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
          // A failed undo does not block the rest (same semantics as the host's dispose)
        }
      }
    }
  }
  return record
}

/** Context object handed to the output's `install(ctx)` (recording version) */
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
    },
    requestSync() {
      /* Smoke cases do not connect the plugin center: sync requests are silently ignored,
         as if signed out */
    }
  }
}

/** Shape of the smoke cases (`workshop.smoke.mjs`) */
interface SmokeCase {
  args?: unknown[]
  expect?: unknown
}
interface SmokeCases {
  channels: Record<string, SmokeCase>
  /**
   * Cleanup calls: **run whether or not the earlier cases passed**, restoring whatever the
   * acceptance run wrote into the user's database/settings (acceptance must not change the
   * user's real data).
   *
   * Arguments may use `$result:<channel>#<field path>` to reference an earlier case's return
   * value, e.g. `$result:plugin:demo:items-create#id` or
   * `$result:plugin:demo:settings-get` (the whole object as the argument).
   */
  cleanup?: Array<SmokeCase & { channel?: string }>
}

/**
 * Load the smoke cases from the draft.
 *
 * Only supports the **expression** form `export default { … }` (which is what templates
 * generate), evaluated with `new Function`. Draft code already runs in the main process at
 * the same trust level (install is written by it too); this additionally requires "the whole
 * file is one default-export expression" so nothing else gets executed by accident.
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
    if (value.cleanup !== undefined && !Array.isArray(value.cleanup)) {
      return { cases: null, error: 'workshop.smoke.mjs 的 cleanup 需要是数组' }
    }
    return { cases: value }
  } catch (err) {
    return { cases: null, error: `workshop.smoke.mjs 求值失败：${(err as Error).message}` }
  }
}

/** Assertion: a function (returns true/a string) or a deep JSON comparison */
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

/**
 * Resolve result references in cleanup arguments: `$result:<channel>#<a.b.c>` (the part
 * after `#` may be omitted = the whole return value).
 *
 * Channel names themselves contain colons (`plugin:<id>:items-create`), so split on the
 * **last `#`**; do not split on `:`.
 */
function resolveSmokeArgs(
  args: unknown[] | undefined,
  results: Map<string, unknown>
): { args: unknown[]; missing: string[] } {
  const missing: string[] = []
  const resolved = (Array.isArray(args) ? args : []).map((arg) => {
    if (typeof arg !== 'string' || !arg.startsWith('$result:')) return arg
    const body = arg.slice('$result:'.length)
    const hash = body.lastIndexOf('#')
    const channel = hash === -1 ? body : body.slice(0, hash)
    const path = hash === -1 ? '' : body.slice(hash + 1)
    if (!results.has(channel)) {
      missing.push(arg)
      return undefined
    }
    let value = results.get(channel)
    if (path !== '') {
      for (const segment of path.split('.')) {
        if (value === null || typeof value !== 'object') return undefined
        value = (value as Record<string, unknown>)[segment]
      }
    }
    return value
  })
  return { args: resolved, missing }
}

/**
 * Manifest check (the workshop's own: the hint must point straight at "which field to fix").
 */
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

/**
 * Dangerous-API list: hits are warnings only, never blocking (plugins already have full
 * main-process privileges).
 */
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

/**
 * Calls that **break the host's operation** (unlike `risk.scan`, these are FATAL: do not
 * publish until fixed).
 *
 * The list is deliberately short: only definite problems where a single plugin can make the
 * whole app disappear or leave channels that cannot be removed. `child_process` and `eval`
 * are merely risky and often legitimate, so they stay as warnings in `risk.scan`.
 * At runtime `main/plugins/plugin-guard.ts` also intercepts exit/abort/kill-self.
 */
const HOST_SAFETY_RULES: Array<{ re: RegExp; label: string; hint: string }> = [
  {
    re: /\bprocess\.exit\s*\(/,
    label: 'process.exit()',
    hint: '删掉退出调用：插件是宿主的一部分，应用何时退出由宿主决定（运行期也会被拦截）'
  },
  {
    re: /\bprocess\.abort\s*\(/,
    label: 'process.abort()',
    hint: '删掉 abort：它会让整个应用无清理地死掉（运行期也会被拦截）'
  },
  {
    re: /\bprocess\.kill\s*\(\s*process\.pid/,
    label: 'process.kill(自己)',
    hint: '删掉自杀调用：应用何时退出由宿主决定（运行期也会被拦截）'
  },
  {
    re: /\bipcMain\s*\.\s*(?:handle|handleOnce|on)\s*\(/,
    label: '直接注册 ipcMain 通道',
    hint: '通道一律经 ctx.registerIpc 注册，否则停用/卸载时摘不掉（宿主会留下永远应答的通道）'
  }
]

/**
 * Scan the main-process output for host-breaking calls (the output is minified; the regex
 * only looks at call shapes).
 */
function safetyScan(outDir: string): Array<{ label: string; hint: string; file: string }> {
  const file = path.join(outDir, 'main.cjs')
  if (!fs.existsSync(file)) return []
  let code = ''
  try {
    code = fs.readFileSync(file, 'utf-8')
  } catch {
    return []
  }
  const findings: Array<{ label: string; hint: string; file: string }> = []
  for (const rule of HOST_SAFETY_RULES) {
    if (rule.re.test(code)) findings.push({ label: rule.label, hint: rule.hint, file: 'main.cjs' })
  }
  return findings
}

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

/**
 * Human-readable label for a contribution (tool contributions show the tool name, purge ones
 * the label).
 */
function contributionLabels(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const item = value as { name?: unknown; label?: unknown }
  if (typeof item.name === 'string') return [item.name]
  if (typeof item.label === 'string') return [item.label]
  return []
}

/**
 * Main-process smoke: really require the output's `main.cjs` and run `install` once with the
 * recording context.
 *
 * Why it must actually run (instead of only inspecting the static output): the three most
 * common load failures — ① importing `@host/**` keys that are not in the host runtime table;
 * ② channel names outside the plugin's own namespace; ③ install throwing on its first line
 * (reading files/settings, wrong API) — **only surface when it is really required once**, and
 * all of them look like "the plugin installed but nothing works".
 *
 * Safety: dispose immediately after the run (LIFO rollback of effects) and clear the require
 * cache; the context is a recording one, so it touches neither ipcMain nor the real
 * contribution registry and cannot change the app's real state.
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

  // Smoke cases: called through the real handlers, with arguments and assertions from the draft
  const loadedCases = loadSmokeCases(draftRoot)
  if (loadedCases.error) {
    smoke.cases.push({ name: 'workshop.smoke.mjs', ok: false, detail: loadedCases.error })
    problems.push(loadedCases.error)
  } else if (loadedCases.cases) {
    /** Case channel name → return value (used to resolve cleanup's `$result:` references) */
    const results = new Map<string, unknown>()
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
        results.set(channel, value)
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

    /**
     * Cleanup: acceptance **must not change the user's real data**.
     *
     * Template smoke cases really create records and change settings (the only way to prove
     * the channels are complete), so `cleanup` must restore them. A failed cleanup also
     * counts as an acceptance failure — otherwise the next time the user opens the plugin
     * they see dirty rows named `smoke-item`, or settings silently flipped to false.
     */
    for (const step of loadedCases.cases.cleanup ?? []) {
      const channel = typeof step.channel === 'string' ? step.channel : ''
      const caseStarted = Date.now()
      if (channel === '') {
        smoke.cases.push({ name: 'cleanup', ok: false, detail: 'cleanup 缺少 channel' })
        continue
      }
      const handler = record.channels[channel] as ((...args: unknown[]) => unknown) | undefined
      if (typeof handler !== 'function') {
        smoke.cases.push({
          name: `cleanup ${channel}`,
          ok: false,
          detail: '收尾通道不存在',
          durationMs: Date.now() - caseStarted
        })
        continue
      }
      const resolved = resolveSmokeArgs(step.args, results)
      if (resolved.missing.length > 0) {
        // Prerequisite case failed → nothing to restore; not a cleanup failure (avoids cascades)
        smoke.cases.push({
          name: `cleanup ${channel}`,
          ok: true,
          detail: `跳过（前置结果不可用：${resolved.missing.join('、')}）`,
          durationMs: Date.now() - caseStarted
        })
        continue
      }
      try {
        const value = await Promise.resolve(handler(...resolved.args))
        const verdict = await runExpect(step.expect, value)
        smoke.cases.push({
          name: `cleanup ${channel}`,
          ok: verdict.ok,
          detail: verdict.ok ? undefined : verdict.detail,
          durationMs: Date.now() - caseStarted
        })
      } catch (err) {
        smoke.cases.push({
          name: `cleanup ${channel}`,
          ok: false,
          detail: `收尾抛出：${(err as Error).message}`,
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

  // Teardown: LIFO rollback + idempotent dispose
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

/**
 * Clear the require cache of the output module (so this temporary module does not linger and
 * disturb real loads).
 */
function clearRequireCache(entry: string): void {
  try {
    // CJS output has require; offline ESM tooling does not (the ReferenceError is swallowed here)
    if (typeof require === 'function' && require.cache) delete require.cache[entry]
  } catch {
    // Ignore
  }
}

export interface VerifyOptions {
  /**
   * Skip the build and verify the existing output (default is to rebuild: acceptance always
   * covers the current source).
   */
  skipBuild?: boolean
  /**
   * Whether to run the live renderer probe (default yes; auto-skips when the host is not
   * wired up or has no window).
   */
  probeRenderer?: boolean
  /** Build-time dev mode (no minification + inline sourcemap) */
  dev?: boolean
}

/** Run a full acceptance pass, write reports/<id>.json and return the structured report */
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

  // ── Build (rebuild every time by default: acceptance always targets the current source) ──
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

  // ── Entries ───────────────────────────────────────────────────────────────
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

  // ── Identity (reserved ids / namespace occupancy) ─────────────────────────
  const identityProblems: string[] = []
  if (RESERVED_DRAFT_IDS.has(id)) identityProblems.push(`'${id}' 是宿主保留 id`)
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
    hint: identityProblems.length > 0 ? '换一个草稿 id（保留 id 不能用）' : undefined
  })

  // ── Main-process host specifiers ──────────────────────────────────────────
  const mainSpecs = bundleMainSpecs(outDir)
  const hostMainKeys = new Set(host.hostMainKeys())
  const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])
  const missingMainHost = mainSpecs.filter(
    (spec) => spec.startsWith('@host/') && !hostMainKeys.has(spec)
  )
  const unresolvable = mainSpecs.filter((spec) => {
    if (spec.startsWith('@host/') || builtins.has(spec)) return false
    // Specifiers provided directly by the host runtime table (including legacy compatibility
    // aliases) need no npm resolution
    if (hostMainKeys.has(spec)) return false
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
          ? '宿主没装这个依赖：改用宿主已有的模块（electron / electron-log / zod/v4 / @host/main/ai/tools 等）'
          : undefined
  })

  // ── Renderer host specifiers (host UI table) ──────────────────────────────
  const rendererSpecs = bundleRendererSpecs(outDir)
  // The `!` prefix marks bare specifiers the build left unrewritten (a builder bug): that is a
  // hard error, independent of whether the table knows them
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

  // ── Relative specifiers in the output (a prerequisite for blob import) ─────
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

  // ── Main-process smoke ────────────────────────────────────────────────────
  const smokeResult = await runMainSmoke(id, outDir, draftRoot, host)
  push(smokeResult.check)

  // ── Live renderer probe ───────────────────────────────────────────────────
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

  // ── Style coverage ────────────────────────────────────────────────────────
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

  // ── Whether styles only apply to the plugin (global rules are dropped at runtime) ─────────
  const cssAudit = sanitizePluginCss(css)
  push({
    id: 'style.safety',
    title: '样式作用域',
    status: cssAudit.dropped.length === 0 && cssAudit.imports.length === 0 ? 'pass' : 'warn',
    fatal: false,
    detail:
      cssAudit.dropped.length === 0 && cssAudit.imports.length === 0
        ? 'plugin.css 没有会波及宿主的全局规则'
        : `以下规则会作用于宿主，运行期会被丢弃：${cssAudit.dropped.join('、') || '（无）'}` +
          (cssAudit.imports.length > 0
            ? `；另有 ${cssAudit.imports.length} 条 @import 被移除`
            : ''),
    hint:
      cssAudit.dropped.length > 0 || cssAudit.imports.length > 0
        ? '改成自己的类名（Tailwind 工具类或带前缀的类）作用在插件 DOM 上：html/body/#root/*/宿主外壳类名与 :root 里的真声明都会被丢'
        : undefined
  })

  // ── Host-breaking calls (exit / abort / direct ipcMain) — fatal, fix before publishing ──
  const safetyFindings = safetyScan(outDir)
  push({
    id: 'safety.scan',
    title: '宿主安全',
    status: safetyFindings.length === 0 ? 'pass' : 'fail',
    fatal: true,
    detail:
      safetyFindings.length === 0
        ? '没有会破坏宿主运转的调用（process.exit / abort / 直接 ipcMain）'
        : safetyFindings.map((finding) => `${finding.label}（${finding.file}）`).join('、'),
    hint: safetyFindings[0]?.hint
  })

  // ── Layout and theme inspection (source level: these compile but break the UI) ──────────
  const layoutFindings = scanWorkshopLayouts(id)
  push({
    id: 'layout.scan',
    title: '布局与主题',
    // warn, not fail: these are "works but looks wrong / is wrong" issues; publishing is not
    // blocked, but the report must name them
    status: layoutFindings.length === 0 ? 'pass' : 'warn',
    fatal: false,
    detail:
      layoutFindings.length === 0
        ? '没有命中布局与主题的反模式（整页滚动条 / 页签叠在一起 / dark: 变体 / 弹窗无高度上限）'
        : layoutFindings
            .map((finding) => `${finding.file}:${finding.line} ${finding.message}`)
            .join('；'),
    hint:
      layoutFindings.length > 0
        ? '按每条的文件:行号改；模板 full 的 renderer/components/ui.tsx 里有现成的正确写法（PageShell / pageTabsProps / formModalProps / usePluginPalette）'
        : undefined
  })

  // ── Risk scan ─────────────────────────────────────────────────────────────
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
    // With skipBuild, use the fingerprint recorded in the output: the report can only speak for
    // this output, not for source changed afterwards
    sourceHash: build.sourceHash ?? meta?.sourceHash,
    checks,
    build,
    main: smokeResult.smoke,
    renderer: rendererProbe
  }
  if (meta) report.version = report.version ?? ''
  writeJson(reportPath(id), report)
  return report
}

/** Read a saved acceptance report (used by the panel) */
export function readReport(id: string): WorkshopReport | null {
  try {
    return JSON.parse(fs.readFileSync(reportPath(id), 'utf-8')) as WorkshopReport
  } catch {
    return null
  }
}

/** Probe status → check status (same mapping as in the acceptance battery) */
function probeCheckStatus(probe: WorkshopRendererProbe): WorkshopCheck['status'] {
  if (probe.status === 'pass') return 'pass'
  if (probe.status === 'skip') return 'skip'
  return 'fail'
}

/**
 * Write the **post-publish** renderer re-check result back into the latest acceptance report.
 *
 * Why it is worth writing back: before installation the probe can only SKIP because the
 * plugin is not installed/enabled yet, so the report always misses this item; the publish
 * flow verifies once in the real UI right after installing, and that conclusion is what the
 * user actually cares about. After writing back, the panel and later readers see "installed
 * and verified" instead of a stale SKIP.
 *
 * Returns null when no report exists (the user installed straight from the panel without
 * running acceptance); it never fabricates one.
 */
export function updateReportRenderer(
  id: string,
  probe: WorkshopRendererProbe
): WorkshopReport | null {
  const report = readReport(id)
  if (!report) return null
  report.renderer = probe
  const check = report.checks.find((item) => item.id === 'renderer.probe')
  if (check) {
    check.status = probeCheckStatus(probe)
    check.detail = probe.detail
    check.durationMs = probe.durationMs
    if (check.status === 'pass') check.hint = undefined
  }
  writeJson(reportPath(id), report)
  return report
}

/** Report → compact text for the model (tool return value; the panel uses structured data) */
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

/** Number of draft files (shows the size in the tool summary) */
export function draftFileCount(id: string): number {
  return listDraftFiles(id).length
}
