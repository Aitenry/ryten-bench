import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntApp } from 'antd'
import Root from './Root'
import { LanguageProvider } from './contexts/LanguageContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { installHostUi } from './plugin-host/host-ui'

/**
 * 宿主 UI 表（插件渲染包的 `@host/**` 与 react/antd 等 vendor 都从这里取实例，
 * 见 src/plugins/PACKAGING.md）。必须**在任何插件渲染模块被 fetch 之前**挂上：
 * 插件是异步加载的（PluginStateBridge 的 effect），而桥模块的生成依赖这里上报的
 * 「键 → 导出名」，所以放在模块求值期（早于 React 渲染）最稳。
 */
installHostUi()

/**
 * 未捕获错误 / 未处理的 Promise 拒绝：把**栈**打进 console。
 *
 * 为什么需要（2026-09-19）：Electron 的 `console-message` 只带首行消息，渲染进程此前也没有任何
 * 全局处理器，日志里于是只剩一句 `Uncaught TypeError: Cannot read properties of undefined
 * (reading 'startTime')`——没有文件、没有行号、没有栈，静态排查（把 renderer 源码、antd/rc、
 * react-dom 全扫过）又排除了所有已知读取点，只能干瞪眼。这条处理器让下一次出现自带上文。
 *
 * 只上报、不 `preventDefault`：默认行为（DevTools 里的红字、错误边界等）完全不变。
 * 同一条错误在一个会话里最多上报 5 次，避免异常循环把日志刷爆。
 */
const reportedUncaught = new Set<string>()
const UNCAUGHT_REPORT_LIMIT = 5

function reportUncaught(kind: string, error: unknown, fallback: string): void {
  const err = error as { message?: string; stack?: string } | undefined
  const key = `${kind}:${err?.message ?? fallback}`
  if (reportedUncaught.has(key)) return
  if (reportedUncaught.size >= UNCAUGHT_REPORT_LIMIT) return
  reportedUncaught.add(key)
  console.error(`[Uncaught:${kind}] ${err?.message ?? fallback}\n${err?.stack ?? '(no stack)'}`)
}

window.addEventListener('error', (event) => {
  reportUncaught('error', (event as ErrorEvent).error, (event as ErrorEvent).message ?? '')
})
window.addEventListener('unhandledrejection', (event) => {
  reportUncaught('rejection', (event as PromiseRejectionEvent).reason, '')
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 语言在最外层：主题（antd locale）与 dayjs 都跟随它 */}
    <LanguageProvider>
      <ThemeProvider>
        <AntApp>
          <Root />
        </AntApp>
      </ThemeProvider>
    </LanguageProvider>
  </StrictMode>
)
