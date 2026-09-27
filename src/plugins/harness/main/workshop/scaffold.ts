import * as fs from 'fs'
import * as path from 'path'
import type { WorkshopCssMode, WorkshopDraftMeta, WorkshopTemplate } from '../../shared/workshop'
import { assertDraftId, draftDir, draftExists, ensureDir } from './paths'
import { TEMPLATE_INFOS, renderTemplate } from './templates'
import { listDraftFiles, readDraftMeta, writeDraftMeta } from './store'

/**
 * 从模板生成草稿（工坊的入口动作）。
 *
 * 设计取舍：
 * - **默认拒绝覆盖**已存在的草稿：助手在同一个话题里连续调用 create 是很常见的行为，
 *   静默清空它刚写完的代码是最糟的失败模式；要重来必须显式 `overwrite: true`；
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
  dir: string
}

/** 模板是否合法（非法时给出可用取值，避免模型瞎猜） */
export function normalizeTemplate(value: unknown): WorkshopTemplate {
  const known = TEMPLATE_INFOS.map((t) => t.template)
  if (typeof value !== 'string' || value === '') return 'page'
  if (!known.includes(value as WorkshopTemplate)) {
    throw new Error(`模板 '${value}' 不存在：可用 ${known.join(' / ')}`)
  }
  return value as WorkshopTemplate
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

  const dir = draftDir(id)
  if (overwritten) fs.rmSync(dir, { recursive: true, force: true })
  ensureDir(dir)

  const files = renderTemplate(template, {
    id,
    title: typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim() : id,
    description: typeof opts.description === 'string' ? opts.description.trim() : '',
    hostMainKeys: opts.hostMainKeys ?? [],
    hostUiKeys: opts.hostUiKeys ?? []
  })

  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf-8')
  }

  const now = Date.now()
  const meta: WorkshopDraftMeta = {
    id,
    title: typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim() : id,
    template,
    description: typeof opts.description === 'string' ? opts.description.trim() : undefined,
    css: opts.css === 'file' || opts.css === 'off' ? opts.css : 'auto',
    createdAt: readDraftMeta(id)?.createdAt ?? now,
    updatedAt: now
  }
  writeDraftMeta(meta)

  return { meta, files: listDraftFiles(id).map((f) => f.path), overwritten, dir }
}
