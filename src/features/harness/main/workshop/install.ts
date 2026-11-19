import * as fs from 'fs'
import * as path from 'path'
import type { WorkshopPublishResult, WorkshopRendererProbe } from '../../shared/workshop'
import { distDir, draftDir, ensureDir, exportsRoot } from './paths'
import { hasBuild, isBuildStale, workshopHost } from './host'

/**
 * 发布 / 卸载 / 导出。
 *
 * **发布 = 走宿主既有的安装链路**（`installPackageDir` → `setEnabledOverride` →
 * `loadExternalMain` → `broadcastPluginStateChanged`），与设置页里的「从本地安装」、
 * 「从插件仓库安装」是同一条路径的同一批函数。工坊不另造一条：否则「工坊装的插件」
 * 与「用户装的插件」迟早会在升级清理、卸载记账、渲染层重载这些细节上分叉。
 */

/** 发布前的守卫：草稿在、产物在、id 合法 */
function assertPublishable(id: string): { outDir: string } {
  const host = workshopHost()
  if (!fs.existsSync(draftDir(id))) {
    throw new Error(`草稿 '${id}' 不存在`)
  }
  if (host.isBundledPlugin(id)) {
    throw new Error(`'${id}' 是随应用分发的内置插件 id，工坊不能覆盖它`)
  }
  if (!hasBuild(id)) {
    throw new Error(`草稿 '${id}' 还没有构建产物：先跑 plugin_build（或 plugin_verify）`)
  }
  const manifestFile = path.join(distDir(id), 'plugin.json')
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`产物缺少 plugin.json（${manifestFile}）`)
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
  const info = host.installPackage(outDir)
  host.enable(info.id)
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

/** 卸载：摘主模块 + 删 userData/plugins/<id>（数据保留，与面板卸载口径一致） */
export function unpublishDraft(id: string): void {
  const host = workshopHost()
  host.uninstall(id)
  host.notify()
}

/**
 * 导出成可分发的 zip（`<root>/exports/<id>-<version>.zip`）。
 *
 * 用途是「把我做的插件发给别人 / 传到插件仓库」：zip 内容与 `dist/<id>` 逐文件一致，
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
