/**
 * 插件工坊的跨进程契约（主进程服务 / AI 工具 / 设置页三处共用）。
 *
 * 为什么单独一份：工坊的三条消费路径（IPC → 设置页、工具 → 模型、服务 → 构建/验收）
 * 必须对「草稿长什么样、一次验收由什么构成」有同一个答案。这里**不得** import
 * react / electron / node（与 shared/types.ts 同规矩），三端构建都要能直接打包。
 *
 * 术语：
 * - **草稿（draft）**：`<userData>/plugin-workshop/drafts/<id>/` 下的插件源码目录，
 *   助手用 `plugin_draft` 工具读写它，用户不直接编辑；
 * - **产物（package）**：构建出来的可安装插件包 `.../dist/<id>/{plugin.json,main.cjs,
 *   renderer.mjs,chunk-*.mjs,plugin.css}`，与插件仓库里的 `dist/<id>` 完全同构；
 * - **验收（verify）**：对产物跑一遍自动化测试电池，产出 `WorkshopReport`。
 */

/** 草稿模板：决定 `plugin_draft create` 生成哪一套骨架 */
export type WorkshopTemplate = 'page' | 'tool' | 'panel' | 'minimal'

/**
 * 插件自带样式表的来源。
 *
 * - `auto`：构建期用 Tailwind（theme + utilities，**不含 preflight**）扫草稿源码生成
 *   —— 这正是 `plugin.css` 约定的手工做法（见 src/plugins/PACKAGING.md），工坊把它自动化；
 * - `file`：草稿里手写的 `plugin.css` 原样进包（写纯 CSS 时用）；
 * - `off`：不带样式表（全部用内联 style / antd 组件）。
 *
 * 无论哪种模式，产物里若用了类名却没有对应规则，验收都会点名——这是「外部插件界面变形」
 * 那个事故的回归闸门。
 */
export type WorkshopCssMode = 'auto' | 'file' | 'off'

/** 单项检查的结论 */
export type WorkshopCheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

/** 验收电池里的一条检查（面板逐条展示，模型据此决定下一步改什么） */
export interface WorkshopCheck {
  /** 稳定 id（跨版本可比对，例：`pkg.manifest`、`main.smoke`） */
  id: string
  /** 一句话标题（面板显示） */
  title: string
  status: WorkshopCheckStatus
  /** 结论细节（通过也要有信息量：通道数、体积、覆盖了多少类名） */
  detail?: string
  /** 失败/警告时给模型的可执行下一步 */
  hint?: string
  /** true = 插件不可用（致命失败）；false/缺省 = 建议 */
  fatal?: boolean
  durationMs?: number
}

/** 构建结果（产物清单 + 诊断） */
export interface WorkshopBuildInfo {
  ok: boolean
  /** 产物目录（dist/<id>），失败时为 undefined */
  outDir?: string
  at?: number
  durationMs: number
  files: { path: string; size: number }[]
  /** 致命错误（构不成包） */
  errors: string[]
  /** 非致命警告（包能用，但有问题） */
  warnings: string[]
  /** 样式表产出情况 */
  css?: {
    mode: WorkshopCssMode
    bytes: number
    /** 从产物里扫出的候选类名数 */
    candidates: number
    /** 生成的 CSS 里没有规则的类名（前若干条） */
    missing: string[]
  }
}

/** 主进程冒烟结果（用真实 install(ctx) 契约驱动产物里的 main.cjs） */
export interface WorkshopMainSmoke {
  /** 注册的 IPC 通道 */
  channels: string[]
  /** 声明的事件通道（只有发送方） */
  events: string[]
  /** 贡献点（key → 条目标签） */
  contributions: { key: string; labels: string[] }[]
  /** `ctx.effect` 登记的可逆效果数 */
  effects: number
  /** 草稿自带冒烟用例（workshop.smoke.mjs）的执行结果 */
  cases: { name: string; ok: boolean; detail?: string; durationMs?: number }[]
  /** 装载耗时 */
  durationMs: number
}

/** 渲染层实时探针结果（真宿主环境里 import + install 一遍插件的渲染模块） */
export interface WorkshopRendererProbe {
  status: 'pass' | 'fail' | 'skip'
  detail?: string
  /** 探针里记录到的注册项（`route:/demo`、`menu:demo`、`i18n`…） */
  registrations?: string[]
  durationMs?: number
}

/** 一次验收的完整报告 */
export interface WorkshopReport {
  id: string
  /** 被验收的那份清单版本（面板显示「哪个版本验收通过」） */
  version?: string
  at: number
  durationMs: number
  /** 全部致命检查通过 = true */
  ok: boolean
  checks: WorkshopCheck[]
  build: WorkshopBuildInfo
  main?: WorkshopMainSmoke
  renderer?: WorkshopRendererProbe
}

/** 草稿目录里的一个文件 */
export interface WorkshopDraftFile {
  /** 相对草稿根的 posix 路径 */
  path: string
  size: number
  mtime: number
}

/** 草稿元数据（`drafts/<id>/workshop.json`，由工坊维护，助手不手改） */
export interface WorkshopDraftMeta {
  id: string
  title: string
  template: WorkshopTemplate
  description?: string
  css: WorkshopCssMode
  createdAt: number
  updatedAt: number
  /** 最近一次构建时间（构建成功后写入） */
  builtAt?: number
}

/** 草稿列表项（设置页列表 + 工具 list 动作共用） */
export interface WorkshopDraftSummary {
  id: string
  title: string
  template: WorkshopTemplate
  version: string
  description?: string
  createdAt: number
  updatedAt: number
  fileCount: number
  /** 产物是否存在（dist/<id>/plugin.json） */
  built: boolean
  builtAt?: number
  /** 是否已装进 userData/plugins/<id> */
  installed: boolean
  enabled: boolean
  /** 最近一次验收的摘要（没有则不出现） */
  lastReport?: { at: number; ok: boolean; failed: number; total: number }
  /** 产物与应用包/已装副本是否同构（打不出来时 undefined） */
  distBytes?: number
}

/** 草稿详情（设置页抽屉用：列表项 + 文件清单 + 清单原文） */
export interface WorkshopDraftDetail extends WorkshopDraftSummary {
  files: WorkshopDraftFile[]
  /** plugin.json 解析结果（非法时为 null，错误在 lint 检查里） */
  manifest: Record<string, unknown> | null
  /** 草稿根绝对路径（面板给「打开目录」用） */
  dir: string
  css: WorkshopCssMode
}

/** 工坊动作的统一返回（失败不抛错，面板据此提示） */
export interface WorkshopActionResult<T = unknown> {
  ok: boolean
  error?: string
  data?: T
}

/** 安装（发布）结果 */
export interface WorkshopPublishResult {
  id: string
  version: string
  /** true = 覆盖了同 id 的既有安装 */
  upgraded: boolean
  /** 落地目录（userData/plugins/<id>） */
  dest: string
  files: number
  enabled: boolean
  /** 若产物比草稿源码旧，这里如实报出（面板可以提示「重新构建」） */
  staleBuild?: boolean
  /**
   * 安装后立刻做的渲染层复验结果（只有真的跑到了才有：装了但渲染层炸 → 已自动回滚，
   * 此时不会返回结果而是抛错）。
   */
  rendererProbe?: WorkshopRendererProbe
}
