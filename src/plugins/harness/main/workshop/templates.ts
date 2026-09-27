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
      'route / menu / settingsSection / i18n（渲染层）+ 4 个 IPC 通道 + 1 个事件通道 + harness.tool 与 plugin.purge 贡献（主进程）'
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

/**
 * 完整骨架的主进程入口：状态文件 + 4 个通道 + 事件推送 + AI 工具 + 卸载清数据。
 *
 * 它是**能跑通的示例合集**，把插件的每个契约面都摆出来一遍：
 * 可逆 effect（建目录/读盘/回滚）、registerIpc、registerEvent + safeSend 推送、
 * harness.tool 贡献（工具与插件自己的数据是同一份）、plugin.purge 声明。
 * 助手在这个骨架上删掉不需要的部分即可——比从零拼装可靠得多。
 */
function fullMain(vars: TemplateVars): string {
  const toolName = toolNameOf(vars.id)
  return `import * as fs from 'fs'
import * as path from 'path'
import { app, BrowserWindow } from 'electron'
import { tool } from '@langchain/core/tools'
import * as z from 'zod/v4'
import { PLUGIN_PURGE } from '@host/main/plugins/contributions'
import { HARNESS_TOOL_CONTRIBUTION } from '@host/main/plugins/tool-contract'
import { safeSend } from '@host/main/safe-send'
import type { MainPluginContext } from './context'

/**
 * ${vars.title} 的主进程：状态落盘 + 通道 + 事件推送 + 给助手的工具。
 *
 * 三条容易写错的规矩（都在这里做对了，照抄即可）：
 * - 通道名必须以 \`plugin:${vars.id}:\` 开头，否则装载期就抛；
 * - 主进程 → 渲染层的推送要**先 registerEvent 声明**（否则渲染层订阅不到），
 *   并用宿主 safe-send（向已失效的渲染帧发送不会抛错，只有它能识别）；
 * - 一切副作用都放进 ctx.effect 并返回回滚函数，插件停用时宿主会逆序撤销。
 */
const STATE_CHANGED = 'plugin:${vars.id}:state-changed'

interface PluginState {
  /** 页面里保存的内容 */
  value: string
  /** 设置页里的开关 */
  enabled: boolean
  /** 设置页里的备注 */
  note: string
}

let stateFile = ''
let state: PluginState = { value: '', enabled: false, note: '' }

function persist(): void {
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(state), 'utf-8')
}

/** 状态变了就推给所有窗口（渲染层订阅 STATE_CHANGED 的那一处会实时更新） */
function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win.webContents, STATE_CHANGED, { ...state })
  }
}

export function install(ctx: MainPluginContext): void {
  ctx.effect(() => {
    // 数据放 userData（别写用户的工作区：那是他的项目目录）
    const dir = path.join(app.getPath('userData'), 'plugin-state')
    fs.mkdirSync(dir, { recursive: true })
    stateFile = path.join(dir, '${vars.id}.json')
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as Partial<PluginState>
      state = { ...state, ...saved }
    } catch {
      // 首次运行没有文件：用默认值
    }
    return () => {
      stateFile = ''
    }
  })

  // 只推送、没有 handler 的通道必须声明，否则渲染层订阅不到
  ctx.registerEvent(STATE_CHANGED)

  ctx.registerIpc({
    'plugin:${vars.id}:state-get': () => ({ ...state }),
    'plugin:${vars.id}:state-set': (value: unknown) => {
      state = { ...state, value: typeof value === 'string' ? value : '' }
      persist()
      broadcast()
      return { ...state }
    },
    'plugin:${vars.id}:settings-get': () => ({ ...state }),
    'plugin:${vars.id}:settings-set': (patch: Partial<PluginState>) => {
      state = {
        ...state,
        enabled: typeof patch?.enabled === 'boolean' ? patch.enabled : state.enabled,
        note: typeof patch?.note === 'string' ? patch.note : state.note
      }
      persist()
      broadcast()
      return { ...state }
    }
  })

  // 卸载时勾了「同时删除该插件的全部数据」才会跑到这里（插件当时仍装载着）
  ctx.contribute(PLUGIN_PURGE, {
    label: '本插件保存的内容与设置（plugin-state/${vars.id}.json）',
    run: () => {
      if (stateFile) fs.rmSync(stateFile, { force: true })
    }
  })

  // 给助手贡献一个工具：读的正是这份插件自己的状态（工具与数据同源）
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
        async () => {
          const saved = state.value ? state.value : '（还没有保存任何内容）'
          return ${jsonEscape(vars.title)} + '：' + saved
        },
        {
          name: '${toolName}',
          description: ${jsonEscape(vars.description)},
          schema: z.object({})
        }
      )
  })
}
`
}

/** 完整骨架的渲染层入口：路由 + 侧栏菜单 + 设置页 + 词条 */
function fullPlugin(vars: TemplateVars): string {
  return `import { RiPuzzleLine } from '@remixicon/react'
import type { PluginRenderContext } from './context'
import Page from './Page'
import Settings from './Settings'

/**
 * 完整骨架的渲染层入口：把三类挂载点各注册一个（路由页面 / 侧栏菜单 / 设置页），
 * 再加一组词条。都是可逆装配——插件停用时宿主自动摘除，不需要写反注册。
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
    // 词条：第一个参数是命名空间（宿主界面一律 'translation'），第二个是「语言 → 词条树」
    ctx.use('i18n').addResources('translation', {
      'zh-CN': {
        '${vars.id}': {
          menu: { title: ${jsonEscape(vars.title)} },
          settings: { title: ${jsonEscape(vars.title)} }
        }
      },
      'en-US': {
        '${vars.id}': {
          menu: { title: ${jsonEscape(vars.title)} },
          settings: { title: ${jsonEscape(vars.title)} }
        }
      }
    })
  }
}

export default plugin
`
}

/** 完整骨架的页面：读写内容 + 订阅主进程推送（实时） */
function fullPage(vars: TemplateVars): string {
  return `import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Input, Space, Typography } from 'antd'
import { RiSaveLine, RiRefreshLine } from '@remixicon/react'
import { invoke } from './context'

interface PluginState {
  value: string
  enabled: boolean
  note: string
}

/**
 * ${vars.title} 的页面。
 *
 * 数据只走本插件的主进程通道；主进程改了状态会推 \`plugin:${vars.id}:state-changed\`，
 * 这里订阅它做实时更新（设置页里改开关，这一页也会跟着变）。
 */
export default function Page(): React.JSX.Element {
  const [state, setState] = useState<PluginState>({ value: '', enabled: false, note: '' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      setState((await invoke('plugin:${vars.id}:state-get')) as PluginState)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    // 事件通道由插件主进程 registerEvent 声明过才进 preload 白名单
    return window.api.plugin.on('plugin:${vars.id}:state-changed', (data) => {
      setState(data as PluginState)
    })
  }, [])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      setState((await invoke('plugin:${vars.id}:state-set', state.value)) as PluginState)
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
              {state.enabled ? '设置页里的开关是打开的' : '设置页里的开关是关闭的'}
              {state.note ? ' · 备注：' + state.note : ''}
            </Typography.Text>
            <Input.TextArea
              value={state.value}
              onChange={(e) => setState((prev) => ({ ...prev, value: e.target.value }))}
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

/** 完整骨架的设置页 */
function fullSettings(vars: TemplateVars): string {
  return `import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Switch, Typography } from 'antd'
import { invoke } from './context'

interface PluginState {
  value: string
  enabled: boolean
  note: string
}

/**
 * ${vars.title} 的设置页（设置 → 助手 → 本插件）。
 *
 * 与页面共用同一份主进程状态：这里改开关，页面那边会通过事件推送同步过去。
 */
export default function Settings(): React.JSX.Element {
  const [state, setState] = useState<PluginState>({ value: '', enabled: false, note: '' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setState((await invoke('plugin:${vars.id}:settings-get')) as PluginState)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (patch: Partial<PluginState>): Promise<void> => {
    setBusy(true)
    try {
      setState((await invoke('plugin:${vars.id}:settings-set', patch)) as PluginState)
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
        这一页由插件自己注册（settingsSection 挂载点）；停用插件后这一页随之消失。
      </Typography.Paragraph>
      <div className="flex max-w-[560px] flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <span>启用示例开关</span>
          <Switch
            checked={state.enabled}
            onChange={(value) => void save({ enabled: value })}
            size="small"
          />
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

/** 完整骨架的冒烟用例：两条通道各验一次 */
function fullSmoke(vars: TemplateVars): string {
  return `/**
 * 草稿自带的冒烟用例（工坊验收电池会执行它）。
 *
 * 语义：\`channels\` 里的每一项都会用**真实装载的插件**调用对应 IPC 处理器，
 * 参数是 args 数组，返回值交给 expect 断言（返回 true = 通过，返回字符串 = 失败原因）。
 * 加新通道时在这里补一条——它比「装上去点一下」更早发现问题。
 */
export default {
  channels: {
    'plugin:${vars.id}:state-set': {
      args: ['smoke-value'],
      expect: (value) => value && value.value === 'smoke-value'
    },
    'plugin:${vars.id}:settings-set': {
      args: [{ enabled: true, note: 'smoke' }],
      expect: (value) => value && value.enabled === true && value.note === 'smoke'
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
      // 默认模板 = 全部内容（用户口径「默认是全部内容都要」）：页面 + 设置页 + AI 工具 + 事件推送
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
      files['main/index.ts'] = fullMain(vars)
      files['renderer/plugin.tsx'] = fullPlugin(vars)
      files['renderer/Page.tsx'] = fullPage(vars)
      files['renderer/Settings.tsx'] = fullSettings(vars)
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

| 文件 | 作用 |
|------|------|
| \`plugin.json\` | 插件清单（id/name/version/description/inject/routes/menu）。**不要手写 entry**，构建时写入 |
| \`main/index.ts\` | 主进程入口：\`export function install(ctx)\`。缺省即无主进程能力（但产物里仍会有一个空 main.cjs） |
| \`renderer/plugin.tsx\` | 渲染层入口：\`export default { install(ctx) }\`。**必需** |
| \`renderer/*.tsx\` | 页面与组件（路由的 \`load()\` 指向它们才会拆成懒加载 chunk） |
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
