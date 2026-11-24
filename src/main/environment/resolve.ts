import { join } from 'path'

/**
 * 「运行环境 → 应用名 / userData 目录」的**唯一**规则。
 *
 * 为什么需要这层隔离（2026-11-24 用户真机反馈）：
 * 打包产物里的 package.json 由 electron-builder 生成，**没有** productName；开发态的
 * package.json 也没有。于是两端 `app.getName()` 都是 `ryten-bench`，
 * `app.getPath('userData')` 也指向同一个 `%APPDATA%\ryten-bench`——
 * 设置（settings.json）、PGlite 数据库（RytenBenchDB）、插件包（plugins/）、账号空间
 * （profiles/）、密钥库、会话文件、日志全部共用。结果就是「`pnpm dev` 启动测试」读写的
 * 就是打包版的数据：开发时改着改着，真实数据被改了；反过来装个安装包，看到的也是开发库。
 *
 * 目录口径（用户确认）：
 * - production（打包产物，`app.isPackaged === true`）：`<appData>/ryten-bench`
 *   —— 与历史发布版完全一致，老用户升级不换目录、不丢数据；
 * - development（`pnpm dev` / `pnpm start` / 直接 `electron .`）：`<appData>/ryten-bench-dev`
 *   —— 开发、调试、工装随便造，碰不到发布版数据。
 *
 * `<appData>` 由调用方从 `app.getPath('appData')` 取（Windows `%APPDATA%`、
 * macOS `~/Library/Application Support`、Linux `$XDG_CONFIG_HOME` 或 `~/.config`）。
 * 这里刻意不读 `process.platform`：拼路径交给 path.join，纯函数才能被单测直接覆盖。
 */
export type AppEnvironmentName = 'development' | 'production'

/** 打包产物的应用名（系统菜单 / 关于面板 / macOS 日志目录会显示它） */
export const PRODUCTION_APP_NAME = 'RytenBench'
/** 开发态的应用名：和发布版区分开，避免两套窗口/日志在系统里同名 */
export const DEVELOPMENT_APP_NAME = 'RytenBench Dev'
/** 打包产物的 userData 目录名：历史路径，不能改（发布版用户的数据在这里） */
export const PRODUCTION_DATA_DIR = 'ryten-bench'
/** 开发态的 userData 目录名：独立的一套数据 */
export const DEVELOPMENT_DATA_DIR = 'ryten-bench-dev'

export interface EnvironmentInputs {
  /** `app.isPackaged`：打包产物为 true，`electron .` / electron-vite dev 为 false */
  packaged: boolean
  /** `app.getPath('appData')`：跨平台的「每用户应用数据根」 */
  appDataDir: string
}

export interface AppEnvironment {
  name: AppEnvironmentName
  /** 写进 `app.setName()` 的显示名 */
  appName: string
  /** userData 目录名（`<appDataDir>/<dataDirName>`） */
  dataDirName: string
  /** 常规 userData 目录；被 `--user-data-dir` 覆盖时进程实际用的不是它 */
  userDataDir: string
}

export function resolveEnvironment(inputs: EnvironmentInputs): AppEnvironment {
  const dataDirName = inputs.packaged ? PRODUCTION_DATA_DIR : DEVELOPMENT_DATA_DIR
  return {
    name: inputs.packaged ? 'production' : 'development',
    appName: inputs.packaged ? PRODUCTION_APP_NAME : DEVELOPMENT_APP_NAME,
    dataDirName,
    userDataDir: join(inputs.appDataDir, dataDirName)
  }
}

/** 只依赖 `hasSwitch`，这样纯函数也能接受 Electron 的 `app.commandLine` 或测试替身 */
export interface CommandLineLike {
  hasSwitch?(name: string): boolean
}

/**
 * 自动化（`test/probe-*.mjs`、CI 冒烟）会用 `--user-data-dir=...` 给自己划一块临时目录。
 *
 * 这类进程不能再被环境默认值盖回去：否则一次工装就会往真实数据目录里写东西
 * （`storage/layout.ts` 也靠这条判断决定「不要把安装目录侧的 data/ 搬来搬去」）。
 * 命令行开关可能写成 `--user-data-dir=...`，也可能拆成两个 argv（`--user-data-dir` + 路径），
 * Electron 自己还会把它解析进 `app.commandLine`，所以三种形态都要认。
 */
export function hasUserDataDirOverride(
  argv: readonly string[],
  commandLine?: CommandLineLike
): boolean {
  if (commandLine?.hasSwitch?.('user-data-dir') === true) return true
  return argv.some((arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='))
}
