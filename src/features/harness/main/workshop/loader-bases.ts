import * as fs from 'fs'
import * as path from 'path'

/**
 * 工坊模块加载器的**候选基准**（顺序即优先级）。
 *
 * 为什么单独一个文件：这段顺序有一条**真机踩过两次的约束**，而 `wiring.ts` 一被 import
 * 就会拉进 electron 与整条 IPC 链，离线工装测不了。拆出来后
 * `test/verify-plugin-workshop.mjs` 能直接断言顺序，不必真的打包。
 *
 * ## 约束：`app.asar.unpacked` 必须排在 `app.asar` 前面
 *
 * asar 里的文件对 `require` 是**可见**的（Electron 给 fs 打了补丁），但对 `spawn` 不可见。
 * 于是顺序反了会出现这样的假成功：`esbuild` 从 asar 里正常解析出来 → 它的 JS 主模块去
 * `spawn(<包目录>/…/@esbuild/win32-x64/esbuild.exe)` → asar 里那个路径只是个虚拟条目 →
 * 必然报
 *
 * ```
 * The service is no longer running: spawn …\resources\app.asar\node_modules\@esbuild\win32-x64\esbuild.exe ENOENT
 * ```
 *
 * 2026-09-29 的排查顺序值得记住：先发现「打包后根本没有 esbuild」（它只在 devDependencies 里，
 * 被 files 规则排除），补进 dependencies 与 asarUnpack 之后**仍然报同样形态的错**——
 * 因为拿到的还是 asar 里那份。**「有没有」和「从哪里加载」是两件事**。
 */
export function resolveLoaderBases(options: {
  /** 打包态的 `process.resourcesPath`；开发态不给 */
  resourcesPath?: string
  /** `app.getAppPath()`（开发态 = 仓库根；打包态 = …/resources/app.asar） */
  appPath: string
  /** 判断目录是否存在的注入点（离线测试用） */
  exists?: (dir: string) => boolean
}): string[] {
  const exists = options.exists ?? fs.existsSync
  const bases: string[] = []
  if (options.resourcesPath) {
    const unpacked = path.join(options.resourcesPath, 'app.asar.unpacked')
    // 只在真的存在时作为基准：开发态没有这个目录，不必让每次解析都多试一个空路径
    if (exists(unpacked)) bases.push(unpacked)
    bases.push(path.join(options.resourcesPath, 'app'))
  }
  // 开发态：仓库 node_modules 在应用根下
  bases.push(options.appPath)
  return bases
}
