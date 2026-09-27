/**
 * 沙箱层的日志出口（可注入，默认走 console）。
 *
 * 为什么不让 sandbox/* 直接 import electron-log：沙箱服务必须能在**任何 node 环境**里
 * 独立跑起来——本机工装、Linux/macOS 容器验证、未来的 CLI 都靠它；一旦 import electron-log，
 * 这些场景就会因为解析不到依赖而挂掉（实测：pnpm 的 node_modules 是 Windows 绝对路径符号链接，
 * 挂进 Linux 容器后直接 ERR_MODULE_NOT_FOUND）。
 * 因此这一层只依赖 node 内建；Electron 侧在插件 install 时把真正的 logger 注入进来即可。
 */

export interface SandboxLogger {
  info(message: string): void
  warn(message: string, ...args: unknown[]): void
}

const defaultLogger: SandboxLogger = {
  info: (message) => console.log(message),
  warn: (message, ...args) => console.warn(message, ...args)
}

let current: SandboxLogger = defaultLogger

/** 注入日志实现（Electron 侧在插件 install 时调用一次） */
export function setSandboxLogger(logger: SandboxLogger): void {
  current = logger
}

/** 恢复默认（工装/测试用） */
export function resetSandboxLogger(): void {
  current = defaultLogger
}

/** 沙箱层统一的日志出口 */
export const sandboxLog: SandboxLogger = {
  info: (message) => current.info(message),
  warn: (message, ...args) => current.warn(message, ...args)
}
