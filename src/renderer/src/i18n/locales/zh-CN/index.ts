import { zhCNCommon } from './common'
import { zhCNSettings } from './settings'
import { zhCNModelSettings } from './modelSettings'
import { zhCNSystemInfo } from './systemInfo'
import { zhCNShell } from './shell'
import { zhCNMarkdown } from './markdown'
import { harnessZhCN } from '@features/harness/locales/zh-CN'
import { notesZhCN } from '@features/notes/locales/zh-CN'

/**
 * 简体中文是**源语言**：词条结构与文案以这里为准。
 * 其它语言文件必须以 `typeof zhCN` 声明，键多一个少一个都会编译报错。
 *
 * harness / notes 已移出插件，词条改为随系统功能静态打包（不再由插件 install 注册）。
 */
export const zhCN = {
  common: zhCNCommon,
  settings: zhCNSettings,
  modelSettings: zhCNModelSettings,
  systemInfo: zhCNSystemInfo,
  shell: zhCNShell,
  markdown: zhCNMarkdown,
  ...harnessZhCN,
  ...notesZhCN
}
