import logger from 'electron-log'
import type { PGlite } from '@electric-sql/pglite'
import { settingsStore } from '../context'
import type { HarnessSettings } from '../types/settings'
import { migrateWorkspaceData } from './workspace-migration'

/**
 * 把「工作区」这一层运行配置与某个账号数据库对齐。
 *
 * 为什么单独成文件：这段逻辑以前内联在启动流程里，只在启动早期跑一次。现在账号数据空间
 * 可以在运行中原地切换（登出 / 换号 / 改基址，见 `profiles/live.ts`），切完必须再跑一次——
 * `harness.activeWorkspaceId` 存在**机器级** `settings.json` 里，而工作区行在**账号级**
 * 数据库里：换到另一个账号后，这个 id 很可能指向不存在的行，不重新对齐会出现
 * 「侧栏没有活动工作区 / 打开的会话属于上一个账号」这类串号现象。
 *
 * 幂等：重复调用只会把设置改回与当前库一致的值。
 */
export async function applyWorkspaceSettings(db: PGlite): Promise<void> {
  const result = await migrateWorkspaceData(
    db,
    () => {
      const harness = settingsStore.get('harness') as HarnessSettings | undefined
      return harness?.activeWorkspaceId
    },
    // 插件存放路径：分类历史上的插件工作区（kind='plugin'）用，没配就跳过那一步
    (settingsStore.get('harness') as HarnessSettings | undefined)?.pluginsPath
  )

  // 把迁移确定的活动工作区写回设置（id 与路径一起同步）
  const harness = settingsStore.get('harness') as HarnessSettings | undefined
  const next: HarnessSettings = { ...(harness ?? ({} as HarnessSettings)) }
  if (result.activeWorkspaceId == null) {
    // 没有任何工作区：清掉残留配置，回到「未配置」，由对话页引导用户选择目录
    if (next.activeWorkspaceId != null || next.workspacePath) {
      delete next.activeWorkspaceId
      next.workspacePath = ''
      settingsStore.set('harness', next)
    }
  } else if (
    next.activeWorkspaceId !== result.activeWorkspaceId ||
    next.workspacePath !== result.activeWorkspacePath
  ) {
    next.activeWorkspaceId = result.activeWorkspaceId
    next.workspacePath = result.activeWorkspacePath ?? ''
    settingsStore.set('harness', next)
  }
  logger.info(
    `[Workspace] Settings reconciled, active workspace=${result.activeWorkspaceId ?? 'none'}`
  )
}
