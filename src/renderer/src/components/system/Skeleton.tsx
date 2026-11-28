import React from 'react'
import { SKELETON_CSS, skeletonVars, useSkeletonPalette } from './skeleton-palette'

/**
 * Global skeleton materials (the single source of truth for loading states).
 *
 * Background: before the redesign, loading states mixed three different languages — antd `Spin` /
 * `LoadingOutlined` / `RiLoader2Line spin-anim` — so the same list showed a different spinner style
 * on a different page. Since 2026-09-26 they are unified into skeletons: structure first, data
 * filled in after, avoiding the jump of "blank block + centered spinner".
 *
 * Rhythm and colors follow the RouteSkeleton set (1.8s ease-in-out opacity breathing; dark
 * rgba(255,255,255,.09) / light rgba(0,0,0,.06)); route-level skeletons (route/RouteSkeleton.tsx)
 * and component-level skeletons share the same low-level constants — see skeleton-palette.ts in the
 * same directory.
 *
 * Colors go through CSS variables: the preset root node calls useSkeletonPalette() once and writes
 * --rb-skel-block / --rb-skel-track into inline styles, and SkeletonBlock in the subtree references
 * the variables directly — a dashboard with dozens of blocks need not read tokens per block.
 */

/**
 * A screen may mount several skeleton presets at once: injecting the same rule twice is harmless
 */
export const SkeletonStyle: React.FC = () => <style>{SKELETON_CSS}</style>

/**
 * Skeleton block: the only atom. Width, height and radius are always explicit so the structure
 * stays stable (no random widths). Without a color it uses --rb-skel-block from the root node; with
 * no preset root node (bare use) it falls back to the mid-gray default in SKELETON_CSS, visible in
 * both light and dark themes.
 */
export const SkeletonBlock: React.FC<{
  w?: number | string
  h?: number
  r?: number
  color?: string
  className?: string
  style?: React.CSSProperties
}> = ({ w = '100%', h = 12, r = 6, color, className, style }) => (
  <div
    className={className ? `rb-skel-block ${className}` : 'rb-skel-block'}
    style={{
      width: w,
      height: h,
      borderRadius: r,
      background: color,
      flexShrink: 0,
      ...style
    }}
  />
)

/**
 * Paragraph text skeleton: widths follow a fixed pattern (random numbers would make the structure
 * jitter on every render)
 */
const TEXT_RATIOS = [1, 0.94, 0.82, 0.97, 0.7, 0.88, 0.62]

export const SkeletonTextLines: React.FC<{
  lines?: number
  height?: number
  gap?: number
  dark?: boolean
}> = ({ lines = 5, height = 11, gap = 9, dark }) => {
  const palette = useSkeletonPalette(dark)
  return (
    <div className="flex flex-col" style={{ ...skeletonVars(palette), gap }}>
      <SkeletonStyle />
      {Array.from({ length: lines }, (_, i) => (
        <SkeletonBlock
          key={i}
          w={`${Math.round(TEXT_RATIOS[i % TEXT_RATIOS.length] * 100)}%`}
          h={height}
          r={5}
        />
      ))}
    </div>
  )
}

/**
 * List skeleton:
 * - line    : single row (optionally with a leading icon slot) — directories, folder lists
 * - stacked : two stacked rows (title + secondary info) — topic bar, note list
 */
export const SkeletonListRows: React.FC<{
  rows?: number
  variant?: 'line' | 'stacked'
  icon?: boolean
  dark?: boolean
}> = ({ rows = 4, variant = 'line', icon = false, dark }) => {
  const palette = useSkeletonPalette(dark)
  return (
    <div
      className="flex flex-col"
      style={{ ...skeletonVars(palette), gap: variant === 'stacked' ? 14 : 4 }}
    >
      <SkeletonStyle />
      {Array.from({ length: rows }, (_, i) =>
        variant === 'stacked' ? (
          <div key={i} className="flex flex-col gap-1.5 px-1">
            <SkeletonBlock w={`${74 - (i % 3) * 9}%`} h={12} />
            <SkeletonBlock w={`${48 - (i % 2) * 8}%`} h={9} r={4} />
          </div>
        ) : (
          <div key={i} className="flex items-center gap-2 px-1" style={{ height: 28 }}>
            {icon ? <SkeletonBlock w={13} h={13} r={4} /> : null}
            <SkeletonBlock w={`${64 - (i % 3) * 11}%`} h={11} r={5} />
          </div>
        )
      )}
    </div>
  )
}

/**
 * Settings panel row skeleton: title + description on the left, control on the right, hairlines
 * between rows, matching SettingRow
 */
export const SkeletonSettingRows: React.FC<{ rows?: number; dark?: boolean }> = ({
  rows = 4,
  dark
}) => {
  const palette = useSkeletonPalette(dark)
  return (
    <div style={skeletonVars(palette)}>
      <SkeletonStyle />
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center"
          style={{
            gap: 12,
            padding: '11px 0',
            borderBottom: i === rows - 1 ? 'none' : `1px solid ${palette.hairline}`
          }}
        >
          <div className="flex flex-col gap-1.5" style={{ flex: 1, minWidth: 0 }}>
            <SkeletonBlock w={`${40 - (i % 3) * 6}%`} h={12} />
            <SkeletonBlock w={`${60 - (i % 2) * 14}%`} h={9} r={4} />
          </div>
          <SkeletonBlock w={28} h={16} r={8} />
        </div>
      ))}
    </div>
  )
}

/**
 * Message stream skeleton: used when loading earlier messages, staggered bubble outlines on the
 * left and right
 */
export const SkeletonMessages: React.FC<{ rows?: number; dark?: boolean }> = ({
  rows = 2,
  dark
}) => {
  const palette = useSkeletonPalette(dark)
  return (
    <div className="flex flex-col gap-3" style={skeletonVars(palette)}>
      <SkeletonStyle />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={i % 2 === 0 ? 'flex justify-start' : 'flex justify-end'}>
          <SkeletonBlock w={i % 2 === 0 ? '58%' : '42%'} h={i % 2 === 0 ? 42 : 34} r={12} />
        </div>
      ))}
    </div>
  )
}

/**
 * Graph canvas skeleton: center node + six spokes + surrounding nodes, occupying the canvas
 * structure first
 */
export const SkeletonGraph: React.FC<{ dark?: boolean }> = ({ dark }) => {
  const palette = useSkeletonPalette(dark)
  const spokes = [0, 60, 120, 180, 240, 300]
  const radius = 150
  const satellite = 44
  return (
    <div
      className="relative h-full w-full"
      style={{ ...skeletonVars(palette), padding: 20, overflow: 'hidden' }}
    >
      <SkeletonStyle />
      <div className="flex items-center gap-2">
        <SkeletonBlock w={10} h={10} r={3} color={palette.accent} />
        <SkeletonBlock w={72} h={10} r={5} />
      </div>
      <div className="absolute inset-0">
        <div className="absolute" style={{ left: '50%', top: '50%' }}>
          {spokes.map((deg) => (
            <div
              key={`spoke-${deg}`}
              className="rb-skel-block"
              style={{
                position: 'absolute',
                width: radius,
                height: 1,
                background: palette.track,
                transformOrigin: '0 50%',
                transform: `rotate(${deg}deg)`
              }}
            />
          ))}
          {spokes.map((deg) => {
            const rad = (deg * Math.PI) / 180
            return (
              <SkeletonBlock
                key={`node-${deg}`}
                w={satellite}
                h={satellite}
                r={satellite / 2}
                style={{
                  position: 'absolute',
                  left: Math.cos(rad) * radius - satellite / 2,
                  top: Math.sin(rad) * radius - satellite / 2
                }}
              />
            )
          })}
          <SkeletonBlock
            w={92}
            h={92}
            r={46}
            color={palette.accent}
            style={{ position: 'absolute', left: -46, top: -46 }}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * Home dashboard skeleton: greeting + three stat blocks + three quick-create blocks + two-column
 * list (matching the EmptyDashboard layout)
 */
export const SkeletonDashboard: React.FC<{ dark?: boolean }> = ({ dark }) => {
  const palette = useSkeletonPalette(dark)
  return (
    <div
      className="custom-scrollbar"
      style={{ ...skeletonVars(palette), flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}
    >
      <SkeletonStyle />
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '36px 40px 56px' }}>
        <SkeletonBlock w={210} h={26} r={8} />
        <div style={{ marginTop: 10, marginBottom: 24 }}>
          <SkeletonBlock w={280} h={12} r={5} />
        </div>

        <div className="flex" style={{ gap: 12, marginBottom: 24 }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                flex: 1,
                minWidth: 0,
                padding: '16px 18px',
                borderRadius: 12,
                border: `1px solid ${palette.hairline}`
              }}
            >
              <div className="flex items-center" style={{ gap: 8, marginBottom: 10 }}>
                <SkeletonBlock w={15} h={15} r={4} />
                <SkeletonBlock w={48} h={10} r={5} />
              </div>
              <SkeletonBlock w={42} h={22} r={6} />
              <div style={{ marginTop: 8 }}>
                <SkeletonBlock w={106} h={10} r={5} />
              </div>
            </div>
          ))}
        </div>

        <div className="flex" style={{ gap: 12, marginBottom: 28 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ flex: 1, minWidth: 0 }}>
              <SkeletonBlock h={42} r={10} />
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {[0, 1].map((col) => (
            <div key={col}>
              <div style={{ marginBottom: 12 }}>
                <SkeletonBlock w={92} h={12} r={5} />
              </div>
              <div className="flex flex-col" style={{ gap: 8 }}>
                {[0, 1, 2, 3].map((i) => (
                  <SkeletonBlock key={i} h={36} r={8} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Document editor skeleton: title + metadata row + three paragraphs (paragraph width narrows
 * progressively)
 */
export const SkeletonDocPane: React.FC<{ dark?: boolean }> = ({ dark }) => {
  const palette = useSkeletonPalette(dark)
  return (
    <div
      className="custom-scrollbar"
      style={{ ...skeletonVars(palette), flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}
    >
      <SkeletonStyle />
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '32px 40px 64px' }}>
        <SkeletonBlock w="62%" h={28} r={8} />
        <div className="flex items-center" style={{ gap: 10, marginTop: 14, marginBottom: 28 }}>
          <SkeletonBlock w={64} h={10} r={5} />
          <SkeletonBlock w={88} h={10} r={5} />
          <SkeletonBlock w={52} h={10} r={5} />
        </div>
        {[0, 1, 2].map((p) => (
          <div key={p} className="flex flex-col" style={{ gap: 10, marginBottom: 26 }}>
            <SkeletonBlock w={`${Math.max(40, 54 - p * 7)}%`} h={15} r={5} />
            <SkeletonTextLines lines={p === 1 ? 4 : 3} height={11} gap={10} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Todo panel skeleton: checkbox slot + title + field pill row + body text */
export const SkeletonTodoPane: React.FC<{ dark?: boolean }> = ({ dark }) => {
  const palette = useSkeletonPalette(dark)
  return (
    <div
      className="custom-scrollbar"
      style={{ ...skeletonVars(palette), flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}
    >
      <SkeletonStyle />
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '32px 40px 64px' }}>
        <div className="flex items-center" style={{ gap: 10 }}>
          <SkeletonBlock w={20} h={20} r={7} />
          <SkeletonBlock w="46%" h={22} r={7} />
        </div>
        <div
          className="flex"
          style={{ gap: 10, marginTop: 20, marginBottom: 26, flexWrap: 'wrap' }}
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center"
              style={{
                gap: 8,
                padding: '6px 10px',
                borderRadius: 8,
                border: `1px solid ${palette.hairline}`
              }}
            >
              <SkeletonBlock w={13} h={13} r={4} />
              <SkeletonBlock w={56} h={10} r={5} />
            </div>
          ))}
        </div>
        <SkeletonTextLines lines={6} height={11} gap={10} />
      </div>
    </div>
  )
}
