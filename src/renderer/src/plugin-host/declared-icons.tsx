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
 * Menu icon resolution for **declaration entries** (`PluginListEntry.menu.icon` is a remixicon
 * name string).
 *
 * Why this table is needed: real registrations pass a component from the plugin itself
 * (`icon: <RiDiscLine size={16} />`, see each plugin's `renderer/plugin.tsx`); only declaration
 * entries pre-registered by the host from manifest metadata receive a **name**, which must be
 * mapped to a node explicitly here. When the name does not match (the manifest names some other
 * icon, or a third-party plugin's plugin.json has no icon), fall back to the generic icon and
 * never throw — a declaration entry is only a first-frame placeholder that the plugin's real
 * registration replaces a few hundred milliseconds later.
 *
 * The **single source of truth** for the list is `@shared/plugin/menu-icons` (the workshop reads
 * the same list when generating templates); the Record here uses `DeclaredMenuIconName` as its
 * key type, so a missing mapping fails to compile.
 */
const DECLARED_MENU_ICON_COMPONENTS: Record<DeclaredMenuIconName, RemixiconComponentType> = {
  RiPlugLine,
  RiDashboardLine,
  RiCalendar2Line,
  RiDiscLine,
  RiChatAiLine
}

/**
 * Brand icons that really appear in manifests but are **not part of the workshop icon picker**
 * (drawn in the plugin panel / detail page).
 *
 * Why not merge them into `@shared/plugin/menu-icons`: that list is also the candidate pool for new
 * workshop drafts, so adding RiTiktokFill / RiWalletLine would let new drafts randomly pick another
 * vendor's logo; meanwhile stand-alone plugins in the plugin repository declare their sidebar icons
 * with exactly these two names, and the card must draw them verbatim.
 *
 * Keys are `string`: plugin manifests come from disk/remote, so names are not bound by the list;
 * unresolvable names are still handled by the caller.
 */
const BRAND_ICON_COMPONENTS: Record<string, RemixiconComponentType> = {
  RiTiktokFill,
  RiWalletLine
}

/**
 * Name → icon node (adjustable size) for brand glyphs (card/detail page): look up the first-frame
 * menu whitelist first, then the brand supplement table; return `null` when neither has it, so the
 * caller decides the fallback (the panel uses a puzzle piece).
 */
export function declaredIconGlyph(name: string | undefined, size = 16): ReactNode {
  if (!name) return null
  const Icon =
    DECLARED_MENU_ICON_COMPONENTS[name as DeclaredMenuIconName] ?? BRAND_ICON_COMPONENTS[name]
  return Icon ? <Icon size={size} /> : null
}

/** Resolve a declaration entry's menu icon by name (unknown names fall back to the generic icon) */
export function declaredMenuIcon(name: string | undefined, size = 16): ReactNode {
  if (!name) return <RiPlugLine size={size} />
  const Icon = DECLARED_MENU_ICON_COMPONENTS[name as DeclaredMenuIconName]
  return Icon ? <Icon size={size} /> : <RiPlugLine size={size} />
}
