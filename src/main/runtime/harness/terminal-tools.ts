/**
 * Persistent terminal tool surface (open/send/read/close/list).
 *
 * Security boundary:
 * - `terminal_open` / `terminal_send` are **only available in `danger-full-access` mode**
 *   (the terminal is not sandboxed);
 * - `terminal_read` / `terminal_close` / `terminal_list` are not mode-restricted — reading and
 *   cleanup must always work, otherwise a running terminal could not be closed after the user
 *   switches back to a restricted mode.
 *
 * The real process and session state lives in `terminal-sessions.ts` (no electron/i18n, so
 * integration tests can drive it directly).
 */
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { mainFormat } from '../../i18n'
import { getTerminalToolTexts, type TerminalToolTexts } from '../../i18n/tool-results-terminal'
import { isPermissionMode, type PermissionMode } from './permission'
import { permissionGate } from './permission-gate'
import {
  DEFAULT_WAIT_MS,
  MAX_RESULT_CHARS,
  MAX_SESSIONS_PER_TOPIC,
  MAX_WAIT_MS,
  TERMINAL_MAX_COMMAND_CHARS,
  terminalSessions,
  type TerminalErrorCode
} from './terminal-sessions'

/** Tool runtime context: the topic and the permission mode actually in effect for this call */
function contextOf(config: unknown): { topicId: number; mode: PermissionMode } {
  const cfg = config as
    | { configurable?: { topicId?: unknown; sandboxMode?: unknown } }
    | undefined
  const topicId = typeof cfg?.configurable?.topicId === 'number' ? cfg.configurable.topicId : 0
  const injected = cfg?.configurable?.sandboxMode
  const mode = isPermissionMode(injected) ? injected : permissionGate.modeFor(topicId)
  return { topicId, mode }
}

/** Localized permission mode name */
function modeLabel(texts: TerminalToolTexts, mode: PermissionMode): string {
  if (mode === 'read-only') return texts.modeReadOnly
  if (mode === 'workspace-write') return texts.modeWorkspace
  return texts.modeDanger
}

/** Error code → localized text */
function errorText(
  texts: TerminalToolTexts,
  error: TerminalErrorCode,
  detail?: string
): string {
  switch (error) {
    case 'too-many-sessions':
      return mainFormat(texts.tooMany, { limit: MAX_SESSIONS_PER_TOPIC })
    case 'invalid-cwd':
      return mainFormat(texts.invalidCwd, { cwd: detail ?? '' })
    case 'no-shell':
      return texts.noShell
    case 'session-not-found':
      return mainFormat(texts.notFound, { id: detail ?? '' })
    case 'session-busy':
      return texts.busy
    case 'session-exited':
      return mainFormat(texts.exited, { code: detail ?? texts.none })
    case 'empty-command':
      return texts.emptyCommand
    case 'command-too-long':
      return mainFormat(texts.tooLongCommand, { max: TERMINAL_MAX_COMMAND_CHARS })
    case 'nul-command':
      return texts.nulCommand
    default:
      return mainFormat(texts.spawnFailed, { message: detail ?? texts.none })
  }
}

/** Build the persistent terminal tool set (not mounted when there is no workspace) */
export function buildTerminalTools(options: { workspacePath?: string }): StructuredToolInterface[] {
  const workspacePath = options.workspacePath
  if (!workspacePath) return []

  const terminalOpen = tool(
    async ({ cwd, shell }, config) => {
      const texts = getTerminalToolTexts()
      const { topicId, mode } = contextOf(config)
      if (mode !== 'danger-full-access') {
        return mainFormat(texts.denied, { mode: modeLabel(texts, mode) })
      }
      const result = await terminalSessions.open({
        topicId,
        workspaceRoot: workspacePath,
        cwd,
        shell
      })
      if (!result.ok) return errorText(texts, result.error, result.detail)
      return mainFormat(texts.opened, {
        id: result.session.sessionId,
        shell: result.session.shell,
        cwd: result.session.cwd
      })
    },
    {
      name: 'terminal_open',
      description:
        'Open a persistent shell session (pwsh/cmd on Windows, bash on POSIX) whose state survives between calls (cd, env vars, venv). Only available in the danger-full-access permission mode because the shell is not sandboxed. At most 3 sessions per conversation; sessions idle-time-out after 10 minutes.',
      schema: z.object({
        cwd: z
          .string()
          .optional()
          .describe('Working directory, absolute or relative to the workspace root (default: workspace root)'),
        shell: z
          .enum(['pwsh', 'cmd', 'sh'])
          .optional()
          .describe('Force a shell; omit to pick the best available one')
      })
    }
  )

  const terminalSend = tool(
    async ({ session_id, command, wait_ms }, config) => {
      const texts = getTerminalToolTexts()
      const { topicId, mode } = contextOf(config)
      void topicId
      if (mode !== 'danger-full-access') {
        return mainFormat(texts.denied, { mode: modeLabel(texts, mode) })
      }
      const sent = await terminalSessions.send(
        session_id,
        command,
        wait_ms ?? DEFAULT_WAIT_MS
      )
      if (!sent.ok) return errorText(texts, sent.error)
      const { result } = sent
      const header = mainFormat(texts.sendHeader, { id: session_id })
      const notes: string[] = []
      if (result.timedOut) notes.push(mainFormat(texts.timedOut, { wait: wait_ms ?? DEFAULT_WAIT_MS }))
      let body: string
      if (result.binary) {
        body = mainFormat(texts.binaryNote, { chars: result.output.length })
      } else {
        body = result.output.trim() === '' ? texts.outputEmpty : result.output
      }
      if (!result.timedOut && result.unreadChars > 0) {
        notes.push(mainFormat(texts.unreadNote, { chars: result.unreadChars }))
      }
      return [header, ...notes, body].join('\n\n')
    },
    {
      name: 'terminal_send',
      description:
        'Send one command to an open terminal session and wait up to wait_ms for it to finish (a completion marker is appended automatically). Returns the output of this command; if it times out the command may still be running — use terminal_read instead of resending. Only available in the danger-full-access permission mode.',
      schema: z.object({
        session_id: z.string().min(1).describe('Session id returned by terminal_open'),
        command: z
          .string()
          .min(1)
          .describe('Command line(s) to run in the session shell; multi-line is allowed'),
        wait_ms: z
          .number()
          .int()
          .min(200)
          .max(MAX_WAIT_MS)
          .optional()
          .describe(`How long to wait for completion (default ${DEFAULT_WAIT_MS}ms, max ${MAX_WAIT_MS}ms)`)
      })
    }
  )

  const terminalRead = tool(
    async ({ session_id, max_chars }) => {
      const texts = getTerminalToolTexts()
      const read = terminalSessions.read(session_id, max_chars ?? MAX_RESULT_CHARS)
      if (!read.ok) return errorText(texts, read.error, session_id)
      const header = mainFormat(texts.readHeader, { id: session_id })
      const notes: string[] = []
      if (read.truncated) notes.push(texts.readTruncated)
      if (read.droppedChars > 0) notes.push(mainFormat(texts.readDropped, { chars: read.droppedChars }))
      const body = read.binary
        ? mainFormat(texts.binaryNote, { chars: read.text.length })
        : read.text.trim() === ''
          ? texts.readEmpty
          : read.text
      return [header, ...notes, body].join('\n\n')
    },
    {
      name: 'terminal_read',
      description:
        'Read the output a terminal session produced since the last read (incremental; the session keeps a bounded ring buffer of recent output). Use it after terminal_send times out or to follow a long-running command.',
      schema: z.object({
        session_id: z.string().min(1).describe('Session id returned by terminal_open'),
        max_chars: z
          .number()
          .int()
          .min(1)
          .max(MAX_RESULT_CHARS)
          .optional()
          .describe(`Maximum characters to read (default ${MAX_RESULT_CHARS})`)
      })
    }
  )

  const terminalClose = tool(
    async ({ session_id }) => {
      const texts = getTerminalToolTexts()
      const closed = terminalSessions.close(session_id)
      return mainFormat(closed.found ? texts.closed : texts.closeNotFound, { id: session_id })
    },
    {
      name: 'terminal_close',
      description:
        'Close a terminal session and terminate its whole process tree (idempotent). Always allowed, regardless of the permission mode, so a running terminal can always be cleaned up.',
      schema: z.object({
        session_id: z.string().min(1).describe('Session id returned by terminal_open')
      })
    }
  )

  const terminalList = tool(
    async (_args, config) => {
      const texts = getTerminalToolTexts()
      const { topicId } = contextOf(config)
      const sessions = terminalSessions.list(topicId)
      if (sessions.length === 0) return texts.listEmpty
      const header = mainFormat(texts.listHeader, { count: sessions.length })
      const items = sessions.map((session) =>
        mainFormat(texts.listItem, {
          id: session.sessionId,
          shell: session.shell,
          cwd: session.cwd,
          state: session.alive ? texts.stateAlive : texts.stateDead,
          unread: session.unreadChars
        })
      )
      return [header, ...items].join('\n')
    },
    {
      name: 'terminal_list',
      description:
        'List the terminal sessions of this conversation with shell, working directory, liveness and unread output size.',
      schema: z.object({})
    }
  )

  return [terminalOpen, terminalSend, terminalRead, terminalClose, terminalList]
}
