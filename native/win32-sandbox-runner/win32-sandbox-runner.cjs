#!/usr/bin/env node
/**
 * RytenBench 沙箱服务 —— Windows 受限令牌 runner（**自研实现**，不依赖任何第三方沙箱包）。
 *
 * 它被主进程当作「argv 前缀」spawn：
 *
 *   [electron/node, win32-sandbox-runner.cjs,
 *    '--workspace', <工作区>, '--temp', <私有临时目录根>,
 *    '--mode', <read-only|workspace-write|cleanup>, ['--revoke-workspace'],
 *    '--', <真正要跑的命令...>]
 *
 * 机制（全部是用户态 Win32：不需要管理员、不新建账户、不装任何外部工具）：
 *  1. 打开当前进程令牌 → 取出登录 SID（S-1-5-5-x-y，进程初始化必需）；
 *  2. 由工作区路径**确定性派生**一个能力 SID（`S-1-4-a-b`），私有临时目录再派生第二个；
 *  3. 给工作区/临时目录的 DACL 合并一条「该 SID 的写 ACE」（写 + 删除 + 删除子项，
 *     刻意不含 WRITE_DAC/WRITE_OWNER——被沙箱化的进程不能改 DACL 或夺取所有权自救）；
 *  4. `CreateRestrictedToken(WRITE_RESTRICTED)`：restricting 列表 = [登录 SID, Everyone]
 *     （workspace-write 时再加两个能力 SID）。Windows 对写类访问做**两遍检查**：
 *     普通 SID 与 restricting SID 都通过才放行 ⇒ restricting 列表里没有的 SID 拿不到
 *     任何写权限，这就是「只能写工作区」的落地方式；
 *  5. `CreateProcessAsUserW` 以受限令牌 spawn，**runner 自己 `CreatePipe` 建匿名管道**做 stdio
 *     （Node 的管道是 overlapped 的，受限子进程同步写会 `ERROR_INVALID_PARAMETER`），
 *     `PeekNamedPipe` + `ReadFile` 泵回 runner 的 stdout；子进程放进 kill-on-close 的
 *     Job Object（runner 被杀 → 整棵子树被清理）；子进程**共享 runner 的控制台**并用
 *     `STARTF_USESHOWWINDOW + SW_HIDE` 隐藏窗口（**不传 CREATE_NO_WINDOW**：受限令牌下
 *     控制台隔离会让子进程以 0xC0000142 死在 DLL 初始化阶段，见常量处的实测记录）；
 *  6. 子进程退出后撤销临时 ACE、删除私有临时目录，并镜像子进程退出码。
 *
 * 失败契约：runner 侧任何失败都往 stderr 打 `ryten-sandbox-run: <detail>` 并以 127 退出
 * ——**绝不会在没有受限令牌的情况下 spawn 子进程**（故障关闭）。
 *
 * 已知边界（由上层写进文档，不假装是绝对边界）：
 *  - restricting 列表必须保留 Everyone（早期 DLL 初始化与 CNG 依赖它），因此 DACL 里
 *    显式授予 Everyone 写权限的对象仍可写；NTFS 硬链接也能把已授权文件别名到工作区外；
 *  - 只在带 ACL 的卷上有效（exFAT / 网络盘上没有 ACL）——这种工作区由上层判定为不可用；
 *  - 子进程与 runner **共享控制台**：受限令牌下做不了控制台隔离（`CREATE_NO_WINDOW` /
 *    `CREATE_NEW_CONSOLE` 的子进程会在 DLL 初始化阶段以 0xC0000142 死亡），窗口用
 *    `STARTF_USESHOWWINDOW + SW_HIDE` 隐藏；stdio 走 runner 自己建的管道，不受影响。
 *  - 本文件是 plain CJS（不经过打包器）：它是被独立进程加载的脚本，需要 koffi 能在
 *    应用根下解析到，并运行在 Electron 的 node 模式（ELECTRON_RUN_AS_NODE=1）。
 */
'use strict'

const { createHash } = require('node:crypto')
const { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')

/** runner 失败签名（主进程按它区分「沙箱坏了」与「命令失败了」） */
const RUNNER_SIGNATURE = 'ryten-sandbox-run'
/** runner 失败退出码（刻意与任何命令退出码区分开） */
const RUNNER_FAILURE_EXIT = 127
/** 子进程在 loader/控制台初始化阶段就死掉（只做诊断提示，不改退出码语义） */
const STATUS_DLL_INIT_FAILED = 0xc0000142

/* ────────────────────────── Win32 常量 ────────────────────────── */

const PROCESS_QUERY_INFORMATION = 0x0400
const TOKEN_ASSIGN_PRIMARY = 0x0001
const TOKEN_DUPLICATE = 0x0002
const TOKEN_QUERY = 0x0008
const TOKEN_ADJUST_DEFAULT = 0x0080
/** CreateRestrictedToken 标志 */
const DISABLE_MAX_PRIVILEGE = 0x1
const LUA_TOKEN = 0x4
const WRITE_RESTRICTED = 0x8
/** CreateProcessAsUserW 标志 */
const CREATE_UNICODE_ENVIRONMENT = 0x00000400
/**
 * STARTUPINFO.dwFlags：让 wShowWindow 生效。
 *
 * **刻意不传 `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE`**：受限令牌下这两种「控制台隔离」
 * 会让子进程在 DLL 初始化阶段直接死掉（`STATUS_DLL_INIT_FAILED` = 0xC0000142，stderr 全空）。
 * 2026-09-27 在 GitHub Actions（windows-latest，控制台/桌面环境与开发机不同）实测复现：
 * 打包产物自检的两条「工作区内写入」都是 exit=0xC0000142，而 cleanup（不起子进程）正常，
 * 说明坏的是「受限子进程起不来」而不是 runner 本身。参考实现（dsh-sandbox-windows-acl）
 * 的已知边界写得同样直白：CREATE_NO_WINDOW / CREATE_NEW_CONSOLE 子进程在 DLL 初始化期死亡，
 * 子进程共享宿主控制台，基于管道的 stdio 重定向不受影响。
 *
 * 共享控制台 + `wShowWindow = SW_HIDE` 才是正解：控制台照常存在（子进程能起来），
 * 但窗口不显示（GUI 宿主下不会闪黑框）。这也是本文件第 5 步 `SetConsoleCtrlHandler(null, 1)`
 * 「子进程在同一控制台里自己处理 Ctrl+C」所假设的形态。
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
/** 标准句柄 */
const STD_INPUT_HANDLE = -10
const STD_OUTPUT_HANDLE = -11
const STD_ERROR_HANDLE = -12
const STARTF_USESTDHANDLES = 0x00000100
/** 安全信息 / 对象类型 / 访问模式 */
const DACL_SECURITY_INFORMATION = 0x00000004
const SE_FILE_OBJECT = 1
const GRANT_ACCESS = 1
const REVOKE_ACCESS = 4
const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3
const TRUSTEE_IS_SID = 0
const TRUSTEE_IS_UNKNOWN = 0
const NO_MULTIPLE_TRUSTEE = 0
const ERROR_SUCCESS = 0
/** 令牌信息类 */
const TokenGroups = 2
const TokenDefaultDacl = 6
/** SID */
const SECURITY_MAX_SID_SIZE = 68
const SE_GROUP_LOGON_ID = 0xc0000000
const WinWorldSid = 1
/** 访问掩码：写 + 删除 + 删除子项；刻意排除 WRITE_DAC/WRITE_OWNER 与标准权限位 */
const STANDARD_RIGHTS_WRITE = 0x00020000
const FILE_GENERIC_WRITE = 0x00120116
const DELETE = 0x00010000
const FILE_DELETE_CHILD = 0x00000040
const GRANT_MASK = (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE
const FILE_ALL_ACCESS = 0x1f01ff
/** x64 结构体尺寸（自检用） */
const STARTUPINFOW_SIZE = 104
const PROCESS_INFORMATION_SIZE = 24
const JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE = 144
const EXPLICIT_ACCESS_W_SIZE = 48

/* ────────────────────────── 失败 ────────────────────────── */

class RunnerFailure extends Error {}

/** runner 侧失败：打签名行并以 127 退出（绝不静默不受限地跑） */
function fail(detail) {
  process.stderr.write(`${RUNNER_SIGNATURE}: ${detail}\n`)
  throw new RunnerFailure(detail)
}

/* ────────────────────────── koffi 绑定 ────────────────────────── */

/**
 * 加载 koffi（FFI 只是「调 Win32 API 的手」，沙箱逻辑全在本文件里）。
 *
 * 解析路径要覆盖三种运行形态：开发态（仓库根 node_modules）、打包态（app.asar 内，
 * Electron 的 node 模式会把它映射到 app.asar.unpacked）以及工装态（显式给 RYTEN_APP_ROOT）。
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
      // 试下一个候选根
    }
  }
  fail('koffi is not resolvable (set RYTEN_APP_ROOT to the application root)')
}

/** 建一次绑定表（进程级复用） */
function createBindings() {
  const koffi = loadKoffi()
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')

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
    // ACL 遍历（幂等检查用）：刻意不用 koffi.view 读整块 ACL 内存（在 Electron 下会崩，见 readBytes）
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

  // 结构体布局自检：布局错了会以极难排查的方式失败，这里直接故障关闭
  const sizes = [
    ['STARTUPINFOW', koffi.sizeof(STARTUPINFOW), STARTUPINFOW_SIZE],
    ['PROCESS_INFORMATION', koffi.sizeof(PROCESS_INFORMATION), PROCESS_INFORMATION_SIZE]
  ]
  for (const [name, actual, expected] of sizes) {
    if (actual !== expected) fail(`unexpected ${name} size ${actual} (expected ${expected} on x64)`)
  }

  return { koffi, kernel, advapi, STARTUPINFOW, PROCESS_INFORMATION }
}

/* ────────────────────────── SID / 内存小工具 ────────────────────────── */

/**
 * 逐字节读一段原生内存（SID / ACE 内嵌 SID 用）。
 *
 * **为什么不用 `koffi.view`**：koffi 3.3.1 的 `view()` 在 Electron（实测 44.1.1 / Node 24.19）
 * 里会直接 `FATAL ERROR: Error::New napi_get_last_error_info` 崩掉整个进程——而 `decode`、
 * `address`、`encode`、以及所有 Win32 调用在该运行时下都正常。这个崩溃是原生 abort、
 * try/catch 拦不住，因此本文件**禁止使用 `koffi.view`**（工装里有一条静态断言盯着）。
 * SID 最长 68 字节，逐字节 decode 的开销可以忽略。
 */
function readBytes(koffi, ptr, offset, count) {
  const bytes = Buffer.allocUnsafe(count)
  for (let index = 0; index < count; index++) {
    bytes[index] = koffi.decode(ptr, offset + index, 'uint8_t')
  }
  return bytes
}

/** 取指针指向的 SID 的字节（SID = 1 字节修订 + 1 字节子权威数 + 6 字节权威 + N×4 字节子权威） */
function sidBytes(koffi, sidPtr) {
  const count = koffi.decode(sidPtr, 1, 'uint8_t')
  if (count > 15) fail(`implausible SID sub-authority count ${count}`)
  return readBytes(koffi, sidPtr, 0, 8 + count * 4)
}

/** 抛 Win32 错误（带 API 名、错误码与上下文） */
function throwWin32(kernel, api, code, context) {
  fail(`${api} failed (Win32 ${code}) ${context}`)
}

/* ────────────────────────── 能力 SID 派生 ────────────────────────── */

/**
 * 由路径确定性派生一个能力 SID：`S-1-4-a-b`。
 *
 * 为什么确定性：工作区 ACE 是「每台机器每个工作区只物化一次」的复用缓存（第二次起命中
 * 精确 ACE 就跳过，不必对整个目录树重新传播）。能力 SID 字符串本身不是秘密，它的权力
 * 完全来自「哪些 DACL 上有它的 ACE」与「哪些令牌带它」。
 */
function capabilitySid(path, salt) {
  const digest = createHash('sha256').update(`${salt}\u0000${path.toLowerCase()}`).digest()
  const a = (digest.readUInt32BE(0) % 0x7fffffff) + 1
  const b = (digest.readUInt32BE(4) % 0x7fffffff) + 1
  return `S-1-4-${a}-${b}`
}

/** 工作区写身份（跨会话复用） */
function workspaceWriteSid(workspace) {
  return capabilitySid(realpathSync.native(workspace), 'ryten-workspace-write')
}

/** 私有临时目录写身份（每次运行随机目录 → 随机身份） */
function tempWriteSid(tempDir) {
  return capabilitySid(tempDir, 'ryten-temp-write')
}

/** SID 字符串 → SID 指针（调用方负责 LocalFree） */
function sidFromString(bindings, sidString) {
  const slot = [null]
  if (bindings.advapi.ConvertStringSidToSidW(sidString, slot) === 0) {
    throwWin32(bindings.kernel, 'ConvertStringSidToSidW', bindings.kernel.GetLastError(), sidString)
  }
  if (slot[0] === null) fail(`ConvertStringSidToSidW returned a null SID for ${sidString}`)
  return slot[0]
}

/* ────────────────────────── 令牌 ────────────────────────── */

/** 打开当前进程令牌（CreateRestrictedToken 需要这几个权限） */
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

/** 取出登录 SID（S-1-5-5-x-y）：没有它，很多进程初始化路径会直接死掉（0xC0000142） */
function findLogonSid(bindings, token) {
  const { koffi, kernel, advapi } = bindings
  const needed = [0]
  advapi.GetTokenInformation(token, TokenGroups, null, 0, needed) // 预期以 ERROR_INSUFFICIENT_BUFFER 失败
  if (needed[0] < 8) {
    throwWin32(kernel, 'GetTokenInformation', kernel.GetLastError(), 'TokenGroups size query')
  }
  const groups = Buffer.alloc(needed[0])
  if (advapi.GetTokenInformation(token, TokenGroups, groups, groups.length, needed) === 0) {
    throwWin32(kernel, 'GetTokenInformation', kernel.GetLastError(), 'TokenGroups')
  }
  const count = groups.readUInt32LE(0)
  // TOKEN_GROUPS：DWORD GroupCount，随后 SID_AND_ATTRIBUTES[count]（x64 每项 16 字节：
  // PSID 8 字节 + DWORD 属性 + 4 字节填充），首项偏移 8
  for (let index = 0; index < count; index++) {
    const offset = 8 + index * 16
    const sidPtr = koffi.decode(groups, offset, 'void *')
    const attributes = groups.readUInt32LE(offset + 8)
    if (sidPtr === null) continue
    // >>> 0：JS 位运算是有符号 32 位，而 SE_GROUP_LOGON_ID 的最高位是 1
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

/** 创建一个众所周知的 SID（Everyone） */
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
 * 造受限令牌：restricting 列表 = [登录 SID, Everyone]（+ workspace-write 的两个能力 SID）。
 *
 * 保留 Everyone 与登录 SID 是**必需**的：没有它们，被沙箱化的进程在早期 DLL 初始化与
 * CNG 上会崩（实测 0xC0000142 / pwsh 0xE0434352）。这也正是「Everyone 的既有授权仍可写」
 * 这一已知边界的来源。
 */
function createRestrictedToken(bindings, currentToken, logonSid, writeSids, everyoneSid, mode) {
  const { koffi, kernel, advapi } = bindings
  if (mode !== 'read-only' && writeSids.length === 0) {
    fail('workspace-write requires at least one write SID')
  }
  const sids =
    mode === 'read-only' ? [logonSid, everyoneSid] : [logonSid, everyoneSid, ...writeSids]
  // SID_AND_ATTRIBUTES[count]：x64 每项 16 字节（SID 指针 + 属性 0 + 填充）
  const list = Buffer.alloc(16 * sids.length)
  sids.forEach((sid, index) => {
    list.writeBigUInt64LE(koffi.address(sid), 16 * index)
  })
  const tokenSlot = [null]
  const ok = advapi.CreateRestrictedToken(
    currentToken,
    DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
    0,
    null, // 不禁用任何 SID
    0,
    null, // 不删除任何权限
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
 * 把一条「该 SID 的完全访问 ACE」并进令牌的默认 DACL。
 *
 * 受限令牌会原样继承用户的默认 DACL，而默认 DACL 里没有 restricting SID：被沙箱化的进程
 * 新建对象（匿名管道、临时文件）时，写访问的第二遍检查会失败（ERROR_ACCESS_DENIED，Node
 * 表现为 spawn EPERM），于是「子进程再起子进程」全线崩。并入一条命名 restricting SID 的
 * ACE 后，新对象自身的 DACL 能过第二遍检查，而「能不能创建这个对象」仍由父目录 DACL 把关
 * （工作区之外照样创建不了）。
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

/* ────────────────────────── ACL 授权 / 撤销 ────────────────────────── */

/** 打包一条 EXPLICIT_ACCESS_W（48 字节 x64；permissions 在 REVOKE 时为 0） */
function explicitAccess(bindings, sidPtr, mode, permissions) {
  const entry = Buffer.alloc(EXPLICIT_ACCESS_W_SIZE)
  entry.writeUInt32LE(permissions, 0) // grfAccessPermissions
  entry.writeUInt32LE(mode, 4) // grfAccessMode
  entry.writeUInt32LE(SUB_CONTAINERS_AND_OBJECTS_INHERIT, 8) // grfInheritance = OI|CI
  entry.writeUInt32LE(NO_MULTIPLE_TRUSTEE, 24) // Trustee.MultipleTrusteeOperation
  entry.writeUInt32LE(TRUSTEE_IS_SID, 28) // Trustee.TrusteeForm
  entry.writeUInt32LE(TRUSTEE_IS_UNKNOWN, 32) // Trustee.TrusteeType
  entry.writeBigUInt64LE(bindings.koffi.address(sidPtr), 40) // Trustee.ptstrName = 能力 SID
  return entry
}

/** 一个受保护路径的锁文件：<系统临时目录>/ryten-acl-locks/<sha256(路径)>.lock */
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
 * 在「每路径独占锁」下执行一次 DACL 读-改-写。
 *
 * 为什么需要：授权是「读当前 DACL → 合并 → 写回」，两个并发沙箱（比如两个子代理同时跑
 * 命令）会互相覆盖对方的 ACE。锁用 LockFileEx（不是「文件存在与否」），且不共享删除位
 * ——可被删除的锁文件会让两个进程同时「持有」同一把锁。
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
  const overlapped = Buffer.alloc(32) // OVERLAPPED 全零：偏移 0、hEvent NULL
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

/** 读目录当前的显式 DACL（描述符必须在合并消费完 DACL 之后再释放） */
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

/** 合并并落盘：把一条 EXPLICIT_ACCESS_W 并进 oldAcl，再 SetNamedSecurityInfoW */
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
  if (descriptor !== null) kernel.LocalFree(descriptor) // 描述符块（含 oldAcl）此后失效
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
 * 目录当前 DACL 是否已带完全相同的授权 ACE（有则跳过写回）：命中即省掉整棵树的重新传播。
 *
 * 实现刻意**只用 Win32 的 ACL 接口 + `koffi.decode`**（`GetAclInformation` 取 ACE 数量、
 * `GetAce` 逐条取 ACE 指针），不用 `koffi.view` 去读整块 ACL 内存：
 * ACE 里的 SID 是**内嵌**的（不是指针），只能按偏移逐字节读出来比较；而 `koffi.view`
 * 在 Electron 下会崩（见 readBytes 的注释）。
 */
function hasExactGrant(bindings, oldAcl, sidPtr) {
  const { koffi, advapi, kernel } = bindings
  const info = Buffer.alloc(12) // ACL_SIZE_INFORMATION { AceCount; AclBytesInUse; AclBytesFree; }
  if (advapi.GetAclInformation(oldAcl, info, info.length, 2) === 0) {
    // 读不出 ACL 结构：退回合并路径（那条路有完整的错误处理）
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

/** 给目录合并一条写授权 ACE（幂等） */
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

/** 撤销该 SID 在该目录上的所有 ACE（其它条目保留） */
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

/** SECURITY_ATTRIBUTES（x64 24 字节）：bInheritHandle=1 让管道写端可被子进程继承 */
function inheritableAttributes() {
  const sa = Buffer.alloc(24)
  sa.writeUInt32LE(24, 0) // nLength
  sa.writeUInt32LE(1, 16) // bInheritHandle
  return sa
}

/**
 * 给受限子进程建两条**自己的**匿名管道（stdout / stderr）。
 *
 * 为什么不直接把 runner 的 std 句柄传下去：Node/libuv 的管道是 overlapped 的，
 * 子进程对它做同步 WriteFile 会以 ERROR_INVALID_PARAMETER 失败；控制台句柄则会被
 * 受限令牌的写检查挡住。自己 CreatePipe 出来的是普通匿名管道，子进程同步写没问题，
 * runner 再把内容泵到自己的 stdout（Node 侧异步写 overlapped 句柄是没问题的）。
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

/** 从管道读一次可用数据（Peek 到有数据才 Read，避免阻塞在空管道上） */
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

/** 把两条管道泵到 runner 自己的 stdout/stderr，直到两条都关闭 */
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
    // 没有数据可读时让出事件循环（子进程可能还在跑）
    if (moved === 0 && (stdoutOpen || stderrOpen)) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

/** 关掉管道两端（子进程侧先关：读端才能看到 EOF） */
function closePipes(bindings, pipes) {
  const { kernel } = bindings
  for (const pipe of [pipes.stdout, pipes.stderr]) {
    if (pipe.write) kernel.CloseHandle(pipe.write)
    if (pipe.read) kernel.CloseHandle(pipe.read)
  }
}

/* ────────────────────────── 受限 spawn ────────────────────────── */

/** Windows 命令行参数引用规则（含空格/引号时加引号并转义反斜杠） */
function quoteArg(value) {
  const text = String(value)
  if (text.length > 0 && !/[\s"]/.test(text)) return text
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

/** 建 kill-on-close 的 Job Object（runner 消失 → 子树一起消失） */
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
 * 以受限令牌 spawn 子进程，stdio 继承 runner 自己的（父进程看到的仍是普通管道）。
 * 子进程被放进 Job Object：runner 一旦消失（被杀/崩溃），Job 句柄关闭 → 整棵子树被杀。
 */
function spawnConfined(bindings, token, { command, args, cwd }) {
  const { kernel, advapi } = bindings
  const pipes = createStdioPipes(bindings)
  // koffi 用「普通 JS 对象 ↔ C 结构体」映射：声明里带 _Inout_/_Out_ 的参数会把结构体
  // 拷进去、执行后把字段写回同一个对象（struct 类型本身不是构造函数）。
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
    1, // bInheritHandles：让子进程拿到我们建的管道写端
    CREATE_UNICODE_ENVIRONMENT, // 刻意不带 CREATE_NO_WINDOW / CREATE_NEW_CONSOLE（见常量注释）
    null, // 环境块继承：TMP/TEMP 已由 runner 改写
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
  // 写端已经交给子进程：runner 侧立刻关掉，读端才能看到 EOF
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

/** 等子进程退出并取退出码 */
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

/* ────────────────────────── 命令行解析 ────────────────────────── */

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

/** 私有临时目录必须位于工作区之外（否则「临时目录可写」就等于给工作区开口子） */
function assertTempOutsideWorkspace(workspace, temp) {
  const canonicalWorkspace = realpathSync.native(workspace).toLowerCase()
  const canonicalTemp = realpathSync.native(temp).toLowerCase()
  if (canonicalTemp === canonicalWorkspace || canonicalTemp.startsWith(canonicalWorkspace + '\\')) {
    fail(`--temp must live outside --workspace (workspace=${workspace}, temp=${temp})`)
  }
}

/* ────────────────────────── 主流程 ────────────────────────── */

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  requireDirectory('--workspace', parsed.workspace)
  requireDirectory('--temp', parsed.temp)

  const bindings = createBindings()
  const { kernel } = bindings

  // cleanup 模式：只撤销工作区上我们的 ACE（卸载/清理入口），不起任何进程
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

  // runner 忽略 Ctrl+C：受限子进程（同一控制台）继续自己处理，runner 必须活到
  // 撤销临时 ACE、清理临时目录、镜像退出码为止
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
      // 私有临时目录：随机路径 → 随机能力 SID，别的会话写不进来
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
     * 默认 DACL：workspace-write 并「能力 SID + Everyone」两条，read-only 并 Everyone。
     *
     * 为什么不能只并那条能力 SID：受限令牌只原样继承用户的默认 DACL，而它**不含任何
     * restricting SID**。被沙箱化的进程在启动期新建对象（控制台、段、事件、管道、临时文件）时，
     * 写类访问要过两遍检查，第二遍只能靠对象自身 DACL 里的 restricting SID：
     *   - 本地实测（临时把这段整个去掉）：控制台子进程立刻以 0xC0000142 死在 DLL 初始化阶段；
     *   - CI 实测（GitHub windows-latest，只并能力 SID）：`workspace-write` 的控制台子进程同样
     *     0xC0000142，而 `read-only`（默认 DACL 并的是 Everyone）正常 —— 说明启动期那个对象
     *     还会被**别的组件**（控制台宿主等）访问，随机能力 SID 只有我们自己带得动。
     * 所以两条都并：能力 SID 让自有对象按最小授权走，Everyone 让宿主侧组件也过得去。
     * 代价（如实记在 README 的已知边界里）：子进程**新建**对象的 DACL 会含 Everyone；
     * 能不能新建仍由父目录 DACL 把关，越界创建照样被拒。
     */
    setTokenDefaultDaclGrant(bindings, restrictedToken, workspaceSidPtr ?? everyoneSid)
    if (workspaceSidPtr !== null) setTokenDefaultDaclGrant(bindings, restrictedToken, everyoneSid)

    if (privateTempDir !== null) {
      // 子进程的 TMP/TEMP 指向已授权的私有临时目录（只改 runner 自己的环境，子进程继承）
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
      // 先泵输出（子进程写完 → 关闭写端 → 读端 EOF），再取退出码
      await pumpPipes(bindings, child.pipes)
      exitCode = waitForExit(bindings, child.process)
      // 信息性提示（刻意不带 `ryten-sandbox-run:` 失败签名，避免被上层判成「后端坏了」）：
      // 子进程在 DLL/控制台初始化阶段就死掉时，0xC0000142 这个退出码对上层完全不可解释。
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
    // 清理必须尽力而为：绝不能掩盖子进程的退出码
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
    // 只有 Win32 分配的 SID（ConvertStringSidToSidW）才 LocalFree；
    // 登录 SID / Everyone 是我们自己 Buffer 里的字节，不能 LocalFree
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
