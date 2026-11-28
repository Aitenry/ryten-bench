/**
 * **Generic** notification type for the notification center (core service, consumable by plugins).
 *
 * Ownership boundary: the "carrier" of notifications belongs to the shell (the bell list lives in
 * `NotificationList`), while the "concrete shape" of a notification belongs to the plugin that
 * produces it (for example, graph build progress belongs to notes). Core therefore declares only
 * the minimal generic contract: locatable, classifiable, clickable, and able to show a title and
 * description.
 *
 * Plugins extend it in their own modules (notes defines `BuildProgressNotification` in
 * `providers/build-progress.ts`), and the extension fields exist on this type as optional fields;
 * the list reads them by field name — so core never needs to import any plugin's notification type.
 */
export interface NotificationItem {
  id: string
  /** Notification category (currently only 'build_progress'; future plugin categories just widen
   * this to a string) */
  type: string
  title: string
  description: string
  timestamp: number
  readonly?: boolean
  read: boolean
  onClick?: () => void

  /** Plugin extension fields (e.g. wikiId / overallProgress / completed for build progress), read
   * by core as needed */
  [key: string]: unknown
}

/** Base notification fields (plugins `extends` this when extending their own notification type) */
export type BaseNotification = NotificationItem
