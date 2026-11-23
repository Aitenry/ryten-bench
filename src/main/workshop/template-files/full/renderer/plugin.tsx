import { ${vars.menuIcon}, RiSettings4Line } from '@remixicon/react'
import { ${vars.pascal}Locales } from '../locales'
import type { PluginRenderContext } from './context'
import Page from './Page'
import Settings from './Settings'

/**
 * ${vars.title} 的渲染层入口（**只做装配**）。
 *
 * 挂载点：route（页面）、menu（侧栏）、settingsSection（设置页）、i18n（词条）。
 * 都是可逆装配——插件停用时宿主自动摘除，不需要写反注册。
 *
 * 两个坑（见 WORKSHOP.md 第 6 节）：
 * - 菜单的 `icon` 名字必须在 `@remixicon/react` 里真实存在，且与 `plugin.json` 的
 *   `menu.icon` 是同一枚（清单图标只决定首帧，名单见宿主 declared-icons.tsx）；
 * - 词条第一个参数是**命名空间**（'translation'），写成语言名会让界面显示原始键名。
 */
const plugin = {
  install(ctx: PluginRenderContext): void {
    ctx.use('route').register({
      path: '/${vars.id}',
      load: () => import('./Page')
    })
    ctx.use('menu').register({
      // 菜单键必须与路由路径一致：点击菜单就是 navigate('/' + key)
      key: '${vars.id}',
      labelKey: '${vars.id}.menu.title',
      icon: <${vars.menuIcon} size={16} />,
      order: 60
    })
    ctx.use('settingsSection').register({
      tabKey: '${vars.id}',
      labelKey: '${vars.id}.settings.title',
      icon: <RiSettings4Line size={16} />,
      group: 'assistant',
      order: 90,
      Component: Settings
    })
    // 词条随插件注册：第一个参数是命名空间（宿主界面一律 'translation'），第二个是「语言 → 词条树」
    ctx.use('i18n').addResources('translation', ${vars.pascal}Locales)
  }
}

export default plugin
