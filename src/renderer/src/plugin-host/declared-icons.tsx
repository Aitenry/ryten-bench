import { type ReactNode } from 'react'
import {
  RiCalendar2Line,
  RiChatAiLine,
  RiDashboardLine,
  RiDiscLine,
  RiPlugLine,
  RiTiktokFill,
  RiWalletLine
} from '@remixicon/react'
import type { RemixiconComponentType } from '@remixicon/react'
import type { DeclaredMenuIconName } from '@shared/plugin/menu-icons'

/**
 * **声明项**的菜单图标解析（`PluginListEntry.menu.icon` 是 remixicon 名字符串）。
 *
 * 为什么需要这张表：真实注册由插件自己传组件（`icon: <RiDiscLine size={16} />`，
 * 见各插件 `renderer/plugin.tsx`），只有「宿主按清单元数据预注册」的声明项拿到的
 * 是**名字**，必须在这里显式映射成节点。名字对不上（清单里写了别的图标、或第三方
 * 插件的 plugin.json 没写 icon）一律回退到通用图标，绝不抛错——声明项只是首帧的
 * 占位，几百毫秒后会被插件的真实注册覆盖。
 *
 * 名单的**唯一真源**是 `@shared/plugin/menu-icons`（工坊生成模板时引用同一份）；
 * 这里的 Record 用 `DeclaredMenuIconName` 做键类型，漏映射会直接编译失败。
 */
const DECLARED_MENU_ICON_COMPONENTS: Record<DeclaredMenuIconName, RemixiconComponentType> = {
  RiPlugLine,
  RiDashboardLine,
  RiCalendar2Line,
  RiDiscLine,
  RiChatAiLine
}

/**
 * 清单里真实出现、但**不参与工坊挑图标**的品牌图标（插件面板/详情页显示用）。
 *
 * 为什么不并进 `@shared/plugin/menu-icons`：那份名单同时是工坊新建草稿的候选池，
 * 把 RiTiktokFill / RiWalletLine 塞进去会让新草稿随机拿到别家 logo；而插件仓库里的
 * 独立插件恰恰是按这两枚名字声明自己的侧栏图标，卡片要照原样画出来。
 *
 * 键用 `string`：插件清单来自磁盘/远端，名字不受名单约束；解析不到仍由调用方兜底。
 */
const BRAND_ICON_COMPONENTS: Record<string, RemixiconComponentType> = {
  RiTiktokFill,
  RiWalletLine
}

/**
 * 名字 → 图标节点（尺寸可调），供品牌图（卡片/详情页）使用：先查首帧菜单白名单，
 * 再查品牌补充表；都没有返回 `null`，由调用方决定回退成什么（面板用拼图）。
 */
export function declaredIconGlyph(name: string | undefined, size = 16): ReactNode {
  if (!name) return null
  const Icon =
    DECLARED_MENU_ICON_COMPONENTS[name as DeclaredMenuIconName] ?? BRAND_ICON_COMPONENTS[name]
  return Icon ? <Icon size={size} /> : null
}

/** 按名字解析声明项的菜单图标（未知名字回退通用图标） */
export function declaredMenuIcon(name: string | undefined, size = 16): ReactNode {
  if (!name) return <RiPlugLine size={size} />
  const Icon = DECLARED_MENU_ICON_COMPONENTS[name as DeclaredMenuIconName]
  return Icon ? <Icon size={size} /> : <RiPlugLine size={size} />
}
