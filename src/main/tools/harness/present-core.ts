/**
 * `present` 的纯路径校验（无 electron / i18n 依赖，可离线测试）。
 *
 * 规则（与 DSH 的 present 一致：交付物必须是**已存在的工作区文件**）：
 * - 只接受工作区虚拟路径（`/docs/a.pdf`）或工作区相对路径（`docs/a.pdf`，自动补 `/`）；
 * - 拒绝绝对磁盘路径（`C:\...`、`/home/...` 在 Windows 上会被当成相对路径，因此按段校验）；
 * - 拒绝 `..` 逃逸出工作区；
 * - 文件必须存在且是普通文件。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export type PresentPathFailure =
  | { code: 'empty' }
  | { code: 'no-workspace' }
  | { code: 'escape'; path: string }
  | { code: 'missing'; path: string }
  | { code: 'not-file'; path: string }

export type PresentPathResult =
  | { ok: true; virtualPath: string; realPath: string }
  | { ok: false; failure: PresentPathFailure }

/** 把用户/模型给的路径归一化成工作区虚拟路径；失败返回失败原因 */
export function normalizePresentPath(raw: string, workspaceRoot?: string): PresentPathResult {
  const input = (raw ?? '').trim()
  if (!input) return { ok: false, failure: { code: 'empty' } }

  // 统一分隔符；绝对磁盘路径（含盘符）一律拒绝
  const unified = input.replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(unified)) {
    return { ok: false, failure: { code: 'escape', path: input } }
  }

  const withoutLeading = unified.replace(/^\/+/, '')
  const segments = withoutLeading
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0) return { ok: false, failure: { code: 'empty' } }
  if (segments.some((segment) => segment === '..')) {
    return { ok: false, failure: { code: 'escape', path: input } }
  }

  const virtualPath = `/${segments.join('/')}`
  if (!workspaceRoot) return { ok: false, failure: { code: 'no-workspace' } }

  const realPath = path.join(workspaceRoot, ...segments)
  const relative = path.relative(workspaceRoot, realPath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, failure: { code: 'escape', path: input } }
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(realPath)
  } catch {
    return { ok: false, failure: { code: 'missing', path: virtualPath } }
  }
  if (!stat.isFile()) return { ok: false, failure: { code: 'not-file', path: virtualPath } }
  return { ok: true, virtualPath, realPath }
}
