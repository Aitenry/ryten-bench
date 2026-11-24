import { app } from 'electron'
import * as fs from 'fs'
import { hasUserDataDirOverride, resolveEnvironment, type AppEnvironment } from './resolve'

export * from './resolve'

/**
 * 进程启动早期的环境装配：确定「开发 / 打包」两套数据目录，并把它应用到 Electron。
 *
 * **时机是硬约束**，不是偏好：`context.ts` 的 electron-store 和 `database/loading.ts`
 * 的数据库目录都在**模块求值阶段**解析 `app.getPath('userData')`。等到 `app.whenReady()`
 * 再设置就晚了——它们早把路径定死在旧目录里。因此本模块被 import 时立即执行
 * `applyEnvironment()`，并要求 `src/main/index.ts` 把它放在**第一条 import**（见那里的注释）。
 *
 * 覆盖规则：命令行带 `--user-data-dir`（自动化隔离）时只改应用名、不动 userData，
 * 让工装拿到的临时目录原样生效。
 */

let applied: AppEnvironment | null = null

export function applyEnvironment(): AppEnvironment {
  if (applied) return applied

  const environment = resolveEnvironment({
    packaged: app.isPackaged,
    appDataDir: app.getPath('appData')
  })

  // 必须在 ready 之前：app.name 影响系统菜单、关于面板与 macOS 的日志目录。
  // 开发态带 Dev 后缀，桌面/日志里一眼能区分两套环境。
  app.setName(environment.appName)

  const overridden = hasUserDataDirOverride(process.argv, app.commandLine)
  if (!overridden) {
    try {
      // Electron 的 setPath 要求目录已存在，否则直接抛错。
      fs.mkdirSync(environment.userDataDir, { recursive: true })
      app.setPath('userData', environment.userDataDir)
    } catch (error) {
      // 绝不静默退回默认目录：默认目录就是另一套环境的数据，正是本模块要防的事。
      throw new Error(
        `无法准备 ${environment.name} 环境的用户数据目录 ${environment.userDataDir}：` +
          (error instanceof Error ? error.message : String(error))
      )
    }
  }

  applied = environment
  return environment
}

/** 当前进程使用的环境（import 本模块时已应用；这里补一次，幂等） */
export function currentEnvironment(): AppEnvironment {
  return applied ?? applyEnvironment()
}

/** 当前进程真正在用的 userData 根目录（尊重 `--user-data-dir` 覆盖） */
export function currentUserDataDir(): string {
  currentEnvironment()
  return app.getPath('userData')
}

applyEnvironment()
