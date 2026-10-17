import * as fs from 'fs'
import * as path from 'path'
import type { WorkshopCssMode, WorkshopDraftMeta, WorkshopTemplate } from '../../shared/workshop'
import {
  assertDraftId,
  backupsRoot,
  draftDir,
  draftExists,
  ensureDir,
  requirePluginsRoot,
  writeJson
} from './paths'
import { TEMPLATE_INFOS, renderTemplate } from './templates'
import { listDraftFiles, readDraftMeta } from './store'

/**
 * 从模板生成草稿（工坊的入口动作）。
 *
 * 设计取舍：
 * - **默认拒绝覆盖**已存在的草稿：助手在同一个话题里连续调用 create 是很常见的行为，
 *   静默清空它刚写完的代码是最糟的失败模式；要重来必须显式 `overwrite: true`；
 * - **覆盖前先整份备份**：草稿目录是用户自己的源码（能进 git、能用编辑器打开），
 *   直接 `rm -rf` 可能删掉他还没提交的工作。旧目录先拷到
 *   `<userData>/plugin-workshop/backups/<id>-<时间戳>/`（只留最近 3 份），再重建；
 * - **写入是原子的**：先写同盘 staging 目录，成功后再 rename 到位。中途失败
 *   （磁盘满 / 写权限 / 文件被占用）不会留下「半个草稿」——旧目录也原样恢复；
 * - `WORKSHOP.md` 里的宿主模块白名单来自**运行期注入**（`hostMainKeys` / `hostUiKeys`），
 *   因此永远不会写出一份过期的清单（宿主加了新桥键，下一次生成的草稿就能用到）；
 * - 生成完立刻返回文件清单，助手可以据此决定「先读哪个文件再改」。
 */

export interface CreateDraftOptions {
  id: string
  title?: string
  template?: WorkshopTemplate
  description?: string
  css?: WorkshopCssMode
  overwrite?: boolean
  /** 宿主主进程可用的 `@host/main/**` 键 */
  hostMainKeys?: string[]
  /** 宿主渲染层可用的 `@host/renderer/**`、`@host/vendor/**` 键 */
  hostUiKeys?: string[]
}

export interface CreateDraftResult {
  meta: WorkshopDraftMeta
  /** 生成的文件相对路径（已排序） */
  files: string[]
  /** 被覆盖的旧草稿是否存在 */
  overwritten: boolean
  /** 覆盖时旧草稿的备份目录（没有覆盖则为 undefined） */
  backupDir?: string
  dir: string
}

/** 模板是否合法（非法时给出可用取值，避免模型瞎猜）；缺省 = `full`（全部内容） */
export function normalizeTemplate(value: unknown): WorkshopTemplate {
  const known = TEMPLATE_INFOS.map((t) => t.template)
  if (typeof value !== 'string' || value === '') return 'full'
  if (!known.includes(value as WorkshopTemplate)) {
    throw new Error(`模板 '${value}' 不存在：可用 ${known.join(' / ')}`)
  }
  return value as WorkshopTemplate
}

/** 备份目录名里的时间戳（UTC、可排序、不含 Windows 非法字符；加随机后缀防同一毫秒撞名） */
function backupStamp(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  return `${iso}-${Math.random().toString(36).slice(2, 6)}`
}

/** 只保留该插件最近 `keep` 份备份（旧的整份删掉，避免备份目录无限增长） */
function pruneBackups(id: string, keep = 3): void {
  const root = backupsRoot()
  let entries: string[] = []
  try {
    entries = fs.readdirSync(root)
  } catch {
    return
  }
  const mine = entries.filter((name) => name.startsWith(`${id}-`)).sort().reverse()
  for (const name of mine.slice(keep)) {
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
    } catch {
      // 删不掉就留着：备份多点不是问题
    }
  }
}

export function createDraft(opts: CreateDraftOptions): CreateDraftResult {
  const id = assertDraftId(opts.id)
  const template = normalizeTemplate(opts.template)
  const overwritten = draftExists(id)
  if (overwritten && !opts.overwrite) {
    throw new Error(
      `草稿 '${id}' 已存在（要继续改它请用 read/write 动作；确实要按模板重来请传 overwrite=true）`
    )
  }

  // 源码落在用户配置的插件存放路径下（未配置时 draftDir 会抛可读错误，界面据此引导去配置）
  const dir = draftDir(id)
  const root = requirePluginsRoot()
  ensureDir(root)

  const title = typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim() : id
  const files = renderTemplate(template, {
    id,
    title,
    description: typeof opts.description === 'string' ? opts.description.trim() : '',
    hostMainKeys: opts.hostMainKeys ?? [],
    hostUiKeys: opts.hostUiKeys ?? []
  })

  const now = Date.now()
  const meta: WorkshopDraftMeta = {
    id,
    title,
    template,
    description: typeof opts.description === 'string' ? opts.description.trim() : undefined,
    css: opts.css === 'file' || opts.css === 'off' ? opts.css : 'auto',
    createdAt: readDraftMeta(id)?.createdAt ?? now,
    updatedAt: now
  }

  // ① 覆盖前备份：整份拷到工坊自己的 backups/ 下（不动用户目录里的其它文件）
  //
  // 判据用「目录是否存在」而不是 draftExists：一个只有 README、没有 plugin.json 的
  // 残留目录同样不能被 rename 覆盖掉（Windows 上 rename 到已存在的目录会失败）。
  const existingDir = fs.existsSync(dir)
  let backupDir: string | undefined
  if (existingDir) {
    backupDir = path.join(backupsRoot(), `${id}-${backupStamp()}`)
    ensureDir(backupsRoot())
    fs.cpSync(dir, backupDir, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
    pruneBackups(id)
  }

  // ② 先写 staging，再 rename 到位：中途失败不会留下半个草稿
  const staging = path.join(root, `.${id}.staging-${process.pid}-${now}`)
  try {
    fs.mkdirSync(staging, { recursive: true })
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(staging, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content, 'utf-8')
    }
    writeJson(path.join(staging, 'workshop.json'), meta)
    fs.renameSync(staging, dir)
  } catch (err) {
    try {
      fs.rmSync(staging, { recursive: true, force: true })
    } catch {
      // 忽略：staging 本身是个不会被列举的临时目录（id 不合法 → draftExists 为 false）
    }
    // 覆盖失败就把备份放回去，用户至少回到操作前
    if (existingDir && backupDir && !fs.existsSync(dir)) {
      try {
        fs.renameSync(backupDir, dir)
      } catch {
        // 恢复失败：错误信息里带上备份路径，用户仍可手工找回
        throw new Error(
          `重建草稿 '${id}' 失败，且旧目录恢复到原位也失败；` +
            `旧源码在备份目录里：${backupDir}。原始错误：${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    throw err
  }

  return {
    meta,
    files: listDraftFiles(id).map((f) => f.path),
    overwritten,
    backupDir,
    dir
  }
}
