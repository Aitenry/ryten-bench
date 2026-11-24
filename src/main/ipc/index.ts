import { registerMiscIpc } from './misc'
import { registerLockIpc } from './lock'
import { registerSettingsIpc } from './settings'
import { registerProviderIpc } from './provider'
import { registerDialogIpc } from './dialog'
import { registerPluginsIpc } from './plugins'
import { registerLatticeIpc } from './lattice'

/**
 * core（外壳）IPC：窗口杂项 / 系统设置 / 锁屏 / 模型 Provider / 对话框 / 插件管理 /
 * Lattice 插件中心（登录、目录、上传、下载安装、数据同步）。
 *
 * 归属边界：
 * - 这里**只**放外壳自身的能力；
 * - 系统功能（AI 助手 `harness:*` / 资料库 `notes:*`）的通道在 `src/main/ipc/harness/**`、
 *   `src/main/ipc/notes/**`，由 `src/main/system/` 在启动时注册——它们是 core 的一部分，
 *   不是插件；
 * - 第三方插件的通道走插件自己的 `main/index.ts` 的 `install(ctx)` +
 *   `ctx.registerIpc`，由插件宿主按启用态注册与摘除。
 *
 * 归属变更记录：
 * - `workspace-*`（9 个通道）与 harness/harness-topic/mnemon 同批迁进 AI 助手；
 * - `agent-*` / `main-agent-*` 从 `provider.ts` 迁进 `ipc/harness/agent.ts`，
 *   这里只剩模型 Provider 自己的通道。
 */
export function registerCoreIpc(): void {
  registerMiscIpc()
  registerLockIpc()
  registerSettingsIpc()
  registerDialogIpc()
  registerProviderIpc()
  registerPluginsIpc()
  // 插件中心：通道注册 + 启动时恢复登录态/拉取云端安装记录（内部会初始化 lattice/index.ts）
  registerLatticeIpc()
}
