import { app } from 'electron'
import logger from 'electron-log'
import { activeHarnessStreams, streamAbortControllers } from './context'
import { getDatabaseRef } from './database/instance'
import { listContributions } from './plugins/contributions'
import { APP_BEFORE_QUIT, type AppHook } from './plugins/app-hooks'
import { closeHarnessResources, stopHarness } from './system/harness'
import { stopNotes } from './system/notes'

let isQuitting = false
/** 资源清理是否已完成（完成后放行最终退出） */
let cleanupDone = false

/** 应用是否正在退出（托盘「关闭窗口→隐藏」拦截用：真正退出时放行） */
export function isQuittingNow(): boolean {
  return isQuitting
}

/** 标记应用正在退出（系统关机等场景下提前放行关闭拦截） */
export function markQuitting(): void {
  isQuitting = true
}

/** 退出前清理：系统功能（AI 助手 / 资料库）+ 第三方插件贡献的钩子（`app.before-quit`） */
async function runBeforeQuitHooks(): Promise<void> {
  try {
    closeHarnessResources()
  } catch (err) {
    logger.warn('[Lifecycle] Failed to release AI assistant resources:', err)
  }
  for (const hook of listContributions<AppHook>(APP_BEFORE_QUIT)) {
    try {
      await hook.run()
    } catch (err) {
      logger.warn(`[Lifecycle] Before-quit hook failed (${hook.label}):`, err)
    }
  }
  // 落盘/关闭数据库之后再摘通道与订阅，避免退出过程中还有处理器在跑
  try {
    stopNotes()
    stopHarness()
  } catch (err) {
    logger.warn('[Lifecycle] Failed to tear down system features:', err)
  }
}

/** 注册应用生命周期钩子：退出前保存流式数据 / 关闭数据库与插件资源 / 全窗口关闭退出 */
export function registerLifecycleHooks(): void {
  app.on('before-quit', (event) => {
    // 清理完成后放行最终退出
    if (cleanupDone) return
    // 清理进行中：拦截重入 quit（修复：此前直接放行，正在保存的流被掐断、
    // 数据库/记忆清理未完成进程即退出）
    if (isQuitting) {
      event.preventDefault()
      return
    }
    isQuitting = true
    // 统一拦截本次退出：清理完成后再真正退出（修复：此前无活跃流时直接 return，
    // database.close()/closeAllMnemon() 从未执行）
    event.preventDefault()

    void (async () => {
      try {
        // 有活跃流时先中止并等待落库（最长 5s）
        if (activeHarnessStreams.size > 0) {
          for (const controller of streamAbortControllers.values()) {
            controller.abort()
          }
          await Promise.race([
            Promise.allSettled([...activeHarnessStreams]),
            new Promise((resolve) => setTimeout(resolve, 5000))
          ])
        }
      } catch (error) {
        logger.error('Error during stream abort:', error)
      } finally {
        try {
          const database = getDatabaseRef()
          if (database) {
            await database.close()
          }
        } finally {
          try {
            // 退出前释放插件资源（贡献点 `app.before-quit`，例如 harness 关闭 Mnemon 单例）：
            // 逐个 await + catch——单个插件清理失败不能拦住进程退出。
            // 贡献随插件停用摘除，因此停用的插件不会被调用（core 不认识任何插件模块）。
            await runBeforeQuitHooks()
          } catch (err) {
            logger.warn('[Lifecycle] Failed to run before-quit hooks:', err)
          }
          cleanupDone = true
          app.quit()
        }
      }
    })()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
