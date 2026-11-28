import { ${vars.pascal}ZhCN } from './zh-CN'
import { ${vars.pascal}EnUS } from './en-US'

/**
 * Locale registry for ${vars.title}: injected into i18next during renderer install via
 * `ctx.use('i18n').addResources('translation', ${vars.pascal}Locales)`.
 *
 * These keys disappear when the plugin is deactivated — do not put them into the host core's locale files.
 */
export const ${vars.pascal}Locales = {
  'zh-CN': ${vars.pascal}ZhCN,
  'en-US': ${vars.pascal}EnUS
}

export default ${vars.pascal}Locales
