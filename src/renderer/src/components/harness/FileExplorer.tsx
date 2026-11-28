import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  RiFolder3Line,
  RiFolderOpenLine,
  RiArrowRightSLine,
  RiRefreshLine,
  RiCheckLine
} from '@remixicon/react'
import { getFileIcon } from '../../utils/harness/fileIcons'
import { useTranslation } from '@renderer/i18n'
import { harnessApi } from '../../api/harness'

export interface FileEntry {
  name: string
  isDirectory: boolean
  path: string
}

interface FileExplorerProps {
  workspacePath: string
  isDarkMode: boolean
  colorBgContainer: string
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  onOpenFile: (filePath: string, fileName: string) => void
  activeFilePath?: string | null
  /**
   * The (real absolute) path requested for reveal: when it changes, expand the tree level by level and highlight it.
   * Triggered from tool cards (ls) — "show this directory in the explorer".
   * Carries a nonce: requesting the same directory again (the user collapsed the tree and clicked
   * the card once more) must expand it again.
   */
  revealRequest?: { path: string; nonce: number } | null
  /** Files with pending changes → number of changes (count on file rows, a dot on parent directories) */
  pendingByPath?: Map<string, number>
  /** Total number of pending changes (when > 0 the title bar shows an entry that can keep them all at once) */
  pendingTotal?: number
  /**
   * Number of **files** with pending changes (reported in the title bar too when > 1).
   *
   * Why it is required: pendingTotal is the **number of change records** (one per model write/edit),
   * so a file changed 10 times counts as 10 — reporting only that number makes people think 10
   * files were touched (user feedback 2026-09-23: "only one file was edited, but this shows 10").
   */
  pendingFiles?: number
  /** Keep all (clear every pending-review mark; disk content is unchanged) */
  onKeepAllPending?: () => void
  /**
   * Disk change event (model writes / command execution / external editor): refresh only the
   * affected directories, and **preserve the expanded state** — this is exactly the fix for
   * "collapsed content gets collapsed again after refreshing".
   */
  fsEvent?: { nonce: number; paths: string[] } | null
}

interface TreeNode extends FileEntry {
  children: TreeNode[] | null
  expanded: boolean
  loaded: boolean
}

/** Persistence key for the expanded state (isolated per workspace) */
function storageKey(workspacePath: string): string {
  return `workspace-explorer:${workspacePath.replace(/\\/g, '/')}`
}

/** Path normalization (for comparison: forward slashes, no trailing slash, case-insensitive on Windows) */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Get the parent directory (after normalization) */
function parentOf(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : normalized
}

const FileExplorer: React.FC<FileExplorerProps> = ({
  workspacePath,
  isDarkMode,
  colorBgContainer,
  colorText,
  colorTextSecondary,
  colorTextTertiary,
  onOpenFile,
  activeFilePath,
  revealRequest,
  pendingByPath,
  pendingTotal = 0,
  pendingFiles = 0,
  onKeepAllPending,
  fsEvent
}) => {
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const { t } = useTranslation()
  /** Current snapshot of the tree: revealPath needs to read/load child nodes level by level without triggering extra renders */
  const rootNodesRef = useRef<TreeNode[]>([])
  rootNodesRef.current = rootNodes
  /**
   * Set of expanded directories (absolute paths, compared after normalization).
   * This is the **single source of truth** for the expanded state: after a refresh (manual or
   * disk-driven) the tree is restored level by level from it, no longer relying on the tree
   * nodes' own expanded flags (re-listing a directory replaces its nodes entirely).
   */
  const expandedRef = useRef<Set<string>>(new Set())
  const saveTimerRef = useRef<number | null>(null)

  const fetchDir = useCallback(async (dirPath: string): Promise<FileEntry[]> => {
    return harnessApi.workspace.listDir(dirPath)
  }, [])

  const makeNodes = useCallback(
    (entries: FileEntry[]): TreeNode[] =>
      entries.map((e) => ({ ...e, children: null, expanded: false, loaded: false })),
    []
  )

  /** Persist the expanded state (debounced: expanding several directories in a row writes once) */
  const persistExpanded = useCallback(() => {
    if (!workspacePath) return
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      try {
        localStorage.setItem(storageKey(workspacePath), JSON.stringify([...expandedRef.current]))
      } catch {
        // Fail silently when storage is unavailable (private mode etc.): the in-memory expanded state remains valid
      }
    }, 200)
  }, [workspacePath])

  // On unmount (workspace switch / panel close / app quit) flush the pending expanded state immediately,
  // otherwise expanding a directory and closing the panel makes it "all collapsed" again next time
  useEffect(() => {
    return () => {
      if (saveTimerRef.current === null || !workspacePath) return
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      try {
        localStorage.setItem(storageKey(workspacePath), JSON.stringify([...expandedRef.current]))
      } catch {
        // Same as above: ignore when storage is unavailable
      }
    }
  }, [workspacePath])

  /** Restore level by level from the saved expanded set (load only directories on expanded paths) */
  const restoreExpanded = useCallback(
    async (nodes: TreeNode[], cancelled: () => boolean): Promise<void> => {
      for (const node of nodes) {
        if (!node.isDirectory) continue
        if (!expandedRef.current.has(normalizePath(node.path))) continue
        if (!node.loaded) {
          try {
            node.children = makeNodes(await fetchDir(node.path))
            node.loaded = true
          } catch {
            // The directory may have been deleted: skip it but keep the parent
            continue
          }
        }
        node.expanded = true
        if (cancelled()) return
        if (node.children) await restoreExpanded(node.children, cancelled)
      }
    },
    [fetchDir, makeNodes]
  )

  /**
   * Reload the root directory (refresh button / root change).
   * Key point: **preserve the expanded state** — reload and expand level by level from expandedRef;
   * this is the direct fix for "collapsed content gets collapsed again after refreshing the explorer".
   */
  const loadRoot = useCallback(() => {
    if (!workspacePath) return
    setLoading(true)
    let cancelled = false
    fetchDir(workspacePath)
      .then(async (entries) => {
        const nodes = makeNodes(entries)
        await restoreExpanded(nodes, () => cancelled)
        if (cancelled) return
        setRootNodes(nodes)
      })
      // Previously there was no catch here, so a deleted directory / permission error produced an unhandled rejection and a blank UI
      .catch((err) => {
        console.error('Failed to load workspace root:', err)
        if (!cancelled) setRootNodes([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspacePath, fetchDir, makeNodes, restoreExpanded])

  // Workspace change: first read back this workspace's expanded state, then load the root directory
  useEffect(() => {
    if (!workspacePath) return
    expandedRef.current = new Set<string>()
    try {
      const raw = localStorage.getItem(storageKey(workspacePath))
      if (raw) {
        const saved = JSON.parse(raw) as unknown
        if (Array.isArray(saved)) {
          expandedRef.current = new Set(saved.map((p) => normalizePath(String(p))))
        }
      }
    } catch {
      // Treat a parse failure as "everything collapsed"
    }
    const cancel = loadRoot()
    return cancel
  }, [workspacePath, loadRoot])

  /** Find a directory node by path in the tree */
  const findNode = useCallback((targetPath: string): TreeNode | null => {
    const wanted = normalizePath(targetPath)
    const walk = (nodes: TreeNode[]): TreeNode | null => {
      for (const node of nodes) {
        if (normalizePath(node.path) === wanted) return node
        if (node.children) {
          const found = walk(node.children)
          if (found) return found
        }
      }
      return null
    }
    return walk(rootNodesRef.current)
  }, [])

  /**
   * Re-list a directory and merge the results:
   * entries that still exist **reuse the original node objects** (expanded state and loaded
   * children are preserved), new entries are inserted, disappeared ones removed. This way a
   * disk-change refresh does not collapse the tree.
   */
  const refreshDir = useCallback(
    async (dirPath: string): Promise<void> => {
      const isRoot = normalizePath(dirPath) === normalizePath(workspacePath)
      const node = isRoot ? null : findNode(dirPath)
      if (!isRoot && (!node || !node.isDirectory || !node.loaded)) return
      try {
        const entries = await fetchDir(dirPath)
        const existing = isRoot ? rootNodesRef.current : (node!.children ?? [])
        const byPath = new Map(existing.map((child) => [normalizePath(child.path), child]))
        const merged = entries.map((entry) => {
          const found = byPath.get(normalizePath(entry.path))
          if (found) {
            byPath.delete(normalizePath(entry.path))
            return found
          }
          return { ...entry, children: null, expanded: false, loaded: false }
        })
        if (isRoot) setRootNodes(merged)
        else {
          node!.children = merged
          setRootNodes([...rootNodesRef.current])
        }
      } catch (err) {
        console.warn('Failed to refresh directory:', err)
      }
    },
    [workspacePath, fetchDir, findNode]
  )

  /**
   * Reveal (when a tool card's ls is clicked): walk from the root to the target directory and expand it.
   *
   * Paths are compared with forward slashes — the workspace path and the sub-paths returned by the
   * main process both use backslashes on Windows, but the target path held by the renderer comes
   * from virtual path concatenation, so the two sides are not guaranteed to use the same separator.
   * Levels not yet loaded are loaded in place (same fetchDir as toggleExpand), then the tree is
   * refreshed once at the end.
   */
  useEffect(() => {
    const target = revealRequest?.path
    if (!target) return
    let cancelled = false

    const run = async (): Promise<void> => {
      const rootNorm = normalizePath(workspacePath)
      const targetNorm = normalizePath(target)
      const segments = targetNorm.startsWith(rootNorm)
        ? targetNorm.slice(rootNorm.length).split('/').filter(Boolean)
        : []
      if (segments.length === 0) return

      let nodes = rootNodesRef.current
      let parentNorm = rootNorm
      let changed = false
      for (const segment of segments) {
        const wanted = `${parentNorm}/${segment}`
        const node = nodes.find((n) => normalizePath(n.path) === wanted)
        if (!node || !node.isDirectory) return
        if (!node.loaded) {
          try {
            const entries = await fetchDir(node.path)
            if (cancelled) return
            node.children = makeNodes(entries)
            node.loaded = true
          } catch (err) {
            console.warn('Failed to reveal directory:', err)
            return
          }
        }
        node.expanded = true
        expandedRef.current.add(normalizePath(node.path))
        changed = true
        parentNorm = normalizePath(node.path)
        nodes = node.children ?? []
      }
      if (!cancelled && changed) {
        persistExpanded()
        setRootNodes([...rootNodesRef.current])
      }
    }
    void run()
    return () => {
      cancelled = true
    }
    // rootNodes.length is a dependency: when the panel just mounted the root is still loading
    // asynchronously and the reveal request would miss; once the root is loaded (length changes)
    // it reruns automatically. run is idempotent (expansion only) and cannot self-trigger.
  }, [revealRequest, workspacePath, fetchDir, makeNodes, persistExpanded, rootNodes.length])

  /** Disk change: refresh only the affected directories (preserving the expanded state), not the whole tree */
  useEffect(() => {
    const changes = fsEvent?.paths
    if (!changes || changes.length === 0) return
    const rootNorm = normalizePath(workspacePath)
    // Normalized path → the path actually used for listing (listing must use the original path; Windows separators must not be swapped blindly)
    const targets = new Set<string>()
    for (const changed of changes) {
      const normalized = normalizePath(changed)
      if (!normalized.startsWith(rootNorm)) continue
      targets.add(normalizePath(parentOf(changed)))
    }
    if (targets.size === 0) return
    void (async () => {
      for (const target of targets) {
        if (target === rootNorm) {
          await refreshDir(workspacePath)
          continue
        }
        const node = findNode(target)
        if (node) await refreshDir(node.path)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fsEvent?.nonce])

  const toggleExpand = useCallback(
    async (node: TreeNode) => {
      if (!node.isDirectory) {
        onOpenFile(node.path, node.name)
        return
      }
      const key = normalizePath(node.path)
      if (node.expanded) {
        node.expanded = false
        expandedRef.current.delete(key)
        persistExpanded()
        setRootNodes([...rootNodesRef.current])
        return
      }
      if (!node.loaded) {
        try {
          const entries = await fetchDir(node.path)
          node.children = makeNodes(entries)
          node.loaded = true
        } catch (err) {
          console.error('Failed to expand directory:', err)
          return
        }
      }
      node.expanded = true
      expandedRef.current.add(key)
      persistExpanded()
      setRootNodes([...rootNodesRef.current])
    },
    [fetchDir, makeNodes, onOpenFile, persistExpanded]
  )

  const titleBarBg = isDarkMode ? '#252526' : '#f3f3f3'
  const titleBarBorder = isDarkMode ? '#1e1e1e' : '#e4e4e4'
  const hoverBg = isDarkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)'
  const activeBg = isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'

  const getRelativePath = (absPath: string): string => {
    const normalizedWs = workspacePath.replace(/\\/g, '/').replace(/\/$/, '')
    const normalizedPath = absPath.replace(/\\/g, '/')
    if (normalizedPath.startsWith(normalizedWs)) {
      return normalizedPath.slice(normalizedWs.length) || '/'
    }
    return '/' + normalizedPath.replace(/^\/+/, '')
  }

  const handleDragStart = (e: React.DragEvent, node: TreeNode): void => {
    const relativePath = getRelativePath(node.path)
    e.dataTransfer.setData('text/plain', relativePath)
    e.dataTransfer.setData(
      'application/json',
      JSON.stringify({ path: relativePath, isDirectory: node.isDirectory })
    )
    e.dataTransfer.effectAllowed = 'copy'
  }

  /** Set of directories containing pending changes (parent directories show a dot, visible whether expanded or not) */
  const pendingDirs = React.useMemo(() => {
    const dirs = new Set<string>()
    if (!pendingByPath) return dirs
    for (const filePath of pendingByPath.keys()) {
      let dir = parentOf(filePath)
      const rootNorm = normalizePath(workspacePath)
      while (dir.startsWith(rootNorm) && dir.length >= rootNorm.length) {
        if (dirs.has(dir)) break
        dirs.add(dir)
        const next = parentOf(dir)
        if (next === dir) break
        dir = next
      }
    }
    return dirs
  }, [pendingByPath, workspacePath])

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const padLeft = 8 + depth * 16
    const isActiveFile = !node.isDirectory && activeFilePath === node.path
    const pendingCount = !node.isDirectory ? (pendingByPath?.get(node.path) ?? 0) : 0
    const dirPending = node.isDirectory && pendingDirs.has(normalizePath(node.path))
    return (
      <React.Fragment key={node.path}>
        <div
          draggable
          className="flex items-center gap-0.5 py-[2px] cursor-pointer select-none text-[13px]"
          style={{
            paddingLeft: padLeft,
            paddingRight: 8,
            color: colorText,
            background: isActiveFile ? activeBg : 'transparent'
          }}
          onClick={() => toggleExpand(node)}
          onDragStart={(e) => handleDragStart(e, node)}
          onMouseEnter={(e) => {
            if (!isActiveFile) e.currentTarget.style.background = hoverBg
          }}
          onMouseLeave={(e) => {
            if (!isActiveFile) e.currentTarget.style.background = 'transparent'
          }}
          title={node.path}
        >
          {node.isDirectory ? (
            <RiArrowRightSLine
              size={14}
              style={{
                color: colorTextTertiary,
                transform: node.expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.1s',
                flexShrink: 0
              }}
            />
          ) : (
            <span style={{ width: 14, flexShrink: 0 }} />
          )}
          {node.isDirectory ? (
            node.expanded ? (
              <RiFolderOpenLine size={16} style={{ color: '#dcb67a', flexShrink: 0 }} />
            ) : (
              <RiFolder3Line size={16} style={{ color: '#dcb67a', flexShrink: 0 }} />
            )
          ) : (
            (() => {
              // Icons are colored by file type (file names keep the body text color — no rainbow)
              const { Icon, color } = getFileIcon(node.path, isDarkMode)
              return (
                <Icon size={16} style={{ color, flexShrink: 0, opacity: isActiveFile ? 1 : 0.9 }} />
              )
            })()
          )}
          <span className="truncate leading-5">{node.name}</span>
          <div className="flex-1" />
          {pendingCount > 0 && (
            <span
              className="shrink-0 tabular-nums"
              style={{
                fontSize: 10,
                lineHeight: '14px',
                padding: '0 4px',
                borderRadius: 7,
                color: isDarkMode ? '#9ecf8a' : '#2f6b4f',
                background: isDarkMode ? 'rgba(120,190,140,0.16)' : 'rgba(70,150,100,0.14)'
              }}
            >
              {pendingCount}
            </span>
          )}
          {dirPending && (
            <span
              className="shrink-0"
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: isDarkMode ? '#9ecf8a' : '#4a8f5b'
              }}
            />
          )}
        </div>
        {node.expanded &&
          node.children &&
          node.children.map((child) => renderNode(child, depth + 1))}
      </React.Fragment>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: colorBgContainer }}>
      {/* Title bar */}
      <div
        className="flex items-center justify-between px-3 shrink-0"
        style={{
          height: 33,
          background: titleBarBg,
          borderBottom: `1px solid ${titleBarBorder}`
        }}
      >
        <span
          className="text-xs font-medium truncate min-w-0"
          style={{ color: colorTextSecondary, letterSpacing: '0.3px' }}
        >
          {t('harness.fileExplorer.title')}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {/* Global pending-changes entry: confirm everything at once without opening the files
              (clears all badges; disk content is untouched).
              Label wording: **file count first, change count second** — the same file edited
              several times in one task produces several records, so reporting only the record
              count reads as "that many files were touched" (user feedback 2026-09-23).
              The button itself is shrink-0 + nowrap: on a narrow panel the title may be squeezed
              out, but the entry must not wrap or be clipped. */}
          {pendingTotal > 0 && onKeepAllPending && (
            <button
              className="flex items-center gap-1 px-1.5 h-5 rounded-md transition-opacity hover:opacity-80 shrink-0 whitespace-nowrap"
              onClick={onKeepAllPending}
              title={`${t('harness.fileExplorer.keepAllTip')}\n${t('harness.fileExplorer.pendingFilesTip')}`}
              style={{
                fontSize: 10.5,
                lineHeight: '16px',
                color: isDarkMode ? '#9ecf8a' : '#2f6b4f',
                background: isDarkMode ? 'rgba(120,190,140,0.16)' : 'rgba(70,150,100,0.14)'
              }}
            >
              <RiCheckLine size={11} style={{ flexShrink: 0 }} />
              {pendingFiles > 1
                ? t('harness.fileExplorer.pendingSummary', {
                    files: t('harness.fileExplorer.pendingFiles', { count: pendingFiles }),
                    changes: t('harness.fileExplorer.pendingReview', { count: pendingTotal })
                  })
                : t('harness.fileExplorer.pendingReview', { count: pendingTotal })}
            </button>
          )}
          <button
            className="flex items-center justify-center w-6 h-6 rounded-md hover:opacity-70 transition-opacity shrink-0"
            onClick={loadRoot}
            title={t('harness.fileExplorer.refresh')}
            style={{ color: colorTextTertiary }}
          >
            <RiRefreshLine size={14} />
          </button>
        </div>
      </div>

      {/* Tree content */}
      <div className="flex-1 overflow-y-auto py-1 history-scrollbar">
        {loading ? (
          <p className="text-xs text-center py-6" style={{ color: colorTextTertiary }}>
            {t('harness.fileExplorer.loading')}
          </p>
        ) : rootNodes.length === 0 ? (
          <p className="text-xs text-center py-6" style={{ color: colorTextTertiary }}>
            {t('harness.fileExplorer.empty')}
          </p>
        ) : (
          rootNodes.map((node) => renderNode(node, 0))
        )}
      </div>
    </div>
  )
}

export default FileExplorer
