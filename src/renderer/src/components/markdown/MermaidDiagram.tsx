import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@renderer/i18n'
import { renderMermaidDiagram } from './mermaid'

interface MermaidDiagramProps {
  code: string
  isDarkMode?: boolean
}

/** Mermaid diagram in read-only preview (mermaid package lazy-loaded, theme follows light/dark) */
const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ code, isDarkMode = false }) => {
  const { t } = useTranslation()
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const blockRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    // Keep the previous diagram until the new one is ready, avoiding flicker/height jumps on update
    renderMermaidDiagram(code, isDarkMode)
      .then((result) => {
        if (cancelled) return
        setSvg(result)
        setState('ready')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [code, isDarkMode])

  // Scale the SVG down proportionally into the visible area (chat/preview has no canvas
  // interaction, so the whole diagram must remain visible)
  useEffect(() => {
    if (state !== 'ready' || !blockRef.current) return
    const svgEl = blockRef.current.querySelector('svg')
    const vb = svgEl?.viewBox?.baseVal
    if (!svgEl || !vb || vb.width <= 0 || vb.height <= 0) return
    const availW = Math.max(1, blockRef.current.clientWidth - 32)
    const availH = Math.max(1, Math.min(window.innerHeight * 0.6, 480) - 32)
    const scale = Math.min(1, availW / vb.width, availH / vb.height)
    svgEl.style.width = `${Math.round(vb.width * scale)}px`
    svgEl.style.height = `${Math.round(vb.height * scale)}px`
  }, [state, svg])

  if (state === 'error') {
    return (
      <div className="mermaid-block mermaid-error">
        <div>{t('markdown.mermaid.errorWithReason', { reason: error })}</div>
      </div>
    )
  }

  // Loading but an old diagram exists: keep showing it (loading hint only when there is none yet)
  if (!svg) {
    return <div className="mermaid-block mermaid-loading">{t('markdown.mermaid.loading')}</div>
  }

  return <div ref={blockRef} className="mermaid-block" dangerouslySetInnerHTML={{ __html: svg }} />
}

export default MermaidDiagram
