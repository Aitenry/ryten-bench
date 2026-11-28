/**
 * Menu icon names the host can resolve on the **first frame** (the single list shared by all three sides).
 *
 * Why a shared list: `menu.icon` in `plugin.json` is a string, and the host uses
 * `renderer/src/plugin-host/declared-icons.tsx` to turn it into a component — names outside
 * the list fall back to a generic icon (no error, replaced once the plugin actually registers).
 * If the workshop template generation kept its own copy of the list, adding or renaming an
 * icon on the host would silently desynchronise; keeping it here means both sides reference
 * the same list.
 *
 * Constraint: every name in the list must be a **real export** of the `@remixicon/react`
 * version the host installs (a typo = runtime undefined → JSX throws "Element type is invalid"
 * and the screen goes blank). `test/verify-plugin-workshop.mjs` checks the list against the real exports.
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
 * Pick a **stable** first-frame icon for a draft.
 *
 * Why hash by id instead of always using the first icon: previously every generated plugin used
 * `RiDashboardLine` (the notes icon), so several drafts looked identical in the sidebar and users
 * could not tell them apart. Hashing guarantees the same id always gets the same icon while
 * spreading different drafts apart.
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
