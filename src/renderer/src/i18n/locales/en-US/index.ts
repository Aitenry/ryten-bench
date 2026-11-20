import type { zhCN } from '../zh-CN'
import { enUSCommon } from './common'
import { enUSSettings } from './settings'
import { enUSModelSettings } from './modelSettings'
import { enUSSystemInfo } from './systemInfo'
import { enUSShell } from './shell'
import { enUSMarkdown } from './markdown'
import { harnessEnUS } from './harness'
import { notesEnUS } from './notes'

/**
 * `typeof zhCN` 约束：与中文源语言逐键对齐，缺译/多键在编译期即报错。
 * harness / notes 已移出插件，词条随系统功能静态打包。
 */
export const enUS: typeof zhCN = {
  common: enUSCommon,
  settings: enUSSettings,
  modelSettings: enUSModelSettings,
  systemInfo: enUSSystemInfo,
  shell: enUSShell,
  markdown: enUSMarkdown,
  ...harnessEnUS,
  ...notesEnUS
}
