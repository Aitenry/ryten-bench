/**
 * "What this reply changed / delivered" summary under an assistant message.
 *
 * Two blocks (each hidden when empty, so plain Q&A never grows an extra card):
 *
 * 1. **Edited files** — aggregated from this message's `write_file` / `edit_file` / `apply_patch`
 *    tool cards (`card.path` + `card.added/removed`, produced by the main process). One row per
 *    file, whole row clickable → opens that file in the workspace panel. The per-segment chip in
 *    AssistantMessage only says "N files changed"; this card is the answer to "which ones, and how
 *    big".
 * 2. **Deliverables** — the files the model declared with the `present` tool (its input is
 *    persisted with the conversation, so the cards survive a reload).
 *
 * Why it lives here instead of inside the tool cards: the tool cards sit inside the task fold and
 * unmount when folded; this summary stays outside, next to the answer.
 */
import React, { useMemo, useState } from 'react'
import { theme } from 'antd'
import {
  RiArrowDownSLine,
  RiCodeSSlashLine,
  RiFileImageLine,
  RiFileTextLine,
  RiArrowRightSLine
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { useWorkspaceBridge } from '../../../contexts/harness/workspace-bridge'
import OpenWithButton from '../OpenWithButton'
import type { MessageBlock } from '../../../../../shared/harness/types'

/** File-writing tools whose cards carry a path (and usually line stats) */
const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch'])

/** Rows shown before the list folds ("show all") */
const COLLAPSED_ROWS = 4

interface ChangedFile {
  path: string
  added: number
  removed: number
}

interface Deliverable {
  path: string
  description?: string
}

/** Path → store format (separators normalized, no trailing slash) for de-duplication */
function pathKey(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Code-ish extension? Drives the row icon (code vs document vs image) */
function kindOf(path: string): 'code' | 'image' | 'doc' {
  const ext = pathKey(path).split('.').pop()?.toLowerCase() ?? ''
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'html', 'vue', 'py', 'go', 'rs', 'java', 'sql', 'sh'].includes(ext)) {
    return 'code'
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image'
  return 'doc'
}

function FileKindIcon({ path, size = 14 }: { path: string; size?: number }): React.ReactElement {
  const kind = kindOf(path)
  if (kind === 'code') return <RiCodeSSlashLine size={size} />
  if (kind === 'image') return <RiFileImageLine size={size} />
  return <RiFileTextLine size={size} />
}

/** "src/renderer/x.tsx" → "…/renderer/x.tsx" so long paths keep their meaningful tail */
function shortPath(path: string): string {
  // Virtual workspace paths start with "/", which reads better without the leading slash here
  const normalized = pathKey(path).replace(/^\/+/, '')
  if (normalized.length <= 64) return normalized
  const segments = normalized.split('/')
  while (segments.length > 3 && segments.join('/').length > 60) segments.shift()
  return `…/${segments.join('/')}`
}

const MessageWorkSummary: React.FC<{ blocks: MessageBlock[] }> = ({ blocks }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const bridge = useWorkspaceBridge()
  const [expanded, setExpanded] = useState(false)

  const changedFiles = useMemo<ChangedFile[]>(() => {
    const byPath = new Map<string, ChangedFile>()
    for (const block of blocks) {
      if (block.type !== 'tool') continue
      const tool = block.tool
      if (!tool || !EDIT_TOOLS.has(tool.name)) continue
      const card = tool.card
      if (card?.status === 'error') continue
      const rawPath =
        typeof card?.path === 'string'
          ? card.path
          : (tool.input as { file_path?: unknown } | undefined)?.file_path
      if (typeof rawPath !== 'string' || !rawPath.trim()) continue
      const key = pathKey(rawPath)
      const prev = byPath.get(key)
      const added = typeof card?.added === 'number' ? card.added : 0
      const removed = typeof card?.removed === 'number' ? card.removed : 0
      byPath.set(key, {
        path: rawPath,
        added: (prev?.added ?? 0) + added,
        removed: (prev?.removed ?? 0) + removed
      })
    }
    return [...byPath.values()]
  }, [blocks])

  const deliverables = useMemo<Deliverable[]>(() => {
    const out: Deliverable[] = []
    const seen = new Set<string>()
    for (const block of blocks) {
      if (block.type !== 'tool') continue
      const tool = block.tool
      if (!tool || tool.name !== 'present') continue
      const files = (tool.input as { files?: unknown } | undefined)?.files
      if (!Array.isArray(files)) continue
      for (const file of files as Array<{ path?: unknown; description?: unknown }>) {
        if (typeof file?.path !== 'string' || !file.path.trim()) continue
        const key = pathKey(file.path)
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          path: file.path,
          description:
            typeof file.description === 'string' && file.description.trim()
              ? file.description.trim()
              : undefined
        })
      }
    }
    return out
  }, [blocks])

  if (changedFiles.length === 0 && deliverables.length === 0) return null

  const totalAdded = changedFiles.reduce((sum, file) => sum + file.added, 0)
  const totalRemoved = changedFiles.reduce((sum, file) => sum + file.removed, 0)
  const hasStats = totalAdded + totalRemoved > 0
  const addShare = hasStats ? Math.max(6, Math.round((totalAdded / (totalAdded + totalRemoved)) * 100)) : 0
  const visibleFiles = expanded ? changedFiles : changedFiles.slice(0, COLLAPSED_ROWS)
  const hiddenCount = changedFiles.length - visibleFiles.length

  const openFile = (path: string): void => {
    bridge?.openFile(path)
  }

  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {changedFiles.length > 0 && (
        <div
          data-work-summary="changes"
          data-work-files={changedFiles.length}
          style={{
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 14,
            overflow: 'hidden',
            background: token.colorFillQuaternary
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 11,
              padding: '12px 14px',
              borderBottom: `1px solid ${token.colorBorderSecondary}`
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 9,
                flex: '0 0 auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: token.colorPrimary,
                background: token.colorPrimaryBg,
                border: `1px solid ${token.colorPrimaryBorder}`
              }}
            >
              <RiCodeSSlashLine size={17} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 650, color: token.colorText }}>
                {t('harness.assistantMessage.workEditedFiles', {
                  count: String(changedFiles.length)
                })}
              </div>
              {hasStats && (
                <div
                  style={{
                    marginTop: 3,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    fontSize: 11.5,
                    fontVariantNumeric: 'tabular-nums'
                  }}
                >
                  <span style={{ color: '#3fb950' }}>+{totalAdded}</span>
                  <span style={{ color: '#f85149' }}>−{totalRemoved}</span>
                  <span
                    style={{
                      width: 46,
                      height: 3,
                      borderRadius: 2,
                      overflow: 'hidden',
                      display: 'flex',
                      background: token.colorFillSecondary
                    }}
                  >
                    <i style={{ width: `${addShare}%`, background: '#3fb950' }} />
                    <i style={{ flex: '1 1 auto', background: '#f85149' }} />
                  </span>
                </div>
              )}
            </div>
          </div>

          {visibleFiles.map((file) => (
            <button
              key={file.path}
              type="button"
              className="ryt-work-row"
              onClick={() => openFile(file.path)}
              title={file.path}
              disabled={!bridge}
            >
              <span className="ryt-work-row__kind" style={{ color: token.colorTextTertiary }}>
                <FileKindIcon path={file.path} />
              </span>
              <span className="ryt-work-row__path" style={{ color: token.colorTextSecondary }}>
                {shortPath(file.path)}
              </span>
              <span className="ryt-work-row__stat">
                <span style={{ color: '#3fb950' }}>+{file.added}</span>
                <span style={{ color: '#f85149' }}>−{file.removed}</span>
              </span>
              <span className="ryt-work-chev" style={{ color: token.colorTextTertiary }}>
                <RiArrowRightSLine size={13} />
              </span>
            </button>
          ))}

          {hiddenCount > 0 || expanded ? (
            <button
              type="button"
              className="ryt-work-row ryt-work-row--more"
              onClick={() => setExpanded((prev) => !prev)}
              style={{ color: token.colorTextTertiary, fontSize: 11.5 }}
            >
              <span style={{ display: 'inline-flex', transform: expanded ? 'rotate(180deg)' : 'none' }}>
                <RiArrowDownSLine size={13} />
              </span>
              {expanded
                ? t('harness.assistantMessage.workCollapse')
                : t('harness.assistantMessage.workShowAll', { count: String(hiddenCount) })}
            </button>
          ) : null}
        </div>
      )}

      {deliverables.length > 0 && (
        <div
          data-work-summary="deliverables"
          data-work-deliverables={deliverables.length}
          style={{
            display: 'grid',
            gridTemplateColumns: deliverables.length > 1 ? '1fr 1fr' : '1fr',
            gap: 10
          }}
        >
          {deliverables.map((file) => (
            <div
              key={file.path}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 10px',
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 13,
                background: token.colorFillQuaternary,
                minWidth: 0
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 9,
                  flex: '0 0 auto',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: token.colorPrimary,
                  background: token.colorPrimaryBg,
                  border: `1px solid ${token.colorPrimaryBorder}`
                }}
              >
                <FileKindIcon path={file.path} size={18} />
              </div>
              <div style={{ minWidth: 0, flex: '1 1 auto' }}>
                <div
                  style={{
                    fontSize: 12.3,
                    fontWeight: 600,
                    color: token.colorText,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                  title={file.path}
                >
                  {pathKey(file.path).split('/').pop() ?? file.path}
                </div>
                <div
                  style={{
                    marginTop: 3,
                    fontSize: 10.8,
                    color: token.colorTextTertiary,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                  title={file.description ?? file.path}
                >
                  {file.description ?? pathKey(file.path)}
                </div>
              </div>
              <OpenWithButton
                virtualPath={file.path}
                label={t('harness.assistantMessage.workOpen')}
                onOpenInApp={bridge ? () => openFile(file.path) : undefined}
                small
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default MessageWorkSummary
