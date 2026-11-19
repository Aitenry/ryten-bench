import type { PluginManifest } from '../shared/plugin/types'

/**
 * 随应用分发的**内置插件清单注册表**（主进程用）。
 *
 * `harness`（AI 助手）与 `notes`（资料库）已经移出插件系统，作为 `src/features/**`
 * 下的系统级功能随应用启动，不再进入插件清单、安装器或插件仓库。
 *
 * **不在这里的插件 = 第三方插件**：不随应用分发、不自动安装、默认停用，
 * 由用户从 GitHub（见应用侧的「从 GitHub 安装」）或本地目录装进来。
 * `task-planner` / `music-player` 就是这样的独立插件——源码与发布在
 * `github.com/Aitenry/ryten-plugins`。
 */
export const BUILTIN_PLUGIN_MANIFESTS: PluginManifest[] = []

export default BUILTIN_PLUGIN_MANIFESTS
