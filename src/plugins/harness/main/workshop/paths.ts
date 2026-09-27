import * as fs from 'fs'
import * as path from 'path'

/**
 * 工坊的目录约定与**路径安全**（唯一真源）。
 *
 * ```
 * <userData>/plugin-workshop/
 *   drafts/<id>/        草稿源码（助手唯一编辑面）
 *   dist/<id>/          构建产物（= 可安装插件包，与插件仓库 dist/<id> 同构）
 *   reports/<id>.json   最近一次验收报告（面板与工具都读它）
 *   exports/<id>-<v>.zip 导出的可分发压缩包
 * ```
 *
 * 三条不变量：
 * 1. **草稿 id 就是插件 id**：目录名 = `plugin.json.id` = 安装后的 `userData/plugins/<id>`，
 *    三者一致才能让「卸载/升级/重装」这套既有语义原样成立（scanner 要求目录名与 id 相同）；
 * 2. **所有对外来的路径都要过 `normalizeDraftRel`**：工具的 `path` 参数来自模型，
 *    `../` 逃逸必须在这里被挡住（不是靠调用方自觉）；
 * 3. **根目录可配**（`configureWorkshopRoot`）：服务本身不 import electron，
 *    离线工装因此能用临时目录跑完整的「生成 → 构建 → 验收 → 发布」链路。
 */

/** 工坊根（未配置时为空字符串 = 工坊不可用，见 `isWorkshopReady`） */
let root = ''

/**
 * 配置工坊根目录（主进程在插件 install 的 effect 里用 `app.getPath('userData')` 注入；
 * 离线工装注入临时目录）。传空字符串 = 关闭工坊（工具/通道会给出可读错误而不是崩）。
 */
export function configureWorkshopRoot(dir: string | null | undefined): void {
  root = typeof dir === 'string' ? dir : ''
}

/** 工坊是否已接线（未接线时所有动作都返回可读错误） */
export function isWorkshopReady(): boolean {
  return root !== ''
}

/** 工坊根（未接线时抛错——调用方应先问 `isWorkshopReady()`） */
export function workshopRoot(): string {
  if (!root) throw new Error('插件工坊尚未接线（未注入工坊根目录）')
  return root
}

export function draftsRoot(): string {
  return path.join(workshopRoot(), 'drafts')
}

export function distRoot(): string {
  return path.join(workshopRoot(), 'dist')
}

export function reportsRoot(): string {
  return path.join(workshopRoot(), 'reports')
}

export function exportsRoot(): string {
  return path.join(workshopRoot(), 'exports')
}

export function draftDir(id: string): string {
  return path.join(draftsRoot(), assertDraftId(id))
}

export function distDir(id: string): string {
  return path.join(distRoot(), assertDraftId(id))
}

export function reportPath(id: string): string {
  return path.join(reportsRoot(), `${assertDraftId(id)}.json`)
}

/**
 * 插件 id 规则（草稿目录名 = 插件 id）。
 *
 * 比 `isValidManifest` 的正则更严：**只允许小写 kebab**。理由是这个 id 同时是目录名、
 * IPC 命名空间（`plugin:<id>:*`）与 `plugin://<id>/…` 的地址段，大小写/点号混进来会让
 * 「同一个插件的两种写法」在卸载与路由上分裂。内置插件（notes / harness）本来就是这个形态。
 */
const DRAFT_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
/** 单段长度上限（目录名 + 命名空间都够用） */
const DRAFT_ID_MAX = 40

/**
 * 宿主保留 id：`plugin://host/…` 是渲染层宿主 UI 桥的地址（见 scanner.ts 的说明），
 * 目录叫 host 的插件永远取不到自己的文件——因此在**生成草稿**这一步就挡掉，
 * 而不是等安装后才表现为「界面白屏」。
 */
export const RESERVED_DRAFT_IDS: ReadonlySet<string> = new Set(['host'])

/** 校验草稿 id（不合法直接抛可读错误） */
export function assertDraftId(id: unknown): string {
  if (typeof id !== 'string' || id === '') {
    throw new Error('草稿 id 不能为空')
  }
  if (id.length > DRAFT_ID_MAX) {
    throw new Error(`草稿 id 太长（${id.length} > ${DRAFT_ID_MAX}）：${id}`)
  }
  if (!DRAFT_ID_RE.test(id)) {
    throw new Error(
      `草稿 id '${id}' 不合法：只允许小写字母、数字与中划线（如 'pomodoro-timer'），且以字母开头`
    )
  }
  if (RESERVED_DRAFT_IDS.has(id)) {
    throw new Error(`草稿 id '${id}' 是宿主保留 id，请换一个名字`)
  }
  return id
}

/**
 * 归一化草稿内的相对路径。
 *
 * 挡住三类：绝对路径（`C:\…` / `/etc/…`）、上层逃逸（`..`）、空路径。
 * 反斜杠统一成 `/`，因为模型经常按 Windows 习惯写 `renderer\plugin.tsx`。
 */
export function normalizeDraftRel(rel: unknown): string {
  if (typeof rel !== 'string' || rel.trim() === '') {
    throw new Error('文件路径不能为空')
  }
  const unified = rel.replace(/\\/g, '/').trim()
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) {
    throw new Error(`文件路径必须是草稿内的相对路径，不能是绝对路径：${rel}`)
  }
  const segments = unified.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.length === 0) throw new Error(`文件路径不合法：${rel}`)
  for (const segment of segments) {
    if (segment === '..') {
      throw new Error(`文件路径不允许越出草稿目录：${rel}`)
    }
    if (segment.includes('\0')) throw new Error('文件路径含有非法字符')
  }
  return segments.join('/')
}

/** 把草稿内相对路径解析成绝对路径（越界/非法立即抛错） */
export function resolveInDraft(id: string, rel: unknown): string {
  return path.join(draftDir(id), normalizeDraftRel(rel))
}

/** 把任意相对路径解析到某个根之下（导出/报告等同款保护） */
export function resolveUnder(base: string, rel: unknown): string {
  const target = path.resolve(base, normalizeDraftRel(rel))
  const normalizedBase = path.resolve(base)
  if (target !== normalizedBase && !target.startsWith(normalizedBase + path.sep)) {
    throw new Error(`路径越界：${rel}`)
  }
  return target
}

/** 确保目录存在并返回它 */
export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 读 JSON（不存在/解析失败返回 null，调用方决定要不要报错） */
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
  } catch {
    return null
  }
}

/** 写 JSON（自动建父目录，末尾换行——与仓库里其它产物文件一致） */
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf-8')
}

/** 草稿是否已存在（有 workshop.json 或 plugin.json 即算存在） */
export function draftExists(id: string): boolean {
  try {
    const dir = draftDir(id)
    return (
      fs.existsSync(path.join(dir, 'workshop.json')) || fs.existsSync(path.join(dir, 'plugin.json'))
    )
  } catch {
    return false
  }
}
