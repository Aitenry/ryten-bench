import { useEffect, useState } from 'react'
import { harnessApi } from '../api/harness'

/**
 * 全局 PTY 终端运行数（侧栏「开始」角标 + 开始页终端卡片）。
 *
 * 主进程是唯一真源：挂载时拉一次，之后订阅会话变化事件，另加 5s 兜底轮询
 * （事件在窗口重建/插件重载后可能漏一次）。
 */
export function usePtyTerminalStats(): number {
  const [alive, setAlive] = useState(0)
  useEffect(() => {
    let disposed = false
    const refresh = (): void => {
      void harnessApi.ptyTerminal
        .stats()
        .then((result) => {
          if (!disposed && result.ok) setAlive(result.alive)
        })
        .catch(() => {
          // 助手插件停用时通道不存在：保持 0，不报错
        })
    }
    refresh()
    const unsubscribe = harnessApi.ptyTerminal.onSessionsChanged(refresh)
    const timer = window.setInterval(refresh, 5000)
    return () => {
      disposed = true
      unsubscribe()
      window.clearInterval(timer)
    }
  }, [])
  return alive
}
