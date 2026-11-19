import { harnessZhCN } from './zh-CN'
import { harnessEnUS } from './en-US'

/**
 * harness 插件词条注册表（renderer install 时经
 * `ctx.use('i18n').addResources('translation', harnessLocales)` 注入 i18next）。
 *
 * 顶层键 `harness` / `agentSettings` / `memorySettings` / `skillsSettings` 与原中央词条一致，
 * 插件停用时这些键随之消失——不再由中央词条文件无条件打包进首屏。
 */
export const harnessLocales = {
  'zh-CN': harnessZhCN,
  'en-US': harnessEnUS
}

export default harnessLocales
