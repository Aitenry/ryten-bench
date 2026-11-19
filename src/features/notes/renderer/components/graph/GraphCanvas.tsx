import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts'
import type { EChartsOption } from 'echarts'
import { Button, theme } from 'antd'
import { RiEyeLine, RiEyeOffLine } from '@remixicon/react'
import { useTheme } from '@renderer/hooks/useTheme'
import { useTranslation } from '@renderer/i18n'
import { GraphEntity } from '../../../shared/types'
import type { GraphCanvasProps } from '../../types'

let _chart: echarts.ECharts | null = null
let _container: HTMLDivElement | null = null

function getOrCreateChart(container: HTMLDivElement): echarts.ECharts {
  if (_chart && !_chart.isDisposed() && _container === container) return _chart
  if (_chart && !_chart.isDisposed()) _chart.dispose()
  _chart = echarts.init(container)
  _container = container
  return _chart
}

const GraphCanvas: React.FC<GraphCanvasProps> = ({ data, onEntityClick, onEntityDblClick }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [hideIsolated, setHideIsolated] = useState(true)
  const [hiddenCats, setHiddenCats] = useState<Record<string, boolean>>({})
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null)
  const {
    token: { colorBgContainer }
  } = theme.useToken()
  const { effectiveTheme } = useTheme()
  const { t } = useTranslation()
  const isDarkMode = effectiveTheme === 'dark'

  // Count isolated nodes (no connections) — used by both chart and hint overlay
  //（修复：此前每次渲染新建 connectedNodes 引用,父级任何重渲染（如点选实体）都触发
  // 下方 effect 重跑 → 整图重建、缩放/平移视口被重置）
  const { connectedNodes, isolatedCount } = useMemo(() => {
    const connectedNodeIds = new Set<string>()
    for (const link of data.links) {
      connectedNodeIds.add(String(link.source))
      connectedNodeIds.add(String(link.target))
    }
    const connected = data.nodes.filter((n) => connectedNodeIds.has(n.id))
    return { connectedNodes: connected, isolatedCount: data.nodes.length - connected.length }
  }, [data])

  useEffect(() => {
    if (!containerRef.current || !data) return

    const chart = getOrCreateChart(containerRef.current)
    const cw = containerRef.current.clientWidth || 800
    const ch = containerRef.current.clientHeight || 600
    const cx = cw / 2
    const cy = ch / 2
    const padding = 40
    const maxR = Math.min(cx, cy) - padding

    // If all nodes are isolated, show all to avoid blank canvas
    const nodesToRender = hideIsolated && connectedNodes.length > 0 ? connectedNodes : data.nodes
    const effectiveCount = nodesToRender.length

    // Node size: aggressively shrink for large graphs
    const symbolSize =
      effectiveCount <= 10
        ? 28
        : effectiveCount <= 30
          ? 22
          : effectiveCount <= 80
            ? 16
            : effectiveCount <= 200
              ? 12
              : effectiveCount <= 500
                ? 8
                : 5

    // Sunflower phyllotaxis: optimal disk packing. sqrt(r) ∝ i for constant area density
    const phi = (1 + Math.sqrt(5)) / 2
    const goldenAngle = (2 * Math.PI) / (phi * phi)

    const positionedNodes = nodesToRender.map((node, i) => {
      const r = maxR * Math.sqrt((i + 0.5) / effectiveCount)
      const angle = i * goldenAngle
      return {
        ...node,
        symbolSize,
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
        fixed: true
      }
    })

    // Dynamic visual scaling based on graph size
    const labelFontSize =
      effectiveCount <= 50 ? 11 : effectiveCount <= 200 ? 9 : effectiveCount <= 500 ? 8 : 7
    const lineOpacity = 0.35
    const lineWidth = 1

    // Build node id→name lookup for edge tooltips
    const nodeNameMap = new Map(data.nodes.map((n) => [n.id, n.name]))

    // Filter series data when a category is hovered (show that category + connected nodes)
    let seriesNodes = positionedNodes
    let seriesLinks = data.links.map((l) => ({
      source: l.source,
      target: l.target,
      data: { label: l.label, description: l.description }
    }))

    if (hoveredCategory) {
      const catNodeIds = new Set(
        data.nodes
          .filter((n) => {
            const c = data.categories[n.category]
            return c && c.name === hoveredCategory
          })
          .map((n) => n.id)
      )

      const visibleIds = new Set(catNodeIds)
      for (const link of data.links) {
        const s = String(link.source)
        const t = String(link.target)
        if (catNodeIds.has(s)) visibleIds.add(t)
        if (catNodeIds.has(t)) visibleIds.add(s)
      }

      seriesNodes = positionedNodes.filter((n) => visibleIds.has(n.id))
      seriesLinks = data.links
        .filter((l) => visibleIds.has(String(l.source)) && visibleIds.has(String(l.target)))
        .map((l) => ({
          source: l.source,
          target: l.target,
          data: { label: l.label, description: l.description }
        }))
    }

    const option: EChartsOption = {
      backgroundColor: colorBgContainer,
      tooltip: {
        confine: true,
        extraCssText: 'max-width: 320px; white-space: normal; word-break: break-word;',
        formatter: (params: unknown) => {
          const p = params as {
            dataType?: string
            data?: {
              name?: string
              source?: string
              target?: string
              original?: GraphEntity
              data?: {
                label?: string
                description?: string | null
              }
            }
          }
          if (p.dataType === 'node') {
            const desc = p.data?.original?.description
            return `<b>${p.data?.name || ''}</b>${desc ? `<br/><div style="margin-top:4px;line-height:1.5;">${t('graph.canvas.tooltipDescription', { description: desc })}</div>` : ''}`
          }
          if (p.dataType === 'edge') {
            const sourceId = String(p.data?.source ?? '')
            const targetId = String(p.data?.target ?? '')
            const sourceName = nodeNameMap.get(sourceId) || sourceId
            const targetName = nodeNameMap.get(targetId) || targetId
            const label = p.data?.data?.label || ''
            const desc = p.data?.data?.description
            const body = t('graph.canvas.edgeTooltip', {
              source: sourceName,
              relation: label,
              target: targetName
            })
            return `<b>${body}</b>${desc ? `<br/><div style="margin-top:4px;line-height:1.5;">${t('graph.canvas.tooltipDescription', { description: desc })}</div>` : ''}`
          }
          return ''
        }
      },
      legend:
        data.categories.length > 0
          ? {
              show: false,
              data: data.categories.map((c) => c.name),
              selected: Object.fromEntries(
                data.categories.map((c) => [c.name, !hiddenCats[c.name]])
              )
            }
          : undefined,
      series: [
        {
          type: 'graph',
          layout: 'none',
          data: seriesNodes,
          links: seriesLinks,
          categories: data.categories,
          roam: true,
          label: {
            show: true,
            position: 'right',
            formatter: '{b}',
            fontSize: labelFontSize,
            color: isDarkMode ? 'rgba(255,255,255,0.75)' : '#333'
          },
          labelLayout: {
            hideOverlap: true
          },
          scaleLimit: {
            min: 0.2,
            max: 6
          },
          lineStyle: {
            color: 'source',
            curveness: 0.15,
            width: lineWidth,
            opacity: lineOpacity
          },
          emphasis: {
            focus: 'adjacency',
            lineStyle: {
              width: 3,
              opacity: 0.95
            },
            label: {
              show: true,
              fontSize: Math.max(labelFontSize, 10)
            }
          },
          blur: {
            itemStyle: { opacity: 0 },
            lineStyle: { opacity: 0 },
            label: { show: false }
          }
        }
      ]
    }

    chart.setOption(option, true)

    // Handle click
    const handleClick = (params: unknown): void => {
      const p = params as { dataType?: string; data?: { original?: GraphEntity } }
      if (p.dataType === 'node' && p.data?.original) {
        onEntityClick(p.data.original)
      }
    }
    chart.off('click')
    chart.on('click', handleClick)

    // Handle double click
    if (onEntityDblClick) {
      const handleDblClick = (params: unknown): void => {
        const p = params as { dataType?: string; data?: { original?: GraphEntity } }
        if (p.dataType === 'node' && p.data?.original) {
          onEntityDblClick(p.data.original)
        }
      }
      chart.off('dblclick')
      chart.on('dblclick', handleDblClick)
    }

    // Legend hover is handled by the custom React legend component below
  }, [
    data,
    onEntityClick,
    onEntityDblClick,
    colorBgContainer,
    hideIsolated,
    connectedNodes,
    isDarkMode,
    hiddenCats,
    hoveredCategory,
    t
  ])

  // Handle resize
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      if (_chart && !_chart.isDisposed()) {
        _chart.resize()
      }
    })
    ro.observe(container)
    return () => {
      ro.disconnect()
    }
  }, [])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', background: colorBgContainer }}
      />
      {/* Custom legend — hover to highlight category entities & relationships */}
      {data.categories.length > 0 && (
        <div
          className="custom-scrollbar"
          style={{
            position: 'absolute',
            left: 8,
            top: 8,
            zIndex: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '6px 8px',
            background: isDarkMode ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.85)',
            borderRadius: 6,
            fontSize: 12,
            maxHeight: 'calc(100% - 46px)',
            overflowY: 'auto'
          }}
        >
          {data.categories.map((cat) => {
            const isHidden = hiddenCats[cat.name]
            return (
              <div
                key={cat.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '2px 6px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  transition: 'background 0.15s',
                  opacity: isHidden ? 0.45 : 1,
                  textDecoration: isHidden ? 'line-through' : 'none'
                }}
                onMouseEnter={() => {
                  if (isHidden) return
                  setHoveredCategory(cat.name)
                }}
                onMouseLeave={() => {
                  setHoveredCategory(null)
                }}
                onClick={() => {
                  setHoveredCategory(null)
                  setHiddenCats((prev) => ({ ...prev, [cat.name]: !prev[cat.name] }))
                }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: cat.itemStyle.color,
                    flexShrink: 0
                  }}
                />
                <span
                  style={{
                    color: isDarkMode ? 'rgba(255,255,255,0.85)' : '#333',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {cat.name}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {isolatedCount > 0 && (
        <>
          <Button
            type="dashed"
            shape="circle"
            size="small"
            icon={hideIsolated ? <RiEyeOffLine size={14} /> : <RiEyeLine size={14} />}
            title={
              hideIsolated
                ? t('graph.canvas.showIsolated', { count: isolatedCount })
                : t('graph.canvas.hideIsolated', { count: isolatedCount })
            }
            onClick={() => setHideIsolated(!hideIsolated)}
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 10
            }}
          />
          {hideIsolated && (
            <div
              style={{
                position: 'absolute',
                bottom: 8,
                left: 8,
                padding: '4px 10px',
                background: 'rgba(0,0,0,0.6)',
                color: '#fff',
                borderRadius: 4,
                fontSize: 11,
                pointerEvents: 'none',
                zIndex: 10
              }}
            >
              {t('graph.canvas.isolatedHidden', { count: isolatedCount })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default GraphCanvas
