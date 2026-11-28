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
import type { FileChangeView } from '../../types/harness/file-change'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import { harnessApi } from '../../api/harness'
import { getMemoryScope } from '../../utils/harness/memory-scope'

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
   * Pending changes grouped by path, passed back to the parent (path → count).
   *
   * They are bubbled up for the **change badge in the task section header**: once a section is
   * folded its edit cards are unmounted, leaving only the task name in the chat, yet the section
   * header badge still needs to know how many changes a file has left unreviewed — and the source
   * of truth for that data lives in this panel (`workspace-changes-pending`).
   */
  onPendingByPathChange?: (pending: Map<string, number>) => void
}

/** Public capabilities of the right-hand panel (invoked from chat-area tool cards via WorkspaceBridge) */
export interface WorkspacePanelHandle {
  /**
   * Open a file from a tool card (virtual path). Files inside the workspace open by real path
   * (saveable, explorer highlight kept in sync); files outside it (e.g. /memories/...) open as
   * read-only tabs.
   */
  openVirtualFile: (virtualPath: string, realPath: string | null) => void
  /** Reveal and expand a directory in the explorer (real absolute path) */
  revealPath: (realPath: string) => void
  /** Open a tool result detail tab (ls / glob / grep / execute) */
  openToolDetail: (tab: Omit<ToolDetailTab, 'key' | 'name'>) => void
}

/** Extract the file name from a path (handles both separators) */
function baseName(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || filePath
}

/**
 * Right-hand workspace panel: file explorer + file editor (edit / diff review).
 *
 * All file-change review data flow converges here:
 * - Each change recorded by the main process pushes `workspace-change-recorded` → the pending
 *   list refreshes, and **already-open tabs** switch to the diff view (requirement: opening a
 *   file that has a diff shows the diff);
 * - Disk changes (model writes / command execution / external editors) push
 *   `workspace-fs-changed` → open tabs are re-read and the explorer refreshes the affected
 *   directories (both keep their expansion state);
 * - Review actions (keep / revert / apply review result) go through main-process IPC, then the
 *   pending list is refetched.
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
    /** Directory the explorer was asked to reveal (real path + incrementing nonce; a new nonce re-expands it) */
    const [revealRequest, setRevealRequest] = useState<{ path: string; nonce: number } | null>(null)
    const revealNonceRef = useRef(0)
    /** Disk change event (forwarded to the explorer to refresh affected directories) */
    const [fsEvent, setFsEvent] = useState<{ nonce: number; paths: string[] } | null>(null)
    const fsNonceRef = useRef(0)
    /** All pending file changes in the current workspace */
    const [pendingChanges, setPendingChanges] = useState<FileChangeView[]>([])
    const [explorerWidth, setExplorerWidth] = useState(220)
    const draggingRef = useRef(false)

    const hasOpenFiles = openFiles.length > 0
    /** Live snapshot of tab state: event callbacks need the latest value and cannot rely on closure capture */
    const openFilesRef = useRef(openFiles)
    openFilesRef.current = openFiles

    useEffect(() => {
      onHasOpenFilesChange?.(hasOpenFiles)
    }, [hasOpenFiles, onHasOpenFilesChange])

    const readFileContent = useCallback(async (filePath: string): Promise<string> => {
      return harnessApi.workspace.readFile(filePath)
    }, [])

    /** Pending changes grouped by path (in insertion order: oldest first) */
    const pendingByPath = useMemo(() => {
      const map = new Map<string, FileChangeView[]>()
      for (const change of pendingChanges) {
        const list = map.get(change.path)
        if (list) list.push(change)
        else map.set(change.path, [change])
      }
      return map
    }, [pendingChanges])

    /** Explorer badge: file path → pending count (pending only; kept changes are no longer flagged) */
    const pendingCountByPath = useMemo(() => {
      const map = new Map<string, number>()
      for (const [path, list] of pendingByPath) {
        const count = list.filter((c) => c.status === 'pending').length
        if (count > 0) map.set(path, count)
      }
      return map
    }, [pendingByPath])

    /** Report "how many changes a file still has unreviewed" to the parent (used by the task section header badge) */
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

    /** Open a tab (switch only if already open, avoiding a redundant file read) */
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
          // Unreviewed model changes exist → open the diff view directly (requirement: opening a file that has a diff shows the diff)
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
     * Tool card "open file": read by virtual path.
     *
     * Differs from opening through the explorer: this goes through the main-process mount
     * resolution (both the workspace and the memory directory are valid), so files such as
     * /memories/... that are not in the explorer can also be viewed; files inside the workspace
     * use the real path as the tab key (the same tab as opening from the explorer, and still
     * editable and saveable).
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
          // `/memories/...` resolves against the current session's scope (a plugin session → that
          // plugin's own memory directory), matching the Runtime mount semantics used in chat
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
        // Tab name: take the last segment for paths ('src'), the first 20 chars of the first line for commands/patterns (a whole command is too long and crowds out other tabs)
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

    /** Re-read a tab's content from disk (manual refresh / sync after a disk change) */
    const reloadTab = useCallback(
      async (filePath: string, options?: { force?: boolean }): Promise<void> => {
        const file = openFilesRef.current.find((f) => f.path === filePath)
        if (!file || file.readOnly || file.tool) return
        if (file.isDirty && !options?.force) {
          // Unsaved content exists: do not overwrite the user's input, only flag it (saving uses the local content)
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

    // --- Review actions ---

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
          // Reverting a "new file" → the file has been deleted, so close the tab
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

    /** Diff view Ctrl+S / keep button: apply the review result to disk and mark it as kept */
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

    /** Markdown tab: WYSIWYG ↔ source */
    const handleSetMarkdownSource = useCallback((filePath: string, source: boolean) => {
      setOpenFiles((prev) =>
        prev.map((f) => (f.path === filePath ? { ...f, markdownSource: source } : f))
      )
    }, [])

    /**
     * Main-process event callbacks (subscribed once; the latest implementation is read through a
     * ref so callbacks never go stale).
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
      // Already-open tab: sync its content to the latest on disk and switch to the diff view for review
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
      // After a revert the main process restores the file content, so tab content must be re-read (revert handles content separately)
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

    // Workspace switch: clear tabs and the pending list (the new workspace has entirely different file paths)
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
        data-workspace-panel="1"
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
        /* Editor host: let CodeMirror fill the container (the outer div from @uiw/react-codemirror) */
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
            /* File count is the primary metric: pendingTotal is the count of "change records", which accumulates when one file changes repeatedly */
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
