import * as fs from 'fs'
import * as path from 'path'
import {
  draftDir,
  draftsRoot,
  draftRootOf,
  ensureDir,
  readJson,
  setDraftRoot,
  workshopRoot
} from './paths'
import { listDraftFiles, writeDraftMeta, readDraftMeta } from './store'

/**
 * 草稿的**工作目录**（源码落盘位置）：把插件源码放到用户自己的目录里——
 * 能进 git、能用编辑器打开、能手工改，而不是埋在 `userData/plugin-workshop/drafts/` 下。
 *
 * 三条安全规则（这是唯一会碰用户目录的模块，写清楚再动手）：
 * 1. **绝不删用户目录**：换目录、删除草稿都只搬自己写进去的文件；用户目录本身留着，
 *    里面的额外文件（.git、README、编辑器配置）一概不动；
 * 2. **非空目录不接管**：目标目录里已经有别的东西时直接拒绝并说明原因，
 *    而不是把用户的文件和自己生成的骨架混在一起；
 * 3. **不接管工坊自己的目录**：目标不能在 `<root>/` 里面（否则 drafts/dist/reports 会互相套娃）。
 */

/** 换目录的结果（面板/工具据此说清「搬了什么、没做什么」） */
export interface WorkingDirResult {
  id: string
  /** 生效后的源码目录 */
  dir: string
  /** 是否发生了文件搬迁（空目录接管时会把草稿搬过去） */
  moved: boolean
  /** true = 目标目录里已有一份同 id 的草稿，直接接管为源码真源 */
  adopted: boolean
  /** 换目录后**留在原处**的东西（默认 drafts 目录，用户可自行删除） */
  previousDir?: string
}

/** 目标目录里是否已有某 id 的插件清单 */
function manifestIdOf(dir: string): string | null {
  const raw = readJson<{ id?: unknown }>(path.join(dir, 'plugin.json'))
  return typeof raw?.id === 'string' ? raw.id : null
}

/** 目录是否为空（忽略系统噪音文件） */
function isEmptyDir(dir: string): boolean {
  const noise = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
  return fs.readdirSync(dir).every((name) => noise.has(name))
}

/** 把一个草稿的源码整体搬到另一个目录（移完删掉源目录——源目录只可能是工坊自己管的） */
function moveDraftFiles(from: string, to: string): void {
  ensureDir(to)
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    fs.rmSync(dest, { recursive: true, force: true })
    fs.renameSync(src, dest)
  }
  fs.rmSync(from, { recursive: true, force: true })
}

/** 校验目标目录可用（存在、是目录、不在工坊根里） */
function assertUsableDir(dir: string): string {
  const resolved = path.resolve(dir)
  const workshop = path.resolve(workshopRoot())
  if (resolved === workshop || resolved.startsWith(workshop + path.sep)) {
    throw new Error('工作目录不能放在插件工坊自己的目录里（drafts / dist / reports 都在那儿）')
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`工作目录不存在：${resolved}`)
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`工作目录不是文件夹：${resolved}`)
  }
  return resolved
}

/**
 * 把草稿的源码放到指定工作目录。
 *
 * 三种情况（其余一律拒绝，理由见文件头）：
 * - 目标为空目录 → 把草稿现有文件**搬过去**；
 * - 目标里已有一份**同 id** 的草稿 → 直接接管那份（适合「我已经有个插件目录，交给工坊管」）；
 * - 草稿本身还没有文件（刚建）→ 直接记住这块目录，等写文件时自然落在那里。
 */
export function attachWorkingDir(id: string, dir: string): WorkingDirResult {
  const target = assertUsableDir(dir)
  const current = draftDir(id)
  const currentIsCustom = draftRootOf(id) !== null
  if (path.resolve(current) === target && currentIsCustom) {
    return { id, dir: target, moved: false, adopted: false }
  }

  const targetId = manifestIdOf(target)
  if (targetId && targetId !== id) {
    throw new Error(
      `目标目录里已经有一个插件草稿 '${targetId}'（plugin.json 的 id 是它）：一个目录只能放一个草稿`
    )
  }
  const targetHasDraft = targetId === id
  if (!targetHasDraft && !isEmptyDir(target)) {
    throw new Error(
      `目标目录不是空的（${fs.readdirSync(target).slice(0, 3).join('、')}…）：` +
        `请选择空文件夹，或已经放着同一个插件草稿的目录`
    )
  }

  const hadFiles = fs.existsSync(current) && listDraftFiles(id).length > 0
  let moved = false
  let previousDir: string | undefined
  if (targetHasDraft) {
    // 接管：目标里那份就是源码真源。原处若是工坊的默认目录，整份搬走（避免两份源码打架）
    if (hadFiles && !currentIsCustom) {
      fs.rmSync(current, { recursive: true, force: true })
    } else if (hadFiles) {
      previousDir = current
    }
  } else if (hadFiles) {
    moveDraftFiles(current, target)
    moved = true
  }

  setDraftRoot(id, target)
  // workshop.json 跟着源码走，所以换目录后要把它写进新家
  const meta = readDraftMeta(id)
  if (meta) writeDraftMeta({ ...meta, updatedAt: Date.now() })
  return { id, dir: target, moved, adopted: targetHasDraft, previousDir }
}

/** 把源码搬回工坊的默认目录（用户不想再用自定义目录时） */
export function detachWorkingDir(id: string): WorkingDirResult {
  const current = draftDir(id)
  if (draftRootOf(id) === null) {
    return { id, dir: current, moved: false, adopted: false }
  }
  const target = path.join(draftsRoot(), id)
  const hasFiles = fs.existsSync(current) && listDraftFiles(id).length > 0
  if (hasFiles) {
    moveDraftFiles(current, target)
  }
  setDraftRoot(id, null)
  const meta = readDraftMeta(id)
  if (meta) writeDraftMeta({ ...meta, updatedAt: Date.now() })
  return { id, dir: target, moved: hasFiles, adopted: false, previousDir: current }
}
