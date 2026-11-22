import type { PluginManifest } from '../shared/plugin/types'

/**
 * 随应用分发的**内置插件清单注册表**（主进程用）。
 *
 * `harness`（AI 助手）与 `notes`（资料库）已经是系统功能的一部分：主进程代码在
 * `src/main/**`、渲染层在 `src/renderer/src/**`，由 `src/main/system/` 装配，
 * 不进入插件清单、安装器或插件仓库。
 *
 * **不在这里的插件 = 第三方插件**：不随应用分发、不自动安装、默认停用，
 * 由用户从插件中心（Lattice 平台）或本地压缩包/目录装进来。
 * `task-planner` / `music-player` 就是这样的独立插件——发布在插件中心，
 * 安装包与源码一起下发。
 */
export const BUILTIN_PLUGIN_MANIFESTS: PluginManifest[] = []

export default BUILTIN_PLUGIN_MANIFESTS
