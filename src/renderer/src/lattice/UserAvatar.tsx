import React, { useState } from 'react'
import { Avatar, theme } from 'antd'
import { initialOf, normalizeAvatarSrc } from './format'

/**
 * Lattice 账号头像（antd Avatar）。
 *
 * 数据来源：`LatticeStatus.user.avatar`（平台 `users.avatar`，可能是 `https://` URL 或
 * `data:image/...;base64` 内联图片）。三种状态：
 * - 有合法图片地址 → 显示图片；
 * - 没有头像（null / 旧主进程缺字段 / 地址形态不合法）→ 用户名首字母圆形（保持原账号区观感）；
 * - 图片加载失败（onError，如 https 404 / 证书问题 / data URL 损坏）→ 回退首字母，不显示破图。
 *
 * 尺寸由调用方传（账号区 26px、账号信息弹窗 56px）；图片完全由 img 渲染，
 * 不依赖 antd 的自动回退图标，保证「加载失败 → 首字母」可被 E2E 断言。
 */
export interface LatticeUserAvatarProps {
  /** 平台头像：https URL / data:image base64；null、空串或缺省 = 无头像 */
  avatar?: string | null
  /** 用户名（display_name 优先由调用方传入），决定首字母回退 */
  name?: string | null
  /** 边长（px）；账号区建议 26，弹窗建议 56 */
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
   * 记录「哪个地址加载失败过」：只在该地址仍是当前地址时回退首字母。
   * 不用 effect 在 src 变化后重置状态——图片 error 事件可能早于 passive effect 派发，
   * 那样会把刚记录的失败又清掉（表现为坏图一直不回落）。换新地址时 `failedSrc !== src`
   * 自然重试，无需额外重置。
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
