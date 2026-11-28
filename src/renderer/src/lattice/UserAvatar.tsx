import React, { useState } from 'react'
import { Avatar, theme } from 'antd'
import { initialOf, normalizeAvatarSrc } from './format'

/**
 * Lattice account avatar (antd Avatar).
 *
 * Data source: `LatticeStatus.user.avatar` (the platform's `users.avatar`, which may be an
 * `https://` URL or an inline `data:image/...;base64` image). Three states:
 * - valid image address → show the image;
 * - no avatar (null / missing field from an older main process / malformed address) → circular
 *   username initial (keeps the original look of the account area);
 * - image failed to load (onError, e.g. https 404 / certificate problem / corrupt data URL) →
 *   fall back to the initial rather than showing a broken image.
 *
 * The size comes from the caller (26px in the account area, 56px in the account info modal);
 * the image is rendered entirely by img, without relying on antd's automatic fallback icon, so
 * "load failure → initial" stays assertable in E2E tests.
 */
export interface LatticeUserAvatarProps {
  /** Platform avatar: https URL / data:image base64; null, empty string or absent = no avatar */
  avatar?: string | null
  /** Username (callers pass display_name when available); determines the initial fallback */
  name?: string | null
  /** Edge length (px); 26 is suggested for the account area, 56 for the modal */
  size?: number
  className?: string
  style?: React.CSSProperties
}

export const LatticeUserAvatar: React.FC<LatticeUserAvatarProps> = ({
  avatar,
  name,
  size = 26,
  className,
  style
}) => {
  const { token } = theme.useToken()
  const src = normalizeAvatarSrc(avatar)
  /**
   * Track which address failed to load: fall back to the initial only while that address is
   * still the current one. Do not reset the state in an effect when src changes — the image
   * error event may fire before the passive effect, which would clear the failure that was just
   * recorded (the broken image would then never fall back). Switching to a new address retries
   * naturally via `failedSrc !== src`, so no extra reset is needed.
   */
  const [failedSrc, setFailedSrc] = useState<string | null>(null)

  const showImage = src !== null && failedSrc !== src
  const background = showImage
    ? token.colorFillTertiary
    : `linear-gradient(135deg, ${token.colorPrimary}, ${token.colorPrimaryActive})`

  return (
    <Avatar
      size={size}
      className={['shell-avatar', 'shell-avatar-user', className].filter(Boolean).join(' ')}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        background,
        color: '#fff',
        fontWeight: 600,
        ...style
      }}
      src={
        showImage ? (
          <img
            src={src}
            alt=""
            draggable={false}
            onError={() => setFailedSrc(src)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : undefined
      }
    >
      {initialOf(name)}
    </Avatar>
  )
}
