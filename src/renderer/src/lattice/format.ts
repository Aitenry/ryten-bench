/**
 * 插件中心展示用的小格式化工具（纯函数，不涉及 i18n；文案由调用方用 t() 拼接）。
 */

/** 时间戳 → `HH:mm`（今天）或 `MM-DD HH:mm`；没有时间戳时返回 null，由调用方决定「尚未同步」文案 */
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

/** 大数字缩写：1200 → 1.2k，12000 → 12k；非法值按 0 处理 */
export function formatCount(value?: number): string {
  if (!value || !Number.isFinite(value) || value <= 0) return '0'
  if (value < 1000) return String(Math.round(value))
  const thousands = value / 1000
  return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`
}

/** 字节数格式化：1.4 MB / 320 KB / 12 B；没有值时返回 '—' */
export function formatBytes(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}

/** 账号首字母（display_name 优先；中文取首字，拉丁字母转大写） */
export function initialOf(name?: string | null): string {
  const value = (name ?? '').trim()
  if (!value) return '?'
  const first = value.charAt(0)
  return /[a-z]/.test(first) ? first.toUpperCase() : first
}

/**
 * 头像地址只接受平台允许的两种形态（其余一律按「无头像」回退首字母，绝不显示破图）：
 * - `https://` / `http://` 远程图片（平台头像常见形态；本地 dev 节点偶发 http）；
 * - `data:image/(png|jpeg|webp|gif);base64,...`（平台允许 ≤256KiB 的内联头像）。
 *
 * 故意不放行 `javascript:` / 相对路径 / svg data URL：平台契约本来就不接受，
 * 客户端再挡一层，避免把任意字符串塞进 `<img src>`。
 */
export function normalizeAvatarSrc(avatar?: string | null): string | null {
  const value = (avatar ?? '').trim()
  if (value === '') return null
  if (/^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(value)) return value
  if (/^https?:\/\/\S+$/i.test(value)) return value
  return null
}
