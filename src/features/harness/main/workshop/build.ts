import * as fs from 'fs'
import * as path from 'path'
import { builtinModules } from 'node:module'
import type { Plugin } from 'esbuild'
import type { WorkshopBuildInfo, WorkshopCssMode } from '../../shared/workshop'
import { distDir, draftDir, readJson, writeJson } from './paths'
import { listDraftFiles, readDraftMeta, patchDraftMeta } from './store'
import { compilePluginCss, missingClasses, scanDraftCandidates } from './css'
import { isWorkshopConfigured, workshopHostOrNull } from './host'

/**
 * 草稿 → 可安装插件包。
 *
 * 产物与插件仓库里的 `dist/<id>` **逐字节同构**（这才让「工坊装出来的插件」和
 * 「用户从仓库装的插件」走完全相同的装载/卸载/升级链路）：
 *
 * ```
 * dist/<id>/plugin.json     清单（entry 由这里写入，builtin 强制 false）
 *           main.cjs        CJS：宿主能力经 globalThis.__RB_HOST_RESOLVE__ 取
 *           renderer.mjs    ESM：宿主能力保留裸说明符/`@host/**`，由宿主 loader 改成桥 URL
 *           chunk-*.mjs     渲染层的懒加载 chunk（说明符已绝对化成 plugin://<id>/…）
 *           plugin.css      自带样式表（auto：Tailwind 扫源码生成；file：草稿里那份）
 * ```
 *
 * 两条容易踩的坑（都在这里处理掉）：
 * 1. **主进程侧必须真改写**：`main.cjs` 在 `userData/plugins/<id>/` 下没有任何 node_modules，
 *    裸 require 一定失败 → 打包时统一改写成 `__RB_HOST_RESOLVE__("<spec>")`；
 * 2. **渲染层的相对说明符必须绝对化**：入口是 fetch + blob import，blob 模块没有相对基准
 *    （`./chunk-x.mjs` 会解析成 `blob:…/chunk-x.mjs`）。
 */

/** 渲染层交给宿主 vendor 桥的第三方包（宿主里已有唯一实例，插件包不得自带第二份） */
export const RENDERER_VENDOR = [
  'react',
  'react-dom',
  'antd',
  '@remixicon/react',
  '@ant-design/icons',
  'dayjs'
]

/** Node 内置模块（含 `node:` 前缀）：保持 external，运行期由 Node 自己解析 */
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

/** 虚拟模块命名空间：主进程侧落到这里，onLoad 生成「去向宿主运行时取」的源码 */
const HOST_MODULE_NS = 'workshop-host'

/** 主进程入口的候选文件名（按序取第一个存在的） */
const MAIN_ENTRIES = ['main/index.ts', 'main/index.tsx', 'main/index.js', 'main/index.mjs']
/** 渲染层入口的候选文件名 */
const RENDERER_ENTRIES = [
  'renderer/plugin.tsx',
  'renderer/plugin.ts',
  'renderer/plugin.jsx',
  'renderer/plugin.js'
]

/** 主进程：`module.exports = globalThis.__RB_HOST_RESOLVE__("<spec>")`（CJS 产物，require 即可） */
const cjsHostModule = (spec: string): string =>
  `module.exports = globalThis.__RB_HOST_RESOLVE__(${JSON.stringify(spec)});\n`

/** 收集到的说明符（构建后拿去做「宿主到底认不认」的体检） */
interface SpecCollector {
  /** 主进程里真的会去 __RB_HOST_RESOLVE__ 的 spec */
  mainSpecs: Set<string>
  /** 渲染层里保留为 external 的宿主 spec（`@host/**` 与 vendor 裸模块） */
  rendererSpecs: Set<string>
}

const isAbsoluteSpec = (spec: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith('/')
const isBare = (spec: string): boolean =>
  !spec.startsWith('.') && !isAbsoluteSpec(spec) && !spec.startsWith('@host/')

/**
 * 打包解析插件里的导入。
 *
 * - `@host/**` → 主进程：虚拟模块（去宿主运行时取）；渲染层：**保持 external**（宿主 loader 改写）；
 * - 别名 `@shared/**` / `@renderer/**`（仓库源码里的写法）→ 映射成 `@host/shared/**` / `@host/renderer/**`，
 *   让助手按熟悉的写法引用宿主能力；
 * - 渲染层裸模块：命中 vendor 名单 → external；其它 → **报错并给出可用名单**
 *   （草稿目录没有 node_modules，放它过去只会在运行期变成一句没有上下文的解析失败）；
 * - 主进程裸模块：虚拟模块（运行期由宿主按应用根解析，拿同一实例）+ 构建后体检；
 * - 相对/绝对路径：草稿内的打进包，草稿外的**拒绝**（看不到别的目录，也就不会误引用仓库源码）。
 */
function hostPlugin(side: 'main' | 'renderer', draftRoot: string, specs: SpecCollector): Plugin {
  return {
    name: 'workshop-host-runtime',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path

        if (NODE_BUILTINS.has(spec)) return { path: spec, external: true }
        if (spec.startsWith('plugin://')) return { path: spec, external: true }

        // 别名：仓库风格 → 宿主键
        let mapped = spec
        if (spec.startsWith('@shared/')) mapped = `@host/shared/${spec.slice('@shared/'.length)}`
        else if (spec.startsWith('@renderer/'))
          mapped = `@host/renderer/${spec.slice('@renderer/'.length)}`

        if (mapped.startsWith('@host/')) {
          if (side === 'renderer') {
            specs.rendererSpecs.add(mapped)
            return { path: mapped, external: true }
          }
          specs.mainSpecs.add(mapped)
          return { path: mapped, namespace: HOST_MODULE_NS }
        }

        if (isBare(spec)) {
          if (side === 'renderer') {
            const vendor = RENDERER_VENDOR.find((v) => spec === v || spec.startsWith(v + '/'))
            if (!vendor) {
              return {
                errors: [
                  {
                    text:
                      `插件不能依赖第三方包 '${spec}'（草稿目录里没有 node_modules）。` +
                      `渲染层只能用宿主已提供的：${RENDERER_VENDOR.join(' / ')}，` +
                      `以及 @host/renderer/** 的宿主 UI 模块。`
                  }
                ]
              }
            }
            specs.rendererSpecs.add(spec)
            return { path: spec, external: true }
          }
          specs.mainSpecs.add(spec)
          return { path: spec, namespace: HOST_MODULE_NS }
        }

        const from = args.importer ? path.dirname(args.importer) : draftRoot
        const abs = path.resolve(from, spec)
        const inside = abs === draftRoot || abs.startsWith(draftRoot + path.sep)
        if (!inside) {
          return {
            errors: [
              {
                text:
                  `导入越出草稿目录：'${spec}'（解析为 ${abs}）。` +
                  `插件只能引用草稿内的文件与 '@host/**' 宿主模块。`
              }
            ]
          }
        }
        return null
      })

      build.onLoad({ filter: /.*/, namespace: HOST_MODULE_NS }, (args) => ({
        contents: cjsHostModule(args.path),
        loader: 'js'
      }))
    }
  }
}

/** 找入口文件（都不在返回 null） */
function findEntry(draftRoot: string, candidates: string[]): string | null {
  for (const rel of candidates) {
    const abs = path.join(draftRoot, rel)
    if (fs.existsSync(abs)) return abs
  }
  return null
}

/** esbuild 报错 → 人读得懂的多行文本（含文件:行:列） */
function formatEsbuildErrors(
  errors:
    | readonly { text: string; location?: { file?: string; line?: number; column?: number } }[]
    | undefined
): string[] {
  if (!errors || errors.length === 0) return []
  return errors.map((error) => {
    const loc = error.location
    const where = loc?.file
      ? `${path.basename(loc.file)}${loc.line ? `:${loc.line}${loc.column !== undefined ? `:${loc.column + 1}` : ''}` : ''}: `
      : ''
    return `${where}${error.text}`
  })
}

/**
 * 把多文件渲染产物里的**相对说明符**绝对化成 `plugin://<id>/<文件>`，返回改写处数。
 *
 * 与 `scripts/build-plugins.mjs` 的同名函数同源（P3 实测的坑）：blob 模块没有相对基准。
 * 只改写**确实指向本次产物文件**的相对说明符（按目标文件名比对），避免误伤字符串字面量。
 */
export function absolutizeChunkSpecifiers(id: string, outDir: string): number {
  const emitted = new Set(fs.readdirSync(outDir).filter((f) => f.endsWith('.mjs')))
  const REL_SPEC =
    /(\bfrom\s*|\bimport\s*\(\s*|(?:^|[;}\n])\s*import\s*)(['"])(\.{1,2}\/[^'"]+)\2/gm
  let count = 0
  for (const file of emitted) {
    const full = path.join(outDir, file)
    const source = fs.readFileSync(full, 'utf-8')
    const next = source.replace(REL_SPEC, (whole, prefix: string, quote: string, spec: string) => {
      const target = path
        .relative(outDir, path.resolve(path.dirname(full), spec))
        .replace(/\\/g, '/')
      if (!emitted.has(target)) return whole
      count += 1
      return `${prefix}${quote}plugin://${id}/${target}${quote}`
    })
    if (next !== source) fs.writeFileSync(full, next)
  }
  return count
}

/** 宿主说明符 → 宿主 UI 桥 URL（键的形态与 `external-loader.ts` / host-ui.ts 一致） */
function bridgeUrlFor(spec: string): string | null {
  if (spec.startsWith('@host/')) {
    return `plugin://host/ui.js?m=${encodeURIComponent(spec)}`
  }
  if (RENDERER_VENDOR.some((v) => spec === v || spec.startsWith(v + '/'))) {
    return `plugin://host/ui.js?m=${encodeURIComponent(`@host/vendor/${spec}`)}`
  }
  return null
}

/**
 * 把产物里**全部**宿主说明符改写成宿主 UI 桥 URL（入口 + 每个 chunk），返回改写处数。
 *
 * 为什么必须在**构建期**做（2026-09-27 真机实测）：
 * 宿主的 `external-loader.ts` 只在装载入口时改一次说明符，而懒加载 chunk 是浏览器按
 * `plugin://<id>/chunk-x.mjs` **自己取回来**的——那条路径没有任何改写机会，chunk 里残留的
 * `from "react"` 会直接报 `Failed to resolve module specifier "react"`。
 * 独立插件仓库（ryten-plugins）的构建也是这么做的：产物里只有 `plugin://host/ui.js?m=<键>`。
 */
export function rewriteHostSpecifiersInBundle(outDir: string): number {
  const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*|(?:^|[;}\n])\s*import\s*)(['"])([^'"]+)\2/gm
  let count = 0
  for (const file of fs.readdirSync(outDir)) {
    if (!file.endsWith('.mjs')) continue
    const full = path.join(outDir, file)
    const source = fs.readFileSync(full, 'utf-8')
    const next = source.replace(SPEC_RE, (whole, prefix: string, quote: string, spec: string) => {
      const url = bridgeUrlFor(spec)
      if (!url) return whole
      count += 1
      return `${prefix}${quote}${url}${quote}`
    })
    if (next !== source) fs.writeFileSync(full, next)
  }
  return count
}

export interface BuildDraftOptions {
  /** dev：不压缩 + inline sourcemap（体积大但能调试） */
  dev?: boolean
  /** 覆盖输出目录（离线工装用临时目录） */
  outDir?: string
}

export interface BuildDraftResult {
  info: WorkshopBuildInfo
  /** 归一化后的清单（构建失败且清单非法时为 null） */
  manifest: Record<string, unknown> | null
}

/** 追加一段 CSS（空段忽略） */
function appendCss(parts: string[], chunk: string): void {
  const text = chunk.trim()
  if (text) parts.push(text)
}

/**
 * 构建一个草稿。
 *
 * **不抛错**：任何失败都收敛成 `info.ok === false` + `info.errors`，
 * 让助手/面板拿到一份可读诊断（工具层再决定怎么说给模型听）。
 */
export async function buildDraft(
  id: string,
  opts: BuildDraftOptions = {}
): Promise<BuildDraftResult> {
  const startedAt = Date.now()
  const info: WorkshopBuildInfo = {
    ok: false,
    durationMs: 0,
    files: [],
    errors: [],
    warnings: []
  }
  /** 清单（构建前后都要能拿到，失败时返回给调用方做静态检查） */
  let manifest: Record<string, unknown> | null = null

  const finish = (): BuildDraftResult => {
    info.durationMs = Date.now() - startedAt
    return { info, manifest }
  }

  if (!isWorkshopConfigured()) {
    info.errors.push('插件工坊尚未接线，无法构建')
    return finish()
  }

  const draftRoot = draftDir(id)
  if (!fs.existsSync(draftRoot)) {
    info.errors.push(`草稿 '${id}' 不存在（先 plugin_draft create 生成骨架）`)
    return finish()
  }

  const raw = readJson<Record<string, unknown>>(path.join(draftRoot, 'plugin.json'))
  if (!raw || typeof raw !== 'object') {
    info.errors.push('plugin.json 缺失或不是合法 JSON')
    return finish()
  }
  manifest = raw
  if (raw.id !== id) {
    info.errors.push(`plugin.json 的 id (${String(raw.id)}) 与草稿目录名 (${id}) 不一致`)
    return finish()
  }

  const meta = readDraftMeta(id)
  const cssMode: WorkshopCssMode = meta?.css ?? 'auto'
  const outDir = opts.outDir ?? distDir(id)
  const host = workshopHostOrNull()
  const specs: SpecCollector = { mainSpecs: new Set(), rendererSpecs: new Set() }

  // 产物目录每次重建：残留的旧 chunk 会让「装上去的还是老界面」
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  const esbuild = host?.loader.require('esbuild') as typeof import('esbuild') | undefined
  if (!esbuild || typeof esbuild.build !== 'function') {
    info.errors.push(
      '构建器不可用：宿主里没有可用的 esbuild（打包后的应用需要把 esbuild 放进 dependencies 并 asarUnpack）'
    )
    return finish()
  }

  const rendererEntry = findEntry(draftRoot, RENDERER_ENTRIES)
  if (!rendererEntry) {
    info.errors.push(
      `缺少渲染层入口：需要 ${RENDERER_ENTRIES[0]}（导出 default { install(ctx) }）—— 插件包必须带渲染层入口`
    )
    return finish()
  }

  // ── ① 主进程（没写 main 入口时也产出空壳：插件包契约要求 main.cjs 存在）──────
  const mainEntry = findEntry(draftRoot, MAIN_ENTRIES)
  try {
    const shared = {
      bundle: true,
      platform: 'node' as const,
      format: 'cjs' as const,
      target: 'node20',
      plugins: [hostPlugin('main', draftRoot, specs)],
      minify: !opts.dev,
      sourcemap: opts.dev ? ('inline' as const) : false,
      logLevel: 'silent' as const,
      legalComments: 'none' as const
    }
    if (mainEntry) {
      await esbuild.build({
        ...shared,
        entryPoints: [mainEntry],
        outfile: path.join(outDir, 'main.cjs')
      })
    } else {
      await esbuild.build({
        ...shared,
        stdin: {
          contents:
            '/** 本插件没有主进程代码（草稿里没有 main/index.ts）：空 install 满足包契约。 */\n' +
            'exports.install = function install() {}\n',
          resolveDir: draftRoot,
          sourcefile: 'main-stub.cjs',
          loader: 'js'
        },
        outfile: path.join(outDir, 'main.cjs')
      })
    }
  } catch (err) {
    info.errors.push(...formatEsbuildErrors((err as { errors?: never[] }).errors))
    if (info.errors.length === 0) info.errors.push(`主进程构建失败：${(err as Error).message}`)
    return finish()
  }

  // ── ② 渲染层（多文件 ESM：入口 + chunk-<hash>.mjs）────────────────────────
  let chunkRewrites = 0
  let hostRewrites = 0
  try {
    await esbuild.build({
      entryPoints: { renderer: rendererEntry },
      outdir: outDir,
      entryNames: 'renderer',
      chunkNames: 'chunk-[hash]',
      outExtension: { '.js': '.mjs' },
      bundle: true,
      // 必须开 splitting：不开时插件自己的动态 import 会被内联进入口（首屏白背大依赖）
      splitting: true,
      platform: 'browser',
      format: 'esm',
      target: 'chrome120',
      jsx: 'automatic',
      plugins: [hostPlugin('renderer', draftRoot, specs)],
      loader: { '.css': 'css', '.svg': 'dataurl' },
      minify: !opts.dev,
      sourcemap: opts.dev ? 'inline' : false,
      logLevel: 'silent',
      legalComments: 'none'
    })
    // 顺序有意义：先把 chunk 之间的相对说明符绝对化，再把宿主说明符换成桥 URL
    //（前者要按「产物文件集」判断，后者只看说明符形态）
    chunkRewrites = absolutizeChunkSpecifiers(id, outDir)
    hostRewrites = rewriteHostSpecifiersInBundle(outDir)
  } catch (err) {
    info.errors.push(...formatEsbuildErrors((err as { errors?: never[] }).errors))
    if (info.errors.length === 0) info.errors.push(`渲染层构建失败：${(err as Error).message}`)
    return finish()
  }

  // ── ③ 样式表（plugin.css）────────────────────────────────────────────────
  const cssParts: string[] = []
  const scanned = scanDraftCandidates(draftRoot)
  if (cssMode === 'auto' && scanned.all.length > 0) {
    try {
      const generated = await compilePluginCss(scanned.all, host!.loader, draftRoot)
      appendCss(cssParts, generated)
    } catch (err) {
      info.warnings.push(
        `Tailwind 生成样式表失败（降级为不带样式）：${(err as Error).message}。` +
          `可以把 workshop.json 的 css 改成 'file' 并手写 plugin.css。`
      )
    }
  }
  const manualCss = path.join(draftRoot, 'plugin.css')
  if (cssMode !== 'off' && fs.existsSync(manualCss)) {
    appendCss(cssParts, fs.readFileSync(manualCss, 'utf-8'))
  } else if (cssMode === 'file' && !fs.existsSync(manualCss)) {
    info.warnings.push("css 模式是 'file'，但草稿里没有 plugin.css（产物将不含样式表）")
  }
  // esbuild 的 css loader 产出：插件源码里 `import './x.css'` 会被合并进 plugin.css
  const emittedCss = path.join(outDir, 'renderer.css')
  if (fs.existsSync(emittedCss)) {
    appendCss(cssParts, fs.readFileSync(emittedCss, 'utf-8'))
    fs.rmSync(emittedCss, { force: true })
  }
  const finalCss = cssParts.join('\n\n')
  if (finalCss.trim()) {
    fs.writeFileSync(path.join(outDir, 'plugin.css'), finalCss + '\n', 'utf-8')
  }
  info.css = {
    mode: cssMode,
    bytes: Buffer.byteLength(finalCss, 'utf-8'),
    candidates: scanned.all.length,
    missing: missingClasses(finalCss, scanned.strict)
  }

  // ── ④ 清单（entry 由构建写入；builtin 强制 false——工坊做的都是第三方插件）──
  const nextManifest: Record<string, unknown> = {
    ...raw,
    builtin: false,
    entry: { renderer: 'renderer.mjs', main: 'main.cjs' }
  }
  writeJson(path.join(outDir, 'plugin.json'), nextManifest)

  // ── ⑤ 主进程裸模块体检（构建期能发现的，就不要留到装载期）──────────────
  for (const spec of specs.mainSpecs) {
    if (spec.startsWith('@host/')) continue
    try {
      host!.loader.resolve(spec)
    } catch {
      info.warnings.push(
        `主进程依赖 '${spec}' 在宿主应用根解析不到：装载时会失败（可用宿主已有依赖，或改进 @host/main/** 桥）`
      )
    }
  }

  const files = listDraftFiles(id).length
  info.files = fs
    .readdirSync(outDir)
    .filter((f) => fs.statSync(path.join(outDir, f)).isFile())
    .map((f) => ({ path: f, size: fs.statSync(path.join(outDir, f)).size }))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'))
  info.ok = true
  info.outDir = outDir
  info.at = Date.now()
  if (chunkRewrites > 0) {
    info.warnings.push(
      `已把 ${chunkRewrites} 处产物内相对说明符改写为 plugin://${id}/…（blob import 前提）`
    )
  }
  if (hostRewrites > 0) {
    info.warnings.push(`已把 ${hostRewrites} 处宿主说明符改写为 plugin://host/ui.js 桥 URL`)
  }
  if (files === 0) info.warnings.push('草稿里一个文件都没有（异常状态）')

  patchDraftMeta(id, { builtAt: info.at })
  return finish()
}

/** 产物里主进程真的会解析的宿主说明符（验收电池据此核对运行时表） */
export function bundleMainSpecs(outDir: string): string[] {
  const file = path.join(outDir, 'main.cjs')
  if (!fs.existsSync(file)) return []
  const code = fs.readFileSync(file, 'utf-8')
  const out = new Set<string>()
  const re = /__RB_HOST_RESOLVE__\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(code)) !== null) out.add(match[2])
  return [...out].sort()
}

/**
 * 渲染层产物里引用的**宿主 UI 键**（入口 + 全部 chunk 去重）。
 *
 * 产物形态是构建期改写出来的 `plugin://host/ui.js?m=<键>`（见 `rewriteHostSpecifiersInBundle`），
 * 因此这里解 URL 里的 `m=` 参数即可；顺带把「没被改写干净的裸宿主说明符」也收进来——
 * 那种残留会让宿主 loader 直接报解析失败，验收必须点名（键里带 `!` 前缀标记）。
 */
export function bundleRendererSpecs(outDir: string): string[] {
  const out = new Set<string>()
  const bareRe = /(\bfrom\s*|\bimport\s*\(\s*|(?:^|[;}\n])\s*import\s*)(['"])([^'"]+)\2/gm
  const bridgeRe = /plugin:\/\/host\/ui\.js\?m=([^"'\s)]+)/g
  for (const file of fs.readdirSync(outDir)) {
    if (!file.endsWith('.mjs')) continue
    const code = fs.readFileSync(path.join(outDir, file), 'utf-8')
    let match: RegExpExecArray | null
    bridgeRe.lastIndex = 0
    while ((match = bridgeRe.exec(code)) !== null) {
      try {
        out.add(decodeURIComponent(match[1]))
      } catch {
        out.add(match[1])
      }
    }
    bareRe.lastIndex = 0
    while ((match = bareRe.exec(code)) !== null) {
      const spec = match[3]
      if (spec.startsWith('@host/')) out.add(`!${spec}`)
      else if (RENDERER_VENDOR.some((v) => spec === v || spec.startsWith(v + '/'))) {
        out.add(`!@host/vendor/${spec}`)
      }
    }
  }
  return [...out].sort()
}

/** 渲染层产物里是否还有相对说明符（blob import 下必然失败 → 验收会点名） */
export function relativeSpecifiersInBundle(outDir: string): string[] {
  const out: string[] = []
  for (const file of fs.readdirSync(outDir)) {
    if (!file.endsWith('.mjs')) continue
    const code = fs.readFileSync(path.join(outDir, file), 'utf-8')
    const re = /(\bfrom\s*|\bimport\s*\(\s*|(?:^|[;}\n])\s*import\s*)(['"])(\.{1,2}\/[^'"]+)\2/gm
    let match: RegExpExecArray | null
    while ((match = re.exec(code)) !== null) out.push(`${file} → ${match[3]}`)
  }
  return out
}
