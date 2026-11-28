import React from 'react'

interface ShinyTextProps {
  children: React.ReactNode
  /** Gloss base color (defaults to the CSS variable --shiny-base, falling back to #b5b5b5) */
  baseColor?: string
  /** Highlight sweep color (defaults to --shiny-shine, falling back to #fff) */
  shineColor?: string
  /** Sweep period in seconds, defaults to 1.5 */
  speed?: number
  /** Disable the animation: render as plain static text */
  disabled?: boolean
  className?: string
  style?: React.CSSProperties
}

/**
 * ShinyText: text is filled with a "base color → white highlight → base color" gradient
 * (background-clip: text + text-fill-color: transparent), and a white gloss band sweeps
 * across the text on the @keyframes shiny-shine cycle.
 * Styles and keyframes live in src/renderer/src/assets/main.css
 */
const ShinyText: React.FC<ShinyTextProps> = ({
  children,
  baseColor,
  shineColor,
  speed = 1.5,
  disabled = false,
  className = '',
  style
}) => {
  if (disabled) {
    return (
      <span className={className} style={style}>
        {children}
      </span>
    )
  }
  return (
    <span
      className={`shiny-text ${className}`}
      style={
        {
          '--shiny-base': baseColor,
          '--shiny-shine': shineColor,
          animationDuration: `${speed}s`,
          ...style
        } as React.CSSProperties
      }
    >
      {children}
    </span>
  )
}

interface ShinyIconProps {
  /** Any @remixicon/react icon component */
  icon: React.ComponentType<{
    size?: number | string
    color?: string
    className?: string
    style?: React.CSSProperties
  }>
  size?: number
  baseColor?: string
  shineColor?: string
  speed?: number
  /** Whether to spin (for loading-indicator icons); static by default */
  spin?: boolean
  /** Disable the animation: render as plain static icon */
  disabled?: boolean
  className?: string
  style?: React.CSSProperties
}

/**
 * Icon variant of ShinyText: SVG cannot use background-clip: text, so it stacks a base-color
 * icon underneath a white icon on top (clipped and swept by a mask gradient band); the gloss
 * looks the same as the text, and the animation also runs on @keyframes shiny-shine-mask
 */
const ShinyIcon: React.FC<ShinyIconProps> = ({
  icon: Icon,
  size = 16,
  baseColor,
  shineColor,
  speed = 1.5,
  spin = false,
  disabled = false,
  className = '',
  style
}) => {
  if (disabled) {
    return (
      <Icon size={size} className={`${className}${spin ? ' animate-spin' : ''}`} style={style} />
    )
  }
  return (
    <span
      className={`shiny-icon ${className}${spin ? ' animate-spin' : ''}`}
      style={{ width: size, height: size, ...style }}
    >
      <Icon size={size} color={baseColor ?? 'var(--shiny-base, #b5b5b5)'} />
      <Icon
        size={size}
        color={shineColor ?? 'var(--shiny-shine, #fff)'}
        className="shiny-icon-sweep"
        style={{ animationDuration: `${speed}s` }}
      />
    </span>
  )
}

export { ShinyText, ShinyIcon }
export default ShinyText
