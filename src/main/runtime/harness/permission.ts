/**
 * **Pure logic** of the sandbox permission policy (zero imports; loadable directly by node for
 * offline regression).
 *
 * Why a separate file: the policy is the source of truth for "under which mode, which call
 * should be allowed / asked / denied", and it is the most likely to drift silently with later
 * changes (one more tool or verb changes what gets intercepted). Decisions must be assertable
 * offline, while permission-gate.ts (approval queue + tool wrapping) needs electron/electron-store,
 * so the rules live here: nothing is imported, and tests can simply `import` this file.
 *
 * Mode semantics:
 * - `read-only`          denies all writes and destructive commands; the model may request a
 *                        one-off exception via "escalation retry";
 * - `workspace-write`    reads/writes inside the workspace and ordinary commands run directly;
 *                        out-of-bounds or dangerous operations prompt the user first;
 * - `danger-full-access` no more interception (switching into it itself requires a risk confirmation).
 *
 * Relationship with the other half (enforcement in the execution layer):
 * The execution layer uses an OS-level sandbox (Linux Landlock/bwrap, macOS Seatbelt, Windows
 * restricted-token ACLs) to block out-of-bounds writes from child processes at the kernel level.
 * This project also has a **cross-platform sandbox service** (`sandbox/`: Windows restricted
 * token + capability SID + DACL, Linux Landlock launcher / bubblewrap, macOS sandbox-exec); the
 * real write boundary is enforced by it, and execution is **refused** when no backend is
 * available (fail closed). The command risk checks (regexes) in this file therefore **only serve
 * the "approval hint layer"**: surfacing "looks dangerous" commands for the user to approve in
 * advance (destructive deletes, out-of-bounds paths, publishing/force-push, download-and-execute);
 * they do not enforce — constructs they miss are caught by the sandbox, and false positives
 * merely ask once more.
 */

/* ────────────────────────── Modes ────────────────────────── */

/** Permission modes */
export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** All modes (rendered in this order by the settings dropdown and selector) */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access'
]

/** Default mode: modify inside the workspace */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'workspace-write'

/** Narrows mode validity (values read from config/database may be dirty and always fall back to the default) */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
}

/** Normalizes dirty values: use the default when not a valid mode (never throw — broken settings should not prevent a conversation from starting) */
export function normalizeMode(value: unknown): PermissionMode {
  return isPermissionMode(value) ? value : DEFAULT_PERMISSION_MODE
}

/**
 * Table of strictly wider modes (escalation can only move up this ladder).
 *
 * Why a closed table: `read-only` can escalate to `workspace-write` or `danger-full-access`,
 * while `workspace-write` can only escalate to `danger-full-access`; "downgrade" and "retry in
 * place" are not escalations and are always rejected **without bothering the user** (no
 * approval dialog), otherwise the model could turn the dialog into noise by requesting repeatedly.
 */
export function widerModes(mode: PermissionMode): PermissionMode[] {
  const order: PermissionMode[] = ['read-only', 'workspace-write', 'danger-full-access']
  const index = order.indexOf(mode)
  return index < 0 ? [] : order.slice(index + 1)
}

/** Whether this is a "strictly wider" escalation target */
export function isStrictlyWider(next: PermissionMode, current: PermissionMode): boolean {
  return widerModes(current).includes(next)
}

/* ────────────────────────── Tool classification ────────────────────────── */

/**
 * The tool's category on the permission plane:
 * - `read`     read-only / no side effects (reading files, search, todo lists, goals, background
 *              jobs, questions, memory reads and writes, ...);
 * - `write`    writes workspace files (virtual paths are already constrained to the workspace by
 *              the mount table);
 * - `exec`     runs shell commands (the only capability that can reach outside the workspace);
 * - `code`     **builds/executes "model-written code"** (the plugin workshop's build/verify/
 *              publish: verify `require`s the model-produced `main.cjs` in the main process and
 *              runs `install`; build/publish also install it into the app) — under restricted
 *              modes the user must confirm every time;
 * - `external` external tools with unknown semantics (MCP servers / plugin-contributed tools) —
 *              whether they are read-only cannot be determined.
 */
export type ToolAccess = 'read' | 'write' | 'exec' | 'code' | 'external'

/** Write tools (in-workspace writes are covered by the mount table; the permission plane only decides whether writing is allowed under this mode) */
const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'str_replace_editor',
  // Persistent terminal: open/send execute arbitrary commands as the user (the tool layer already restricts them to the danger mode)
  'terminal_open',
  'terminal_send',
  // PTC: model-written JS runs in-process (the tool layer already restricts it to the danger mode)
  'run_code',
  // Plugin workshop: draft reads/writes happen in the workshop's own directory, but still count as "write"; the read-only mode should deny them
  'plugin_draft'
])

/**
 * Tools that build/execute "model-written code" (plugin workshop).
 *
 * Why they cannot be allowed as `external` (unknown tools): `plugin_verify` runs `require` +
 * `install(ctx)` on the draft's `main.cjs`, i.e. **executes model-written code in the main
 * process with full user privileges**; `plugin_build` / `plugin_publish` build it and install it
 * into the app. Under the old classification they were in neither WRITE_TOOLS nor READ_TOOLS,
 * fell into `external`, and were judged allow under the default `workspace-write` mode —
 * bypassing the isolation that mode should provide. They are explicitly required to get
 * per-call user approval here.
 */
const CODE_EXEC_TOOLS = new Set(['plugin_build', 'plugin_verify', 'plugin_publish'])

/** Exec tools */
const EXEC_TOOLS = new Set(['execute'])

/**
 * Read-only / side-effect-free tool allowlist.
 *
 * Deliberately **enumerated** instead of guessing by name prefix (`read_*`/`get_*`):
 * `mnemon_remember`, `write_todos` and the like contain write verbs but write the app's own data
 * (memory / todo lists), not "the user's files", so they belong to the read-only plane;
 * conversely, any name not enumerated here falls into `external` (unknown = conservative).
 */
const READ_TOOLS = new Set([
  // File reading and search
  'read_file',
  'read_image',
  'read_document',
  'ls',
  'glob',
  'grep',
  // Historical session search (read-only)
  'session_search',
  'conversation_read',
  'conversation_list',
  // Persistent terminal reads/cleanup (open/send are writes; reading and closing are always allowed)
  'terminal_read',
  'terminal_close',
  'terminal_list',
  // Model route list (read-only)
  'list_subagent_models',
  // Action cards (read-only: show the options to the user)
  'propose_action',
  // Local tools
  'get_time',
  'get_weather',
  // Network (read-only network calls, no local state changes)
  'web_fetch',
  'web_search',
  // MCP resource reads (read-only)
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  // Skill loading (reads the skill directory, does not write user data)
  'skill',
  // Deliverable declaration: only checks that files exist, does not modify files
  'present',
  // Scheduled tasks: write the app's own scheduling data, not user files
  'schedule_create',
  'schedule_list',
  'schedule_view',
  'schedule_edit',
  // Interaction and orchestration
  'ask_user_question',
  // Plan review: only submits a plan to the user, does not modify files (same interaction plane as questions)
  'exit_plan_mode',
  'write_todos',
  'read_todos',
  'create_goal',
  'get_goal',
  'update_goal',
  'job_list',
  'job_output',
  'job_kill',
  'send_message',
  'interrupt_agent',
  'list_agents',
  'task',
  'workflow',
  // Team task board: writes the app's own board data, not user files
  'team_task_create',
  'team_task_claim',
  'team_task_get',
  'team_task_list',
  'team_task_update',
  // Memory (writes the app's own memory directory, not the user workspace)
  'mnemon_memory_bodies',
  'mnemon_recall',
  'mnemon_related',
  'mnemon_status',
  'mnemon_document_search',
  'mnemon_runtime_memory',
  'mnemon_document_manage',
  'mnemon_document_create',
  'mnemon_remember',
  'mnemon_link',
  'mnemon_forget',
  'mnemon_memory_body_create',
  'mnemon_memory_body_update',
  'mnemon_memory_body_merge'
])

/** Classifies a tool by name; unknown names fall into `external` (MCP/plugin tools take this path) */
export function classifyTool(name: string): ToolAccess {
  if (CODE_EXEC_TOOLS.has(name)) return 'code'
  if (WRITE_TOOLS.has(name)) return 'write'
  if (EXEC_TOOLS.has(name)) return 'exec'
  if (READ_TOOLS.has(name)) return 'read'
  return 'external'
}

/* ────────────────────────── Static command risk inspection ────────────────────────── */

/**
 * Risk categories (**structured reason codes**; texts are rendered by the caller per UI
 * language — this module produces no natural language).
 */
export type CommandRiskCode =
  /** Privilege escalation (sudo / runas / Start-Process -Verb RunAs) */
  | 'privilege'
  /** System-level configuration: registry, services, user accounts, scheduled tasks, disks, boot configuration */
  | 'system-config'
  /** Process and power control: killing processes, shutdown/restart */
  | 'process-control'
  /** Pushing data out: publishing packages, force-pushing to a remote */
  | 'exfiltrate'
  /** Download-and-execute: piping into an interpreter, Invoke-Expression, encoded commands */
  | 'download-exec'
  /** Destructive APIs in inline code (python -c / node -e etc.; cannot be fully inspected statically, so block conservatively) */
  | 'inline-code'
  /** Paths outside the workspace in the command (absolute paths, UNC, home directory, environment variable expansion) */
  | 'outside-path'
  /** Irreversible recursive deletes / hard resets inside the workspace */
  | 'destructive-workspace'

/** Command risk result */
export interface CommandRisk {
  risky: boolean
  code?: CommandRiskCode
  /** The matched snippet that triggered the decision (shows users "what triggered it" and supports test assertions) */
  evidence?: string
}

/** Risk-free singleton (avoids allocating an object every time) */
const SAFE: CommandRisk = { risky: false }

/** Returns the first matching snippet (for evidence display) */
function firstMatch(text: string, re: RegExp): string | undefined {
  const m = re.exec(text)
  return m ? m[0] : undefined
}

/** Table of patterns where a match is immediately dangerous (unconditionally dangerous constructs that need no path check) */
const UNCONDITIONAL_RISKS: { code: CommandRiskCode; re: RegExp }[] = [
  // Privilege escalation: commands in normal user space should not require administrator rights
  { code: 'privilege', re: /\b(sudo|runas)\b|Start-Process\b[^\n]*-Verb\s+RunAs/i },
  // System-level configuration
  {
    code: 'system-config',
    re: /\b(reg(\.exe)?\s+(add|delete|import|load|save|restore|copy)|sc(\.exe)?\s+(config|create|delete|start|stop|failure)|net(\.exe)?\s+(user|localgroup|share|accounts)|netsh|bcdedit|vssadmin|diskpart|schtasks|Set-ExecutionPolicy|Enable-PSRemoting|Disable-PSRemoting|New-LocalUser|Add-LocalGroupMember|takeown|icacls|cacls|attrib|setx|wmic\b[^\n]*\b(delete|call|set)\b|Set-ItemProperty\b[^\n]*(HKLM|HKCU|HKCR|Registry::)|New-ItemProperty\b[^\n]*(HKLM|HKCU|HKCR|Registry::))\b/i
  },
  // Process and power control
  {
    code: 'process-control',
    re: /\b(taskkill|Stop-Process|Stop-Service|Stop-Computer|Restart-Computer|shutdown|pkill|killall)\b|\bkill\s+-9\b/i
  },
  // Push data out (irreversible)
  {
    code: 'exfiltrate',
    re: /\b(npm|pnpm|yarn|bun)\s+publish\b|\bgit\s+push\b[^\n]*(--force|-f\b)|\bgit\s+push\b|\bgh\s+release\b|\btwine\s+upload\b/i
  },
  // Download-and-execute / pipe to an interpreter / encoded commands
  {
    code: 'download-exec',
    re: /\|\s*(iex|Invoke-Expression|powershell|pwsh|cmd|bash|sh|node|python3?)\b|\b(iex|Invoke-Expression)\b|-EncodedCommand\b|\|\s*Out-String\b[^\n]*\|\s*iex/i
  },
  // Destructive APIs in inline code (cannot be fully inspected statically, block conservatively)
  {
    code: 'inline-code',
    re: /(-c\s*["']|-e\s*["']|-Command\s*["'])[^\n]*\b(rmtree|unlink|os\.remove|shutil|subprocess|popen|os\.system|exec\(|eval\(|open\([^\n]*["'][wa]|Remove-Item|Stop-Process|Start-Process|Invoke-WebRequest|Invoke-RestMethod|requests\.(get|post)|urllib|socket|child_process|fs\.(rm|unlink|writeFile))\b/i
  }
]

/** Environment variable expansion: always treated as outside the workspace (%TEMP% and the like included — ask once more rather than miss it) */
const ENV_PATH_RE =
  /(%(USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|SystemRoot|SystemDrive|ProgramFiles|ProgramData|HOMEPATH|HOMEDRIVE)%)|(\$env:[A-Za-z_]+)|(\$\{?(HOME|USERPROFILE|APPDATA)\}?)/i

/** Delete verbs (upgraded to dangerous when combined with recursion/wildcards/root targets) */
const DELETE_VERB_RE =
  /\b(del|erase|rmdir|rd|rm|remove-item|ri|shutil\.rmtree|rmtree|unlink|clear-content)\b/i

/** Recursive / force / wildcard flags (only "irreversible large-scale delete" when they co-occur with a delete verb) */
const RECURSIVE_FLAG_RE =
  /(\s-[a-z]*r[a-z]*\b|\s\/s\b|--recursive|-Recurse|-Force|\s-[a-z]*f[a-z]*\b|\*)/i

/** git operations that lose uncommitted work */
const DESTRUCTIVE_GIT_RE = /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*[fd]|checkout\s+(--\s+)?\.)\b/i

/**
 * Path token check: is this token a path outside the workspace?
 *
 * Conservative principle: return false only when it is **certain to be inside the workspace**
 * (relative paths are resolved with cwd = workspace). Single-letter switches such as `/s`, `-rf`
 * are not path tokens.
 */
function isOutsidePathToken(token: string, workspaceRoot?: string): boolean {
  // Strip surrounding quotes and trailing punctuation
  const raw = token.replace(/^["'`]+|["'`,;)]+$/g, '')
  if (!raw) return false
  // Switch: /s /q -rf --flag /p:Name
  if (/^-/.test(raw)) return false
  if (/^\/[A-Za-z](:|\b)/.test(raw) && raw.split('/').length === 2) return false

  // Environment variable expansion
  if (ENV_PATH_RE.test(raw)) return true
  // Home directory
  if (raw === '~' || /^~[\\/]/.test(raw)) return true
  // UNC (\\server\share) and //server/share
  if (/^(\\\\|\/\/)[^\\/]/.test(raw)) return true

  const driveQualified = /^[A-Za-z]:[\\/]/.test(raw)
  if (driveQualified) {
    if (!workspaceRoot) return true
    const norm = (p: string): string =>
      p
        .replace(/[\\/]+/g, '\\')
        .replace(/\\+$/, '')
        .toLowerCase()
    return !norm(raw).startsWith(norm(workspaceRoot))
  }
  // Root-relative paths without a drive letter (\Windows\... / /etc/passwd)
  if (/^\\/.test(raw)) return true
  if (/^\/(etc|usr|var|home|root|opt|tmp|bin|sbin|dev|proc|sys|mnt|media|windows)\b/i.test(raw)) {
    return true
  }
  // Other relative paths are treated as "inside the workspace" (cwd = workspace)
  return false
}

/** Splits a command into tokens (whitespace and non-path separators only; good enough, and does not shred `C:\Program Files` except in quoting cases) */
function tokenize(command: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return tokens
}

/**
 * Inspects the risk of a shell command.
 *
 * @param command       the command text given by the model
 * @param workspaceRoot workspace root (cwd of execute); when omitted, any absolute path is out of bounds
 * @returns risk result (with reason code and triggering snippet)
 */
export function inspectCommand(command: string, workspaceRoot?: string): CommandRisk {
  const text = String(command ?? '')
  if (!text.trim()) return SAFE

  // 1) Unconditionally dangerous constructs
  for (const rule of UNCONDITIONAL_RISKS) {
    const evidence = firstMatch(text, rule.re)
    if (evidence) return { risky: true, code: rule.code, evidence: evidence.trim() }
  }

  // 2) Paths outside the workspace
  for (const token of tokenize(text)) {
    if (isOutsidePathToken(token, workspaceRoot)) {
      return { risky: true, code: 'outside-path', evidence: token.slice(0, 120) }
    }
  }

  // 3) git operations that lose work
  const git = firstMatch(text, DESTRUCTIVE_GIT_RE)
  if (git) return { risky: true, code: 'destructive-workspace', evidence: git.trim() }

  // 4) Delete verb + recursive/wildcard → irreversible large-scale delete inside the workspace
  const del = firstMatch(text, DELETE_VERB_RE)
  if (del && RECURSIVE_FLAG_RE.test(text)) {
    return { risky: true, code: 'destructive-workspace', evidence: del.trim() }
  }

  return SAFE
}

/* ────────────────────────── Call evaluation ────────────────────────── */

/** Reason codes for denial / approval (texts are localized by the caller) */
export type DenyReason =
  | 'read-only-write'
  | 'read-only-exec'
  | 'read-only-external'
  | 'outside-path'
  | 'risky-command'
  | 'code-exec'

/** Decision action */
export type PermissionAction = 'allow' | 'approve' | 'deny'

export interface Verdict {
  action: PermissionAction
  reason?: DenyReason
  /** The snippet that triggered the decision (provided by the command risk check) */
  evidence?: string
  /** Mode actually in effect for this call (the wider one after escalation) */
  effectiveMode: PermissionMode
  /** Tool category (for dialog and card display) */
  access: ToolAccess
}

export interface CallContext {
  mode: PermissionMode
  toolName: string
  args: Record<string, unknown>
  /** Workspace root (cwd of execute; needed for out-of-bounds checks) */
  workspaceRoot?: string
}

/**
 * Evaluates one tool call.
 *
 * Decision table:
 *
 * | mode \ category | read | write | exec (safe command) | exec (dangerous command) | code (build/run model-written code) | external |
 * |---|---|---|---|---|---|---|
 * | read-only        | allow | deny + escalation hint | allow | deny + escalation hint | deny + escalation hint | prompt |
 * | workspace-write  | allow | allow | allow | **prompt** | **prompt** | allow |
 * | danger-full-access | allow | allow | allow | allow | allow | allow |
 *
 * Why read-only is "deny + escalation hint" rather than a direct prompt: the mode is the user's
 * explicit "don't touch" choice, and prompting on every violation would become noise; the model
 * can request escalation with the same call, and only then is a dialog shown.
 */
export function evaluateCall(input: CallContext): Verdict {
  const { mode, toolName, args, workspaceRoot } = input
  const access = classifyTool(toolName)

  if (mode === 'danger-full-access') {
    return { action: 'allow', effectiveMode: mode, access }
  }

  if (access === 'read') {
    return { action: 'allow', effectiveMode: mode, access }
  }

  if (access === 'code') {
    if (mode === 'read-only') {
      return { action: 'deny', reason: 'read-only-exec', effectiveMode: mode, access }
    }
    // plugin_* build/load model-written code: under restricted modes the user must confirm every
    // time; do not allow silently under workspace-write just because it is not an execute tool.
    return { action: 'approve', reason: 'code-exec', effectiveMode: mode, access }
  }

  if (access === 'write') {
    if (mode === 'read-only') {
      return { action: 'deny', reason: 'read-only-write', effectiveMode: mode, access }
    }
    return { action: 'allow', effectiveMode: mode, access }
  }

  if (access === 'exec') {
    const command = typeof args.command === 'string' ? args.command : ''
    const risk = inspectCommand(command, workspaceRoot)
    if (risk.risky) {
      if (mode === 'read-only') {
        return {
          action: 'deny',
          reason: 'read-only-exec',
          evidence: risk.evidence,
          effectiveMode: mode,
          access
        }
      }
      return {
        action: 'approve',
        reason: risk.code === 'outside-path' ? 'outside-path' : 'risky-command',
        evidence: risk.evidence,
        effectiveMode: mode,
        access
      }
    }
    return { action: 'allow', effectiveMode: mode, access }
  }

  // external: external tools with unknown semantics
  if (mode === 'read-only') {
    return { action: 'approve', reason: 'read-only-external', effectiveMode: mode, access }
  }
  return { action: 'allow', effectiveMode: mode, access }
}

/* ────────────────────────── Escalation retry ────────────────────────── */

/** Escalation parameters (the two optional fields in the tool schema; only usable by the call that was denied) */
export interface EscalationRequest {
  mode: PermissionMode
  justification: string
}

/** Reasons why escalation parameter validation fails */
export type EscalationError =
  'invalid-mode' | 'invalid-justification' | 'not-wider' | 'not-previously-denied'

export const MAX_JUSTIFICATION_CHARS = 1000

/**
 * Parses and validates escalation parameters (**touches nobody**).
 *
 * The validation order is deliberate: parameter shape → whether strictly wider → whether this
 * call really was just denied. The first two failures mean "the model is misusing parameters"
 * and can simply return denial text; the third binds escalation to "the same denied call"
 * (retry this exact call once), so the model cannot grant itself permissions out of thin air.
 */
export function parseEscalation(
  args: Record<string, unknown>,
  current: PermissionMode,
  previouslyDenied: boolean
): { ok: true; request: EscalationRequest } | { ok: false; error: EscalationError } {
  const rawMode = args.sandbox_permissions
  const rawJust = args.justification
  if (rawMode === undefined && rawJust === undefined) {
    // No escalation parameters: this path should not be reached (the caller only asks when parameters are present)
    return { ok: false, error: 'invalid-mode' }
  }
  if (!isPermissionMode(rawMode)) return { ok: false, error: 'invalid-mode' }
  if (typeof rawJust !== 'string' || !rawJust.trim()) {
    return { ok: false, error: 'invalid-justification' }
  }
  if (rawJust.length > MAX_JUSTIFICATION_CHARS) {
    return { ok: false, error: 'invalid-justification' }
  }
  if (!isStrictlyWider(rawMode, current)) return { ok: false, error: 'not-wider' }
  if (!previouslyDenied) return { ok: false, error: 'not-previously-denied' }
  return { ok: true, request: { mode: rawMode, justification: rawJust.trim() } }
}

/* ────────────────────────── Protocol strings ────────────────────────── */

/**
 * Denial marker (**protocol string**; both the model and tests identify interception by it, and
 * it does not follow the UI language).
 */
export function denyMarker(mode: PermissionMode): string {
  return `[sandbox: operation denied under ${mode} mode]`
}

/** Escalation hint (also a protocol string) */
export const ESCALATION_HINT =
  '[sandbox: escalation available — retry this exact call once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]'

/** Escalation unavailable (invalid parameters / a call that should not escalate) */
export const ESCALATION_UNAVAILABLE = '[sandbox: escalation is not available for this call]'

/** The user rejected this call */
export const APPROVAL_REJECTED = '[sandbox: the user rejected this call]'

/** No available responder (renderer absent / approval channel not wired): fail closed; never allow silently */
export const APPROVAL_UNAVAILABLE = '[sandbox: approval unavailable — the request fails closed]'

/* ────────────────────────── Display helpers ────────────────────────── */

/** Returns the "signature" of this call (tool name + arguments other than escalation parameters), used to bind escalation to the denied call */
export function callSignature(toolName: string, args: Record<string, unknown>): string {
  const plain: Record<string, unknown> = {}
  for (const key of Object.keys(args ?? {}).sort()) {
    if (key === 'sandbox_permissions' || key === 'justification') continue
    plain[key] = (args as Record<string, unknown>)[key]
  }
  let text = ''
  try {
    text = JSON.stringify(plain)
  } catch {
    text = String(plain)
  }
  return `${toolName}:${text}`
}

/**
 * Human-readable "what this call will do" (used by the dialog body and card messages).
 *
 * Picks the most informative one by argument **shape** (full command / file path / search
 * expression / directory); the tool name does not participate — it has its own place in the
 * dialog and card.
 */
export function describeCall(_toolName: string, args: Record<string, unknown>): string {
  const a = (args ?? {}) as Record<string, unknown>
  if (typeof a.command === 'string') return a.command
  if (typeof a.file_path === 'string') {
    const extra =
      typeof a.old_string === 'string'
        ? ' (edit)'
        : typeof a.content === 'string'
          ? ` (${String(a.content).length} chars)`
          : ''
    return `${String(a.file_path)}${extra}`
  }
  if (typeof a.pattern === 'string') return String(a.pattern)
  if (typeof a.path === 'string') return String(a.path)
  try {
    const text = JSON.stringify(a)
    return text.length > 300 ? `${text.slice(0, 300)}…` : text
  } catch {
    return '(unserializable arguments)'
  }
}

/* ────────────────────────── System prompt section ────────────────────────── */

/**
 * Explanation section injected into the system prompt for the current mode (English — the same
 * language as the other prompts).
 *
 * It states three things: the current mode, what a blocked call looks like, and **how to request
 * one escalation**. The last one is key: without this path, a denied call becomes just one more
 * failed retry.
 */
export function sandboxPromptSection(mode: PermissionMode): string {
  if (mode === 'danger-full-access') {
    return `\n\n## Sandbox
Sandbox mode: danger-full-access (the user turned interception off for this session). File writes and shell commands run without approval prompts. There is no sandbox to catch a mistake: keep destructive or irreversible actions rare, and prefer asking the user before anything that cannot be undone.`
  }
  if (mode === 'read-only') {
    return `\n\n## Sandbox
Sandbox mode: read-only (set by the user). The operating system itself enforces this: reading files and running harmless commands work normally, but every write (in the workspace included), every destructive command, and every external tool call is refused.
When a call is refused you get a result marked ${denyMarker('read-only')} together with an escalation hint. To ask the user for a one-off exception, retry that **exact same call once**, adding two arguments: sandbox_permissions (the narrowest wider mode that suffices, e.g. "workspace-write") and a one-line justification. The user sees a single approval prompt; if they allow it, that one call runs under the wider mode. A refusal without the hint is final — do not invent workarounds.`
  }
  return `\n\n## Sandbox
Sandbox mode: workspace-write (set by the user). The workspace directory is the only place you may write: the operating system denies every write outside it (and outside the private temp directory you are given), so a command that tries to modify files elsewhere fails with a sandbox denial instead of succeeding quietly.
- A denial comes back as ${denyMarker('workspace-write')} plus an escalation hint: you may retry that **exact same call once** with sandbox_permissions (the narrowest wider mode that suffices) and a one-line justification, and the user is asked to approve it once.
- Separately, a command that looks destructive (recursive deletes, hard resets, registry or service changes, killing processes, publishing or force-pushing, download-and-execute) is shown to the user for approval *before* it runs. If the user rejects it, stop that line of work and say what you would need instead — do not retry and do not look for a way around it.`
}
