/**
 * 宿主**首帧**能解析的菜单图标名（三端共用的唯一名单）。
 *
 * 为什么需要一份共享名单：`plugin.json` 的 `menu.icon` 是字符串，宿主要靠
 * `renderer/src/plugin-host/declared-icons.tsx` 把它换成组件——名单外的名字一律回退成
 * 通用图标（不报错，等插件真实注册后才覆盖）。工坊生成模板时若自己抄一份名单，
 * 宿主机加图标/改名就会悄悄不同步；放这里两边引用同一份。
 *
 * 约束：名单里的每个名字都必须是宿主装的 `@remixicon/react` 里**真实存在的导出**
 * （写错 = 运行期 undefined → JSX 抛「Element type is invalid」白屏）。
 * `test/verify-plugin-workshop.mjs` 会核对名单与真实导出。
 */
export const DECLARED_MENU_ICON_NAMES = [
  'RiPlugLine',
  'RiDashboardLine',
  'RiCalendar2Line',
  'RiDiscLine',
  'RiChatAiLine'
] as const

export type DeclaredMenuIconName = (typeof DECLARED_MENU_ICON_NAMES)[number]

/**
 * 给一份草稿挑一枚**稳定**的首帧图标。
 *
 * 为什么按 id 散列而不是固定第一枚：以前所有生成的插件都用 `RiDashboardLine`
 * （笔记的图标），侧栏里几个草稿长得一模一样，用户分不出谁是谁。散列保证同一个 id
 * 每次生成得到同一枚，又能在多份草稿之间分散开。
 */
export function pickDeclaredMenuIcon(id: string): DeclaredMenuIconName {
  const text = typeof id === 'string' ? id : ''
  if (text === '') return 'RiPlugLine'
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  }
  return DECLARED_MENU_ICON_NAMES[hash % DECLARED_MENU_ICON_NAMES.length]
}
