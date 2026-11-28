import React from 'react'
import { theme } from 'antd'
import { useTranslation } from '@renderer/i18n'
import { SkeletonBlock } from '@renderer/components/system/Skeleton'
import {
  SKELETON_CSS,
  skeletonVars,
  useSkeletonPalette
} from '@renderer/components/system/skeleton-palette'

export type RouteSkeletonVariant = string

const MONO_FONT = "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace"

/* The skeleton block's own pulse and palette live in components/system/Skeleton.tsx (shared
   with component-level skeletons); only the route-level monospace label in the bottom-right
   corner remains here */
const TAG_CSS = `
.rb-skel-tag {
  position: absolute;
  right: 12px;
  bottom: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: ${MONO_FONT};
  font-size: 10px;
  letter-spacing: 0.16em;
  user-select: none;
  pointer-events: none;
}
.rb-skel-tag-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  animation: rb-skel-dot 1.2s ease-in-out infinite;
}
@keyframes rb-skel-dot {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}
`

/**
 * Route-level skeleton: when navigating while the target page's chunk is still loading, show
 * that page's skeleton structure right away (topic sidebar / gantt chart / playlist) instead of
 * the old centered spinner and "stuck on the previous page".
 * Colors come from antd tokens, adapting automatically to light and dark themes; the monospace
 * "LOADING" label in the bottom-right corner echoes the monospace label styling used throughout
 * the UI.
 *
 * Page-internal data loading can also reuse it as a placeholder (e.g. planner loading its task
 * tree); in that case pass `showTag={false}` — the label text is route semantics, so do not use
 * it for data loading.
 */
const RouteSkeleton: React.FC<{ variant: RouteSkeletonVariant; showTag?: boolean }> = ({
  variant,
  showTag = true
}) => {
  const {
    token: {
      colorBgContainer,
      colorBgLayout,
      colorBorderSecondary,
      colorPrimary,
      colorTextTertiary
    }
  } = theme.useToken()
  const { t } = useTranslation()
  const palette = useSkeletonPalette()

  const block = (w: number | string, h: number, r = 6, color?: string): React.ReactElement => (
    <SkeletonBlock w={w} h={h} r={r} color={color} />
  )

  let content: React.ReactNode
  if (variant === 'harness') {
    content = (
      <div className="flex h-full w-full min-h-0" style={{ background: colorBgContainer }}>
        {/* Topic sidebar */}
        <div
          className="flex flex-col gap-3 px-3 py-4"
          style={{ width: 230, flexShrink: 0, borderRight: `1px solid ${colorBorderSecondary}` }}
        >
          <div className="flex items-center gap-2.5">
            {block(30, 30, 10)}
            {block(120, 13)}
          </div>
          <div style={{ height: 10 }} />
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              {block(128 - (i % 3) * 16, 12)}
              {block(84, 9)}
            </div>
          ))}
        </div>
        {/* Main area: header + message area + input box */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            className="flex items-center gap-3 px-4"
            style={{
              height: 52,
              flexShrink: 0,
              borderBottom: `1px solid ${colorBorderSecondary}`
            }}
          >
            {block(24, 24, 8)}
            {block(150, 13)}
            <div className="flex-1" />
            {block(64, 26, 8)}
          </div>
          <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 px-8 py-6">
            <div className="flex w-full max-w-3xl flex-col gap-3">
              <div className="flex justify-center">{block(220, 14)}</div>
              {block(300, 56, 12)}
              {block(380, 72, 12)}
              <div className="self-end">{block(260, 44, 12)}</div>
            </div>
            {block('100%', 110, 14)}
          </div>
        </div>
      </div>
    )
  } else if (variant === 'planner') {
    content = (
      <div className="flex h-full w-full flex-col" style={{ background: colorBgContainer }}>
        {/* Top toolbar */}
        <div
          className="flex items-center gap-2.5 px-4"
          style={{ height: 56, flexShrink: 0, borderBottom: `1px solid ${colorBorderSecondary}` }}
        >
          {block(96, 30, 8)}
          {block(96, 30, 8)}
          <div className="flex-1" />
          {block(64, 30, 8)}
        </div>
        <div className="flex min-h-0 flex-1">
          {/* Task tree */}
          <div
            className="flex flex-col gap-2.5 p-4"
            style={{ width: 240, flexShrink: 0, borderRight: `1px solid ${colorBorderSecondary}` }}
          >
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex flex-col gap-1.5" style={{ paddingLeft: (i % 3) * 14 }}>
                {block(150 - (i % 3) * 26, 12)}
                {block(96, 9)}
              </div>
            ))}
          </div>
          {/* Gantt chart */}
          <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
            {block('100%', 10)}
            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="flex items-center gap-3">
                {block(22, 14)}
                <div
                  className="flex-1"
                  style={{
                    height: 30,
                    borderRadius: 6,
                    background: palette.track,
                    overflow: 'hidden'
                  }}
                >
                  {/* Gantt bars use the accent color, echoing the monochrome accent design language */}
                  <div
                    className="rb-skel-block"
                    style={{
                      width: `${32 + ((i * 13) % 55)}%`,
                      height: '100%',
                      borderRadius: 6,
                      background: palette.accent
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  } else if (variant === 'music') {
    content = (
      <div className="flex h-full w-full gap-2.5 p-2.5" style={{ background: colorBgLayout }}>
        {/* Playlist sidebar */}
        <div
          className="flex flex-col gap-2.5 p-3"
          style={{ width: 200, flexShrink: 0, background: colorBgContainer, borderRadius: 10 }}
        >
          {block(28, 28, 10)}
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              {block(150 - (i % 2) * 14, 12)}
              {block(76, 9)}
            </div>
          ))}
        </div>
        {/* Main area: now playing + list + playback controls */}
        <div
          className="flex min-w-0 flex-1 flex-col"
          style={{ background: colorBgContainer, borderRadius: 10, overflow: 'hidden' }}
        >
          <div
            className="flex items-center gap-5 p-5"
            style={{ borderBottom: `1px solid ${colorBorderSecondary}` }}
          >
            {block(112, 112, 12)}
            <div className="flex flex-col gap-2.5">
              {block(190, 18)}
              {block(130, 12)}
              {block(88, 10)}
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-2.5 p-4">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center gap-3">
                {block(16, 16, 5)}
                {block(190, 13)}
                {block(120, 11)}
                <div className="flex-1" />
                {block(36, 11)}
              </div>
            ))}
          </div>
          <div
            className="flex items-center gap-4 px-5"
            style={{ height: 64, flexShrink: 0, borderTop: `1px solid ${colorBorderSecondary}` }}
          >
            {block(36, 36, 8)}
            <div className="flex flex-col gap-1.5">
              {block(130, 10, 5)}
              {block(72, 8, 5)}
            </div>
            <div className="flex-1" />
            {block(22, 22, 6)}
            {block(30, 30, 15)}
            {block(22, 22, 6)}
          </div>
        </div>
      </div>
    )
  } else {
    // Generic fallback: give an unknown variant (e.g. an external plugin route) a simple centered
    // skeleton
    content = (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-4 p-8"
        style={{ background: colorBgContainer }}
      >
        {block(260, 16)}
        {block(360, 12)}
        {block('70%', 64, 12)}
        {block(200, 32, 8)}
      </div>
    )
  }

  return (
    <div className="relative h-full w-full min-h-0 overflow-hidden" style={skeletonVars(palette)}>
      <style>{SKELETON_CSS}</style>
      <style>{TAG_CSS}</style>
      {content}
      {showTag && (
        <div className="rb-skel-tag" style={{ color: colorTextTertiary }}>
          <span className="rb-skel-tag-dot" style={{ background: colorPrimary }} />
          {t('shell.routing.loading')}
        </div>
      )}
    </div>
  )
}

export default RouteSkeleton
