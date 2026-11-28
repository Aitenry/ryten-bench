import * as fs from 'fs'
import * as path from 'path'
import type { WorkshopPublishResult, WorkshopRendererProbe } from '../../shared/harness/workshop'
import { distDir, draftDir, ensureDir, exportsRoot, readJson } from './paths'
import { hasBuild, isBuildStale, workshopHost } from './host'
import { updateReportRenderer } from './verify'

/**
 * Publish / uninstall / export.
 *
 * **Publish = go through the host's existing install chain** (`installPackageDir` →
 * `setEnabledOverride` → `loadExternalMain` → `broadcastPluginStateChanged`), the same set of
 * functions used by "install from local" and "install from the plugin center" on the settings
 * page. The workshop does not build a second one: otherwise "plugins installed by the
 * workshop" and "plugins installed by the user" would eventually diverge on details like
 * upgrade cleanup, uninstall bookkeeping, and renderer reloads.
 */

/** Pre-publish guard: the draft exists, the output exists, the id is valid */
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
  // The output may have been edited by hand: when the id differs, what gets installed is **another plugin**, so block it before touching disk
  const manifest = readJson<{ id?: unknown }>(manifestFile)
  if (typeof manifest?.id !== 'string' || manifest.id !== id) {
    throw new Error(
      `产物清单的 id（${String(manifest?.id)}）与草稿 '${id}' 不一致：重新 plugin_build，不要手改 dist 里的文件`
    )
  }
  return { outDir: distDir(id) }
}

/**
 * Install the draft's build output into the app and enable it, **then immediately re-verify
 * against the real UI**.
 *
 * Why re-verify automatically after publish (rather than trusting the static checks done
 * before publish): only the real UI can tell whether the renderer loads (the `plugin://`
 * protocol, the host UI bridge, and blob import are all required), and that is testable only
 * after the plugin is **already installed**. A failed re-verification **rolls back
 * automatically** (uninstall), turning the failure mode left on the user's machine from "an
 * extra plugin in the menu that shows a blank screen when clicked" into "a single install
 * failure with a reason".
 *
 * A stale output does not block (the user may simply want to look at the old version), but
 * the result is honestly flagged with `staleBuild`.
 */
export async function publishDraft(id: string): Promise<WorkshopPublishResult> {
  const host = workshopHost()
  const { outDir } = assertPublishable(id)
  const staleBuild = isBuildStale(id)
  /** New install or upgrade: decides whether a failure means "roll back by uninstalling" or "keep it installed but disabled" */
  const wasInstalled = host.isInstalled(id)

  let info: ReturnType<typeof host.installPackage>
  try {
    info = host.installPackage(outDir)
  } catch (err) {
    // A failed new install (copy error midway / manifest rejected) may leave a half-written directory: clean it up so the panel does not show a broken plugin
    if (!wasInstalled) {
      try {
        host.uninstall(id)
        host.notify()
      } catch {
        // If cleanup fails, just report the install error honestly below
      }
    }
    throw new Error(`安装失败：${(err as Error).message}`)
  }

  /**
   * Enable failures must **converge the state**; do not leave "installed but not enabled" for
   * the user to discover:
   * - Upgrade: the old version cannot be restored (its output was overwritten), so keep the
   *   new install directory and mark it disabled, telling the user to retry;
   * - New install: roll back the whole install, so the failure mode goes from "an extra
   *   plugin in the panel that cannot be enabled" to "a single install failure with a reason".
   */
  try {
    host.enable(info.id)
  } catch (err) {
    try {
      host.disable(info.id)
    } catch {
      // If disabling also fails, the error below is enough for the user to handle it in the panel
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
      // Roll back: delete the code just installed (there was no data anyway), and rethrow the reason as-is to the caller
      try {
        host.uninstall(info.id)
        host.notify()
      } catch (err) {
        // Rollback failures must be reported honestly: otherwise a broken plugin is left on the user's machine
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
    // Write the re-verification result back to the most recent verification report: before
    // installation this item can only be SKIP (the plugin is not installed yet); the probe
    // that runs right after installation is the evidence that "the UI really loads"
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

/** Disable (keep the installed directory and data): equivalent to turning the switch off in the panel */
export function disableDraft(id: string): void {
  const host = workshopHost()
  host.disable(id)
  host.notify()
}

/** Enable result (shared by panel/tools: what was enabled + the renderer re-verification result) */
export interface WorkshopEnableResult {
  id: string
  enabled: boolean
  rendererProbe?: WorkshopRendererProbe
}

/**
 * Enable a plugin that is **already installed**, then immediately re-verify against the real
 * UI.
 *
 * Why a separate action: after a failed publish or a manual install by the user, a plugin may
 * be left in "installed · disabled". Previously the only option was to have the user click
 * the switch in the panel — yet the assistant can finish this itself. A failed
 * re-verification **disables automatically** (rather than leaving a plugin that is enabled
 * but shows a blank screen), converging the failure into one enable failure with a reason.
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
        // Even when disabling fails, report the probe reason honestly (it is included in the error thrown below)
      }
      throw new Error(
        `启用后渲染层复验失败，已自动停用：${rendererProbe.detail ?? '未知原因'}。` +
          `常见原因是渲染入口顶层抛错或引了宿主 UI 表里没有的模块——改完重新 plugin_verify 再发布。`
      )
    }
  }
  return { id, enabled: host.isEnabled(id), ...(rendererProbe ? { rendererProbe } : {}) }
}

/** Uninstall: unload the main module + delete userData/plugins/<id> (data is kept, same behavior as uninstalling from the panel) */
export function unpublishDraft(id: string): void {
  const host = workshopHost()
  host.uninstall(id)
  host.notify()
}

/**
 * Export as a distributable zip (`<root>/exports/<id>-<version>.zip`).
 *
 * The purpose is "send a plugin I made to someone else / upload it to the plugin center": the
 * zip content is file-for-file identical to `dist/<id>`, and the other side can install it via
 * the settings page's "install from local → choose zip" (that chain already exists).
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

/** Open the draft directory (for the panel's "open directory"; how to open it is decided by the host) */
export function draftDirOf(id: string): string {
  return draftDir(id)
}
