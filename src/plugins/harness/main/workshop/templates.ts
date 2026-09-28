import type { WorkshopTemplate } from '../../shared/workshop'

/**
 * 草稿模板：`plugin_draft create` 生成的骨架。
 *
 * 两条硬要求：
 * 1. **模板必须是能真的构建、装载、跑起来的插件**（离线工装 `test/verify-plugin-workshop.mjs`
 *    会逐个模板走完「构建 → 验收 → 发布」全链路，模板写错了工装就红）；
 * 2. **`WORKSHOP.md` 是给模型看的契约单**：宿主模块白名单、挂载点、通道命名、样式与冒烟用例
 *    的写法都在里面，助手照着它改代码。宿主模块白名单是**运行期注入**的（`hostMainKeys` /
 *    `hostUiKeys`），所以模板永远不会写出一份过期的白名单。
 *
 * 生成出来的代码一律用**裸说明符**引用宿主能力（`react` / `antd` / `@host/main/...`）：
 * 打包时主进程侧被改写成 `__RB_HOST_RESOLVE__`，渲染层侧原样留在产物里由宿主 loader
 * 在装载时改写成 `plugin://host/ui.js` 桥——这保证插件永远用宿主那一份 React / i18n。
 */

/** 模板变量（scaffold 收集后传给模板） */
export interface TemplateVars {
  id: string
  title: string
  description: string
  /** 宿主主进程可用的 `@host/main/**` 键（运行期从宿主运行时表读出） */
  hostMainKeys: string[]
  /** 宿主渲染层可用的 `@host/renderer/**`、`@host/vendor/**` 键 */
  hostUiKeys: string[]
}

export interface TemplateInfo {
  template: WorkshopTemplate
  label: string
  /** 一句话说明（`plugin_draft create` 的返回里回显给模型） */
  description: string
  /** 生成的入口形态（用于 WORKSHOP.md 的「这个模板注册了什么」段） */
  registers: string
}

export const TEMPLATE_INFOS: TemplateInfo[] = [
  {
    template: 'full',
    label: '完整骨架（默认）',
    description:
      '一份就含全部内容：侧栏页面 + 设置页 + 给助手贡献的 AI 工具 + 主进程通道与事件推送 + 卸载清数据',
    registers:
      'route / menu / settingsSection / i18n（渲染层）+ 6 个 IPC 通道 + 1 个事件通道 + 自己的表（ddl/schema/mapper）+ harness.tool 与 plugin.purge 贡献（主进程）'
  },
  {
    template: 'page',
    label: '只要独立页面',
    description: '侧栏菜单 + 路由页面 + 一对主进程 IPC 通道（把数据存到 userData 下的 JSON）',
    registers: 'route / menu / i18n（渲染层）+ 2 个 IPC 通道 + plugin.purge（主进程）'
  },
  {
    template: 'panel',
    label: '只要设置页',
    description: '设置 → 助手 分组下的一页（表单 / 开关 / 状态展示的落点）',
    registers: 'settingsSection / i18n（渲染层）+ 1 个 IPC 通道（主进程）'
  },
  {
    template: 'tool',
    label: '只要 AI 工具',
    description: '给 AI 助手贡献一个可在对话里调用的工具（harness.tool 贡献点）',
    registers: 'harness.tool 贡献（主进程）+ 设置页状态展示（渲染层）'
  },
  {
    template: 'minimal',
    label: '空骨架',
    description: '只满足插件契约的空骨架：一个空 install + 一个空挂载点示例',
    registers: 'appProvider（渲染层空 Provider）'
  }
]

/** 工具名只能用 [A-Za-z0-9_-]，草稿 id 里的中划线换成下划线 */
export function toolNameOf(id: string, suffix = 'echo'): string {
  return `${id.replace(/-/g, '_')}_${suffix}`
}

/** SQL 标识符里的安全形态（表名/索引名只能由字母数字下划线组成） */
function sqlNameOf(id: string): string {
  return id.replace(/[^A-Za-z0-9]+/g, '_')
}

/** 生成代码里的类型名前缀（personal-ledger → PersonalLedger） */
function pascalOf(id: string): string {
  return id
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')
}

/** JSON 里安全的字符串（模板变量由工具校验过，这里只是兜底） */
function jsonEscape(value: string): string {
  return JSON.stringify(value ?? '')
}

/** 生成 `plugin.json`（entry 由构建写入，这里不写） */
function manifestFile(vars: TemplateVars, extra: Record<string, unknown> = {}): string {
  const manifest: Record<string, unknown> = {
    id: vars.id,
    name: vars.title,
    version: '0.1.0',
    description: vars.description,
    builtin: false,
    ...extra
  }
  return JSON.stringify(manifest, null, 2) + '\n'
}

/** 渲染层入口的两套上下文类型（草稿里没有宿主的 d.ts，就地写一份最小契约） */
const RENDERER_CONTEXT_DTS = `/**
 * 宿主给插件渲染层的上下文（最小契约；完整说明见 WORKSHOP.md）。
 *
 * 草稿目录里没有宿主的类型声明，这份 interface 就是「能调什么」的本地真源：
 * 挂载点由 ctx.use(键) 取得，effect 登记的可逆效果会在插件停用时 LIFO 回滚。
 */
export interface PluginRenderContext {
  use(key: 'route'): {
    register(route: { path: string; skeleton?: string; load: () => Promise<unknown> }): void
  }
  use(key: 'menu'): {
    register(item: { key: string; labelKey: string; icon: unknown; order?: number }): void
  }
  use(key: 'settingsSection'): {
    register(section: {
      tabKey: string
      labelKey: string
      icon?: unknown
      group?: string
      order?: number
      Component: unknown
    }): void
  }
  use(key: 'appProvider'): { register(provider: { Provider: unknown; order?: number }): void }
  /**
   * 词条注册。第一个参数是 **i18next 命名空间**（宿主界面一律用 'translation'），
   * 第二个参数是「语言 → 词条树」；写成 addResources('zh-CN', …) 会把 'zh-CN' 当命名空间，
   * 菜单里就会显示原始键名（x.menu.title）——宿主 API 定义见
   * src/renderer/src/plugin-host/host.ts 的 addResources。
   */
  use(key: 'i18n'): {
    addResources(namespace: 'translation', resources: Record<string, Record<string, unknown>>): void
  }
  use(key: 'events'): {
    emit(name: string, data?: unknown): void
    on(name: string, handler: (data: unknown) => void): () => void
  }
  effect(register: () => void | (() => void)): void
}

/** 主进程通道的调用桥（preload 暴露的通用桥，通道名必须是 plugin:<id>:<name>） */
export const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  window.api.plugin.invoke(channel, ...args)
`

/** 主进程上下文的最小契约 */
const MAIN_CONTEXT_DTS = `/**
 * 宿主给插件主进程的上下文（最小契约；完整说明见 WORKSHOP.md）。
 */
export interface MainPluginContext {
  /** 插件 id（= 目录名 = plugin.json.id） */
  readonly id: string
  /** 通道命名空间：plugin:<namespace>:* 里的 namespace（= id 去掉开头的 plugin. 段） */
  readonly namespace: string
  /** 注册 IPC 处理器（通道必须以 plugin:<namespace>: 开头，否则装载期抛错） */
  registerIpc(handlers: Record<string, (...args: never[]) => unknown>): () => void
  /** 声明只有发送方的事件通道（主进程 → 渲染层推送；不声明则渲染层订阅不到） */
  registerEvent(...channels: string[]): void
  /** 注册可逆效果（定时器 / 监听器），插件停用时 LIFO 回滚 */
  effect(register: () => void | (() => void)): void
  /** 挂载多值贡献（例如给 AI 助手贡献工具：HARNESS_TOOL_CONTRIBUTION） */
  contribute<T>(key: string, value: T): void
}
`

/** 页面模板的渲染层页面组件 */
function pageComponent(vars: TemplateVars): string {
  const channelGet = `plugin:${vars.id}:state-get`
  const channelSet = `plugin:${vars.id}:state-set`
  return `import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Input, Space, Typography } from 'antd'
import { RiSaveLine, RiRefreshLine } from '@remixicon/react'
import { invoke } from './context'

/**
 * ${vars.title} 的页面。
 *
 * 数据来源是插件自己的主进程通道（${channelGet} / ${channelSet}）——
 * 页面永远不直接读磁盘，跨进程一律走 plugin:<id>:* 通道（契约见 WORKSHOP.md）。
 */
export default function Page(): React.JSX.Element {
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const state = (await invoke('${channelGet}')) as { value?: string } | null
      setValue(state?.value ?? '')
      setSaved(state?.value ?? '')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const state = (await invoke('${channelSet}', value)) as { value?: string }
      setSaved(state?.value ?? '')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full w-full overflow-auto p-6">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
        <Typography.Title level={4} style={{ margin: 0 }}>
          ${vars.title}
        </Typography.Title>
        <Card size="small">
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <Typography.Text type="secondary">
              {saved ? '已保存：' + saved : '还没有保存过内容'}
            </Typography.Text>
            <Input.TextArea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoSize={{ minRows: 4, maxRows: 12 }}
              placeholder="写点什么，保存后重启仍然在"
            />
            <Space>
              <Button type="primary" icon={<RiSaveLine size={16} />} loading={busy} onClick={save}>
                保存
              </Button>
              <Button icon={<RiRefreshLine size={16} />} onClick={() => void load()}>
                重新读取
              </Button>
            </Space>
          </Space>
        </Card>
      </div>
    </div>
  )
}
`
}

/** 页面模板的渲染层入口 */
function pagePlugin(vars: TemplateVars): string {
  const labelKey = `${vars.id}.menu.title`
  return `import { RiPuzzleLine } from '@remixicon/react'
import type { PluginRenderContext } from './context'
import Page from './Page'

/**
 * 渲染层入口：宿主装载本插件时调用 install(ctx)。
 *
 * 注册的都是**可逆装配**：插件停用时宿主会把这些注册项一并摘除
 * （菜单消失、路由卸载、词条移除），不需要自己写反注册。
 */
const plugin = {
  install(ctx: PluginRenderContext): void {
    ctx.use('route').register({
      path: '/${vars.id}',
      load: () => import('./Page')
    })
    ctx.use('menu').register({
      // 菜单键必须与路由路径一致：点击菜单是 navigate('/' + key)
      key: '${vars.id}',
      labelKey: '${labelKey}',
      icon: <RiPuzzleLine size={16} />,
      order: 60
    })
    ctx.use('i18n').addResources('translation', {
      'zh-CN': { '${vars.id}': { menu: { title: ${jsonEscape(vars.title)} } } },
      'en-US': { '${vars.id}': { menu: { title: ${jsonEscape(vars.title)} } } }
    })
  }
}

export default plugin
`
}

/** 页面模板的主进程入口（JSON 落盘 + purge 贡献） */
function pageMain(vars: TemplateVars): string {
  return `import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { PLUGIN_PURGE } from '@host/main/plugins/contributions'
import type { MainPluginContext } from './context'

/**
 * 主进程入口：install(ctx) 必须**可逆**——注册的东西都挂在 ctx 上，
 * 插件停用/卸载时由宿主一次性回滚（effect 是 LIFO）。
 *
 * 数据落在 userData/plugin-state/${vars.id}.json（不写工作区：那是用户的项目目录），
 * 并用 PLUGIN_PURGE 贡献声明「卸载时勾了删数据要清掉什么」——
 * 宿主的卸载确认框会把 label 原文显示给用户看。
 */
let stateFile = ''

function readState(): { value: string } {
  try {
    const raw = fs.readFileSync(stateFile, 'utf-8')
    const parsed = JSON.parse(raw) as { value?: unknown }
    return { value: typeof parsed.value === 'string' ? parsed.value : '' }
  } catch {
    return { value: '' }
  }
}

export function install(ctx: MainPluginContext): void {
  // effect：登记「怎么初始化」与「怎么撤销」。写文件要建目录，因此放在 effect 里。
  ctx.effect(() => {
    const dir = path.join(app.getPath('userData'), 'plugin-state')
    fs.mkdirSync(dir, { recursive: true })
    stateFile = path.join(dir, '${vars.id}.json')
    return () => {
      stateFile = ''
    }
  })

  ctx.registerIpc({
    'plugin:${vars.id}:state-get': () => {
      if (!stateFile) return { value: '' }
      return readState()
    },
    'plugin:${vars.id}:state-set': (value: unknown) => {
      const next = { value: typeof value === 'string' ? value : '' }
      if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(next), 'utf-8')
      return next
    }
  })

  // 卸载时「同时删除该插件的数据」被勾上才会跑到这里（插件当时仍是装载状态）
  ctx.contribute(PLUGIN_PURGE, {
    label: '保存的内容（plugin-state/${vars.id}.json）',
    run: () => {
      if (stateFile) fs.rmSync(stateFile, { force: true })
    }
  })
}
`
}

/** 设置页模板的渲染层设置页组件 */
function panelComponent(vars: TemplateVars): string {
  return `import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Switch, Typography } from 'antd'
import { invoke } from './context'

/**
 * ${vars.title} 的设置页。
 *
 * 页面结构用宿主提供的 SettingsUI（设置页样式随宿主走），
 * 数据同样只走本插件的主进程通道。
 */
interface PanelState {
  enabled: boolean
  note: string
}

export default function Settings(): React.JSX.Element {
  const [state, setState] = useState<PanelState>({ enabled: false, note: '' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const next = (await invoke('plugin:${vars.id}:settings-get')) as PanelState
    setState({ enabled: Boolean(next?.enabled), note: String(next?.note ?? '') })
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (patch: Partial<PanelState>): Promise<void> => {
    setBusy(true)
    try {
      const next = (await invoke('plugin:${vars.id}:settings-set', patch)) as PanelState
      setState({ enabled: Boolean(next?.enabled), note: String(next?.note ?? '') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        ${vars.title}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        这一页由插件自己注册（settingsSection 挂载点），停用插件后这一页随之消失。
      </Typography.Paragraph>
      <div className="flex max-w-[560px] flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <span>启用示例开关</span>
          <Switch checked={state.enabled} onChange={(v) => void save({ enabled: v })} size="small" />
        </div>
        <Input
          value={state.note}
          onChange={(e) => setState((prev) => ({ ...prev, note: e.target.value }))}
          placeholder="备注（保存后持久化）"
        />
        <Button type="primary" loading={busy} onClick={() => void save({ note: state.note })}>
          保存
        </Button>
      </div>
    </div>
  )
}
`
}

/** 设置页模板的渲染层入口 */
function panelPlugin(vars: TemplateVars): string {
  return `import { RiSettings4Line } from '@remixicon/react'
import type { PluginRenderContext } from './context'
import Settings from './Settings'

const plugin = {
  install(ctx: PluginRenderContext): void {
    ctx.use('settingsSection').register({
      tabKey: '${vars.id}',
      labelKey: '${vars.id}.settings.title',
      icon: <RiSettings4Line size={16} />,
      // group 决定它落在设置弹窗的哪个分组：general / assistant
      group: 'assistant',
      order: 90,
      Component: Settings
    })
    ctx.use('i18n').addResources('translation', {
      'zh-CN': { '${vars.id}': { settings: { title: ${jsonEscape(vars.title)} } } },
      'en-US': { '${vars.id}': { settings: { title: ${jsonEscape(vars.title)} } } }
    })
  }
}

export default plugin
`
}

/** 设置页模板的主进程入口 */
function panelMain(vars: TemplateVars): string {
  return `import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { PLUGIN_PURGE } from '@host/main/plugins/contributions'
import type { MainPluginContext } from './context'

/** 设置项落盘位置（userData 下，不污染用户的工作区） */
let settingsFile = ''
let cache: { enabled: boolean; note: string } = { enabled: false, note: '' }

export function install(ctx: MainPluginContext): void {
  ctx.effect(() => {
    const dir = path.join(app.getPath('userData'), 'plugin-state')
    fs.mkdirSync(dir, { recursive: true })
    settingsFile = path.join(dir, '${vars.id}.json')
    try {
      cache = { ...cache, ...(JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as object) }
    } catch {
      // 首次运行没有文件：用默认值
    }
    return () => {
      settingsFile = ''
    }
  })

  ctx.registerIpc({
    'plugin:${vars.id}:settings-get': () => ({ ...cache }),
    'plugin:${vars.id}:settings-set': (patch: Partial<{ enabled: boolean; note: string }>) => {
      cache = {
        enabled: typeof patch?.enabled === 'boolean' ? patch.enabled : cache.enabled,
        note: typeof patch?.note === 'string' ? patch.note : cache.note
      }
      if (settingsFile) fs.writeFileSync(settingsFile, JSON.stringify(cache), 'utf-8')
      return { ...cache }
    }
  })

  // 卸载时勾了「同时删除数据」才会跑到：清掉自己的设置文件
  ctx.contribute(PLUGIN_PURGE, {
    label: '本插件的设置（plugin-state/${vars.id}.json）',
    run: () => {
      if (settingsFile) fs.rmSync(settingsFile, { force: true })
    }
  })
}
`
}

/** AI 工具模板的主进程入口 */
function toolMain(vars: TemplateVars): string {
  const toolName = toolNameOf(vars.id)
  return `import { tool } from '@langchain/core/tools'
import * as z from 'zod/v4'
import { HARNESS_TOOL_CONTRIBUTION } from '@host/main/plugins/tool-contract'
import type { MainPluginContext } from './context'

/**
 * 给 AI 助手贡献一个工具（harness.tool 贡献点）。
 *
 * 要点：
 * - 贡献随插件停用一并摘除：助手**下一轮**组装工具集时就看不到它了；
 * - 用户还要在 设置 → 智能体 → 工具 里勾选本工具才会真正挂给模型；
 * - build() 是延迟调用的（插件没装载就不会被调到），可以放心读插件自己的数据。
 */
export function install(ctx: MainPluginContext): void {
  ctx.contribute(HARNESS_TOOL_CONTRIBUTION, {
    name: '${toolName}',
    info: {
      name: '${toolName}',
      label: ${jsonEscape(vars.title)},
      description: ${jsonEscape(vars.description)},
      icon: 'RiToolsLine',
      color: '#8b5cf6'
    },
    build: () =>
      tool(
        async (input: { text: string; upper?: boolean }) => {
          const text = String(input?.text ?? '')
          const out = input?.upper ? text.toUpperCase() : text
          return ${jsonEscape(vars.title)} + ' → ' + out
        },
        {
          name: '${toolName}',
          description: ${jsonEscape(vars.description)},
          schema: z.object({
            text: z.string().describe('要处理的文本'),
            upper: z.boolean().optional().describe('是否转成大写')
          })
        }
      )
  })
}
`
}

/** AI 工具模板的渲染层（设置页里展示工具状态） */
function toolPlugin(vars: TemplateVars): string {
  const toolName = toolNameOf(vars.id)
  return `import { RiToolsLine } from '@remixicon/react'
import type { PluginRenderContext } from './context'

/**
 * 工具型插件同样需要渲染层入口（插件包契约要求 renderer.mjs 存在）。
 * 这里只注册一页设置说明，告诉用户工具在哪里启用。
 */
function ToolSettings(): React.JSX.Element {
  return (
    <div className="flex max-w-[560px] flex-col gap-2">
      <div className="text-[13px] font-medium">${vars.title}</div>
      <div className="text-[12px] opacity-70">
        本插件给助手贡献了工具 <code>${toolName}</code>：在「设置 → 智能体 → 工具」里勾选后，
        助手的下一轮对话就能调用它。停用本插件时该工具会立即从可用清单里消失。
      </div>
    </div>
  )
}

const plugin = {
  install(ctx: PluginRenderContext): void {
    ctx.use('settingsSection').register({
      tabKey: '${vars.id}',
      labelKey: '${vars.id}.settings.title',
      icon: <RiToolsLine size={16} />,
      group: 'assistant',
      order: 95,
      Component: ToolSettings
    })
    ctx.use('i18n').addResources('translation', {
      'zh-CN': { '${vars.id}': { settings: { title: ${jsonEscape(vars.title)} } } },
      'en-US': { '${vars.id}': { settings: { title: ${jsonEscape(vars.title)} } } }
    })
  }
}

export default plugin
`
}

/** 最小骨架的渲染层入口（模板变量只用于文件头，正文与 id 无关） */
function minimalPlugin(): string {
  return `import type { PluginRenderContext } from './context'

/**
 * 最小骨架：宿主装载时 install(ctx) 被调用，停用时全部注册项回滚。
 *
 * 想加界面就在下面挂挂载点（route / menu / settingsSection / appProvider），
 * 完整清单见 WORKSHOP.md。
 */
const plugin = {
  install(ctx: PluginRenderContext): void {
    // 示例：一个不做任何渲染的全局 Provider（不需要界面、只想常驻后台逻辑时用）
    ctx.use('appProvider').register({
      order: 90,
      Provider: ({ children }: { children?: unknown }) => children
    })
  }
}

export default plugin
`
}

/** 最小骨架/工具模板共用的主进程入口 */
function noopMain(): string {
  return `import type { MainPluginContext } from './context'

/**
 * 本插件当前不需要主进程能力。
 *
 * 保留这个入口的原因是插件包契约要求 main.cjs 存在（缺入口的包装不上），
 * 需要通道/后台逻辑时在这里 ctx.registerIpc / ctx.effect 即可。
 */
export function install(ctx: MainPluginContext): void {
  void ctx
}
`
}

// ============================================================================
// full：一份就含全部内容（默认模板，2026-09-27 用户要求「默认是全部内容都要」）
// ============================================================================
//
// 布局与**真实插件仓库**（ryten-plugins 的 music-player / task-planner）对齐——
// 用户 2026-09-28 拿生成的草稿和那边比，指出「缺失了好多内容」。对齐后每个文件都有明确职责：
//
//   plugin.json            清单（宿主据此装载；entry 由构建写入）
//   WORKSHOP.md            给助手的契约单（宿主模块白名单 + 各种写法）
//   shared/types.ts        跨进程 DTO（主进程与渲染层共用一份形状）
//   main/index.ts          入口：装配（建表 side-effect / 通道 / 事件 / 工具 / 清数据）
//   main/ipc.ts            通道实现 + 设置落盘 + 变更推送
//   main/tools.ts          给助手贡献的 AI 工具（读的是本插件自己的 mapper）
//   main/tool-texts.ts     工具返回文案（中文 / 英文，跟随界面语言）
//   main/purge.ts          卸载清数据（删自己的表行 + 应用托管的数据）
//   main/db/ddl.ts         本插件自带建表（幂等）+ schemaReady 承诺
//   main/db/schema.ts      drizzle 表定义（查询用）
//   main/db/mapper.ts      数据访问（统一走宿主 withOrm）
//   locales/*              词条（zh-CN / en-US，装停随插件走）
//   renderer/plugin.tsx    渲染层装配（路由 / 侧栏菜单 / 设置页 / 词条）
//   renderer/api.ts        通道的薄封装（组件不直接写通道名）
//   renderer/Page.tsx      页面
//   renderer/Settings.tsx  设置页
//   renderer/components/ItemForm.tsx  表单弹窗（组件拆分的落点）
//   workshop.smoke.mjs     冒烟用例（验收电池会真的调用这些通道）

/** 跨进程 DTO：不 import drizzle / electron，两端都能直接打包 */
function fullSharedTypes(vars: TemplateVars): string {
  const P = pascalOf(vars.id)
  return `/**
 * ${vars.title} 的跨进程契约（主进程 mapper 与渲染层组件共用）。
 *
 * 规矩：**不 import drizzle / electron / node**——渲染层也要 import 它，
 * 带上任何一端的东西都会把那一端打进另一端的产物。
 */

/** 一条记录（表 ${sqlNameOf(vars.id)}_items 的一行） */
export interface ${P}Item {
  id: number
  title: string
  note: string
  done: boolean
  createdAt: string | null
  updatedAt: string | null
}

/** 新建/修改的入参（id 与时间戳由数据库管） */
export interface ${P}ItemInput {
  title: string
  note?: string
}

/** 设置页里的开关（与应用数据分开存：它是配置，不是记录） */
export interface ${P}Settings {
  enabled: boolean
  note: string
}

/** 页面一次拉全的量（记录 + 设置） */
export interface ${P}State {
  items: ${P}Item[]
  settings: ${P}Settings
}
`
}

/** drizzle 表定义（查询用；建表语句在 ./ddl.ts） */
function fullDbSchema(vars: TemplateVars): string {
  const P = pascalOf(vars.id)
  const sql = sqlNameOf(vars.id)
  return `import { boolean, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * ${vars.title} 的表。
 *
 * - 表名必须带**本插件的前缀**（\`${sql}_\`）：一个库里装着所有插件的表，撞名就是事故；
 * - 列名 snake_case（与宿主同规矩）；行类型的单一真源就是这里（\`$inferSelect\`）；
 * - 建表语句在 \`./ddl.ts\`（独立插件的 DDL 归插件自己，宿主不认识这张表）。
 */
export const ${sql}_items = pgTable('${sql}_items', {
  id: serial().primaryKey().notNull(),
  title: text().notNull(),
  note: text(),
  done: boolean().default(false),
  created_at: timestamp({ mode: 'string' }).defaultNow(),
  updated_at: timestamp({ mode: 'string' }).defaultNow()
})

/** 一行（mapper 内部用；跨进程一律转成 shared/types.ts 的 DTO） */
export type ${P}ItemRow = typeof ${sql}_items.$inferSelect
`
}

/** 自带建表（幂等）+ schemaReady 承诺 */
function fullDbDdl(vars: TemplateVars): string {
  const sql = sqlNameOf(vars.id)
  return `import { sql } from 'drizzle-orm'
import logger from 'electron-log'
import { withOrm } from '@host/main/database/orm'

/**
 * ${vars.title} **自带建表**（独立插件的 DDL 归插件自己）。
 *
 * 三条约束：
 * - **幂等**：一律 \`IF NOT EXISTS\`，插件每次装载都会跑一遍；
 * - **只动自己的表**：表名带插件前缀，绝不碰别的插件或宿主的表；
 * - **装载期就可以调用**：插件主模块是在**数据库初始化之前**被宿主装载的
 *   （\`initPluginHost()\` 早于 \`createLoadingWindow()\`），所以这里不能在装载期假设库已就绪。
 *   宿主的 \`withOrm\` 会等库就绪（宿主侧 \`database/instance.ts\` 的保证），因此下面这个
 *   立即执行的承诺是安全的——但**别在装载期同步等它**，也不要「先读库再导出同步状态」。
 */
const DDL: string[] = [
  \`CREATE TABLE IF NOT EXISTS ${sql}_items (
     id         SERIAL PRIMARY KEY,
     title      TEXT NOT NULL,
     note       TEXT,
     done       BOOLEAN DEFAULT FALSE,
     created_at TIMESTAMP DEFAULT NOW(),
     updated_at TIMESTAMP DEFAULT NOW()
   )\`,
  \`CREATE INDEX IF NOT EXISTS idx_${sql}_items_created ON ${sql}_items(created_at DESC)\`
]

/** 建表承诺：mapper / purge 都先 await 它，保证不会有访问跑到建表之前 */
export const schemaReady: Promise<void> = (async () => {
  await withOrm('${vars.id}.ensureSchema', async (db) => {
    for (const statement of DDL) await db.execute(sql.raw(statement))
  })
  logger.info('[${vars.id}] 表结构已就绪（${sql}_items）')
})().catch((err) => {
  logger.error('[${vars.id}] 建表失败，插件将无法读写数据:', err)
  throw err
})
`
}

/** 数据访问（统一走宿主的 withOrm，行 → DTO 只在这里转换） */
function fullDbMapper(vars: TemplateVars): string {
  const P = pascalOf(vars.id)
  const sql = sqlNameOf(vars.id)
  return `import { desc, eq } from 'drizzle-orm'
import { withOrm } from '@host/main/database/orm'
import type { ${P}Item, ${P}ItemInput } from '../../shared/types'
import { schemaReady } from './ddl'
import { ${sql}_items, type ${P}ItemRow } from './schema'

/**
 * ${vars.title} 的数据访问层。
 *
 * 规矩（与宿主 mapper 一致）：
 * - **每个函数先 \`await schemaReady\`**：插件装载即建表，但不保证建表先于第一次查询；
 * - 一律走 \`withOrm\`：拿到 drizzle 实例、异常统一记日志；
 * - 行类型只在插件内部流转，出这一层就转成 \`shared/types.ts\` 的 DTO（渲染层不认识 drizzle）。
 */
function toDto(row: ${P}ItemRow): ${P}Item {
  return {
    id: row.id,
    title: row.title,
    note: row.note ?? '',
    done: row.done ?? false,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null
  }
}

/** 全部记录（新的在前） */
export async function listItems(): Promise<${P}Item[]> {
  await schemaReady
  const rows = await withOrm('${vars.id}.listItems', async (db) =>
    db.select().from(${sql}_items).orderBy(desc(${sql}_items.created_at), desc(${sql}_items.id))
  )
  return rows.map(toDto)
}

/** 新建一条 */
export async function createItem(input: ${P}ItemInput): Promise<${P}Item> {
  await schemaReady
  const title = String(input?.title ?? '').trim()
  if (!title) throw new Error('标题不能为空')
  const rows = await withOrm('${vars.id}.createItem', async (db) =>
    db
      .insert(${sql}_items)
      .values({ title, note: String(input?.note ?? '').trim() || null })
      .returning()
  )
  return toDto(rows[0])
}

/** 改一条（只改传进来的字段；返回 null = 这条不存在） */
export async function updateItem(
  id: number,
  patch: { title?: string; note?: string; done?: boolean }
): Promise<${P}Item | null> {
  await schemaReady
  const next: Partial<${P}ItemRow> = { updated_at: new Date().toISOString() }
  if (patch.title !== undefined) {
    const title = String(patch.title).trim()
    if (!title) throw new Error('标题不能为空')
    next.title = title
  }
  if (patch.note !== undefined) next.note = String(patch.note).trim() || null
  if (patch.done !== undefined) next.done = Boolean(patch.done)
  const rows = await withOrm('${vars.id}.updateItem', async (db) =>
    db.update(${sql}_items).set(next).where(eq(${sql}_items.id, id)).returning()
  )
  return rows[0] ? toDto(rows[0]) : null
}

/** 删一条（返回是否真的删掉了） */
export async function deleteItem(id: number): Promise<boolean> {
  await schemaReady
  const rows = await withOrm('${vars.id}.deleteItem', async (db) =>
    db.delete(${sql}_items).where(eq(${sql}_items.id, id)).returning({ id: ${sql}_items.id })
  )
  return rows.length > 0
}

/** 删掉本插件的全部记录（卸载清数据用；返回删了几行） */
export async function deleteAllItems(): Promise<number> {
  await schemaReady
  const rows = await withOrm('${vars.id}.deleteAllItems', async (db) =>
    db.delete(${sql}_items).returning({ id: ${sql}_items.id })
  )
  return rows.length
}
`
}

/** 通道实现 + 设置落盘 + 变更推送 */
function fullMainIpc(vars: TemplateVars): string {
  const P = pascalOf(vars.id)
  return `import * as fs from 'fs'
import * as path from 'path'
import { app, BrowserWindow } from 'electron'
import { safeSend } from '@host/main/safe-send'
import type { ${P}ItemInput, ${P}Settings } from '../shared/types'
import { createItem, deleteItem, listItems, updateItem } from './db/mapper'
import type { MainPluginContext } from './context'

/**
 * ${vars.title} 的主进程通道（前缀 \`plugin:${vars.id}:\`，否则装载期就抛）。
 *
 * 分工：**数据进数据库**（./db/*，能查询、能被 AI 工具读），**设置进 JSON**
 * （userData/plugin-state/${vars.id}.json——它是配置，不值得为它建表）。
 * 数据一变就推 \`plugin:${vars.id}:items-changed\`，开着的页面实时刷新。
 */

/** 主进程 → 渲染层：记录变了（只有发送方，必须在 install 里 registerEvent 声明） */
export const ITEMS_CHANGED = 'plugin:${vars.id}:items-changed'

const SETTINGS_FILE = (): string =>
  path.join(app.getPath('userData'), 'plugin-state', '${vars.id}.json')

const DEFAULT_SETTINGS: ${P}Settings = { enabled: true, note: '' }
let settings: ${P}Settings = { ...DEFAULT_SETTINGS }

/** 读设置（首次运行没有文件 → 默认值） */
function loadSettings(): void {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf-8')) as Partial<${P}Settings>
    settings = { ...DEFAULT_SETTINGS, ...saved }
  } catch {
    settings = { ...DEFAULT_SETTINGS }
  }
}

/** 写设置（目录不存在就建：数据放 userData，别写用户的工作区） */
function saveSettings(): void {
  const file = SETTINGS_FILE()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf-8')
}

/** 数据变了推给所有窗口（宿主 safe-send：向已失效的渲染帧发送不抛错） */
export function broadcastItemsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win.webContents, ITEMS_CHANGED, { at: Date.now() })
  }
}

/** 通道表（install 里交给 ctx.registerIpc；停用时随 ctx.dispose 一并摘除） */
export function createIpcHandlers(): Record<string, (...args: never[]) => unknown> {
  loadSettings()
  return {
    'plugin:${vars.id}:items-list': () => listItems(),
    'plugin:${vars.id}:items-create': async (input: ${P}ItemInput) => {
      const item = await createItem(input)
      broadcastItemsChanged()
      return item
    },
    'plugin:${vars.id}:items-update': async (
      id: number,
      patch: { title?: string; note?: string; done?: boolean }
    ) => {
      const item = await updateItem(id, patch)
      broadcastItemsChanged()
      return item
    },
    'plugin:${vars.id}:items-delete': async (id: number) => {
      const removed = await deleteItem(id)
      broadcastItemsChanged()
      return removed
    },
    'plugin:${vars.id}:settings-get': () => ({ ...settings }),
    'plugin:${vars.id}:settings-set': (patch: Partial<${P}Settings>) => {
      settings = {
        ...settings,
        enabled: typeof patch?.enabled === 'boolean' ? patch.enabled : settings.enabled,
        note: typeof patch?.note === 'string' ? patch.note : settings.note
      }
      saveSettings()
      broadcastItemsChanged()
      return { ...settings }
    }
  }
}

/** 设置文件路径（清数据时用） */
export function settingsFilePath(): string {
  return SETTINGS_FILE()
}

/** 装载期间把设置读进来，并保证首次运行就落一份文件（放进 ctx.effect：停用即回滚） */
export function initSettings(ctx: MainPluginContext): void {
  ctx.effect(() => {
    loadSettings()
    saveSettings()
    return () => {
      settings = { ...DEFAULT_SETTINGS }
    }
  })
}
`
}

/** 工具返回文案（跟随界面语言） */
function fullMainToolTexts(vars: TemplateVars): string {
  const ns = sqlNameOf(vars.id)
  return `import { getMainLanguage } from '@host/main/i18n'

/**
 * ${vars.title} 工具的返回文案（显示在工具卡片上，跟随界面语言）。
 *
 * 为什么单独一份：模型看到的字符串会原样进对话，**用户也会看到**——
 * 文案随插件走，插件停用就一起消失（别塞进宿主内核的文案表）。
 */
export const zhCNToolTexts = {
  common: {
    unknownAction: '未知动作：{{action}}。支持：{{supported}}'
  },
  ${ns}: {
    empty: '还没有任何记录。',
    listHeader: '**${vars.title}**（{{count}} 条）\\n',
    listLine: '  [{{id}}] {{title}}{{done}}',
    doneMark: '（已完成）',
    added: '已添加「{{title}}」（id={{id}}）。',
    updated: '已更新 [{{id}}]。',
    removed: '已删除 [{{id}}]。',
    notFound: '没有 id={{id}} 的记录。'
  }
} as const

export const enUSToolTexts: typeof zhCNToolTexts = {
  common: {
    unknownAction: 'Unknown action: {{action}}. Supported: {{supported}}'
  },
  ${ns}: {
    empty: 'No records yet.',
    listHeader: '**${vars.title}** ({{count}})\\n',
    listLine: '  [{{id}}] {{title}}{{done}}',
    doneMark: ' (done)',
    added: 'Added "{{title}}" (id={{id}}).',
    updated: 'Updated [{{id}}].',
    removed: 'Removed [{{id}}].',
    notFound: 'No record with id={{id}}.'
  }
}

/** 当前界面语言对应的文案 */
export function getToolTexts(): typeof zhCNToolTexts {
  return getMainLanguage() === 'en-US' ? enUSToolTexts : zhCNToolTexts
}

/** 工具描述（给模型看的；也显示在设置 → 智能体 → 工具里） */
export function toolDescriptions(): { zh: string; en: string } {
  return {
    zh: '读写「${vars.title}」：action=list 列全部；add 新增一条；done 标记完成；remove 删除一条。',
    en: 'Read and write "${vars.title}": action=list all; add a record; done marks it complete; remove deletes one.'
  }
}
`
}

/** 给助手贡献的 AI 工具（读本插件自己的 mapper） */
function fullMainTools(vars: TemplateVars): string {
  const toolName = toolNameOf(vars.id, 'items')
  const ns = sqlNameOf(vars.id)
  return `import { tool } from '@langchain/core/tools'
import * as z from 'zod/v4'
import { mainFormat } from '@host/main/i18n'
import { HARNESS_TOOL_CONTRIBUTION } from '@host/main/plugins/tool-contract'
import { createItem, deleteItem, listItems, updateItem } from './db/mapper'
import { getToolTexts, toolDescriptions } from './tool-texts'

/**
 * ${vars.title} 给助手的 AI 工具。
 *
 * 两条规矩：
 * - 经 **工具贡献点**（HARNESS_TOOL_CONTRIBUTION）注册：插件停用时 harness 拉不到这条贡献，
 *   工具自然从模型面前消失（不需要去改宿主的工具表）；
 * - 工具读的是**本插件自己的 mapper**（与页面同一份数据），不跨插件直读别人的表。
 */
export const ITEM_TOOL_NAME = '${toolName}'

export function createToolContribution(): {
  name: string
  info: { name: string; label: string; description: string; icon: string; color: string }
  build: () => unknown
} {
  const desc = toolDescriptions()
  return {
    name: ITEM_TOOL_NAME,
    info: {
      name: ITEM_TOOL_NAME,
      label: ${jsonEscape(vars.title)},
      description: desc.zh,
      icon: 'RiToolsLine',
      color: '#8b5cf6'
    },
    build: () =>
      tool(
        async (input: {
          action: 'list' | 'add' | 'done' | 'remove'
          title?: string
          id?: number
        }) => {
          const texts = getToolTexts()[${JSON.stringify(ns)}]
          const supported = 'list, add, done, remove'
          if (!input || !supported.includes(String(input.action))) {
            return mainFormat(getToolTexts().common.unknownAction, {
              action: String(input?.action ?? ''),
              supported
            })
          }
          if (input.action === 'list') {
            const items = await listItems()
            if (items.length === 0) return texts.empty
            const lines = [mainFormat(texts.listHeader, { count: items.length })]
            for (const item of items) {
              lines.push(
                mainFormat(texts.listLine, {
                  id: item.id,
                  title: item.title,
                  done: item.done ? texts.doneMark : ''
                })
              )
            }
            return lines.join('\\n')
          }
          if (input.action === 'add') {
            const title = String(input.title ?? '').trim()
            if (!title) return texts.empty
            const item = await createItem({ title })
            return mainFormat(texts.added, { title: item.title, id: item.id })
          }
          const id = Number(input.id)
          if (!Number.isFinite(id)) {
            return mainFormat(texts.notFound, { id: String(input.id ?? '') })
          }
          if (input.action === 'done') {
            const item = await updateItem(id, { done: true })
            return item ? mainFormat(texts.updated, { id }) : mainFormat(texts.notFound, { id })
          }
          const removed = await deleteItem(id)
          return removed ? mainFormat(texts.removed, { id }) : mainFormat(texts.notFound, { id })
        },
        {
          name: ITEM_TOOL_NAME,
          description: desc.zh,
          schema: z.object({
            action: z.enum(['list', 'add', 'done', 'remove']),
            title: z.string().optional().describe('add 时的标题'),
            id: z.number().optional().describe('done / remove 时的记录 id')
          })
        }
      )
  }
}

export { HARNESS_TOOL_CONTRIBUTION }
`
}

/** 卸载清数据 */
function fullMainPurge(vars: TemplateVars): string {
  return `import * as fs from 'fs'
import logger from 'electron-log'
import { deleteAllItems } from './db/mapper'
import { settingsFilePath } from './ipc'

/**
 * ${vars.title} 的清数据实现（\`plugin.purge\` 贡献）。
 *
 * 用户卸载插件并勾了「同时删除该插件的全部数据」时由宿主调用，做两件事：
 * 1. **删自己的表行**（绝不碰别的表）；
 * 2. **删应用托管的数据**（这里是设置文件；如果你还托管了目录，也只删自己建的那一层，
 *    用户自己选的原始文件一律不动）。
 *
 * 表结构不动：迁移由宿主统一管，卸载后迁移记录必须保持一致。
 */
export async function purgePluginData(): Promise<void> {
  const removed = await deleteAllItems()
  let removedFile = false
  try {
    const file = settingsFilePath()
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true })
      removedFile = true
    }
  } catch (err) {
    // 文件被占用：只告警，不阻塞卸载（表行已经删干净了）
    logger.warn('[${vars.id}] 清理设置文件失败:', err)
  }
  logger.info(
    '[${vars.id}] 已清除插件数据：记录 ' + removed + ' 条、设置文件 ' + (removedFile ? '已删' : '不存在')
  )
}
`
}

/** 主进程入口：只做装配 */
function fullMain(vars: TemplateVars): string {
  const sql = sqlNameOf(vars.id)
  return `import { PLUGIN_PURGE } from '@host/main/plugins/contributions'
import { HARNESS_TOOL_CONTRIBUTION } from '@host/main/plugins/tool-contract'
// 副作用导入：装载即触发**本插件自带建表**（幂等），不必等到第一次查询
import { schemaReady } from './db/ddl'
import { ITEMS_CHANGED, createIpcHandlers, initSettings } from './ipc'
import { purgePluginData } from './purge'
import { createToolContribution } from './tools'
import type { MainPluginContext } from './context'

/**
 * ${vars.title} 的主进程入口（**只做装配**，实现分在 ./ipc ./tools ./purge ./db 下）。
 *
 * - \`./db/ddl\`：本插件自带建表（宿主不认识 \`${sql}_items\` 这张表），幂等；
 * - \`ctx.registerIpc\`：6 个 \`plugin:${vars.id}:*\` 通道（记录增删改查 + 设置读写），
 *   停用或卸载时随 \`ctx.dispose()\` 一并摘除；
 * - \`ctx.registerEvent\`：主进程 → 渲染层的事件通道（**只有发送方**，不声明渲染层就订阅不到）；
 * - \`ctx.contribute(HARNESS_TOOL_CONTRIBUTION, …)\`：给助手的 AI 工具（读写同一份数据）；
 * - \`ctx.contribute(PLUGIN_PURGE, …)\`：卸载勾「同时删除数据」时清本插件的表行与文件。
 *
 * 一切副作用都放进 \`ctx.effect\` 并返回回滚函数：插件停用时宿主逆序撤销。
 */
export function install(ctx: MainPluginContext): void {
  // 建表是异步的：这里只是「早点开始」，mapper / purge 各自还会 await 它的承诺
  void schemaReady

  initSettings(ctx)

  ctx.registerEvent(ITEMS_CHANGED)
  ctx.registerIpc(createIpcHandlers())

  ctx.contribute(HARNESS_TOOL_CONTRIBUTION, createToolContribution())

  ctx.contribute(PLUGIN_PURGE, {
    label: '本插件的记录与设置（表 ${sql}_items + plugin-state/${vars.id}.json）',
    run: purgePluginData
  })
}
`
}

/** 词条：中文 */
function fullLocalesZh(vars: TemplateVars): string {
  return `/**
 * ${vars.title} 的中文词条。
 *
 * 顶层键 = 插件 id，里面的结构随你——宿主界面只按 labelKey 取用
 * （例如菜单的 labelKey 是 \`${vars.id}.menu.title\`）。
 * 英文那份必须**逐键对齐**（少一个键，切到英文就会显示原始键名）。
 */
export const ${pascalOf(vars.id)}ZhCN = {
  '${vars.id}': {
    menu: { title: ${jsonEscape(vars.title)} },
    settings: { title: ${jsonEscape(vars.title)} },
    page: {
      title: ${jsonEscape(vars.title)},
      add: '新建',
      empty: '还没有记录，点「新建」加一条。',
      deleteConfirm: '删除这条记录？'
    },
    form: {
      createTitle: '新建记录',
      editTitle: '编辑记录',
      titleLabel: '标题',
      titlePlaceholder: '写点什么',
      noteLabel: '备注',
      notePlaceholder: '可选'
    },
    settingsPage: {
      intro: '这一页由插件自己注册（settingsSection 挂载点）；停用插件后这一页随之消失。',
      enabledLabel: '启用示例开关',
      noteLabel: '备注（保存后持久化）',
      save: '保存',
      storageHint: '记录存在应用数据库里，设置存在 userData 的 plugin-state 目录下。'
    }
  }
}

export default ${pascalOf(vars.id)}ZhCN
`
}

/** 词条：英文（逐键对齐，不是把中文抄一遍） */
function fullLocalesEn(vars: TemplateVars): string {
  const P = pascalOf(vars.id)
  return `import type { ${P}ZhCN } from './zh-CN'

/**
 * ${vars.title} 的英文词条：**逐键对齐** zh-CN（类型就是那么来的，少键/多键都编译不过）。
 */
export const ${P}EnUS: typeof ${P}ZhCN = {
  '${vars.id}': {
    menu: { title: ${jsonEscape(vars.title)} },
    settings: { title: ${jsonEscape(vars.title)} },
    page: {
      title: ${jsonEscape(vars.title)},
      add: 'New',
      empty: 'Nothing here yet - hit "New" to add one.',
      deleteConfirm: 'Delete this record?'
    },
    form: {
      createTitle: 'New record',
      editTitle: 'Edit record',
      titleLabel: 'Title',
      titlePlaceholder: 'Write something',
      noteLabel: 'Note',
      notePlaceholder: 'optional'
    },
    settingsPage: {
      intro:
        'This page is registered by the plugin itself (settingsSection); disabling the plugin removes it.',
      enabledLabel: 'Example switch',
      noteLabel: 'Note (persisted on save)',
      save: 'Save',
      storageHint: 'Records live in the app database; settings live under plugin-state in userData.'
    }
  }
}

export default ${P}EnUS
`
}

/** 词条注册表 */
function fullLocalesIndex(vars: TemplateVars): string {
  const P = pascalOf(vars.id)
  return `import { ${P}ZhCN } from './zh-CN'
import { ${P}EnUS } from './en-US'

/**
 * ${vars.title} 的词条注册表：渲染层 install 时经
 * \`ctx.use('i18n').addResources('translation', ${P}Locales)\` 注入 i18next。
 *
 * 插件停用这些键随之消失——别把它们塞进宿主内核的词条文件。
 */
export const ${P}Locales = {
  'zh-CN': ${P}ZhCN,
  'en-US': ${P}EnUS
}

export default ${P}Locales
`
}

/** 渲染层：通道封装 */
function fullRendererApi(vars: TemplateVars): string {
  const P = pascalOf(vars.id)
  return `import type { ${P}Item, ${P}ItemInput, ${P}Settings } from '../shared/types'

/**
 * ${vars.title} 主进程通道的薄封装。
 *
 * 组件里**不直接写通道名**：改通道只动这一处，类型也只有这一处需要维护。
 * 走的是 preload 唯一暴露的通用桥（\`window.api.plugin.invoke\` / \`.on\`）。
 */
const invoke = window.api.plugin.invoke

export const api = {
  list: () => invoke('plugin:${vars.id}:items-list') as Promise<${P}Item[]>,
  create: (input: ${P}ItemInput) =>
    invoke('plugin:${vars.id}:items-create', input) as Promise<${P}Item>,
  update: (id: number, patch: { title?: string; note?: string; done?: boolean }) =>
    invoke('plugin:${vars.id}:items-update', id, patch) as Promise<${P}Item | null>,
  remove: (id: number) => invoke('plugin:${vars.id}:items-delete', id) as Promise<boolean>,
  getSettings: () => invoke('plugin:${vars.id}:settings-get') as Promise<${P}Settings>,
  setSettings: (patch: Partial<${P}Settings>) =>
    invoke('plugin:${vars.id}:settings-set', patch) as Promise<${P}Settings>,
  /** 记录变了（主进程推送）——返回取消订阅的函数 */
  onItemsChanged: (callback: () => void): (() => void) =>
    window.api.plugin.on('plugin:${vars.id}:items-changed', () => callback())
}

export default api
`
}

/** 渲染层：表单弹窗组件 */
function fullRendererItemForm(vars: TemplateVars): string {
  const P = pascalOf(vars.id)
  return `import { useEffect, useState } from 'react'
import { Input, Modal } from 'antd'
import type { ${P}Item, ${P}ItemInput } from '../../shared/types'

/**
 * 新建 / 编辑记录的弹窗。
 *
 * 为什么拆出来：表单是**状态最多的那一块**（草稿值、校验、提交中），
 * 塞在页面组件里会让列表渲染跟着一起重渲染。组件只认 props 与本插件自己的 DTO。
 */
export default function ItemForm(props: {
  open: boolean
  /** 传了就是编辑，没传就是新建 */
  item?: ${P}Item | null
  saving: boolean
  labels: {
    createTitle: string
    editTitle: string
    titleLabel: string
    titlePlaceholder: string
    noteLabel: string
    notePlaceholder: string
    save: string
    cancel: string
  }
  onCancel: () => void
  onSubmit: (input: ${P}ItemInput) => void
}): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')

  // 每次打开都用当前这条记录重置草稿（关掉再打开不能留着上一次的输入）
  useEffect(() => {
    if (!props.open) return
    setTitle(props.item?.title ?? '')
    setNote(props.item?.note ?? '')
  }, [props.open, props.item])

  return (
    <Modal
      open={props.open}
      title={props.item ? props.labels.editTitle : props.labels.createTitle}
      okText={props.labels.save}
      cancelText={props.labels.cancel}
      confirmLoading={props.saving}
      okButtonProps={{ disabled: title.trim().length === 0 }}
      onCancel={props.onCancel}
      onOk={() => props.onSubmit({ title: title.trim(), note: note.trim() })}
    >
      <div className="flex flex-col gap-3 pt-2">
        <Input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={props.labels.titlePlaceholder}
          addonBefore={props.labels.titleLabel}
        />
        <Input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={props.labels.notePlaceholder}
          addonBefore={props.labels.noteLabel}
        />
      </div>
    </Modal>
  )
}
`
}

/** 渲染层：页面 */
function fullPage(vars: TemplateVars): string {
  const P = pascalOf(vars.id)
  return `import { useCallback, useEffect, useState } from 'react'
import { App, Button, Checkbox, Empty, Typography } from 'antd'
import { RiAddLine, RiDeleteBin6Line, RiRefreshLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { ${P}Item, ${P}ItemInput } from '../shared/types'
import api from './api'
import ItemForm from './components/ItemForm'

/**
 * ${vars.title} 的页面。
 *
 * 数据只走本插件的主进程通道（./api）；主进程改数据会推 \`plugin:${vars.id}:items-changed\`，
 * 这里订阅它做实时刷新——设置页那边改开关，这一页也会跟着变。
 */
export default function Page(): React.JSX.Element {
  const { t } = useTranslation()
  const { modal } = App.useApp()
  const [items, setItems] = useState<${P}Item[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<${P}Item | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setItems(await api.list())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 主进程推送：记录变了就重拉（事件通道由插件主进程 registerEvent 声明过才订阅得到）
  useEffect(() => api.onItemsChanged(() => void load()), [load])

  const submit = async (input: ${P}ItemInput): Promise<void> => {
    setSaving(true)
    try {
      if (editing) await api.update(editing.id, input)
      else await api.create(input)
      setFormOpen(false)
      setEditing(null)
      await load()
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (item: ${P}Item, done: boolean): Promise<void> => {
    await api.update(item.id, { done })
    await load()
  }

  const remove = (item: ${P}Item): void => {
    modal.confirm({
      title: t('${vars.id}.page.deleteConfirm'),
      okText: t('common.action.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common.action.cancel'),
      onOk: async () => {
        await api.remove(item.id)
        await load()
      }
    })
  }

  return (
    <div className="h-full w-full overflow-auto p-6">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
        <div className="flex items-center justify-between">
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('${vars.id}.page.title')}
          </Typography.Title>
          <div className="flex items-center gap-2">
            <Button
              size="small"
              icon={<RiRefreshLine size={14} />}
              loading={loading}
              onClick={() => void load()}
            >
              {t('common.action.refresh')}
            </Button>
            <Button
              size="small"
              type="primary"
              icon={<RiAddLine size={14} />}
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              {t('${vars.id}.page.add')}
            </Button>
          </div>
        </div>

        {items.length === 0 && !loading ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('${vars.id}.page.empty')} />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors"
              >
                <Checkbox
                  checked={item.done}
                  onChange={(event) => void toggle(item, event.target.checked)}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 cursor-pointer truncate border-none bg-transparent p-0 text-left"
                  onClick={() => {
                    setEditing(item)
                    setFormOpen(true)
                  }}
                >
                  <span className={item.done ? 'line-through opacity-60' : undefined}>
                    {item.title}
                  </span>
                  {item.note ? <span className="ml-2 text-xs opacity-60">{item.note}</span> : null}
                </button>
                <Button
                  size="small"
                  type="text"
                  aria-label={t('common.action.delete')}
                  icon={<RiDeleteBin6Line size={14} />}
                  onClick={() => remove(item)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <ItemForm
        open={formOpen}
        item={editing}
        saving={saving}
        labels={{
          createTitle: t('${vars.id}.form.createTitle'),
          editTitle: t('${vars.id}.form.editTitle'),
          titleLabel: t('${vars.id}.form.titleLabel'),
          titlePlaceholder: t('${vars.id}.form.titlePlaceholder'),
          noteLabel: t('${vars.id}.form.noteLabel'),
          notePlaceholder: t('${vars.id}.form.notePlaceholder'),
          save: t('common.action.save'),
          cancel: t('common.action.cancel')
        }}
        onCancel={() => {
          setFormOpen(false)
          setEditing(null)
        }}
        onSubmit={(input) => void submit(input)}
      />
    </div>
  )
}
`
}

/** 渲染层：设置页 */
function fullSettings(vars: TemplateVars): string {
  const P = pascalOf(vars.id)
  return `import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Switch, Typography } from 'antd'
import { useTranslation } from '@host/renderer/i18n'
import type { ${P}Settings } from '../shared/types'
import api from './api'

/**
 * ${vars.title} 的设置页（设置 → 助手 → 本插件）。
 *
 * 与页面共用同一份主进程状态：这里改开关，页面那边会通过事件推送同步过去。
 * 界面文案一律走词条（locales/），不写死在组件里。
 */
export default function Settings(): React.JSX.Element {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<${P}Settings>({ enabled: true, note: '' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setSettings(await api.getSettings())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (patch: Partial<${P}Settings>): Promise<void> => {
    setBusy(true)
    try {
      setSettings(await api.setSettings(patch))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {t('${vars.id}.settings.title')}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        {t('${vars.id}.settingsPage.intro')}
      </Typography.Paragraph>
      <div className="flex max-w-[560px] flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <span>{t('${vars.id}.settingsPage.enabledLabel')}</span>
          <Switch
            size="small"
            checked={settings.enabled}
            onChange={(value) => void save({ enabled: value })}
          />
        </div>
        <Input
          value={settings.note}
          onChange={(event) => setSettings((prev) => ({ ...prev, note: event.target.value }))}
          placeholder={t('${vars.id}.settingsPage.noteLabel')}
        />
        <Button type="primary" loading={busy} onClick={() => void save({ note: settings.note })}>
          {t('${vars.id}.settingsPage.save')}
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('${vars.id}.settingsPage.storageHint')}
        </Typography.Text>
      </div>
    </div>
  )
}
`
}

/** 渲染层入口：路由 + 菜单 + 设置页 + 词条 */
function fullPlugin(vars: TemplateVars): string {
  const P = pascalOf(vars.id)
  return `import { RiPuzzleLine } from '@remixicon/react'
import { ${P}Locales } from '../locales'
import type { PluginRenderContext } from './context'
import Page from './Page'
import Settings from './Settings'

/**
 * ${vars.title} 的渲染层入口（**只做装配**）。
 *
 * 挂载点：route（页面）、menu（侧栏）、settingsSection（设置页）、i18n（词条）。
 * 都是可逆装配——插件停用时宿主自动摘除，不需要写反注册。
 */
const plugin = {
  install(ctx: PluginRenderContext): void {
    ctx.use('route').register({
      path: '/${vars.id}',
      load: () => import('./Page')
    })
    ctx.use('menu').register({
      // 菜单键必须与路由路径一致：点击菜单就是 navigate('/' + key)
      key: '${vars.id}',
      labelKey: '${vars.id}.menu.title',
      icon: <RiPuzzleLine size={16} />,
      order: 60
    })
    ctx.use('settingsSection').register({
      tabKey: '${vars.id}',
      labelKey: '${vars.id}.settings.title',
      icon: <RiPuzzleLine size={16} />,
      group: 'assistant',
      order: 90,
      Component: Settings
    })
    // 词条随插件注册：第一个参数是命名空间（宿主界面一律 'translation'），第二个是「语言 → 词条树」
    ctx.use('i18n').addResources('translation', ${P}Locales)
  }
}

export default plugin
`
}

/** 完整骨架的冒烟用例：真的走一遍「建一条 → 列出来」 */
function fullSmoke(vars: TemplateVars): string {
  return `/**
 * 草稿自带的冒烟用例（工坊验收电池会执行它）。
 *
 * 语义：\`channels\` 里的每一项都会用**真实装载的插件**调用对应 IPC 处理器，
 * 参数是 args 数组，返回值交给 expect 断言（返回 true = 通过，返回字符串 = 失败原因）。
 * 加新通道时在这里补一条——它比「装上去点一下」更早发现问题。
 *
 * 这几条连起来就是一条业务路径：**建一条记录 → 列出来能看见它 → 设置能存住**。
 */
export default {
  channels: {
    'plugin:${vars.id}:items-create': {
      args: [{ title: 'smoke-item', note: 'created by workshop smoke' }],
      expect: (value) => value && value.title === 'smoke-item' && typeof value.id === 'number'
    },
    'plugin:${vars.id}:items-list': {
      args: [],
      expect: (value) => Array.isArray(value) && value.some((item) => item.title === 'smoke-item')
    },
    'plugin:${vars.id}:settings-set': {
      args: [{ enabled: false, note: 'smoke' }],
      expect: (value) => value && value.enabled === false && value.note === 'smoke'
    }
  }
}
`
}

/** 冒烟用例（工坊的验收电池会真的调用这些通道；模板变量由调用方拼进 channel/args/expect） */
function smokeFile(channel: string, args: string, expect: string): string {
  return `/**
 * 草稿自带的冒烟用例（工坊验收电池会执行它）。
 *
 * 语义：\`channels\` 里的每一项都会用**真实装载的插件**调用对应 IPC 处理器，
 * 参数是 args 数组，返回值交给 expect 断言（返回 true = 通过，返回字符串 = 失败原因）。
 * 没写这个文件时工坊只做契约级冒烟（能装载、通道命名合法、可回滚）。
 */
export default {
  channels: {
    '${channel}': {
      args: ${args},
      expect: ${expect}
    }
  }
}
`
}

/**
 * 按模板生成草稿文件表（相对路径 → 文件内容）。
 *
 * 所有模板都会带上 `WORKSHOP.md` 与 `renderer/context.ts`：前者是模型的契约单，
 * 后者是草稿里唯一的「宿主能力类型声明」，两者都不随包分发。
 */
export function renderTemplate(
  template: WorkshopTemplate,
  vars: TemplateVars
): Record<string, string> {
  const files: Record<string, string> = {
    'WORKSHOP.md': workshopDoc(template, vars),
    'renderer/context.ts': RENDERER_CONTEXT_DTS,
    'main/context.ts': MAIN_CONTEXT_DTS
  }

  switch (template) {
    case 'panel':
      files['plugin.json'] = manifestFile(vars, {
        inject: ['settingsSection', 'i18n']
      })
      files['main/index.ts'] = panelMain(vars)
      files['renderer/plugin.tsx'] = panelPlugin(vars)
      files['renderer/Settings.tsx'] = panelComponent(vars)
      files['workshop.smoke.mjs'] = smokeFile(
        `plugin:${vars.id}:settings-set`,
        "[{ enabled: true, note: 'smoke' }]",
        "(value) => value && value.enabled === true && value.note === 'smoke'"
      )
      break

    case 'tool':
      files['plugin.json'] = manifestFile(vars, {
        inject: ['settingsSection', 'i18n']
      })
      files['main/index.ts'] = toolMain(vars)
      files['renderer/plugin.tsx'] = toolPlugin(vars)
      break

    case 'minimal':
      files['plugin.json'] = manifestFile(vars, { inject: ['appProvider'] })
      files['main/index.ts'] = noopMain()
      files['renderer/plugin.tsx'] = minimalPlugin()
      break

    case 'page':
      files['plugin.json'] = manifestFile(vars, {
        inject: ['route', 'menu', 'i18n'],
        routes: [{ path: `/${vars.id}` }],
        menu: {
          key: vars.id,
          labelKey: `${vars.id}.menu.title`,
          icon: 'RiPuzzleLine',
          order: 60
        }
      })
      files['main/index.ts'] = pageMain(vars)
      files['renderer/plugin.tsx'] = pagePlugin(vars)
      files['renderer/Page.tsx'] = pageComponent(vars)
      files['workshop.smoke.mjs'] = smokeFile(
        `plugin:${vars.id}:state-set`,
        "['smoke-value']",
        "(value) => value && value.value === 'smoke-value'"
      )
      break

    case 'full':
    default:
      // 默认模板 = 全部内容（用户口径「默认是全部内容都要」）：页面 + 设置页 + AI 工具 + 事件推送，
      // 并且**按真实插件仓库的分层来铺**（用户 2026-09-28：「和 ryten-plugins 比缺失了好多内容」）：
      // 自己的表（db/ddl + db/schema + db/mapper）、自己的词条（locales/）、通道封装（renderer/api）、
      // 工具文案（main/tool-texts）、组件拆分（renderer/components/）。
      files['plugin.json'] = manifestFile(vars, {
        inject: ['route', 'menu', 'settingsSection', 'i18n'],
        routes: [{ path: `/${vars.id}` }],
        menu: {
          key: vars.id,
          labelKey: `${vars.id}.menu.title`,
          icon: 'RiPuzzleLine',
          order: 60
        }
      })
      files['shared/types.ts'] = fullSharedTypes(vars)
      files['locales/index.ts'] = fullLocalesIndex(vars)
      files['locales/zh-CN.ts'] = fullLocalesZh(vars)
      files['locales/en-US.ts'] = fullLocalesEn(vars)
      files['main/index.ts'] = fullMain(vars)
      files['main/ipc.ts'] = fullMainIpc(vars)
      files['main/tools.ts'] = fullMainTools(vars)
      files['main/tool-texts.ts'] = fullMainToolTexts(vars)
      files['main/purge.ts'] = fullMainPurge(vars)
      files['main/db/ddl.ts'] = fullDbDdl(vars)
      files['main/db/schema.ts'] = fullDbSchema(vars)
      files['main/db/mapper.ts'] = fullDbMapper(vars)
      files['renderer/plugin.tsx'] = fullPlugin(vars)
      files['renderer/api.ts'] = fullRendererApi(vars)
      files['renderer/Page.tsx'] = fullPage(vars)
      files['renderer/Settings.tsx'] = fullSettings(vars)
      files['renderer/components/ItemForm.tsx'] = fullRendererItemForm(vars)
      files['workshop.smoke.mjs'] = fullSmoke(vars)
      break
  }

  return files
}

/** 契约单（模型照着它写代码；也是人排查「生成的插件为什么这样写」的入口） */
function workshopDoc(template: WorkshopTemplate, vars: TemplateVars): string {
  const mainKeys = vars.hostMainKeys.length
    ? vars.hostMainKeys.map((k) => '- `' + k + '`').join('\n')
    : '- （宿主当前没有可用的主进程模块）'
  const uiKeys = vars.hostUiKeys.length
    ? vars.hostUiKeys.map((k) => '- `' + k + '`').join('\n')
    : '- （宿主当前没有可用的渲染层模块）'
  const info = TEMPLATE_INFOS.find((t) => t.template === template)

  return `# 插件工坊契约（${vars.id}）

> 这份文件由工坊生成，是**改这个插件时的唯一契约来源**。改完代码用工具走一遍：
> \`plugin_build\`（构建）→ \`plugin_verify\`（自动验收）→ \`plugin_publish\`（装进应用启用）。

## 1. 这个草稿是什么

- 插件 id：\`${vars.id}\`（= 目录名 = plugin.json.id = IPC 命名空间 \`plugin:${vars.id}:*\`）
- 模板：\`${template}\`（${info?.label ?? template}）—— ${info?.description ?? ''}
- 已注册：${info?.registers ?? ''}

## 2. 文件职责

布局与真实插件仓库（ryten-plugins）一致——每个文件一个职责，助手改哪块就只看哪块：

| 文件 | 作用 |
|------|------|
| \`plugin.json\` | 插件清单（id/name/version/description/inject/routes/menu）。**不要手写 entry**，构建时写入 |
| \`shared/types.ts\` | 跨进程 DTO（主进程与渲染层共用一份形状；**不许** import drizzle/electron/node） |
| \`main/index.ts\` | 主进程入口：\`export function install(ctx)\`，**只做装配**（建表 side-effect / 通道 / 事件 / 工具 / 清数据） |
| \`main/ipc.ts\` | 通道实现 + 设置落盘 + 变更推送（\`ITEMS_CHANGED\` 这类事件常量也在这里） |
| \`main/tools.ts\` | 给助手贡献的 AI 工具（\`HARNESS_TOOL_CONTRIBUTION\`） |
| \`main/tool-texts.ts\` | 工具的返回文案（中文 / 英文，跟随界面语言） |
| \`main/purge.ts\` | 卸载清数据（删自己的表行 + 应用托管的数据；挂 \`PLUGIN_PURGE\`） |
| \`main/db/ddl.ts\` | **本插件自带建表**（幂等 \`IF NOT EXISTS\`）+ \`schemaReady\` 承诺 |
| \`main/db/schema.ts\` | drizzle 表定义（查询用；行类型 \`$inferSelect\` 的单一真源） |
| \`main/db/mapper.ts\` | 数据访问（统一走宿主 \`withOrm\`；行 → DTO 只在这里转） |
| \`locales/{index,zh-CN,en-US}.ts\` | 词条（渲染层 install 时注册；英文逐键对齐中文） |
| \`renderer/plugin.tsx\` | 渲染层入口：\`export default { install(ctx) }\`，**只做装配**。**必需** |
| \`renderer/api.ts\` | 主进程通道的薄封装（组件不直接写通道名） |
| \`renderer/Page.tsx\` / \`renderer/Settings.tsx\` | 页面与设置页（路由的 \`load()\` 指向它们才会拆成懒加载 chunk） |
| \`renderer/components/*.tsx\` | 拆出来的组件（表单弹窗这类状态多的块别塞进页面） |
| \`plugin.css\` | 可选：手写样式（\`workshop.json\` 的 \`css: 'file'\` 时原样进包）。默认 \`auto\`，由工坊用 Tailwind 扫源码生成 |
| \`workshop.smoke.mjs\` | 可选：验收电池要跑的通道级冒烟用例 |
| \`renderer/context.ts\` / \`main/context.ts\` | 宿主上下文的最小类型声明（**不随包分发**，仅供写代码时参考） |

## 3. 清单字段（plugin.json）

\`\`\`jsonc
{
  "id": "${vars.id}",            // 小写 kebab，必须与目录名一致，不可再改
  "name": "${vars.title}",       // 展示名
  "version": "0.1.0",            // 改了代码要升版本（面板据此显示更新）
  "description": "…",
  "builtin": false,              // 第三方插件必须是 false
  "inject": ["route", "menu", "settingsSection", "appProvider", "i18n", "events", "storage"],
  "routes": [{ "path": "/${vars.id}" }],                                   // 可选
  "menu": { "key": "${vars.id}", "labelKey": "${vars.id}.menu.title", "icon": "RiPuzzleLine", "order": 60 }
}
\`\`\`

## 4. 渲染层契约

\`\`\`ts
ctx.use('route').register({ path: '/x', load: () => import('./Page') })
ctx.use('menu').register({ key: 'x', labelKey: 'x.menu.title', icon: <RiPuzzleLine size={16} />, order: 60 })
ctx.use('settingsSection').register({ tabKey: 'x', labelKey: 'x.settings.title', icon, group: 'assistant', order: 90, Component: Settings })
ctx.use('appProvider').register({ Provider, order: 90 })
ctx.use('i18n').addResources('translation', {
  'zh-CN': { x: { menu: { title: '名字' } } },
  'en-US': { x: { menu: { title: 'Name' } } }
})
ctx.effect(() => { const t = setInterval(tick, 1000); return () => clearInterval(t) })
\`\`\`

- **菜单键必须等于路由路径去掉斜杠**（\`key: 'x'\` ↔ \`path: '/x'\`）：点击菜单就是 \`navigate('/' + key)\`；
- 词条注册的**第一个参数是 i18next 命名空间**（宿主界面一律 \`'translation'\`），第二个参数是
  「语言 → 词条树」。写成 \`addResources('zh-CN', …)\` 是把语言当成了命名空间，
  菜单/设置页会显示原始键名（\`x.menu.title\`）；
- 一切注册都随插件停用回滚，**不要**自己写反注册；
- 调主进程一律 \`window.api.plugin.invoke('plugin:${vars.id}:<name>', ...args)\`（或草稿里的 \`invoke()\`）。

### 可用的宿主模块（渲染层）

只有下面这些键（外加 \`react\` / \`react-dom\` / \`antd\` / \`@remixicon/react\` / \`@ant-design/icons\` / \`dayjs\`
这些宿主已有唯一实例的 **vendor** 可以直接裸导入）能在产物里保留为外部依赖；
**其它第三方包一律没有**（草稿目录里没有 node_modules），import 了会构建失败：

${uiKeys}

## 5. 主进程契约

\`\`\`ts
export function install(ctx) {
  ctx.registerIpc({ 'plugin:${vars.id}:do-something': async (arg) => result })
  ctx.registerEvent('plugin:${vars.id}:pushed')   // 只推送、无 handler 的通道必须声明
  ctx.effect(() => { start(); return () => stop() })
  ctx.contribute(HARNESS_TOOL_CONTRIBUTION, { name, info, build })  // 给助手加工具
  // 卸载时勾了「同时删除数据」才会跑：清自己的数据文件/表行（label 会显示给用户看）
  ctx.contribute(PLUGIN_PURGE, { label: '本插件的数据', run: () => { /* 删自己的东西 */ } })
}
\`\`\`

- 通道名**必须**以 \`plugin:${vars.id}:\` 开头，否则装载期直接抛错；
- 主进程可以直接 import \`electron\` / \`electron-log\` / \`zod/v4\` / \`@langchain/core/tools\` 等宿主已装依赖；
- 数据请落在 \`app.getPath('userData')\` 下（别写用户工作区）。

### 可用的宿主模块（主进程）

${mainKeys}

## 5b. 数据与表（要存东西时照这个来）

独立插件的表**归插件自己管**：宿主不认识它们，迁移链里也没有它们。

\`\`\`ts
// main/db/ddl.ts —— 建表：幂等 + 只动自己的表（表名必须带插件前缀）
const DDL = [\`CREATE TABLE IF NOT EXISTS ${sqlNameOf(vars.id)}_items ( id SERIAL PRIMARY KEY, … )\`]
export const schemaReady = (async () => {
  await withOrm('${vars.id}.ensureSchema', async (db) => {
    for (const s of DDL) await db.execute(sql.raw(s))
  })
})()

// main/db/mapper.ts —— 每个函数先 await schemaReady，再走 withOrm
export async function listItems() {
  await schemaReady
  return withOrm('${vars.id}.listItems', async (db) => db.select().from(${sqlNameOf(vars.id)}_items))
}
\`\`\`

- **表名前缀 = 插件 id 的 SQL 形态**（\`${sqlNameOf(vars.id)}_\`）：一个库里装着所有插件的表，撞名就是事故；
- \`@host/main/database/orm\` 的 \`withOrm(op, fn)\` 给 drizzle 实例并统一记异常（务必用它，别自己拿连接）；
- \`schemaReady\` 是承诺：装载即建表，但**不保证建表先于第一次查询**，mapper / purge 都要 await 它；
- **插件是在数据库初始化之前被装载的**（宿主 \`initPluginHost()\` 早于 \`createLoadingWindow()\`）：
  \`withOrm\` 会等库就绪，所以装载期调用它是安全的，但**别在装载期同步等它**、也别「先读库再导出同步状态」；
- **应用数据进表**（可查询、AI 工具能读），**设置进 JSON**（\`userData/plugin-state/${vars.id}.json\`）；
  用户的工作区是他的项目目录，**任何数据都不要写进去**。

## 5c. 词条（界面上要显示的文字）

- 词条放 \`locales/zh-CN.ts\` 与 \`locales/en-US.ts\`，由 \`locales/index.ts\` 汇总；
  渲染层 install 里 \`ctx.use('i18n').addResources('translation', ${pascalOf(vars.id)}Locales)\` 注册；
- **英文逐键对齐中文**（用 \`typeof zhCN\` 约束，删/加键都会编译报错）——
  别把中文抄进 en-US，切到英文就露馅；
- 组件里一律 \`t('${vars.id}.page.xxx')\`，不写死文案；工具返回的文案放 \`main/tool-texts.ts\`
  （\`getMainLanguage()\` 选语言），它同样会显示给用户看。

## 6. 样式

- 默认由工坊用 Tailwind（theme + utilities，**不含 preflight**）扫源码生成 \`plugin.css\` 并随包分发；
- 因此**类名必须是字面量**（\`className="p-4 flex"\` 可以，\`className={'p-' + n}\` 扫不到）；
- 宿主的 Tailwind 产物**不覆盖外部插件**：漏样式 = 界面变形，验收里的 \`style.coverage\` 会点名。

## 7. 冒烟用例（可选）

\`\`\`js
export default {
  channels: {
    'plugin:${vars.id}:some-channel': {
      args: ['参数1', 2],
      expect: (value) => value?.ok === true || '失败原因'
    }
  }
}
\`\`\`

## 8. 做完之后

1. \`plugin_build\`：构建 + 静态审计（清单、宿主契约、体积）；
2. \`plugin_verify\`：跑完整验收电池（含真实装载 main.cjs 的冒烟与渲染层探针），报告逐项给结论；
3. \`plugin_publish\`：装进 \`userData/plugins/${vars.id}/\` 并启用，界面立即出现（菜单/设置页）。
`
}
