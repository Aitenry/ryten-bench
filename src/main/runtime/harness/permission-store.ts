import { settingsStore } from '../../context'
import { mainFormat } from '../../i18n'
import { getFsToolTexts } from '../../i18n/tool-results-fs'
import type { HarnessSettings } from '../../types/settings'
import { permissionGate, type GateTexts } from './permission-gate'
import {
  APPROVAL_REJECTED,
  APPROVAL_UNAVAILABLE,
  DEFAULT_PERMISSION_MODE,
  ESCALATION_HINT,
  ESCALATION_UNAVAILABLE,
  denyMarker,
  normalizeMode,
  type DenyReason,
  type EscalationError,
  type PermissionMode
} from './permission'

/**
 * **Persistence and wiring** for permission modes (the `permissions` key of electron-store plus
 * gate wiring).
 *
 * Why modes are not in the database: the mode is a session-level switch for "how this session
 * runs", not conversation content; keeping it in a separate top-level electron-store key (the
 * same approach as `mainAgent` / `mcp`) avoids a drizzle migration, and a leftover small record
 * after a topic is deleted does no harm. Shape:
 *
 * ```json
 * { "permissions": { "defaultMode": "workspace-write", "byTopic": { "12": "read-only" } } }
 * ```
 *
 * Two layers:
 * - `defaultMode`: the mode for **newly created** topics (the default permission mode in the
 *   settings page's "Agent" section);
 * - `byTopic[topicId]`: the current topic's choice (selector at the bottom-left of the input
 *   box); the default at that time is used when there is no record.
 *
 * This file is also the gate's **wiring point**: mode source, workspace root, and UI-language
 * texts are all injected here, so permission-gate.ts itself does not need to know electron /
 * i18n (which is why offline regression can run).
 */

/** Persisted shape (dirty data is normalized on read, never throws) */
export interface PermissionsConfig {
  defaultMode: PermissionMode
  /** Topic id (string keys; electron-store JSON object keys can only be strings) → mode */
  byTopic: Record<string, PermissionMode>
}

/** Reads (with normalization): any dirty value falls back to the default mode */
export function readPermissionsConfig(): PermissionsConfig {
  const raw = settingsStore.get('permissions') as Partial<PermissionsConfig> | undefined
  const byTopic: Record<string, PermissionMode> = {}
  const source = raw?.byTopic
  if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) {
      if (/^\d+$/.test(key)) byTopic[key] = normalizeMode(value)
    }
  }
  return { defaultMode: normalizeMode(raw?.defaultMode), byTopic }
}

/** Writes (merge-style: only overwrites the provided fields) */
function writePermissionsConfig(patch: Partial<PermissionsConfig>): PermissionsConfig {
  const next = { ...readPermissionsConfig(), ...patch }
  settingsStore.set('permissions', next)
  return next
}

/** Current mode of a topic (no topic record = use the default; new topics therefore follow the "new session default") */
export function permissionModeOf(topicId: number): PermissionMode {
  const config = readPermissionsConfig()
  if (topicId > 0) {
    const scoped = config.byTopic[String(topicId)]
    if (scoped) return scoped
  }
  return config.defaultMode
}

/** Full state needed by the frontend (current mode + new-session default) */
export function permissionStateFor(topicId?: number | null): {
  topicId: number
  mode: PermissionMode
  defaultMode: PermissionMode
} {
  const config = readPermissionsConfig()
  const id = typeof topicId === 'number' && topicId > 0 ? topicId : 0
  return {
    topicId: id,
    mode: id > 0 ? (config.byTopic[String(id)] ?? config.defaultMode) : config.defaultMode,
    defaultMode: config.defaultMode
  }
}

/** Switches the current topic's mode (writes the topic scope, leaving the new-session default untouched) */
export function setTopicPermissionMode(topicId: number, mode: PermissionMode): PermissionMode {
  if (!(topicId > 0)) return readPermissionsConfig().defaultMode
  const config = readPermissionsConfig()
  const next = { ...config.byTopic, [String(topicId)]: normalizeMode(mode) }
  writePermissionsConfig({ byTopic: next })
  return normalizeMode(mode)
}

/** Switches the "new session default" mode (settings page; does not affect existing topics) */
export function setDefaultPermissionMode(mode: PermissionMode): PermissionMode {
  const next = writePermissionsConfig({ defaultMode: normalizeMode(mode) })
  return next.defaultMode
}

/* ────────────────────────── Text wiring ────────────────────────── */

/** Looks up the localized explanation by reason code (shared by the model-visible denial text and the dialog reason) */
function reasonText(code: DenyReason, evidence?: string): string {
  const tr = getFsToolTexts().sandbox
  switch (code) {
    case 'read-only-write':
      return tr.reason.readOnlyWrite
    case 'read-only-exec':
      return evidence ? mainFormat(tr.reason.readOnlyExec, { evidence }) : tr.reason.readOnlyExec
    case 'read-only-external':
      return tr.reason.readOnlyExternal
    case 'outside-path':
      return mainFormat(tr.reason.outsidePath, { evidence: evidence ?? '' })
    case 'code-exec':
      return tr.reason.codeExec
    case 'risky-command':
    default:
      return evidence ? mainFormat(tr.reason.riskyCommand, { evidence }) : tr.reason.riskyCommand
  }
}

/** Explanation when escalation parameters are invalid */
function escalationText(error: EscalationError): string {
  const tr = getFsToolTexts().sandbox.escalation
  switch (error) {
    case 'invalid-mode':
      return tr.invalidMode
    case 'invalid-justification':
      return tr.invalidJustification
    case 'not-wider':
      return tr.notWider
    case 'not-previously-denied':
    default:
      return tr.notPreviouslyDenied
  }
}

/** Gate texts (denial / reason / escalation unavailable): markers are protocol, the body follows the UI language */
const GATE_TEXTS: GateTexts = {
  denial: ({ mode, reason, evidence, detail }) =>
    `${denyMarker(mode)} ${reasonText(reason, evidence)}\n${ESCALATION_HINT}${detail ? `\n(${detail})` : ''}`,
  reason: (code, evidence) => reasonText(code, evidence),
  escalationUnavailable: (error) => `${ESCALATION_UNAVAILABLE} ${escalationText(error)}`
}

/** Text shown to the user and the model when the user denies or no one answers (also used by the ipc layer and card display) */
export const PERMISSION_APPROVAL_REJECTED = APPROVAL_REJECTED
export const PERMISSION_APPROVAL_UNAVAILABLE = APPROVAL_UNAVAILABLE

/** Whether wiring is complete (idempotent; repeated calls have no side effects) */
let wired = false

/**
 * Wires the gate (called once when the plugin is installed).
 *
 * The workspace root comes from "the current workspace in settings" — that is the cwd of
 * `execute`, and out-of-bounds checks must use the same value as the working directory actually
 * used to run commands.
 */
export function wirePermissionGate(): void {
  if (wired) return
  wired = true
  permissionGate.setModeSource((topicId) => permissionModeOf(topicId))
  permissionGate.setWorkspaceRootSource(() => {
    const settings = settingsStore.get('harness') as HarnessSettings | undefined
    return settings?.workspacePath || undefined
  })
  permissionGate.setTexts(GATE_TEXTS)
}

/** Re-exports the default mode constant (used to initialize the settings page) */
export { DEFAULT_PERMISSION_MODE }
