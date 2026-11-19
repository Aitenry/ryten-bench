import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  useImperativeHandle,
  forwardRef
} from 'react'
import FileExplorer from './FileExplorer'
import FileEditor, { OpenFile } from './FileEditor'
import type { ToolDetailTab } from './ToolDetailView'
import type { FileChangeView } from '../types/file-change'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import { harnessApi } from '../api'
import { getMemoryScope } from '../memory-scope'

interface WorkspacePanelProps {
  workspacePath: string
  isDarkMode: boolean
  colorBgContainer: string
  borderRadiusLG: number
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  onHasOpenFilesChange?: (hasOpen: boolean) => void
  /**
   * 待审查改动按路径分组后回传（路径 → 条数）。
   *
   * 往上传一层是为了**任务段头那颗改动徽标**：段折起后段内的编辑卡片会被卸载，
   * 聊天里就只剩任务名——段头的徽标需要知道「这个文件还有几处没审」，
   * 而这份数据的真源在面板里（`workspace-changes-pending`）。
   */
  onPendingByPathChange?: (pending: Map<string, number>) => void
}

/** 右侧面板的对外能力（由聊天区的工具卡片经 WorkspaceBridge 调用） */
export interface WorkspacePanelHandle {
  /**
   * 打开工具卡片里的文件（虚拟路径）。工作区内的文件按真实路径打开（可保存、
   * 资源管理器同步高亮），工作区之外（如 /memories/...）以只读页签打开。
   */
  openVirtualFile: (virtualPath: string, realPath: string | null) => void
  /** 在资源管理器中定位并展开某目录（真实绝对路径） */
  revealPath: (realPath: string) => void
  /** 打开工具结果详情页签（ls / glob / grep / execute） */
  openToolDetail: (tab: Omit<ToolDetailTab, 'key' | 'name'>) => void
}

/** 从路径里取文件名（两种分隔符都吃） */
function baseName(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || filePath
}

/**
 * 右侧工作区面板：资源管理器 + 文件编辑器（编辑 / 差异审查）。
 *
 * 文件改动审查的数据流全部在这里收敛：
 * - 主进程每次记录改动都会推送 `workspace-change-recorded` → 刷新待审查列表，
 *   并把**已经打开的页签**切到差异视图（用户要求：打开文件若该文件有 diff 就显示差异）；
 * - 磁盘变化（模型写入 / 命令执行 / 外部编辑器）推送 `workspace-fs-changed` →
 *   重新读取打开着的页签内容 + 让资源管理器刷新受影响目录（都保留展开状态）；
 * - 审查动作（保留 / 撤销 / 落盘取舍结果）走主进程 IPC，成功后重取待审查列表。
 */
const WorkspacePanel = forwardRef<WorkspacePanelHandle, WorkspacePanelProps>(
  (
    {
      workspacePath,
      isDarkMode,
      colorBgContainer,
      borderRadiusLG,
      colorText,
      colorTextSecondary,
      colorTextTertiary,
      onHasOpenFilesChange,
      onPendingByPathChange
    },
    ref
  ) => {
    const { t } = useTranslation()
    const { viewMessage } = useMessage()
    const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
    const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
    /** 请求资源管理器定位到的目录（真实路径 + 递增序号；序号变化即重新展开） */
    const [revealRequest, setRevealRequest] = useState<{ path: string; nonce: number } | null>(null)
    const revealNonceRef = useRef(0)
    /** 磁盘变化事件（转发给资源管理器刷新受影响目录） */
    const [fsEvent, setFsEvent] = useState<{ nonce: number; paths: string[] } | null>(null)
    const fsNonceRef = useRef(0)
    /** 当前工作区所有待审查的文件改动 */
    const [pendingChanges, setPendingChanges] = useState<FileChangeView[]>([])
    const [explorerWidth, setExplorerWidth] = useState(220)
    const draggingRef = useRef(false)

    const hasOpenFiles = openFiles.length > 0
    /** 页签状态的实时快照：事件回调里需要读最新值，不能依赖闭包捕获 */
    const openFilesRef = useRef(openFiles)
    openFilesRef.current = openFiles

    useEffect(() => {
      onHasOpenFilesChange?.(hasOpenFiles)
    }, [hasOpenFiles, onHasOpenFilesChange])

    const readFileContent = useCallback(async (filePath: string): Promise<string> => {
      return harnessApi.workspace.readFile(filePath)
    }, [])

    /** 待审查改动按路径分组（正序：最早在前） */
    const pendingByPath = useMemo(() => {
      const map = new Map<string, FileChangeView[]>()
      for (const change of pendingChanges) {
        const list = map.get(change.path)
        if (list) list.push(change)
        else map.set(change.path, [change])
      }
      return map
    }, [pendingChanges])

    /** 资源管理器徽标：文件路径 → 待审查条数（只算 pending，已保留的不再提示） */
    const pendingCountByPath = useMemo(() => {
      const map = new Map<string, number>()
      for (const [path, list] of pendingByPath) {
        const count = list.filter((c) => c.status === 'pending').length
        if (count > 0) map.set(path, count)
      }
      return map
    }, [pendingByPath])

    /** 把「哪个文件还有几处没审」回传给上层（任务段头的改动徽标要用） */
    useEffect(() => {
      onPendingByPathChange?.(pendingCountByPath)
    }, [pendingCountByPath, onPendingByPathChange])

    const refreshPending = useCallback(async () => {
      try {
        const api = harnessApi
        const rows = await api.workspace.pendingChanges()
        setPendingChanges(rows)
      } catch (err) {
        console.error('Failed to load pending file changes:', err)
      }
    }, [])

    /** 打开页签（已打开则仅切换，避免重复读取文件） */
    const addTab = useCallback((tab: OpenFile) => {
      setOpenFiles((prev) => (prev.some((f) => f.path === tab.path) ? prev : [...prev, tab]))
      setActiveFilePath(tab.path)
    }, [])

    const handleOpenFile = useCallback(
      async (filePath: string, fileName: string) => {
        const existing = openFilesRef.current.find((f) => f.path === filePath)
        if (existing) {
          setActiveFilePath(filePath)
          return
        }
        try {
          const content = await readFileContent(filePath)
          // 有未审查的模型改动 → 直接打开差异视图（用户要求：打开文件有 diff 就显示差异）
          const hasPending = (pendingByPath.get(filePath) ?? []).some((c) => c.status === 'pending')
          addTab({
            path: filePath,
            name: fileName,
            content,
            isDirty: false,
            view: hasPending ? 'diff' : 'edit'
          })
        } catch (err) {
          console.error('Failed to open file:', err)
          viewMessage('workspace-open-file', 'error', t('harness.fileExplorer.openFailed'))
        }
      },
      [readFileContent, addTab, viewMessage, t, pendingByPath]
    )

    /**
     * 工具卡片「打开文件」：按虚拟路径读取。
     *
     * 与资源管理器打开的区别：这里走主进程的挂载解析（工作区 + 记忆目录都合法），
     * 因此 /memories/... 这类不在资源管理器里的文件也能看；工作区内的文件用真实
     * 路径做页签键（与资源管理器打开的是同一个页签，且仍可编辑保存）。
     */
    const handleOpenVirtualFile = useCallback(
      async (virtualPath: string, realPath: string | null) => {
        const key = realPath ?? virtualPath
        const existing = openFilesRef.current.find((f) => f.path === key)
        if (existing) {
          setActiveFilePath(key)
          return
        }
        try {
          // `/memories/...` 按当前会话的作用域解析（插件会话 → 这份插件自己的记忆目录），
          // 与聊天里 Runtime 的挂载口径一致
          const result = await harnessApi.harness.readVirtualFile(virtualPath, getMemoryScope())
          if ('error' in result) {
            viewMessage('workspace-open-file', 'error', result.error)
            return
          }
          addTab({
            path: key,
            name: baseName(virtualPath),
            content: result.content,
            isDirty: false,
            readOnly: !realPath
          })
        } catch (err) {
          console.error('Failed to open virtual file:', err)
          viewMessage('workspace-open-file', 'error', t('harness.fileExplorer.openFailed'))
        }
      },
      [addTab, viewMessage, t]
    )

    const handleOpenToolDetail = useCallback(
      (tab: Omit<ToolDetailTab, 'key' | 'name'>) => {
        const key = `tool:${tab.topicId}:${tab.callId}`
        const existing = openFilesRef.current.find((f) => f.path === key)
        if (existing) {
          setActiveFilePath(key)
          return
        }
        // 页签名：路径取末段（'src'），命令/模式取首行前 20 字符（命令整条太长会顶掉其它页签）
        const raw = tab.title.trim()
        const name = tab.kind === 'file' || tab.kind === 'dir' ? baseName(raw) : raw.slice(0, 20)
        const detail: ToolDetailTab = { ...tab, key, name: name || tab.kind }
        addTab({
          path: key,
          name: detail.name,
          content: '',
          isDirty: false,
          readOnly: true,
          tool: detail
        })
      },
      [addTab]
    )

    useImperativeHandle(
      ref,
      () => ({
        openVirtualFile: (virtualPath, realPath) => {
          void handleOpenVirtualFile(virtualPath, realPath)
        },
        revealPath: (realPath) => {
          revealNonceRef.current += 1
          setRevealRequest({ path: realPath, nonce: revealNonceRef.current })
        },
        openToolDetail: (tab) => handleOpenToolDetail(tab)
      }),
      [handleOpenVirtualFile, handleOpenToolDetail]
    )

    const handleCloseFile = useCallback((filePath: string) => {
      setOpenFiles((prev) => {
        const idx = prev.findIndex((f) => f.path === filePath)
        const next = prev.filter((f) => f.path !== filePath)
        setActiveFilePath((current) => {
          if (current !== filePath) return current
          if (next.length === 0) return null
          return next[Math.min(idx, next.length - 1)].path
        })
        return next
      })
    }, [])

    const handleSelectFile = useCallback((filePath: string) => {
      setActiveFilePath(filePath)
    }, [])

    const handleContentChange = useCallback((filePath: string, content: string) => {
      setOpenFiles((prev) =>
        prev.map((f) => (f.path === filePath ? { ...f, content, isDirty: true } : f))
      )
    }, [])

    const handleSaveFile = useCallback(
      async (filePath: string) => {
        const file = openFilesRef.current.find((f) => f.path === filePath)
        if (!file || file.readOnly || file.tool) return
        try {
          await harnessApi.workspace.saveFile(filePath, file.content)
          setOpenFiles((prev) =>
            prev.map((f) =>
              f.path === filePath ? { ...f, isDirty: false, diskChanged: false } : f
            )
          )
        } catch (err) {
          console.error('Failed to save file:', err)
          viewMessage('workspace-save-file', 'error', t('harness.fileExplorer.saveFailed'))
        }
      },
      [viewMessage, t]
    )

    /** 从磁盘重新读取页签内容（手动刷新 / 磁盘变化后同步） */
    const reloadTab = useCallback(
      async (filePath: string, options?: { force?: boolean }): Promise<void> => {
        const file = openFilesRef.current.find((f) => f.path === filePath)
        if (!file || file.readOnly || file.tool) return
        if (file.isDirty && !options?.force) {
          // 有未保存内容：不覆盖用户输入，只挂提示（保存时会以本地内容为准）
          setOpenFiles((prev) =>
            prev.map((f) => (f.path === filePath ? { ...f, diskChanged: true } : f))
          )
          return
        }
        try {
          const content = await readFileContent(filePath)
          setOpenFiles((prev) =>
            prev.map((f) =>
              f.path === filePath ? { ...f, content, isDirty: false, diskChanged: false } : f
            )
          )
        } catch (err) {
          console.warn('Failed to reload file:', err)
          setOpenFiles((prev) =>
            prev.map((f) => (f.path === filePath ? { ...f, diskChanged: true } : f))
          )
        }
      },
      [readFileContent]
    )

    const handleReloadFile = useCallback(
      (filePath: string) => {
        void reloadTab(filePath, { force: true })
      },
      [reloadTab]
    )

    // --- 审查动作 ---

    const handleKeepChanges = useCallback(
      async (ids: number[]) => {
        if (ids.length === 0) return
        const api = harnessApi
        await api.workspace.keepChanges(ids)
        await refreshPending()
      },
      [refreshPending]
    )

    const handleRevertChange = useCallback(
      async (id: number) => {
        const api = harnessApi
        const result = await api.workspace.revertChange(id)
        if ('error' in result) {
          viewMessage('workspace-revert-file', 'error', t('harness.fileDiff.revertFailed'))
          await refreshPending()
          return
        }
        if (result.content === null) {
          // 撤销的是「新建文件」→ 文件已被删除，页签关掉
          handleCloseFile(result.path)
        } else {
          setOpenFiles((prev) =>
            prev.map((f) =>
              f.path === result.path
                ? {
                    ...f,
                    content: result.content as string,
                    isDirty: false,
                    diskChanged: false,
                    view: 'edit',
                    changeId: null
                  }
                : f
            )
          )
        }
        await refreshPending()
      },
      [refreshPending, viewMessage, t, handleCloseFile]
    )

    /** 差异视图 Ctrl+S / 保留按钮：落盘取舍结果并标记已保留 */
    const handleApplyReview = useCallback(
      async (filePath: string, content: string) => {
        const api = harnessApi
        const result = await api.workspace.applyReview(filePath, content)
        if ('error' in result) {
          viewMessage('workspace-apply-review', 'error', t('harness.fileDiff.applyFailed'))
          return
        }
        setOpenFiles((prev) =>
          prev.map((f) =>
            f.path === filePath
              ? { ...f, content, isDirty: false, diskChanged: false, view: 'edit', changeId: null }
              : f
          )
        )
        await refreshPending()
      },
      [refreshPending, viewMessage, t]
    )

    const handleChangeView = useCallback((filePath: string, view: 'edit' | 'diff') => {
      setOpenFiles((prev) => prev.map((f) => (f.path === filePath ? { ...f, view } : f)))
    }, [])

    const handleSelectChange = useCallback((filePath: string, changeId: number) => {
      setOpenFiles((prev) =>
        prev.map((f) => (f.path === filePath ? { ...f, view: 'diff', changeId } : f))
      )
    }, [])

    /** Markdown 页签：所见即所得 ↔ 源码 */
    const handleSetMarkdownSource = useCallback((filePath: string, source: boolean) => {
      setOpenFiles((prev) =>
        prev.map((f) => (f.path === filePath ? { ...f, markdownSource: source } : f))
      )
    }, [])

    /**
     * 主进程事件回调（只订阅一次，经 ref 取最新实现，避免闭包过期）。
     */
    const eventHandlersRef = useRef<{
      onFsChanged: (data: {
        changes: { path: string; exists: boolean; isDirectory: boolean }[]
      }) => void
      onChangeRecorded: (change: FileChangeView) => void
      onChangesUpdated: (data: {
        ids: number[]
        status: string
        path?: string
        obsolete?: number
      }) => void
    }>({
      onFsChanged: () => {},
      onChangeRecorded: () => {},
      onChangesUpdated: () => {}
    })

    eventHandlersRef.current.onFsChanged = (data) => {
      const paths = data.changes.map((c) => c.path)
      fsNonceRef.current += 1
      setFsEvent({ nonce: fsNonceRef.current, paths })
      for (const change of data.changes) {
        if (change.isDirectory) continue
        void reloadTab(change.path)
      }
    }

    eventHandlersRef.current.onChangeRecorded = (change) => {
      setPendingChanges((prev) => (prev.some((c) => c.id === change.id) ? prev : [...prev, change]))
      fsNonceRef.current += 1
      setFsEvent({ nonce: fsNonceRef.current, paths: [change.path] })
      // 已打开的页签：内容同步为磁盘最新，并切到差异视图等用户审查
      const file = openFilesRef.current.find((f) => f.path === change.path)
      if (!file || file.readOnly || file.tool) return
      if (file.isDirty) {
        setOpenFiles((prev) =>
          prev.map((f) => (f.path === change.path ? { ...f, diskChanged: true } : f))
        )
        return
      }
      void readFileContent(change.path)
        .then((content) => {
          setOpenFiles((prev) =>
            prev.map((f) =>
              f.path === change.path
                ? {
                    ...f,
                    content,
                    isDirty: false,
                    diskChanged: false,
                    view: 'diff',
                    changeId: change.id
                  }
                : f
            )
          )
        })
        .catch(() => undefined)
    }

    eventHandlersRef.current.onChangesUpdated = (data) => {
      void refreshPending()
      // 撤销后文件内容由主进程改回，页签内容需要重新读取（revert 已单独处理内容）
      if (data.status === 'reverted' && data.path) {
        const file = openFilesRef.current.find((f) => f.path === data.path)
        if (file && !file.isDirty) void reloadTab(data.path, { force: true })
      }
    }

    useEffect(() => {
      const api = harnessApi
      const offFs = api.workspace.onFsChanged((data) => eventHandlersRef.current.onFsChanged(data))
      const offRecorded = api.workspace.onChangeRecorded((change) =>
        eventHandlersRef.current.onChangeRecorded(change)
      )
      const offUpdated = api.workspace.onChangesUpdated((data) =>
        eventHandlersRef.current.onChangesUpdated(data)
      )
      void refreshPending()
      return () => {
        offFs()
        offRecorded()
        offUpdated()
      }
    }, [refreshPending])

    // 工作区切换：清空页签与待审查列表（新工作区的文件路径完全不同）
    useEffect(() => {
      setOpenFiles([])
      setActiveFilePath(null)
      setPendingChanges([])
      void refreshPending()
    }, [workspacePath, refreshPending])

    const handleResizerMouseDown = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault()
        draggingRef.current = true
        const startX = e.clientX
        const startWidth = explorerWidth

        const handleMouseMove = (ev: MouseEvent): void => {
          if (!draggingRef.current) return
          const newWidth = Math.min(300, Math.max(220, startWidth - (ev.clientX - startX)))
          setExplorerWidth(newWidth)
        }

        const handleMouseUp = (): void => {
          draggingRef.current = false
          document.removeEventListener('mousemove', handleMouseMove)
          document.removeEventListener('mouseup', handleMouseUp)
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
        }

        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        document.addEventListener('mousemove', handleMouseMove)
        document.addEventListener('mouseup', handleMouseUp)
      },
      [explorerWidth]
    )

    return (
      <div
        className="flex h-full overflow-hidden"
        style={{
          background: colorBgContainer,
          borderRadius: borderRadiusLG
        }}
      >
        <style>{`
        .workspace-resizer {
          width: 6px;
          cursor: col-resize;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
        }
        .workspace-resizer-dragger {
          width: 2px;
          height: calc(100% - 16px);
          border-radius: 1px;
          background: ${isDarkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'};
          transition: background 0.15s;
        }
        .workspace-resizer:hover .workspace-resizer-dragger {
          background: ${isDarkMode ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)'};
        }
        /* 编辑器宿主：让 CodeMirror 撑满容器（@uiw/react-codemirror 的外层 div） */
        .cm-file-editor-host { height: 100%; }
        .cm-file-editor-host .cm-editor { height: 100%; }
      `}</style>
        {/* When files are open → editor (flex-1) + resizer + explorer (fixed width) */}
        {/* When no files open → explorer takes full width, editor hidden */}
        {hasOpenFiles && (
          <>
            <div className="flex-1 min-w-0 overflow-hidden">
              <FileEditor
                openFiles={openFiles}
                activeFilePath={activeFilePath}
                isDarkMode={isDarkMode}
                colorBgContainer={colorBgContainer}
                colorText={colorText}
                colorTextSecondary={colorTextSecondary}
                colorTextTertiary={colorTextTertiary}
                pendingByPath={pendingByPath}
                onCloseFile={handleCloseFile}
                onSelectFile={handleSelectFile}
                onContentChange={handleContentChange}
                onSaveFile={handleSaveFile}
                onChangeView={handleChangeView}
                onSelectChange={handleSelectChange}
                onKeepChanges={handleKeepChanges}
                onRevertChange={handleRevertChange}
                onApplyReview={handleApplyReview}
                onReloadFile={handleReloadFile}
                onSetMarkdownSource={handleSetMarkdownSource}
              />
            </div>

            <div className="workspace-resizer" onMouseDown={handleResizerMouseDown}>
              <div className="workspace-resizer-dragger" />
            </div>
          </>
        )}

        <div
          style={{
            width: hasOpenFiles ? explorerWidth : '100%',
            flexShrink: 0
          }}
        >
          <FileExplorer
            workspacePath={workspacePath}
            isDarkMode={isDarkMode}
            colorBgContainer={colorBgContainer}
            colorText={colorText}
            colorTextSecondary={colorTextSecondary}
            colorTextTertiary={colorTextTertiary}
            onOpenFile={handleOpenFile}
            activeFilePath={activeFilePath}
            revealRequest={revealRequest}
            pendingByPath={pendingCountByPath}
            pendingTotal={pendingChanges.filter((c) => c.status === 'pending').length}
            /* 文件数是主口径：pendingTotal 是「改动记录条数」，同一文件改多次会累加 */
            pendingFiles={pendingCountByPath.size}
            onKeepAllPending={() =>
              void handleKeepChanges(
                pendingChanges.filter((c) => c.status === 'pending').map((c) => c.id)
              )
            }
            fsEvent={fsEvent}
          />
        </div>
      </div>
    )
  }
)

WorkspacePanel.displayName = 'WorkspacePanel'

export default WorkspacePanel
