import * as fs from 'fs'
import * as path from 'path'
import type { WorkshopPublishResult, WorkshopRendererProbe } from '../../shared/harness/workshop'
import { distDir, draftDir, ensureDir, exportsRoot, readJson } from './paths'
import { hasBuild, isBuildStale, workshopHost } from './host'
import { updateReportRenderer } from './verify'

/**
 * 发布 / 卸载 / 导出。
 *
 * **发布 = 走宿主既有的安装链路**（`installPackageDir` → `setEnabledOverride` →
 * `loadExternalMain` → `broadcastPluginStateChanged`），与设置页里的「从本地安装」、
 * 「从插件中心安装」是同一条路径的同一批函数。工坊不另造一条：否则「工坊装的插件」
 * 与「用户装的插件」迟早会在升级清理、卸载记账、渲染层重载这些细节上分叉。
 */

/** 发布前的守卫：草稿在、产物在、id 合法 */
function assertPublishable(id: string): { outDir: string } {
  if (!fs.existsSync(draftDir(id))) {
    throw new Error(`草稿 '${id}' 不存在`)
  }
  if (!hasBuild(id)) {
    throw new Error(`草稿 '${id}' 还没有构建产物：先跑 plugin_build（或 plugin_verify）`)
  }
  const manifestFile = path.join(distDir(id), 'plugin.json')
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`产物缺少 plugin.json（${manifestFile}）`)
  }
  // 产物可能被手工改过：id 不一致时装进去的是**另一个插件**，必须在落地前挡住
  const manifest = readJson<{ id?: unknown }>(manifestFile)
  if (typeof manifest?.id !== 'string' || manifest.id !== id) {
    throw new Error(
      `产物清单的 id（${String(manifest?.id)}）与草稿 '${id}' 不一致：重新 plugin_build，不要手改 dist 里的文件`
    )
  }
  return { outDir: distDir(id) }
}

/**
 * 把草稿的构建产物装进应用并启用，**随后立刻在真界面上复验一次**。
 *
 * 为什么发布后要自动复验（而不是只信发布前的静态检查）：渲染层能不能装载只有真界面说了算
 * （`plugin://` 协议、宿主 UI 桥、blob import 三者缺一不可），而它在插件**已安装**之后才可测。
 * 复验失败就**自动回滚**（卸载），把插件留在用户机器上的失败模式从「菜单里多一个点了就白屏的
 * 插件」变成「一次带原因的安装失败」。
 *
 * 产物比源码旧时不阻断（用户可能就是想先看看旧版），但在结果里如实标记 `staleBuild`。
 */
export async function publishDraft(id: string): Promise<WorkshopPublishResult> {
  const host = workshopHost()
  const { outDir } = assertPublishable(id)
  const staleBuild = isBuildStale(id)
  /** 新装还是升级：决定失败时「回滚卸载」还是「保留已装但停用」 */
  const wasInstalled = host.isInstalled(id)

  let info: ReturnType<typeof host.installPackage>
  try {
    info = host.installPackage(outDir)
  } catch (err) {
    // 新装失败（拷贝中途出错/清单被拒）可能留下半份目录：清掉，别让面板出现装坏的插件
    if (!wasInstalled) {
      try {
        host.uninstall(id)
        host.notify()
      } catch {
        // 清不掉时下面如实报安装错误即可
      }
    }
    throw new Error(`安装失败：${(err as Error).message}`)
  }

  /**
   * 启用失败要**收敛状态**，不能把「装了但没启用」留给用户自己发现：
   * - 升级：无法恢复旧版本（产物已被覆盖），保留新装目录并标成停用，提示用户重试；
   * - 新装：整份回滚卸载，失败模式从「面板里多一个启用不了的插件」变成「一次带原因的安装失败」。
   */
  try {
    host.enable(info.id)
  } catch (err) {
    try {
      host.disable(info.id)
    } catch {
      // 停用也失败时，下面的报错已经足够让用户去面板处理
    }
    if (wasInstalled) {
      host.notify()
      throw new Error(
        `已升级安装，但启用失败：${(err as Error).message}。` +
          `插件现在是停用状态，请到 设置 → 插件 里重试启用（源码与产物都在，不需要重装）。`
      )
    }
    try {
      host.uninstall(info.id)
      host.notify()
    } catch (rollbackErr) {
      throw new Error(
        `启用失败，且自动回滚卸载也失败（请到 设置 → 插件 里手工卸载 '${info.id}'）：` +
          `${(err as Error).message}；回滚错误：${(rollbackErr as Error).message}`
      )
    }
    throw new Error(`启用失败，已自动回滚卸载：${(err as Error).message}`)
  }
  host.notify()

  let rendererProbe: WorkshopRendererProbe | undefined
  if (host.probeRenderer) {
    try {
      rendererProbe = await host.probeRenderer(info.id)
    } catch (err) {
      rendererProbe = { status: 'fail', detail: `探针异常：${(err as Error).message}` }
    }
    if (rendererProbe.status === 'fail') {
      // 回滚：删掉刚装上去的代码（数据本来就没有），并把原因原样抛给调用方
      try {
        host.uninstall(info.id)
        host.notify()
      } catch (err) {
        // 回滚失败要如实说：否则用户机器上会留一个坏插件
        throw new Error(
          `安装后渲染层复验失败，且自动回滚也失败（请到 设置 → 插件 里手工卸载 '${info.id}'）：` +
            `${rendererProbe.detail ?? '未知原因'}；回滚错误：${(err as Error).message}`
        )
      }
      throw new Error(
        `已安装但渲染层复验失败，已自动回滚卸载：${rendererProbe.detail ?? '未知原因'}。` +
          `常见原因是渲染入口顶层抛错、引了宿主 UI 表里没有的模块，或注册的组件一渲染就崩。`
      )
    }
    // 复验结论回写最近一次验收报告：安装前这一项只能 SKIP（插件还没装），
    // 装完立刻兑现的这次探针才是「界面真的能装载」的证据
    updateReportRenderer(info.id, rendererProbe)
  }

  return {
    id: info.id,
    version: info.version,
    upgraded: info.upgraded,
    dest: info.dest,
    files: info.files,
    enabled: host.isEnabled(info.id),
    ...(staleBuild ? { staleBuild } : {}),
    ...(rendererProbe ? { rendererProbe } : {})
  }
}

/** 停用（保留已装目录与数据）：面板上等价于关掉开关 */
export function disableDraft(id: string): void {
  const host = workshopHost()
  host.disable(id)
  host.notify()
}

/** 启用结果（面板/工具共用：启用了什么 + 渲染层复验结论） */
export interface WorkshopEnableResult {
  id: string
  enabled: boolean
  rendererProbe?: WorkshopRendererProbe
}

/**
 * 启用一个**已经装好**的插件，并立刻在真界面上复验一次。
 *
 * 为什么单独一个动作：发布失败/用户手工装过之后，插件可能停在「已安装·停用」。
 * 此前只能让用户去面板点开关——助手明明能把这件事做完。复验失败会**自动停用**
 * （而不是留一个启用了但界面白屏的插件），把失败收敛成一次带原因的启用失败。
 */
export async function enableDraft(id: string): Promise<WorkshopEnableResult> {
  const host = workshopHost()
  if (!host.isInstalled(id)) {
    throw new Error(`插件 '${id}' 还没安装：先 plugin_publish install（或让用户在插件面板里安装）`)
  }
  host.enable(id)
  host.notify()

  let rendererProbe: WorkshopRendererProbe | undefined
  if (host.probeRenderer) {
    try {
      rendererProbe = await host.probeRenderer(id)
    } catch (err) {
      rendererProbe = { status: 'fail', detail: `探针异常：${(err as Error).message}` }
    }
    if (rendererProbe.status === 'fail') {
      try {
        host.disable(id)
        host.notify()
      } catch {
        // 停用失败也要如实报探针原因（下面抛出的错误里带着）
      }
      throw new Error(
        `启用后渲染层复验失败，已自动停用：${rendererProbe.detail ?? '未知原因'}。` +
          `常见原因是渲染入口顶层抛错或引了宿主 UI 表里没有的模块——改完重新 plugin_verify 再发布。`
      )
    }
  }
  return { id, enabled: host.isEnabled(id), ...(rendererProbe ? { rendererProbe } : {}) }
}

/** 卸载：摘主模块 + 删 userData/plugins/<id>（数据保留，与面板卸载口径一致） */
export function unpublishDraft(id: string): void {
  const host = workshopHost()
  host.uninstall(id)
  host.notify()
}

/**
 * 导出成可分发的 zip（`<root>/exports/<id>-<version>.zip`）。
 *
 * 用途是「把我做的插件发给别人 / 传到插件中心」：zip 内容与 `dist/<id>` 逐文件一致，
 * 对方可以用设置页的「从本地安装 → 选 zip」装进来（那条链路本来就有）。
 */
export async function exportDraft(
  id: string
): Promise<{ file: string; bytes: number; files: string[] }> {
  const host = workshopHost()
  const { outDir } = assertPublishable(id)
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'plugin.json'), 'utf-8')) as {
    version?: string
  }
  const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  const files = fs
    .readdirSync(outDir)
    .filter((f) => fs.statSync(path.join(outDir, f)).isFile() && f !== 'plugin.css.map')
    .sort()

  const JSZip = host.loader.require('jszip') as new () => {
    file: (name: string, data: Buffer) => void
    generateAsync: (opts: { type: 'nodebuffer'; compression: 'DEFLATE' }) => Promise<Buffer>
  }
  const zip = new JSZip()
  for (const file of files) zip.file(file, fs.readFileSync(path.join(outDir, file)))
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })

  const target = path.join(ensureDir(exportsRoot()), `${id}-${version}.zip`)
  fs.writeFileSync(target, buffer)
  return { file: target, bytes: buffer.length, files }
}

/** 打开草稿目录（面板「打开目录」用；由宿主决定怎么打开） */
export function draftDirOf(id: string): string {
  return draftDir(id)
}
