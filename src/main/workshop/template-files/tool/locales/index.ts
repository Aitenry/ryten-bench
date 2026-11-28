import { ${vars.pascal}ZhCN } from './zh-CN'
import { ${vars.pascal}EnUS } from './en-US'

/**
 * ${vars.title} 的词条注册表：渲染层 install 时经
 * `ctx.use('i18n').addResources('translation', ${vars.pascal}Locales)` 注入 i18next。
 */
export const ${vars.pascal}Locales = {
  'zh-CN': ${vars.pascal}ZhCN,
  'en-US': ${vars.pascal}EnUS
}

export default ${vars.pascal}Locales
