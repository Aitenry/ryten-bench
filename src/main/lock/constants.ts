/**
 * Lock-screen constants (shared by the main process and settings validation).
 *
 * The auto-lock durations are a **finite enum**, not arbitrary numbers: the settings page offers
 * only these values and the main process accepts only these, so a hand-edited settings file with
 * something like `autoLockMinutes: 0.0001` cannot lock the UI out.
 */

/** Auto-lock duration (minutes) on first write / when unset */
export const DEFAULT_AUTO_LOCK_MINUTES = 5

/** Auto-lock durations (minutes) offered on the settings page; 0 = disable auto-lock */
export const AUTO_LOCK_MINUTES_OPTIONS = [0, 1, 5, 15, 30] as const

export type AutoLockMinutes = (typeof AUTO_LOCK_MINUTES_OPTIONS)[number]

/** Factory-default unlock code (older versions hard-coded MD5('123456'); new installs start with it too, for easy first-time setup) */
export const DEFAULT_LOCK_CODE = '123456'

/** Whether this is a valid auto-lock duration */
export function isAutoLockMinutes(value: unknown): value is AutoLockMinutes {
  return (
    typeof value === 'number' && (AUTO_LOCK_MINUTES_OPTIONS as readonly number[]).includes(value)
  )
}
