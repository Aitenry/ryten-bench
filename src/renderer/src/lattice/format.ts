/**
 * Small formatting helpers for plugin center display (pure functions, no i18n; callers compose
 * copy with t()).
 */

/** Timestamp → `HH:mm` (today) or `MM-DD HH:mm`; returns null when absent so the caller picks the "not synced yet" copy */
export function formatSyncTime(at?: number): string | null {
  if (!at || !Number.isFinite(at)) return null
  const date = new Date(at)
  const now = new Date()
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return time
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${time}`
}

/** Compact large numbers: 1200 → 1.2k, 12000 → 12k; invalid values are treated as 0 */
export function formatCount(value?: number): string {
  if (!value || !Number.isFinite(value) || value <= 0) return '0'
  if (value < 1000) return String(Math.round(value))
  const thousands = value / 1000
  return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`
}

/** Format a byte count: 1.4 MB / 320 KB / 12 B; returns '—' when absent */
export function formatBytes(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}

/** Account initial (prefers display_name; first character for CJK, uppercased for Latin letters) */
export function initialOf(name?: string | null): string {
  const value = (name ?? '').trim()
  if (!value) return '?'
  const first = value.charAt(0)
  return /[a-z]/.test(first) ? first.toUpperCase() : first
}

/**
 * Avatar URLs accept only the two forms the platform allows (anything else falls back to the
 * initial, never a broken image):
 * - `https://` / `http://` remote images (the usual platform avatar form; local dev nodes
 *   occasionally use http);
 * - `data:image/(png|jpeg|webp|gif);base64,...` (the platform allows inline avatars up to 256KiB).
 *
 * Deliberately rejects `javascript:` / relative paths / svg data URLs: the platform never accepts
 * them, and the client filters once more to keep arbitrary strings out of `<img src>`.
 */
export function normalizeAvatarSrc(avatar?: string | null): string | null {
  const value = (avatar ?? '').trim()
  if (value === '') return null
  if (/^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(value)) return value
  if (/^https?:\/\/\S+$/i.test(value)) return value
  return null
}
