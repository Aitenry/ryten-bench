#!/usr/bin/env node
/**
 * RytenBench sandbox service — Windows restricted-token runner (**custom implementation**, no third-party sandbox package).
 *
 * The main process spawns it as an "argv prefix":
 *
 *   [electron/node, win32-sandbox-runner.cjs,
 *    '--workspace', <workspace>, '--temp', <private temp dir root>,
 *    '--mode', <read-only|workspace-write|cleanup>, ['--revoke-workspace'],
 *    '--', <actual command to run...>]
 *
 * Mechanism (all user-mode Win32: no administrator, no new accounts, no external tools):
 *  1. Open the current process token → extract the logon SID (S-1-5-5-x-y, required for process initialization);
 *  2. **Deterministically derive** a capability SID (`S-1-4-a-b`) from the workspace path, and a second one from the private temp dir;
 *  3. Merge a "write ACE for that SID" into the workspace/temp dir DACL (write + delete + delete children,
 *     deliberately excluding WRITE_DAC/WRITE_OWNER — a sandboxed process must not be able to change the DACL or take ownership to escape);
 *  4. `CreateRestrictedToken(WRITE_RESTRICTED)`: restricting list = [logon SID, Everyone]
 *     (plus the two capability SIDs for workspace-write). Windows performs a **two-pass check** on write-type access:
 *     access is granted only if both the normal SID and the restricting SIDs pass ⇒ SIDs absent from the
 *     restricting list get no write permission, which is how "can only write the workspace" is enforced;
 *  5. `CreateProcessAsUserW` spawns with the restricted token; **the runner itself `CreatePipe`s anonymous pipes** for stdio
 *     (Node's pipes are overlapped, so a restricted child writing synchronously gets `ERROR_INVALID_PARAMETER`),
 *     `PeekNamedPipe` + `ReadFile` pump back to the runner's stdout; the child goes into a kill-on-close
 *     Job Object (runner killed → the whole subtree is cleaned up); the child **shares the runner's console** and hides the window with
 *     `STARTF_USESHOWWINDOW + SW_HIDE` (**no CREATE_NO_WINDOW**: under a restricted token that console
 *     isolation makes the child die during DLL initialization with 0xC0000142; see the measured record at the constant);
 *  6. After the child exits, revoke the temporary ACE, delete the private temp dir, and mirror the child's exit code.
 *
 * Failure contract: any runner-side failure prints `ryten-sandbox-run: <detail>` to stderr and exits with 127
 * —**never spawns a child without a restricted token** (fail closed).
 *
 * Known limits (documented by the upper layer; not pretended to be an absolute boundary):
 *  - the restricting list must keep Everyone (early DLL initialization and CNG depend on it), so objects whose
 *    DACL explicitly grants Everyone write access remain writable; NTFS hard links can also alias an authorized
 *    file outside the workspace;
 *  - only effective on volumes that have ACLs (exFAT / network drives have none) — such workspaces are
 *    deemed unusable by the upper layer;
 *  - the child and the runner **share a console**: console isolation is impossible under a restricted token
 *    (`CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` children die during DLL initialization with 0xC0000142); the
 *    window is hidden with `STARTF_USESHOWWINDOW + SW_HIDE`; stdio uses pipes created by the runner and is unaffected.
 *  - this file is plain CJS (not processed by a bundler): it is a script loaded by a separate process, so koffi must
 *    be resolvable under the app root, and it runs in Electron's node mode (ELECTRON_RUN_AS_NODE=1).
 */
'use strict'

const { createHash } = require('node:crypto')
const { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')

/** Runner failure signature (the main process uses it to distinguish "the sandbox is broken" from "the command failed") */
const RUNNER_SIGNATURE = 'ryten-sandbox-run'
/** Runner failure exit code (deliberately distinct from any command exit code) */
const RUNNER_FAILURE_EXIT = 127
/** Child died during loader/console initialization (diagnostic hint only; does not change exit-code semantics) */
const STATUS_DLL_INIT_FAILED = 0xc0000142

/* ────────────────────────── Win32 constants ────────────────────────── */

const PROCESS_QUERY_INFORMATION = 0x0400
const TOKEN_ASSIGN_PRIMARY = 0x0001
const TOKEN_DUPLICATE = 0x0002
const TOKEN_QUERY = 0x0008
const TOKEN_ADJUST_DEFAULT = 0x0080
/** CreateRestrictedToken flags */
const DISABLE_MAX_PRIVILEGE = 0x1
const LUA_TOKEN = 0x4
const WRITE_RESTRICTED = 0x8
/** CreateProcessAsUserW flags */
const CREATE_UNICODE_ENVIRONMENT = 0x00000400
/** AttachConsole(ATTACH_PARENT_PROCESS): attach to the parent process's console */
const ATTACH_PARENT_PROCESS = 0xffffffff
/**
 * STARTUPINFO.dwFlags: makes wShowWindow effective.
 *
 * **Deliberately no `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE`**: under a restricted token these
 * two forms of "console isolation" make the child die outright during DLL initialization
 * (`STATUS_DLL_INIT_FAILED` = 0xC0000142, stderr completely empty).
 * Reproduced on 2026-09-27 in GitHub Actions (windows-latest, whose console/desktop environment
 * differs from the dev machine): both "write inside workspace" checks in the packaged-artifact
 * self-check ended with exit=0xC0000142, while cleanup (which starts no child) was fine, showing
 * that what broke was "the restricted child won't start", not the runner itself. The known limits
 * are just as explicit: CREATE_NO_WINDOW / CREATE_NEW_CONSOLE children die during DLL
 * initialization, the child shares the host console, and pipe-based stdio redirection is unaffected.
 *
 * Sharing the console + `wShowWindow = SW_HIDE` is the correct fix: the console still exists (so
 * the child starts) but its window is not shown (no black frame flashing under a GUI host). This is
 * also the shape assumed by `SetConsoleCtrlHandler(null, 1)` in step 5 of this file, where
 * "the child handles Ctrl+C itself in the same console".
 */
const STARTF_USESHOWWINDOW = 0x00000100
const SW_HIDE = 0
/** CreateFileW */
const GENERIC_READ = 0x80000000
const GENERIC_WRITE = 0x40000000
const FILE_SHARE_READ = 0x00000001
const FILE_SHARE_WRITE = 0x00000002
const OPEN_ALWAYS = 4
const LOCKFILE_EXCLUSIVE_LOCK = 0x00000002
/** WaitForSingleObject */
const INFINITE = 0xffffffff
const WAIT_FAILED = 0xffffffff
/** Job Object */
const JobObjectExtendedLimitInformation = 9
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
/** Standard handles */
const STD_INPUT_HANDLE = -10
const STD_OUTPUT_HANDLE = -11
const STD_ERROR_HANDLE = -12
const STARTF_USESTDHANDLES = 0x00000100
/** Security info / object type / access mode */
const DACL_SECURITY_INFORMATION = 0x00000004
const SE_FILE_OBJECT = 1
const GRANT_ACCESS = 1
const REVOKE_ACCESS = 4
const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3
const TRUSTEE_IS_SID = 0
const TRUSTEE_IS_UNKNOWN = 0
const NO_MULTIPLE_TRUSTEE = 0
const ERROR_SUCCESS = 0
/** Token information class */
const TokenGroups = 2
const TokenDefaultDacl = 6
/** SID */
const SECURITY_MAX_SID_SIZE = 68
const SE_GROUP_LOGON_ID = 0xc0000000
const WinWorldSid = 1
/** Access mask: write + delete + delete child; deliberately excludes WRITE_DAC/WRITE_OWNER and standard rights bits */
const STANDARD_RIGHTS_WRITE = 0x00020000
const FILE_GENERIC_WRITE = 0x00120116
const DELETE = 0x00010000
const FILE_DELETE_CHILD = 0x00000040
const GRANT_MASK = (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE
const FILE_ALL_ACCESS = 0x1f01ff
/** x64 struct sizes (for self-check) */
const STARTUPINFOW_SIZE = 104
const PROCESS_INFORMATION_SIZE = 24
const JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE = 144
const EXPLICIT_ACCESS_W_SIZE = 48

/* ────────────────────────── Failure ────────────────────────── */

class RunnerFailure extends Error {}

/** Runner-side failure: print the signature line and exit with 127 (never run unrestricted silently) */
function fail(detail) {
  process.stderr.write(`${RUNNER_SIGNATURE}: ${detail}\n`)
  throw new RunnerFailure(detail)
}

/* ────────────────────────── koffi bindings ────────────────────────── */

/**
 * Load koffi (FFI is just the "hand" that calls the Win32 APIs; all sandbox logic lives in this file).
 *
 * Path resolution must cover three run modes: development (repo root node_modules), packaged
 * (inside app.asar, which Electron's node mode maps to app.asar.unpacked), and tooling mode
 * (RYTEN_APP_ROOT is given explicitly).
 */
function loadKoffi() {
  const candidates = [
    process.env.RYTEN_APP_ROOT,
    join(__dirname, '..', '..'),
    process.cwd()
  ].filter(Boolean)
  for (const base of candidates) {
    try {
      return require(require.resolve('koffi', { paths: [base] }))
    } catch {
      // try the next candidate root
    }
  }
  fail('koffi is not resolvable (set RYTEN_APP_ROOT to the application root)')
}

/** Build the bindings table once (reused process-wide) */
function createBindings() {
  const koffi = loadKoffi()
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  const user32 = koffi.load('user32.dll')

  const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
    cb: 'uint32_t',
    lpReserved: 'char16_t *',
    lpDesktop: 'char16_t *',
    lpTitle: 'char16_t *',
    dwX: 'uint32_t',
    dwY: 'uint32_t',
    dwXSize: 'uint32_t',
    dwYSize: 'uint32_t',
    dwXCountChars: 'uint32_t',
    dwYCountChars: 'uint32_t',
    dwFillAttribute: 'uint32_t',
    dwFlags: 'uint32_t',
    wShowWindow: 'uint16_t',
    cbReserved2: 'uint16_t',
    lpReserved2: 'void *',
    hStdInput: 'void *',
    hStdOutput: 'void *',
    hStdError: 'void *'
  })
  const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
    hProcess: 'void *',
    hThread: 'void *',
    dwProcessId: 'uint32_t',
    dwThreadId: 'uint32_t'
  })

  const kernel = {
    OpenProcess: kernel32.func('void *__stdcall OpenProcess(uint32_t, int, uint32_t)'),
    CloseHandle: kernel32.func('int __stdcall CloseHandle(void *)'),
    GetLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
    AllocConsole: kernel32.func('int __stdcall AllocConsole()'),
    AttachConsole: kernel32.func('int __stdcall AttachConsole(uint32_t)'),
    GetConsoleWindow: kernel32.func('void *__stdcall GetConsoleWindow()'),
    LocalFree: kernel32.func('void *__stdcall LocalFree(void *)'),
    GetStdHandle: kernel32.func('void *__stdcall GetStdHandle(int)'),
    SetConsoleCtrlHandler: kernel32.func('int __stdcall SetConsoleCtrlHandler(void *, int)'),
    SetEnvironmentVariableW: kernel32.func(
      'int __stdcall SetEnvironmentVariableW(const char16_t *, const char16_t *)'
    ),
    GetTempPathW: kernel32.func('uint32_t __stdcall GetTempPathW(uint32_t, _Out_ void *)'),
    CreateFileW: kernel32.func(
      'void *__stdcall CreateFileW(const char16_t *, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)'
    ),
    CreatePipe: kernel32.func(
      'int __stdcall CreatePipe(_Out_ void **, _Out_ void **, void *, uint32_t)'
    ),
    PeekNamedPipe: kernel32.func(
      'int __stdcall PeekNamedPipe(void *, _Out_ void *, uint32_t, _Out_ uint32_t *, _Out_ uint32_t *, _Out_ uint32_t *)'
    ),
    ReadFile: kernel32.func(
      'int __stdcall ReadFile(void *, _Out_ void *, uint32_t, _Out_ uint32_t *, void *)'
    ),
    LockFileEx: kernel32.func(
      'int __stdcall LockFileEx(void *, uint32_t, uint32_t, uint32_t, uint32_t, void *)'
    ),
    UnlockFileEx: kernel32.func(
      'int __stdcall UnlockFileEx(void *, uint32_t, uint32_t, uint32_t, void *)'
    ),
    CreateJobObjectW: kernel32.func('void *__stdcall CreateJobObjectW(void *, const char16_t *)'),
    SetInformationJobObject: kernel32.func(
      'int __stdcall SetInformationJobObject(void *, int, void *, uint32_t)'
    ),
    AssignProcessToJobObject: kernel32.func(
      'int __stdcall AssignProcessToJobObject(void *, void *)'
    ),
    TerminateJobObject: kernel32.func('int __stdcall TerminateJobObject(void *, uint32_t)'),
    WaitForSingleObject: kernel32.func('uint32_t __stdcall WaitForSingleObject(void *, uint32_t)'),
    GetExitCodeProcess: kernel32.func('int __stdcall GetExitCodeProcess(void *, _Out_ uint32_t *)')
  }

  const user = {
    ShowWindow: user32.func('int __stdcall ShowWindow(void *, int)')
  }

  const advapi = {
    OpenProcessToken: advapi32.func(
      'int __stdcall OpenProcessToken(void *, uint32_t, _Out_ void **)'
    ),
    GetTokenInformation: advapi32.func(
      'int __stdcall GetTokenInformation(void *, int, _Out_ void *, uint32_t, _Out_ uint32_t *)'
    ),
    SetTokenInformation: advapi32.func(
      'int __stdcall SetTokenInformation(void *, int, void *, uint32_t)'
    ),
    CreateRestrictedToken: advapi32.func(
      'int __stdcall CreateRestrictedToken(void *, uint32_t, uint32_t, void *, uint32_t, void *, uint32_t, void *, _Out_ void **)'
    ),
    CreateWellKnownSid: advapi32.func(
      'int __stdcall CreateWellKnownSid(int, void *, _Out_ void *, _Inout_ uint32_t *)'
    ),
    IsValidSid: advapi32.func('int __stdcall IsValidSid(void *)'),
    GetLengthSid: advapi32.func('uint32_t __stdcall GetLengthSid(void *)'),
    CopySid: advapi32.func('int __stdcall CopySid(uint32_t, _Out_ void *, void *)'),
    ConvertStringSidToSidW: advapi32.func(
      'int __stdcall ConvertStringSidToSidW(const char16_t *, _Out_ void **)'
    ),
    GetNamedSecurityInfoW: advapi32.func(
      'uint32_t __stdcall GetNamedSecurityInfoW(const char16_t *, int, uint32_t, _Out_ void **, _Out_ void **, _Out_ void **, _Out_ void **, _Out_ void **)'
    ),
    // ACL traversal (for the idempotence check): deliberately avoids reading whole ACL memory with koffi.view (it crashes under Electron; see readBytes)
    GetAclInformation: advapi32.func(
      'int __stdcall GetAclInformation(void *, _Out_ void *, uint32_t, int)'
    ),
    GetAce: advapi32.func('int __stdcall GetAce(void *, uint32_t, _Out_ void **)'),
    SetNamedSecurityInfoW: advapi32.func(
      'uint32_t __stdcall SetNamedSecurityInfoW(const char16_t *, int, uint32_t, void *, void *, void *, void *)'
    ),
    SetEntriesInAclW: advapi32.func(
      'uint32_t __stdcall SetEntriesInAclW(uint32_t, void *, void *, _Out_ void **)'
    ),
    CreateProcessAsUserW: advapi32.func(
      'int __stdcall CreateProcessAsUserW(void *, const char16_t *, void *, void *, void *, int, uint32_t, void *, const char16_t *, _Inout_ STARTUPINFOW *, _Out_ PROCESS_INFORMATION *)'
    )
  }

  // Struct layout self-check: a wrong layout fails in extremely hard-to-diagnose ways; fail closed right here
  const sizes = [
    ['STARTUPINFOW', koffi.sizeof(STARTUPINFOW), STARTUPINFOW_SIZE],
    ['PROCESS_INFORMATION', koffi.sizeof(PROCESS_INFORMATION), PROCESS_INFORMATION_SIZE]
  ]
  for (const [name, actual, expected] of sizes) {
    if (actual !== expected) fail(`unexpected ${name} size ${actual} (expected ${expected} on x64)`)
  }

  return { koffi, kernel, user, advapi, STARTUPINFOW, PROCESS_INFORMATION }
}

/* ────────────────────────── SID / memory helpers ────────────────────────── */

/**
 * Read a chunk of native memory byte by byte (for SIDs / SIDs embedded in ACEs).
 *
 * **Why not `koffi.view`**: koffi 3.3.1's `view()` under Electron (measured 44.1.1 / Node 24.19)
 * crashes the whole process with `FATAL ERROR: Error::New napi_get_last_error_info` — while
 * `decode`, `address`, `encode`, and all Win32 calls work fine in that runtime. That crash is a
 * native abort that try/catch cannot intercept, so this file **forbids `koffi.view`** (a static
 * assertion in the tooling watches for it). A SID is at most 68 bytes, so the per-byte decode
 * overhead is negligible.
 */
function readBytes(koffi, ptr, offset, count) {
  const bytes = Buffer.allocUnsafe(count)
  for (let index = 0; index < count; index++) {
    bytes[index] = koffi.decode(ptr, offset + index, 'uint8_t')
  }
  return bytes
}

/** Bytes of the SID pointed to by the pointer (SID = 1-byte revision + 1-byte sub-authority count + 6-byte authority + N×4-byte sub-authorities) */
function sidBytes(koffi, sidPtr) {
  const count = koffi.decode(sidPtr, 1, 'uint8_t')
  if (count > 15) fail(`implausible SID sub-authority count ${count}`)
  return readBytes(koffi, sidPtr, 0, 8 + count * 4)
}

/** Throw a Win32 error (with API name, error code, and context) */
function throwWin32(kernel, api, code, context) {
  fail(`${api} failed (Win32 ${code}) ${context}`)
}

/* ────────────────────────── Capability SID derivation ────────────────────────── */

/**
 * Deterministically derive a capability SID from a path: `S-1-4-a-b`.
 *
 * Why deterministic: the workspace ACE is a reusable cache materialized "once per machine per
 * workspace" (from the second time on, an exact-ACE hit skips repropagating the whole directory
 * tree). The capability SID string itself is not a secret; its power comes entirely from "which
 * DACLs have an ACE for it" and "which tokens carry it".
 */
function capabilitySid(path, salt) {
  const digest = createHash('sha256').update(`${salt}\u0000${path.toLowerCase()}`).digest()
  const a = (digest.readUInt32BE(0) % 0x7fffffff) + 1
  const b = (digest.readUInt32BE(4) % 0x7fffffff) + 1
  return `S-1-4-${a}-${b}`
}

/** Workspace write identity (reused across sessions) */
function workspaceWriteSid(workspace) {
  return capabilitySid(realpathSync.native(workspace), 'ryten-workspace-write')
}

/** Private temp dir write identity (random dir per run → random identity) */
function tempWriteSid(tempDir) {
  return capabilitySid(tempDir, 'ryten-temp-write')
}

/** SID string → SID pointer (caller is responsible for LocalFree) */
function sidFromString(bindings, sidString) {
  const slot = [null]
  if (bindings.advapi.ConvertStringSidToSidW(sidString, slot) === 0) {
    throwWin32(bindings.kernel, 'ConvertStringSidToSidW', bindings.kernel.GetLastError(), sidString)
  }
  if (slot[0] === null) fail(`ConvertStringSidToSidW returned a null SID for ${sidString}`)
  return slot[0]
}

/* ────────────────────────── Token ────────────────────────── */

/** Open the current process token (CreateRestrictedToken needs these permissions) */
function openCurrentProcessToken(bindings) {
  const { kernel, advapi } = bindings
  const processHandle = kernel.OpenProcess(PROCESS_QUERY_INFORMATION, 0, process.pid)
  if (processHandle === null) {
    throwWin32(kernel, 'OpenProcess', kernel.GetLastError(), `pid ${process.pid}`)
  }
  const tokenSlot = [null]
  const ok = advapi.OpenProcessToken(
    processHandle,
    TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY,
    tokenSlot
  )
  const code = kernel.GetLastError()
  kernel.CloseHandle(processHandle)
  if (ok === 0) throwWin32(kernel, 'OpenProcessToken', code, `pid ${process.pid}`)
  if (tokenSlot[0] === null) throwWin32(kernel, 'OpenProcessToken', code, 'null token handle')
  return tokenSlot[0]
}

/** Extract the logon SID (S-1-5-5-x-y): without it, many process initialization paths die outright (0xC0000142) */
function findLogonSid(bindings, token) {
  const { koffi, kernel, advapi } = bindings
  const needed = [0]
  advapi.GetTokenInformation(token, TokenGroups, null, 0, needed) // expected to fail with ERROR_INSUFFICIENT_BUFFER
  if (needed[0] < 8) {
    throwWin32(kernel, 'GetTokenInformation', kernel.GetLastError(), 'TokenGroups size query')
  }
  const groups = Buffer.alloc(needed[0])
  if (advapi.GetTokenInformation(token, TokenGroups, groups, groups.length, needed) === 0) {
    throwWin32(kernel, 'GetTokenInformation', kernel.GetLastError(), 'TokenGroups')
  }
  const count = groups.readUInt32LE(0)
  // TOKEN_GROUPS: DWORD GroupCount, followed by SID_AND_ATTRIBUTES[count] (16 bytes per entry on
  // x64: 8-byte PSID + DWORD attributes + 4 bytes padding), first entry at offset 8
  for (let index = 0; index < count; index++) {
    const offset = 8 + index * 16
    const sidPtr = koffi.decode(groups, offset, 'void *')
    const attributes = groups.readUInt32LE(offset + 8)
    if (sidPtr === null) continue
    // >>> 0: JS bitwise ops are signed 32-bit, while SE_GROUP_LOGON_ID has its top bit set
    if ((attributes & SE_GROUP_LOGON_ID) >>> 0 !== SE_GROUP_LOGON_ID >>> 0) continue
    const length = advapi.GetLengthSid(sidPtr)
    if (length === 0) throwWin32(kernel, 'GetLengthSid', kernel.GetLastError(), `group ${index}`)
    const copy = Buffer.alloc(length)
    if (advapi.CopySid(length, copy, sidPtr) === 0) {
      throwWin32(kernel, 'CopySid', kernel.GetLastError(), `group ${index}`)
    }
    return copy
  }
  fail(`no logon SID among ${count} token groups`)
}

/** Create a well-known SID (Everyone) */
function makeWellKnownSid(bindings, type) {
  const { kernel, advapi } = bindings
  const sid = Buffer.alloc(SECURITY_MAX_SID_SIZE)
  const size = [SECURITY_MAX_SID_SIZE]
  if (advapi.CreateWellKnownSid(type, null, sid, size) === 0) {
    throwWin32(kernel, 'CreateWellKnownSid', kernel.GetLastError(), `type ${type}`)
  }
  if (advapi.IsValidSid(sid) === 0) {
    throwWin32(kernel, 'IsValidSid', kernel.GetLastError(), `type ${type}`)
  }
  return sid
}

/**
 * Create the restricted token: restricting list = [logon SID, Everyone] (+ the two capability SIDs for workspace-write).
 *
 * Keeping Everyone and the logon SID is **mandatory**: without them the sandboxed process crashes
 * during early DLL initialization and in CNG (measured 0xC0000142 / pwsh 0xE0434352). That is also
 * the origin of the known limit "existing grants to Everyone remain writable".
 */
function createRestrictedToken(bindings, currentToken, logonSid, writeSids, everyoneSid, mode) {
  const { koffi, kernel, advapi } = bindings
  if (mode !== 'read-only' && writeSids.length === 0) {
    fail('workspace-write requires at least one write SID')
  }
  const sids =
    mode === 'read-only' ? [logonSid, everyoneSid] : [logonSid, everyoneSid, ...writeSids]
  // SID_AND_ATTRIBUTES[count]: 16 bytes per entry on x64 (SID pointer + attributes 0 + padding)
  const list = Buffer.alloc(16 * sids.length)
  sids.forEach((sid, index) => {
    list.writeBigUInt64LE(koffi.address(sid), 16 * index)
  })
  const tokenSlot = [null]
  const ok = advapi.CreateRestrictedToken(
    currentToken,
    DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
    0,
    null, // disable no SIDs
    0,
    null, // remove no privileges
    sids.length,
    list,
    tokenSlot
  )
  if (ok === 0) {
    throwWin32(
      kernel,
      'CreateRestrictedToken',
      kernel.GetLastError(),
      `${sids.length} restricting SIDs`
    )
  }
  if (tokenSlot[0] === null) {
    throwWin32(kernel, 'CreateRestrictedToken', kernel.GetLastError(), 'null token')
  }
  return tokenSlot[0]
}

/**
 * Merge a "full access ACE for that SID" into the token's default DACL.
 *
 * A restricted token inherits the user's default DACL verbatim, and that default DACL contains no
 * restricting SID: when the sandboxed process creates new objects (anonymous pipes, temp files),
 * the second pass of the write-access check fails (ERROR_ACCESS_DENIED, which Node surfaces as
 * spawn EPERM), so "a child process starting another child" breaks across the board. After merging
 * an ACE that names the restricting SID, the new object's own DACL passes the second check, while
 * "can this object be created at all" is still governed by the parent directory's DACL (creating
 * outside the workspace remains impossible).
 */
function setTokenDefaultDaclGrant(bindings, token, sidPtr) {
  const { kernel, advapi } = bindings
  const needed = [0]
  advapi.GetTokenInformation(token, TokenDefaultDacl, null, 0, needed)
  if (needed[0] === 0) {
    throwWin32(kernel, 'GetTokenInformation', kernel.GetLastError(), 'TokenDefaultDacl size query')
  }
  const buffer = Buffer.alloc(needed[0])
  if (advapi.GetTokenInformation(token, TokenDefaultDacl, buffer, buffer.length, needed) === 0) {
    throwWin32(kernel, 'GetTokenInformation', kernel.GetLastError(), 'TokenDefaultDacl')
  }
  const currentDacl = bindings.koffi.decode(buffer, 0, 'void *')
  if (currentDacl === null) fail('token carries no default DACL to extend')
  const mergedSlot = [null]
  const result = advapi.SetEntriesInAclW(
    1,
    explicitAccess(bindings, sidPtr, GRANT_ACCESS, FILE_ALL_ACCESS),
    currentDacl,
    mergedSlot
  )
  if (result !== ERROR_SUCCESS) throwWin32(kernel, 'SetEntriesInAclW', result, 'default DACL merge')
  const merged = mergedSlot[0]
  if (merged === null) throwWin32(kernel, 'SetEntriesInAclW', result, 'null merged DACL')
  const info = Buffer.alloc(8)
  info.writeBigUInt64LE(bindings.koffi.address(merged), 0)
  const ok = advapi.SetTokenInformation(token, TokenDefaultDacl, info, info.length)
  const code = kernel.GetLastError()
  kernel.LocalFree(merged)
  if (ok === 0) throwWin32(kernel, 'SetTokenInformation', code, 'TokenDefaultDacl')
}

/* ────────────────────────── ACL grant / revoke ────────────────────────── */

/** Pack one EXPLICIT_ACCESS_W (48 bytes on x64; permissions are 0 for REVOKE) */
function explicitAccess(bindings, sidPtr, mode, permissions) {
  const entry = Buffer.alloc(EXPLICIT_ACCESS_W_SIZE)
  entry.writeUInt32LE(permissions, 0) // grfAccessPermissions
  entry.writeUInt32LE(mode, 4) // grfAccessMode
  entry.writeUInt32LE(SUB_CONTAINERS_AND_OBJECTS_INHERIT, 8) // grfInheritance = OI|CI
  entry.writeUInt32LE(NO_MULTIPLE_TRUSTEE, 24) // Trustee.MultipleTrusteeOperation
  entry.writeUInt32LE(TRUSTEE_IS_SID, 28) // Trustee.TrusteeForm
  entry.writeUInt32LE(TRUSTEE_IS_UNKNOWN, 32) // Trustee.TrusteeType
  entry.writeBigUInt64LE(bindings.koffi.address(sidPtr), 40) // Trustee.ptstrName = capability SID
  return entry
}

/** Lock file for one protected path: <system temp>/ryten-acl-locks/<sha256(path)>.lock */
function lockFilePath(bindings, path) {
  const { kernel } = bindings
  const buffer = Buffer.alloc(1024 * 2)
  const length = kernel.GetTempPathW(1024, buffer)
  if (length === 0) fail(`GetTempPathW failed (Win32 ${kernel.GetLastError()})`)
  const tempRoot = buffer.toString('utf16le', 0, length * 2).replace(/\0+$/, '')
  const digest = createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 16)
  return join(tempRoot, 'ryten-acl-locks', `${digest}.lock`)
}

/**
 * Perform one DACL read-modify-write under a "per-path exclusive lock".
 *
 * Why needed: granting is "read current DACL → merge → write back", and two concurrent sandboxes
 * (e.g. two subagents running commands at the same time) would overwrite each other's ACEs. The
 * lock uses LockFileEx (not "does the file exist"), and does not share the delete bit — a deletable
 * lock file would let two processes "hold" the same lock simultaneously.
 */
function withPathLock(bindings, path, action) {
  const { kernel } = bindings
  const lockPath = lockFilePath(bindings, path)
  mkdirSync(join(lockPath, '..'), { recursive: true })
  const handle = kernel.CreateFileW(
    lockPath,
    GENERIC_READ | GENERIC_WRITE,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    null,
    OPEN_ALWAYS,
    0,
    null
  )
  if (handle === null) {
    fail(`CreateFileW failed for lock ${lockPath} (Win32 ${kernel.GetLastError()})`)
  }
  const overlapped = Buffer.alloc(32) // OVERLAPPED all zero: offset 0, hEvent NULL
  if (kernel.LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, overlapped) === 0) {
    const code = kernel.GetLastError()
    kernel.CloseHandle(handle)
    throwWin32(kernel, 'LockFileEx', code, lockPath)
  }
  try {
    return action()
  } finally {
    kernel.UnlockFileEx(handle, 0, 1, 0, overlapped)
    kernel.CloseHandle(handle)
  }
}

/** Read the directory's current explicit DACL (the descriptor must be released only after the merge has consumed the DACL) */
function readCurrentDacl(bindings, path) {
  const { kernel, advapi } = bindings
  const owner = [null]
  const group = [null]
  const dacl = [null]
  const sacl = [null]
  const descriptor = [null]
  const result = advapi.GetNamedSecurityInfoW(
    path,
    SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION,
    owner,
    group,
    dacl,
    sacl,
    descriptor
  )
  if (result !== ERROR_SUCCESS) throwWin32(kernel, 'GetNamedSecurityInfoW', result, path)
  return { oldAcl: dacl[0], descriptor: descriptor[0] }
}

/** Merge and persist: fold one EXPLICIT_ACCESS_W into oldAcl, then SetNamedSecurityInfoW */
function mergeAndApply(bindings, path, entry, oldAcl, descriptor, label) {
  const { kernel, advapi } = bindings
  const mergedSlot = [null]
  const mergeResult = advapi.SetEntriesInAclW(1, entry, oldAcl, mergedSlot)
  if (mergeResult !== ERROR_SUCCESS) {
    if (descriptor !== null) kernel.LocalFree(descriptor)
    throwWin32(kernel, 'SetEntriesInAclW', mergeResult, `${label}(${path})`)
  }
  const merged = mergedSlot[0]
  if (merged === null) {
    if (descriptor !== null) kernel.LocalFree(descriptor)
    throwWin32(kernel, 'SetEntriesInAclW', kernel.GetLastError(), `${label}(${path}) null ACL`)
  }
  if (descriptor !== null) kernel.LocalFree(descriptor) // the descriptor block (including oldAcl) is invalid from here on
  const applyResult = advapi.SetNamedSecurityInfoW(
    path,
    SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION,
    null,
    null,
    merged,
    null
  )
  kernel.LocalFree(merged)
  if (applyResult !== ERROR_SUCCESS) {
    throwWin32(kernel, 'SetNamedSecurityInfoW', applyResult, `${label}(${path})`)
  }
}

/**
 * Whether the directory's current DACL already carries an identical grant ACE (skip the write-back
 * if so): a hit skips repropagating the whole tree.
 *
 * The implementation deliberately **uses only the Win32 ACL interfaces + `koffi.decode`**
 * (`GetAclInformation` for the ACE count, `GetAce` for each ACE pointer), not `koffi.view` to read
 * the whole ACL memory: SIDs inside ACEs are **inline** (not pointers), so they can only be read
 * byte by byte by offset for comparison; and `koffi.view` crashes under Electron (see the readBytes
 * comment).
 */
function hasExactGrant(bindings, oldAcl, sidPtr) {
  const { koffi, advapi, kernel } = bindings
  const info = Buffer.alloc(12) // ACL_SIZE_INFORMATION { AceCount; AclBytesInUse; AclBytesFree; }
  if (advapi.GetAclInformation(oldAcl, info, info.length, 2) === 0) {
    // Can't read the ACL structure: fall back to the merge path (which has full error handling)
    return false
  }
  const aceCount = info.readUInt32LE(0)
  if (aceCount === 0 || aceCount > 65535) return false
  const target = sidBytes(koffi, sidPtr)
  for (let index = 0; index < aceCount; index++) {
    const aceSlot = [null]
    if (advapi.GetAce(oldAcl, index, aceSlot) === 0) continue
    const ace = aceSlot[0]
    if (ace === null) continue
    const aceType = koffi.decode(ace, 0, 'uint8_t')
    const aceFlags = koffi.decode(ace, 1, 'uint8_t')
    const aceSize = koffi.decode(ace, 2, 'uint16_t')
    if (aceType !== 0 || aceFlags !== SUB_CONTAINERS_AND_OBJECTS_INHERIT) continue
    if (koffi.decode(ace, 4, 'uint32_t') !== GRANT_MASK) continue
    if (aceSize < 8 + target.length) continue
    const inline = readBytes(koffi, ace, 8, target.length)
    if (inline.equals(target)) return true
  }
  return false
}

/** Merge one write-grant ACE into the directory (idempotent) */
function grantWrite(bindings, path, sidPtr) {
  withPathLock(bindings, path, () => {
    const { oldAcl, descriptor } = readCurrentDacl(bindings, path)
    if (oldAcl !== null && hasExactGrant(bindings, oldAcl, sidPtr)) {
      if (descriptor !== null) bindings.kernel.LocalFree(descriptor)
      return
    }
    mergeAndApply(
      bindings,
      path,
      explicitAccess(bindings, sidPtr, GRANT_ACCESS, GRANT_MASK),
      oldAcl,
      descriptor,
      'grantWrite'
    )
  })
}

/** Revoke all ACEs for that SID on the directory (other entries are preserved) */
function revokeWrite(bindings, path, sidPtr) {
  withPathLock(bindings, path, () => {
    const { oldAcl, descriptor } = readCurrentDacl(bindings, path)
    if (oldAcl === null) {
      if (descriptor !== null) bindings.kernel.LocalFree(descriptor)
      return
    }
    mergeAndApply(
      bindings,
      path,
      explicitAccess(bindings, sidPtr, REVOKE_ACCESS, 0),
      oldAcl,
      descriptor,
      'revokeWrite'
    )
  })
}

/** SECURITY_ATTRIBUTES (24 bytes on x64): bInheritHandle=1 lets the child inherit the pipe write end */
function inheritableAttributes() {
  const sa = Buffer.alloc(24)
  sa.writeUInt32LE(24, 0) // nLength
  sa.writeUInt32LE(1, 16) // bInheritHandle
  return sa
}

/**
 * Create two **dedicated** anonymous pipes (stdout / stderr) for the restricted child.
 *
 * Why not pass the runner's own std handles down: Node/libuv pipes are overlapped, so a child
 * doing a synchronous WriteFile on one fails with ERROR_INVALID_PARAMETER; console handles, on the
 * other hand, are blocked by the restricted token's write check. Self-created pipes via CreatePipe
 * are ordinary anonymous pipes, so synchronous writes from the child are fine, and the runner then
 * pumps the content to its own stdout (async writes from Node to overlapped handles are fine).
 */
function createStdioPipes(bindings) {
  const { kernel } = bindings
  const attributes = inheritableAttributes()
  const make = () => {
    const read = [null]
    const write = [null]
    if (kernel.CreatePipe(read, write, attributes, 0) === 0) {
      throwWin32(kernel, 'CreatePipe', kernel.GetLastError(), 'child stdio')
    }
    return { read: read[0], write: write[0] }
  }
  return { stdout: make(), stderr: make() }
}

/** Read one batch of available data from a pipe (Peek first, Read only when data exists, avoiding blocking on an empty pipe) */
function drainPipeOnce(bindings, readHandle, sink) {
  const { kernel } = bindings
  const available = [0]
  const ok = kernel.PeekNamedPipe(readHandle, null, 0, null, available, null)
  if (ok === 0) return { closed: true, moved: 0 }
  if (available[0] === 0) return { closed: false, moved: 0 }
  const chunk = Buffer.alloc(Math.min(available[0], 65536))
  const bytesRead = [0]
  if (kernel.ReadFile(readHandle, chunk, chunk.length, bytesRead, null) === 0) {
    return { closed: true, moved: 0 }
  }
  if (bytesRead[0] > 0) sink(chunk.subarray(0, bytesRead[0]))
  return { closed: false, moved: bytesRead[0] }
}

/** Pump both pipes to the runner's own stdout/stderr until both are closed */
async function pumpPipes(bindings, pipes) {
  let stdoutOpen = true
  let stderrOpen = true
  while (stdoutOpen || stderrOpen) {
    let moved = 0
    if (stdoutOpen) {
      const result = drainPipeOnce(bindings, pipes.stdout.read, (chunk) =>
        process.stdout.write(chunk)
      )
      stdoutOpen = !result.closed
      moved += result.moved
    }
    if (stderrOpen) {
      const result = drainPipeOnce(bindings, pipes.stderr.read, (chunk) =>
        process.stderr.write(chunk)
      )
      stderrOpen = !result.closed
      moved += result.moved
    }
    // Nothing to read: yield the event loop (the child may still be running)
    if (moved === 0 && (stdoutOpen || stderrOpen)) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

/** Close both ends of the pipes (the child side first: only then does the read end see EOF) */
function closePipes(bindings, pipes) {
  const { kernel } = bindings
  for (const pipe of [pipes.stdout, pipes.stderr]) {
    if (pipe.write) kernel.CloseHandle(pipe.write)
    if (pipe.read) kernel.CloseHandle(pipe.read)
  }
}

/* ────────────────────────── Restricted spawn ────────────────────────── */

/** Windows command-line argument quoting rules (add quotes and escape backslashes when spaces/quotes are present) */
function quoteArg(value) {
  const text = String(value)
  if (text.length > 0 && !/[\s"]/.test(text)) return text
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

/** Create a kill-on-close Job Object (runner disappears → the subtree disappears with it) */
function createKillOnCloseJob(bindings) {
  const { kernel } = bindings
  const job = kernel.CreateJobObjectW(null, null)
  if (job === null) fail(`CreateJobObjectW failed (Win32 ${kernel.GetLastError()})`)
  const info = Buffer.alloc(JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE)
  info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16) // BasicLimitInformation.LimitFlags
  if (
    kernel.SetInformationJobObject(job, JobObjectExtendedLimitInformation, info, info.length) === 0
  ) {
    const code = kernel.GetLastError()
    kernel.CloseHandle(job)
    throwWin32(kernel, 'SetInformationJobObject', code, 'kill-on-close')
  }
  return job
}

/**
 * Make the runner itself own a **hidden** console.
 *
 * Why it's mandatory (user-measured 2026-09-28 + reproduced locally): the runner is started via
 * `process.execPath` (**electron.exe, GUI subsystem**), and GUI processes **have no console**; the
 * restricted child is `cmd.exe` (console subsystem) and deliberately does not carry
 * `CREATE_NO_WINDOW` (under a restricted token that dies with 0xC0000142; see the constant docs) —
 * so Windows creates a new console for **every** restricted child: Windows 11 hands new consoles to
 * the "default terminal" (Windows Terminal), flashing a cmd/PowerShell window on the desktop.
 * `STARTUPINFO.wShowWindow = SW_HIDE` cannot stop "a new console being created", and
 * `ShowWindow(GetConsoleWindow())` cannot reach that window under WT management either (it gets a
 * pseudo window handle) — **the only reliable fix is to prevent the system from creating one at
 * all**: if the runner occupies a console itself, children that "share the console" stop creating
 * new ones.
 *
 * Order: first `AttachConsole(ATTACH_PARENT_PROCESS)` (when run directly from a terminal, the parent
 * already has a console), and on failure `AllocConsole()` to make one. In both cases the window is
 * set to `SW_HIDE`.
 */
function ensureConsole(bindings) {
  const { kernel, user } = bindings
  try {
    if (kernel.GetConsoleWindow()) {
      user.ShowWindow(kernel.GetConsoleWindow(), SW_HIDE)
      return
    }
    if (kernel.AttachConsole(ATTACH_PARENT_PROCESS) === 0) {
      if (kernel.AllocConsole() === 0) return
    }
    const hwnd = kernel.GetConsoleWindow()
    if (hwnd) user.ShowWindow(hwnd, SW_HIDE)
  } catch {
    // The console exists only to avoid pop-up windows: failing to get one must not affect the command itself
  }
}

/**
 * Spawn the child with the restricted token; stdio inherits the runner's own (the parent process
 * still sees ordinary pipes). The child goes into a Job Object: once the runner disappears
 * (killed/crashed), the Job handle closes → the whole subtree is killed.
 */
function spawnConfined(bindings, token, { command, args, cwd }) {
  const { kernel, advapi } = bindings
  const pipes = createStdioPipes(bindings)
  // koffi maps a "plain JS object ↔ C struct": parameters declared with _Inout_/_Out_ copy the
  // struct in and, after the call, write the fields back to the same object (struct types are not
  // constructors).
  const startupInfo = {
    cb: STARTUPINFOW_SIZE,
    lpReserved: null,
    lpDesktop: null,
    lpTitle: null,
    dwFlags: STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW,
    wShowWindow: SW_HIDE,
    hStdInput: kernel.GetStdHandle(STD_INPUT_HANDLE),
    hStdOutput: pipes.stdout.write,
    hStdError: pipes.stderr.write
  }
  const commandLine = Buffer.from(
    `${quoteArg(command)} ${args.map(quoteArg).join(' ')}\0`,
    'utf16le'
  )
  const processInfo = {}

  const ok = advapi.CreateProcessAsUserW(
    token,
    null,
    commandLine,
    null,
    null,
    1, // bInheritHandles: let the child receive the pipe write ends we created
    CREATE_UNICODE_ENVIRONMENT, // deliberately no CREATE_NO_WINDOW / CREATE_NEW_CONSOLE (see the constant comment)
    null, // environment block inherited: TMP/TEMP were already rewritten by the runner
    cwd,
    startupInfo,
    processInfo
  )
  if (ok === 0) {
    const code = kernel.GetLastError()
    closePipes(bindings, pipes)
    throwWin32(kernel, 'CreateProcessAsUserW', code, command)
  }
  if (!processInfo.hProcess) fail('CreateProcessAsUserW returned no process handle')
  // The write end has been handed to the child: the runner closes its side immediately so the read end can see EOF
  kernel.CloseHandle(pipes.stdout.write)
  pipes.stdout.write = null
  kernel.CloseHandle(pipes.stderr.write)
  pipes.stderr.write = null

  const job = createKillOnCloseJob(bindings)
  if (kernel.AssignProcessToJobObject(job, processInfo.hProcess) === 0) {
    const code = kernel.GetLastError()
    kernel.TerminateJobObject(job, 1)
    if (processInfo.hThread) kernel.CloseHandle(processInfo.hThread)
    kernel.CloseHandle(processInfo.hProcess)
    kernel.CloseHandle(job)
    closePipes(bindings, pipes)
    throwWin32(kernel, 'AssignProcessToJobObject', code, command)
  }
  if (processInfo.hThread) kernel.CloseHandle(processInfo.hThread)
  return { process: processInfo.hProcess, job, pipes, pid: processInfo.dwProcessId }
}

/** Wait for the child to exit and fetch the exit code */
function waitForExit(bindings, handle) {
  const { kernel } = bindings
  const status = kernel.WaitForSingleObject(handle, INFINITE)
  if (status === WAIT_FAILED) {
    throwWin32(kernel, 'WaitForSingleObject', kernel.GetLastError(), 'child')
  }
  const code = [0]
  if (kernel.GetExitCodeProcess(handle, code) === 0) {
    throwWin32(kernel, 'GetExitCodeProcess', kernel.GetLastError(), 'child')
  }
  return code[0]
}

/* ────────────────────────── Command-line parsing ────────────────────────── */

function parseArgs(raw) {
  let workspace
  let temp
  let mode
  let revokeWorkspace = false
  let index = 0
  for (; index < raw.length; index++) {
    const token = raw[index]
    if (token === '--') {
      index++
      break
    }
    if (token === '--revoke-workspace') {
      revokeWorkspace = true
      continue
    }
    index++
    const value = raw[index]
    if (value === undefined) fail(`missing value after ${token}`)
    if (token === '--workspace') workspace = value
    else if (token === '--temp') temp = value
    else if (token === '--mode') mode = value
    else fail(`unknown argument: ${token}`)
  }
  if (!workspace) fail('missing --workspace')
  if (!temp) fail('missing --temp')
  if (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'cleanup') {
    fail(`unknown mode: ${String(mode)}`)
  }
  return { workspace, temp, mode, revokeWorkspace, argv: raw.slice(index) }
}

function requireDirectory(label, path) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    fail(`${label} is not an existing directory: ${path}`)
  }
  if (!stat.isDirectory()) fail(`${label} is not a directory: ${path}`)
}

/** The private temp dir must live outside the workspace (otherwise "the temp dir is writable" would open a hole into the workspace) */
function assertTempOutsideWorkspace(workspace, temp) {
  const canonicalWorkspace = realpathSync.native(workspace).toLowerCase()
  const canonicalTemp = realpathSync.native(temp).toLowerCase()
  if (canonicalTemp === canonicalWorkspace || canonicalTemp.startsWith(canonicalWorkspace + '\\')) {
    fail(`--temp must live outside --workspace (workspace=${workspace}, temp=${temp})`)
  }
}

/* ────────────────────────── Main flow ────────────────────────── */

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  requireDirectory('--workspace', parsed.workspace)
  requireDirectory('--temp', parsed.temp)

  const bindings = createBindings()
  const { kernel } = bindings
  // Give ourselves a (hidden) console first: restricted children are created "sharing the console",
  // and if the runner had none, Windows would create a new one for each child — a black window
  // flashing on the desktop (see the ensureConsole comment).
  ensureConsole(bindings)

  // cleanup mode: only revoke our ACE on the workspace (the uninstall/cleanup entry point); start no processes
  if (parsed.mode === 'cleanup') {
    const sidPtr = sidFromString(bindings, workspaceWriteSid(parsed.workspace))
    try {
      revokeWrite(bindings, parsed.workspace, sidPtr)
    } finally {
      kernel.LocalFree(sidPtr)
    }
    return 0
  }

  assertTempOutsideWorkspace(parsed.workspace, parsed.temp)
  if (parsed.argv.length === 0) fail('missing command after --')

  // The runner ignores Ctrl+C: the restricted child (same console) keeps handling it itself, and the
  // runner must live until it has revoked the temporary ACE, cleaned the temp dir, and mirrored the exit code
  if (kernel.SetConsoleCtrlHandler(null, 1) === 0) {
    fail(`SetConsoleCtrlHandler failed (Win32 ${kernel.GetLastError()})`)
  }

  const currentToken = openCurrentProcessToken(bindings)
  const logonSid = findLogonSid(bindings, currentToken)
  const everyoneSid = makeWellKnownSid(bindings, WinWorldSid)

  let workspaceSidPtr = null
  let tempSidPtr = null
  let privateTempDir = null
  let restrictedToken = null

  try {
    if (parsed.mode === 'workspace-write') {
      workspaceSidPtr = sidFromString(bindings, workspaceWriteSid(parsed.workspace))
      // Private temp dir: random path → random capability SID; other sessions cannot write into it
      privateTempDir = mkdtempSync(join(parsed.temp, 'ryten-sandbox-'))
      tempSidPtr = sidFromString(bindings, tempWriteSid(privateTempDir))
      grantWrite(bindings, parsed.workspace, workspaceSidPtr)
      grantWrite(bindings, privateTempDir, tempSidPtr)
    }

    restrictedToken = createRestrictedToken(
      bindings,
      currentToken,
      logonSid,
      [workspaceSidPtr, tempSidPtr].filter(Boolean),
      everyoneSid,
      parsed.mode
    )
    /**
     * Default DACL: for workspace-write merge two entries ("capability SID + Everyone"), for
     * read-only merge Everyone.
     *
     * Why not merge only the capability SID: a restricted token inherits the user's default DACL
     * verbatim, and that DACL **contains no restricting SID**. When the sandboxed process creates
     * objects during startup (console, sections, events, pipes, temp files), write-type access must
     * pass a two-pass check, and the second pass can only succeed via a restricting SID in the
     * object's own DACL:
     *   - measured locally (temporarily removing this whole block): the console child dies
     *     immediately with 0xC0000142 during DLL initialization;
     *   - measured on CI (GitHub windows-latest, merging only the capability SID): the
     *     `workspace-write` console child likewise gets 0xC0000142, while `read-only` (whose default
     *     DACL merges Everyone) works — showing that the startup object is also accessed by
     *     **other components** (the console host, etc.), and only we carry the random capability SID.
     * So both are merged: the capability SID keeps our own objects at least privilege, and Everyone
     * lets host-side components through too.
     * Cost (recorded honestly among the known limits): DACLs of objects **newly created** by the
     * child contain Everyone; whether creation is possible is still governed by the parent
     * directory's DACL, so out-of-bounds creation is still denied.
     */
    setTokenDefaultDaclGrant(bindings, restrictedToken, workspaceSidPtr ?? everyoneSid)
    if (workspaceSidPtr !== null) setTokenDefaultDaclGrant(bindings, restrictedToken, everyoneSid)

    if (privateTempDir !== null) {
      // The child's TMP/TEMP point at the authorized private temp dir (only the runner's own environment is changed; the child inherits it)
      if (kernel.SetEnvironmentVariableW('TMP', privateTempDir) === 0) {
        fail(`SetEnvironmentVariableW TMP failed (Win32 ${kernel.GetLastError()})`)
      }
      if (kernel.SetEnvironmentVariableW('TEMP', privateTempDir) === 0) {
        fail(`SetEnvironmentVariableW TEMP failed (Win32 ${kernel.GetLastError()})`)
      }
    }

    const child = spawnConfined(bindings, restrictedToken, {
      command: parsed.argv[0],
      args: parsed.argv.slice(1),
      cwd: parsed.workspace
    })
    let exitCode
    try {
      // Pump output first (child finishes writing → closes the write end → read end EOF), then fetch the exit code
      await pumpPipes(bindings, child.pipes)
      exitCode = waitForExit(bindings, child.process)
      // Informational hint (deliberately without the `ryten-sandbox-run:` failure signature, to avoid
      // the upper layer judging it as a "backend failure"): when the child dies during DLL/console
      // initialization, the exit code 0xC0000142 is completely unexplainable to the upper layer.
      if (exitCode === STATUS_DLL_INIT_FAILED) {
        process.stderr.write(
          `[ryten-sandbox] child exited with STATUS_DLL_INIT_FAILED (0xC0000142) before running\n`
        )
      }
    } finally {
      closePipes(bindings, child.pipes)
      kernel.CloseHandle(child.process)
      kernel.CloseHandle(child.job)
    }
    return exitCode
  } finally {
    // Cleanup must be best-effort: it must never mask the child's exit code
    if (workspaceSidPtr !== null && parsed.revokeWorkspace) {
      try {
        revokeWrite(bindings, parsed.workspace, workspaceSidPtr)
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${describeError(error)}\n`)
      }
    }
    if (tempSidPtr !== null && privateTempDir !== null) {
      try {
        revokeWrite(bindings, privateTempDir, tempSidPtr)
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${describeError(error)}\n`)
      }
    }
    if (privateTempDir !== null) {
      try {
        rmSync(privateTempDir, { recursive: true, force: true })
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${describeError(error)}\n`)
      }
    }
    // Only SIDs allocated by Win32 (ConvertStringSidToSidW) may be LocalFree'd; the logon SID /
    // Everyone are bytes in our own Buffers and must not be LocalFree'd
    for (const sid of [workspaceSidPtr, tempSidPtr]) {
      if (sid !== null) kernel.LocalFree(sid)
    }
    if (restrictedToken !== null) kernel.CloseHandle(restrictedToken)
    kernel.CloseHandle(currentToken)
  }
}

function describeError(error) {
  return error && error.message ? error.message : String(error)
}

main().then(
  (exitCode) => {
    process.exitCode = exitCode
  },
  (error) => {
    if (!(error instanceof RunnerFailure)) {
      process.stderr.write(`${RUNNER_SIGNATURE}: ${describeError(error)}\n`)
    }
    process.exitCode = RUNNER_FAILURE_EXIT
  }
)
