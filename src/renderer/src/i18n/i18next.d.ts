import 'i18next'
import type { zhCN } from './locales/zh-CN'
import type { harnessZhCN } from './locales/zh-CN/harness'
import type { notesZhCN } from './locales/zh-CN/notes'

/**
 * Injects resource types into i18next: `t()` key paths are derived from the Chinese source
 * language, so a mistyped key name or an undefined key is a TS compile error.
 *
 * **Built-in** plugin entries (notes / graph / graphSettings, harness / agentSettings /
 * memorySettings / skillsSettings) are registered at runtime by the plugin's install and are not
 * part of the central resources, but their **source-language types** are still what `t()` key
 * checking relies on — so the key spaces of the built-in plugins and the central resources are
 * unioned here (the two do not overlap).
 * Third-party plugins (such as `task-planner` / `music-player`) do not go through here: the host
 * does not know their keys, so they validate their own entries in their own repositories.
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: {
      translation: typeof zhCN & typeof notesZhCN & typeof harnessZhCN
    }
    returnNull: false
  }
}
