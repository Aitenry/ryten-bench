import React, { useEffect, useState } from 'react'
import App from './App'
import StartupSplash from './components/system/StartupSplash'
import { useWindowTitle } from './window-title'
import type { Window } from '../resource/types/window'

/**
 * 把当前窗口标题同步给主进程（原生标题栏显示 `内容 - RytenBench`）。
 *
 * 标题内容由各处通过 `setWindowTitleSource` 声明（插件名 / 页面名 / 对话模式等），
 * 这里只做订阅 + IPC。
 */
const WindowTitleSync: React.FC = () => {
  const title = useWindowTitle()
  useEffect(() => {
    try {
      ;(window as unknown as Window).api.window.setTitle(title)
    } catch {
      // 平台不支持时忽略
    }
  }, [title])
  return null
}

/**
 * 根组件：主界面 + 启动页。
 *
 * 主界面从第一帧就挂载（初始化数据在后台加载），启动页盖在最上面；
 * 初始化任务全部完成且主界面首帧就绪后，启动页淡出并卸载（见 StartupSplash）。
 */
const Root: React.FC = () => {
  const [startupDone, setStartupDone] = useState(false)
  return (
    <>
      <WindowTitleSync />
      <App />
      {!startupDone && <StartupSplash onDone={() => setStartupDone(true)} />}
    </>
  )
}

export default Root
