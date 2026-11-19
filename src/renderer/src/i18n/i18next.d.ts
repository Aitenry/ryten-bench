import 'i18next'
import type { zhCN } from './locales/zh-CN'
import type { harnessZhCN } from '@features/harness/locales/zh-CN'
import type { notesZhCN } from '@features/notes/locales/zh-CN'

/**
 * 为 i18next 注入资源类型：`t()` 的键路径由中文源语言推导，
 * 拼错键名或使用未定义的键会直接是 TS 编译错误。
 *
 * **内置**插件词条（notes / graph / graphSettings、harness / agentSettings / memorySettings /
 * skillsSettings）在运行期由插件 install 时注册，不在中央资源里，但它们的**源语言类型**仍是
 * `t()` 键校验的依据——所以这里按内置插件与中央资源的键空间求并集（两者键不重叠）。
 * 第三方插件（如 `task-planner` / `music-player`）不走这里：宿主不认识它们的键，
 * 它们在自己的仓库里校验自己的词条。
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
