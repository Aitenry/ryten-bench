/**
 * Plugin host root key constants.
 *
 * Root keys: capabilities the host skeleton always provides; plugins can only inject them, never
 * provide them — this guarantees a view can never override the host (consumers may only declare
 * dependencies against the shared context).
 */
export const HOST_KEYS = [
  'route',
  'menu',
  'settingsSection',
  'appProvider',
  'globalComponent',
  'bottomBar',
  'api',
  'i18n',
  'events',
  'storage'
] as const

export type HostKey = (typeof HOST_KEYS)[number]

/** Host vendored instances external plugins can obtain via ctx.require(name) (avoids duplicate React instances) */
export const VENDOR_MODULES = ['react', 'antd', '@remixicon/react'] as const
