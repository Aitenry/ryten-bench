import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'node:module'
import type { WorkshopRendererProbe } from '../../shared/workshop'
import type { ModuleLoader } from './css'
import { configureWorkshopRoot, distDir, draftDir, isWorkshopReady } from './paths'

/**
 * 工坊的**宿主接线**：服务本身不 import electron（离线工装才能跑全链路），
 * 一切「只有应用里才有」的能力都从这里注入。
 *
 * 注入分三层，缺一层只降级对应功能，不阻塞其余部分：
 * - **模块加载器**（`loader`）：esbuild / tailwindcss / jszip —— 拿不到时构建/样式/导出各自报可读错误；
 * - **宿主表**（`hostMainKeys` / `hostUiKeys`）：验收电池据此判断产物的宿主说明符是否都真的能解析；
 * - **安装动作**（`installPackage` / `enable` / `uninstall` / `notify`）：发布与卸载走宿主既有的
 *   插件装载链路（与面板上的安装、卸载**完全同一套**代码），工坊不另造一条。
 */

/** 宿主插件包的安装结果（core `installPackageDir` 的子集） */
export interface InstalledPackageLike {
  id: string
  name: string
  version: string
  upgraded: boolean
  dest: string
  files: number
}

export interface WorkshopHost {
  /** 工坊根目录（`<userData>/plugin-workshop`） */
  root: string
  /** 宿主主进程运行时表的键（`@host/main/**`、`@host/shared/**`） */
  hostMainKeys: () => string[]
  /** 宿主渲染层 UI 表的键；`null` = 渲染层还没上报（此时只跳过对应检查） */
  hostUiKeys: () => string[] | null
  /** 是否内置插件 id（内置插件不能被工坊覆盖安装） */
  isBundledPlugin: (id: string) => boolean
  /** 是否已安装（`userData/plugins/<id>` 存在） */
  isInstalled: (id: string) => boolean
  /** 是否已启用（含「装了但停用」） */
  isEnabled: (id: string) => boolean
  /**
   * 已占用的通道命名空间（撞名检查）。
   *
   * `exceptId` 是**要排除的插件 id**：命名空间是插件 id 去掉 `plugin.` 段得到的，
   * 因此「草稿 `twin` 自己已安装」与「另一个插件 `plugin.twin` 占了 `plugin:twin:`」
   * 必须区分开——前者不是冲突，后者是。宿主按 id 过滤，工坊只比对命名空间。
   */
  usedNamespaces: (exceptId?: string) => string[]
  /** 模块加载器（esbuild / tailwindcss / jszip 从它取） */
  loader: ModuleLoader
  /** 安装（或升级）一个已落盘的插件包目录 */
  installPackage: (dir: string) => InstalledPackageLike
  /** 启用：写启用覆写 + 装载主模块 */
  enable: (id: string) => void
  /** 停用：只摘主模块，保留已装目录 */
  disable: (id: string) => void
  /** 卸载：摘主模块 + 删目录 + 清覆写（数据由插件自己的 purge 贡献处理） */
  uninstall: (id: string) => void
  /** 持久化「插件存放路径」（harness 设置的 pluginsPath） */
  setPluginsRoot: (dir: string) => void
  /** 广播插件状态变化（渲染层据此重新 fetch 插件模块与样式） */
  notify: () => void
  /** 渲染层实时探针（没有可用窗口时返回 `skip`） */
  probeRenderer?: (id: string) => Promise<WorkshopRendererProbe>
}

let host: WorkshopHost | null = null

/** 接线（插件 install 的 effect 里调用；传 null = 关闭工坊） */
export function configureWorkshopHost(next: WorkshopHost | null): void {
  host = next
  configureWorkshopRoot(next?.root)
}

/** 工坊是否可用（工具与通道据此给可读错误） */
export function isWorkshopConfigured(): boolean {
  return host !== null && isWorkshopReady()
}

/** 取宿主接线（未接线时抛可读错误） */
export function workshopHost(): WorkshopHost {
  if (!host) {
    throw new Error('插件工坊尚未接线（宿主未注入工坊能力）')
  }
  return host
}

/** 取宿主接线（可能为 null；给「能优雅降级」的调用方用） */
export function workshopHostOrNull(): WorkshopHost | null {
  return host
}

/**
 * 用 Node 解析路径造一个模块加载器（应用里用 `app.getAppPath()` 等基准）。
 *
 * 为什么按候选基准逐个试：dev 下 esbuild/tailwindcss 在仓库 `node_modules` 里；
 * 打包后只有 `app.asar.unpacked` 下被 `asarUnpack` 解出来的那一份能被 `spawn`/读盘。
 * 逐个 `resolve` 直到命中，比「猜一个路径」稳。
 */
export function createNodeLoader(bases: string[]): ModuleLoader {
  const clean = [...new Set(bases.filter((b): b is string => typeof b === 'string' && b !== ''))]
  const requires = clean.map((base) =>
    createRequire(base.endsWith('package.json') ? base : path.join(base, 'package.json'))
  )
  const find = (id: string): NodeRequire | null => {
    for (const req of requires) {
      try {
        req.resolve(id)
        return req
      } catch {
        // 换下一个基准
      }
    }
    return null
  }
  const fail = (id: string): never => {
    throw new Error(
      `解析不到模块 '${id}'（尝试的基准：${clean.join(' / ') || '（空）'}）。` +
        `插件构建需要 esbuild（样式生成还需要 tailwindcss）：` +
        `开发环境由仓库 node_modules 提供；打包后的应用需要把它们放进 dependencies 并加入 asarUnpack。`
    )
  }
  return {
    require: (id) => {
      const req = find(id)
      if (!req) return fail(id)
      return req(id)
    },
    resolve: (id) => {
      const req = find(id)
      if (!req) return fail(id)
      return req.resolve(id)
    }
  }
}

/** 产物目录里是否有构建结果（有 plugin.json 即算） */
export function hasBuild(id: string): boolean {
  try {
    return fs.existsSync(path.join(distDir(id), 'plugin.json'))
  } catch {
    return false
  }
}

/**
 * 产物是否落后于草稿源码（发布前据此提示「先重新构建」）。
 *
 * 比 mtime：草稿里任一源文件比产物的 `plugin.json` 新，就算过期。
 */
export function isBuildStale(id: string): boolean {
  try {
    const out = path.join(distDir(id), 'plugin.json')
    if (!fs.existsSync(out)) return false
    const builtAt = fs.statSync(out).mtimeMs
    let newest = 0
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist'].includes(entry.name)) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else newest = Math.max(newest, fs.statSync(full).mtimeMs)
      }
    }
    walk(draftDir(id))
    return newest > builtAt
  } catch {
    return false
  }
}
