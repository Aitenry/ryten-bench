import * as path from 'path'
import { settingsStore } from '../context'
import { emitAppEvent } from '../plugins/app-events'
import { APP_EVENT_WORKSPACE_CHANGED } from '../plugins/app-hooks'
import type { HarnessSettings } from '../types/settings'

/**
 * 删除插件草稿后的**机器级设置复位**（活动工作区 / 插件模式记住的内容）。
 *
 * 为什么单独成文件：`workshop/workspace.ts` 只依赖数据库与路径，离线测试可以直接
 * 用它验证「插件工作区行」；这一层需要 electron 的设置存储与事件总线，只有主进程的
 * IPC / AI 工具会调，不该让纯逻辑模块跟着 import electron-store。
 */

/**
 * 草稿源码目录被删除后，如果它正是**当前活动工作区**，把活动工作区复位。
 *
 * 为什么必须做：插件工作区行与会话要保留（删源码不等于删对话），但 `harness.workspacePath`
 * 还指着已删除的目录时，AI 的文件工具、资源管理器、文件监听都会对着不存在的路径报 ENOENT，
 * 用户看到的是「删了插件后对话页一堆报错 / 新建会话没反应」。
 *
 * 只清 `workspacePath` / `activeWorkspaceId`（与「删掉最后一个用户工作区」同一套复位），
 * 工作区行与其下会话原样保留；重建同名草稿后它们会重新可用。
 *
 * @returns 是否真的复位了
 */
export function clearActiveWorkspaceIfRemoved(dir: string): boolean {
  try {
    const target = path.resolve(dir)
    const harness = settingsStore.get('harness') as HarnessSettings | undefined
    const active = typeof harness?.workspacePath === 'string' ? harness.workspacePath.trim() : ''
    if (!active) return false
    const activePath = path.resolve(active)
    if (activePath !== target && !activePath.startsWith(target + path.sep)) return false
    settingsStore.set('harness', {
      ...(harness ?? ({} as HarnessSettings)),
      workspacePath: '',
      activeWorkspaceId: undefined
    })
    emitAppEvent(APP_EVENT_WORKSPACE_CHANGED, {})
    return true
  } catch {
    return false
  }
}

/**
 * 草稿删除后，清掉「插件模式上次看的那条内容」里对它的引用（无论它是不是当前活动工作区）。
 *
 * 不做的话：用户在工作模式删掉某插件源码，之后再切到插件模式，侧栏仍按记忆里的
 * `pluginId` 去打开一个已不存在的插件（一条错误提示），而不是回落到第一份可用插件。
 */
export function clearRememberedPluginContent(pluginId: string): void {
  try {
    const harness = settingsStore.get('harness') as HarnessSettings | undefined
    if (!harness?.pluginContent || harness.pluginContent.pluginId !== pluginId) return
    settingsStore.set('harness', { ...harness, pluginContent: null })
  } catch {
    // 设置读写失败不影响删除本身
  }
}
