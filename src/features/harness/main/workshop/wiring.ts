import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import {
  isBundledPluginId,
  isEnabledPlugin,
  loadExternalMain,
  unloadExternalMain
} from '../../../../main/plugins/host'
import { scanExternalPlugins } from '../../../../main/plugins/scanner'
import { installPackageDir } from '../../../../main/plugins/package-install'
import { uninstallExternalPlugin } from '../../../../main/plugins/lifecycle'
import { setEnabledOverride } from '../../../../main/plugins/store'
import { broadcastPluginStateChanged } from '../../../../main/ipc/plugins'
import { hostRuntimeKeys } from '../../../../main/plugins/runtime'
import { hostUiExportKeys } from '../../../../main/plugins/host-ui-bridge'
import { settingsStore } from '../../../../main/context'
import type { HarnessSettings } from '../../../../main/types/settings'
import { WORKSHOP_EVENT_CHANNELS } from '../ipc/workshop'
import { configureWorkshopHost, createNodeLoader } from './host'
import { resolveLoaderBases } from './loader-bases'
import { configurePluginsRoot } from './paths'
import { probeRendererPlugin } from './probe'

/**
 * 工坊 ↔ 应用宿主的接线（**唯一**把工坊能力接到真实应用的地方）。
 *
 * 为什么单独一个文件：`main/workshop/**` 的其余部分刻意不 import electron / core
 * （离线工装因此能跑「生成 → 构建 → 验收 → 发布」全链路），所有「只有应用里才有」的
 * 能力在这里集中注入一次，读这个文件就能看清工坊到底借了宿主哪些东西：
 *
 * | 借用 | 出处 | 用途 |
 * |------|------|------|
 * | 插件包安装 | `package-install.installPackageDir` | 发布（与「从本地安装」同一套校验/升级清理） |
 * | 启用 / 停用 | `store.setEnabledOverride` + `host.load/unloadExternalMain` | 装完即启用；停用只摘模块 |
 * | 卸载 | `lifecycle.uninstallExternalPlugin` | 第三方插件语义：删代码、留数据 |
 * | 宿主运行时表 | `runtime.hostRuntimeKeys` | 验收里核对主进程 `@host/**` 说明符 |
 * | 宿主 UI 表 | `host-ui-bridge.hostUiExportKeys` | 验收里核对渲染层宿主说明符 |
 * | 模块加载器 | `createNodeLoader`（应用根 / asar.unpacked） | esbuild、tailwindcss、jszip |
 * | 渲染层探针 | `probe.probeRendererPlugin` | 在真界面里 import + install 一遍 |
 */

/**
 * 模块加载器的候选基准（顺序即优先级；约束与踩坑记录见 `./loader-bases.ts`）。
 *
 * 一句话：**`app.asar.unpacked` 必须排在 `app.asar` 前面** —— asar 里的文件对 `require`
 * 可见、对 `spawn` 不可见，顺序反了 `esbuild` 会"解析成功"再去 spawn 一个不存在的
 * `app.asar\…\@esbuild\win32-x64\esbuild.exe`。
 */
function loaderBases(): string[] {
  return resolveLoaderBases({
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    appPath: app.getAppPath()
  })
}

/**
 * 已占用的通道命名空间（撞名检查：含已安装但当前停用的插件）。
 *
 * **只扫已安装插件**（不扫当前通道表）：通道名解析不出所属插件 id，
 * 于是「草稿自己正装着」会被判成冲突；而已安装清单是权威且够用的口径——
 * 通道只可能来自已安装的插件。
 *
 * @param exceptId 要排除的插件 id（草稿自己：它的命名空间当然归它）
 */
function usedNamespaces(exceptId?: string): string[] {
  const namespaces = new Set<string>()
  for (const plugin of scanExternalPlugins()) {
    if (plugin.id === exceptId) continue
    namespaces.add(plugin.id.startsWith('plugin.') ? plugin.id.slice('plugin.'.length) : plugin.id)
  }
  return [...namespaces]
}

/**
 * 工坊根目录（`<userData>/plugin-workshop`）。
 *
 * 只放**工坊自己的东西**：构建产物、验收报告、导出的 zip、旧版草稿目录（迁移用）。
 * 插件源码在用户配置的「插件存放路径」（`harness` 设置的 `pluginsPath`，没有默认值）里——
 * 这个 userData 目录刻意不出现在设置页上（用户口径 2026-09-27「不要在设置页面显示这个目录」）。
 */
export function workshopRootDir(): string {
  return path.join(app.getPath('userData'), 'plugin-workshop')
}

/** 用户配置的插件存放路径（未配置时返回空字符串） */
function configuredPluginsRoot(): string {
  const settings = settingsStore.get('harness') as HarnessSettings | undefined
  return typeof settings?.pluginsPath === 'string' ? settings.pluginsPath : ''
}

/** 落盘「插件存放路径」（写进 harness 设置） */
function persistPluginsRoot(dir: string): void {
  const current = (settingsStore.get('harness') as HarnessSettings | undefined) ?? {}
  settingsStore.set('harness', { ...current, pluginsPath: dir || undefined })
  logger.info(`[Workshop] 插件存放路径已更新：${dir || '（清除）'}`)
}

/**
 * 接线（在 AI 助手插件的 `install(ctx)` 里、`ctx.effect` 的可逆装配内调用）。
 *
 * 注意 `WORKSHOP_EVENT_CHANNELS` 也在这里被引用一次：接线与通道声明在同一个文件里，
 * 加通道时不会漏掉 `registerEvent`（漏了的表现是渲染层订阅静默失效）。
 */
export function installWorkshopHost(): void {
  const root = workshopRootDir()
  fs.mkdirSync(root, { recursive: true })
  const loader = createNodeLoader(loaderBases())

  // 插件存放路径来自设置（没有默认值）：装载时就注入，未配置则草稿相关动作全部拒绝
  configurePluginsRoot(configuredPluginsRoot())

  configureWorkshopHost({
    root,
    loader,
    hostMainKeys: () => hostRuntimeKeys(),
    hostUiKeys: () => hostUiExportKeys(),
    isBundledPlugin: (id) => isBundledPluginId(id),
    isInstalled: (id) => scanExternalPlugins().some((plugin) => plugin.id === id),
    isEnabled: (id) => isEnabledPlugin(id),
    usedNamespaces,
    installPackage: (dir) => installPackageDir(dir),
    enable: (id) => {
      setEnabledOverride(id, true)
      loadExternalMain(id)
    },
    disable: (id) => {
      setEnabledOverride(id, false)
      unloadExternalMain(id)
    },
    uninstall: (id) => uninstallExternalPlugin(id),
    setPluginsRoot: (dir) => persistPluginsRoot(dir),
    // 「工坊状态变了」由 ipc/workshop.ts 广播（刷新面板）；这里广播**宿主**的
    // `plugin-state-changed`——渲染层正是靠它重新拉插件清单、去 plugin:// 取新插件的
    // renderer.mjs 并注册菜单/路由的。少了这一句：插件装上了、通道也能用，
    // 但侧栏/设置页永远不出现（2026-09-27 真机实测，最容易误判成「插件没装上」）。
    notify: () => broadcastPluginStateChanged(),
    probeRenderer: (id) => {
      // 探针靠 `plugin://<id>/…` 取产物：未安装的插件取不到文件（404），
      // 停用的插件是 403。这两种情况都如实 skip（发布后会自动复验一次）。
      if (!scanExternalPlugins().some((plugin) => plugin.id === id)) {
        return Promise.resolve({
          status: 'skip',
          detail: '插件尚未安装：渲染层探针在发布后自动复验（或安装后重跑验收）'
        })
      }
      if (!isEnabledPlugin(id)) {
        return Promise.resolve({
          status: 'skip',
          detail: '插件已安装但处于停用状态：启用后再跑验收即可覆盖渲染层探针'
        })
      }
      return probeRendererPlugin(id)
    }
  })
  logger.info(
    `[Workshop] 插件工坊已接线：内部目录 ${root}；插件存放路径 ${configuredPluginsRoot() || '（未配置）'}` +
      `（加载器基准 ${loaderBases().join(' / ')}）`
  )
}

/** 摘掉接线（停用 AI 助手 = 工坊随之不可用；工具与通道会给出可读错误） */
export function uninstallWorkshopHost(): void {
  configureWorkshopHost(null)
  configurePluginsRoot('')
}

export { WORKSHOP_EVENT_CHANNELS }
