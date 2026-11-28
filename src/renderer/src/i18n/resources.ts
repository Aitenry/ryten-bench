import { zhCN } from './locales/zh-CN'
import { enUS } from './locales/en-US'

/** Single namespace; key paths look like `settings.general.language.rowTitle` */
export const DEFAULT_NS = 'translation'

export const resources = {
  'zh-CN': { [DEFAULT_NS]: zhCN },
  'en-US': { [DEFAULT_NS]: enUS }
}
