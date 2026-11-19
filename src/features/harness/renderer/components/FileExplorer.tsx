import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  RiFolder3Line,
  RiFolderOpenLine,
  RiArrowRightSLine,
  RiRefreshLine,
  RiCheckLine
} from '@remixicon/react'
import { getFileIcon } from '../utils/fileIcons'
import { useTranslation } from '@renderer/i18n'
import { harnessApi } from '../api'

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
   * 请求定位到的（真实绝对）路径：变化即逐级展开目录树并高亮。
   * 由工具卡片（ls）触发——「在资源管理器中查看这个目录」。
   * 带 nonce：同一目录被再次请求时（用户收起树后又点了一次卡片）也要重新展开。
   */
  revealRequest?: { path: string; nonce: number } | null
  /** 有待审查改动的文件 → 改动条数（文件行显示计数，父目录显示圆点） */
  pendingByPath?: Map<string, number>
  /** 待审查改动总数（>0 时标题栏显示入口，可一次性全部保留） */
  pendingTotal?: number
  /**
   * 有待审查改动的**文件数**（>1 时标题栏同时报出来）。
   *
   * 为什么必须有它：pendingTotal 是**改动记录条数**（模型每次写改各记一条），
   * 一个文件改 10 次就是 10——只报这个数会让人以为动了 10 个文件
   * （用户 2026-09-23：「明明就编辑了一个文件，这里显示 10 个」）。
   */
  pendingFiles?: number
  /** 全部保留（清掉所有待审查标记，磁盘内容不变） */
  onKeepAllPending?: () => void
  /**
   * 磁盘变化事件（模型写入 / 命令执行 / 外部编辑器）：只刷新受影响的目录，
   * 且**保留展开状态**——这正是「刷新后折叠内容又被收起来」的修复点。
   */
  fsEvent?: { nonce: number; paths: string[] } | null
}

interface TreeNode extends FileEntry {
  children: TreeNode[] | null
  expanded: boolean
  loaded: boolean
}

/** 展开状态持久化的键（按工作区隔离） */
function storageKey(workspacePath: string): string {
  return `workspace-explorer:${workspacePath.replace(/\\/g, '/')}`
}

/** 路径归一化（比较用：统一正斜杠、去尾斜杠、Windows 大小写不敏感） */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 取父目录（归一化后） */
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
  /** 树的当前快照：定位（revealPath）需要在不触发额外渲染的前提下逐级读取/装载子节点 */
  const rootNodesRef = useRef<TreeNode[]>([])
  rootNodesRef.current = rootNodes
  /**
   * 已展开目录集合（绝对路径，归一化后比较）。
   * 这是展开状态的**单一真源**：刷新（手动 / 磁盘变化）后按它逐级恢复，
   * 不再依赖树节点自身的 expanded 标记（重新列目录会把节点整个换掉）。
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

  /** 展开状态落盘（防抖：连续展开多个目录只写一次） */
  const persistExpanded = useCallback(() => {
    if (!workspacePath) return
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      try {
        localStorage.setItem(storageKey(workspacePath), JSON.stringify([...expandedRef.current]))
      } catch {
        // 存储不可用（隐私模式等）时静默失败：内存里的展开状态仍然有效
      }
    }, 200)
  }, [workspacePath])

  // 卸载（切换工作区 / 关闭面板 / 应用退出）时把待写的展开状态立刻落盘，
  // 否则刚展开目录就关掉面板，下次打开又变回「全部收起」
  useEffect(() => {
    return () => {
      if (saveTimerRef.current === null || !workspacePath) return
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      try {
        localStorage.setItem(storageKey(workspacePath), JSON.stringify([...expandedRef.current]))
      } catch {
        // 同上：存储不可用时忽略
      }
    }
  }, [workspacePath])

  /** 按已保存的展开集合逐级恢复（只加载展开路径上的目录） */
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
            // 目录可能已被删除：跳过，保留父级
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
   * 重新加载根目录（刷新按钮 / 根目录变化）。
   * 关键：**保留展开状态**——按 expandedRef 重新逐级装载并展开，
   * 这是用户报的「刷新资源管理器后折叠内容又被收起来」的直接修复。
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
      // 目录被删/权限异常时此前无 catch,会产生未处理 rejection 且界面只剩空白
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

  // 工作区变化：先读回该工作区的展开状态，再加载根目录
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
      // 解析失败按「全部收起」处理
    }
    const cancel = loadRoot()
    return cancel
  }, [workspacePath, loadRoot])

  /** 在树里按路径找目录节点 */
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
   * 重新列出某个目录并合并结果：
   * 仍在的条目**复用原节点对象**（展开状态、已装载的子节点都不丢），
   * 新增的条目插入，消失的条目移除。这样磁盘变化刷新不会把树折叠回去。
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
   * 定位（工具卡片 ls 点开）：从根出发逐级找到目标目录并展开。
   *
   * 比较路径时统一正斜杠——工作区路径与主进程返回的子路径在 Windows 上都是反斜杠，
   * 但渲染层手里的目标路径来自虚拟路径拼接，两边的分隔符不保证一致。
   * 未装载过的层级就地装载（与 toggleExpand 同一套 fetchDir），最后整体刷新一次。
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
    // rootNodes.length 进依赖：面板刚挂载时根目录还在异步加载，定位请求会扑空；
    // 根节点装载完成后（长度变化）自动重跑一次。run 是幂等的（只做展开），不会自激。
  }, [revealRequest, workspacePath, fetchDir, makeNodes, persistExpanded, rootNodes.length])

  /** 磁盘变化：只刷新涉事目录（保留展开状态），不整树重载 */
  useEffect(() => {
    const changes = fsEvent?.paths
    if (!changes || changes.length === 0) return
    const rootNorm = normalizePath(workspacePath)
    // 归一化路径 → 实际用于列目录的路径（列目录必须用原样路径，Windows 分隔符不能想当然地换掉）
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

  /** 待审查改动所在目录集合（父目录显示圆点，展开与否都能看到） */
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
              // 图标按文件类型着色（文件名保持正文色，不做彩虹）
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
          height: 35,
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
          {/* 待审查改动总入口：不打开文件也能一次性确认（清掉所有徽标，磁盘内容不动）。
              文案口径：**文件数在前、改动条数在后**——同一次任务里同一个文件被改多次
              会产生多条记录，只报条数会被读成「动了这么多文件」（用户 2026-09-23）。
              按钮自身 shrink-0 + nowrap：面板窄时宁可把标题挤掉，也不让入口折行/被裁掉。 */}
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
