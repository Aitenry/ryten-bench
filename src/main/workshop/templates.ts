import type { WorkshopTemplate } from '../../shared/harness/workshop'
import { pickDeclaredMenuIcon } from '../../shared/plugin/menu-icons'
import { renderTemplateFiles } from './template-files'

/**
 * 草稿模板：`plugin_draft create` 生成的骨架。
 *
 * 两条硬要求：
 * 1. **模板必须是能真的构建、装载、跑起来的插件**（离线工装会逐个模板走完
 *    「构建 → 验收 → 发布」全链路，模板写错了工装就红）；
 * 2. **`WORKSHOP.md` 是给模型看的契约单**：宿主模块白名单、挂载点、通道命名、样式与冒烟用例
 *    的写法都在里面，助手照着它改代码。宿主模块白名单是**运行期注入**的（`hostMainKeys` /
 *    `hostUiKeys`），所以模板永远不会写出一份过期的白名单。
 *
 * 生成出来的代码一律用**裸说明符**引用宿主能力（`react` / `antd` / `@host/main/...`）：
 * 打包时主进程侧被改写成 `__RB_HOST_RESOLVE__`，渲染层侧原样留在产物里由宿主 loader
 * 在装载时改写成 `plugin://host/ui.js` 桥——这保证插件永远用宿主那一份 React / i18n。
 *
 * **文本资产不在本文件里**：每个草稿文件的正文（含 WORKSHOP.md）都在
 * `src/main/workshop/template-files/<模板>/…`，保持 `.ts` / `.tsx` / `.mjs` / `.md` 原扩展名，
 * 由 `template-files.ts` 统一按路径匹配后渲染 `${vars.*}` 占位符。这里只留「哪些文件属于
 * 哪个模板」的装配逻辑（`plugin.json` 是数据，仍由 `manifestFile()` 生成）。
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
  /**
   * 清单 `menu.icon` 用的图标名（**由调用方算好**，见 {@link menuIconOf}）。
   *
   * 为什么不让模板硬编码一个名字：`plugin.json` 的 `menu.icon` 是**字符串**，宿主要在
   * 首帧把它换成组件，靠的是 `declared-icons.tsx` 里那张白名单；白名单外的名字一律先回退成
   * 通用图标（不报错，等插件真实注册后才覆盖）。所以这里按「宿主白名单 ∩ remixicon 真实导出」
   * 挑一枚，同一枚也用在 `renderer/plugin.tsx` 的 `ctx.use('menu').register()` 里（两处必须一致）。
   */
  menuIcon?: string
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

/** 清单 `menu.icon` 的**兜底图标名**（宿主白名单里的通用枚：没挑到就用它） */
const MENU_ICON_FALLBACK = 'RiPlugLine'

/**
 * 给这份草稿挑一枚「首帧就能显示」的菜单图标名。
 *
 * 两个条件必须同时成立：
 * 1. 名字在共享名单 `@shared/plugin/menu-icons` 里 —— 否则首帧是通用图标；
 * 2. 名字在宿主装的 `@remixicon/react` 里**真实存在** —— 否则运行期拿到 `undefined`，
 *    JSX 直接抛「Element type is invalid」白屏（工装会核对名单里的每一枚）。
 *
 * 同一枚名字还要用在 `renderer/plugin.tsx` 的 `ctx.use('menu').register({ icon })` 里：
 * 清单图标与真实注册不一致时，首帧与注册后会出现两个图标。
 *
 * 按 id 散列选（见 `pickDeclaredMenuIcon`）：所有草稿都用同一个图标时，侧栏里
 * 几份草稿长得一模一样，用户分不出谁是谁。
 */
export function menuIconOf(id?: string): string {
  try {
    return pickDeclaredMenuIcon(id ?? '') ?? MENU_ICON_FALLBACK
  } catch {
    return MENU_ICON_FALLBACK
  }
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
    ...extra
  }
  return JSON.stringify(manifest, null, 2) + '\n'
}

/** 各模板的清单附加字段（inject / routes / menu） */
function manifestExtra(template: WorkshopTemplate, vars: TemplateVars): Record<string, unknown> {
  const menu = {
    key: vars.id,
    labelKey: `${vars.id}.menu.title`,
    icon: vars.menuIcon ?? MENU_ICON_FALLBACK,
    order: 60
  }
  switch (template) {
    case 'panel':
    case 'tool':
      return { inject: ['settingsSection', 'i18n'] }
    case 'minimal':
      return { inject: ['appProvider'] }
    case 'page':
      return {
        inject: ['route', 'menu', 'i18n'],
        routes: [{ path: `/${vars.id}` }],
        menu
      }
    case 'full':
    default:
      return {
        inject: ['route', 'menu', 'settingsSection', 'i18n'],
        routes: [{ path: `/${vars.id}` }],
        menu
      }
  }
}

/**
 * 渲染一份草稿：模板文本资产 → `${vars.*}` 占位符替换 → 加上生成的 `plugin.json`。
 *
 * 菜单图标在这里统一定：清单字符串与渲染层注册的组件必须同一枚（`menuIconOf` 的口径见其注释）。
 */
export function renderTemplate(
  template: WorkshopTemplate,
  vars: TemplateVars
): Record<string, string> {
  const resolved: TemplateVars = { ...vars, menuIcon: vars.menuIcon ?? menuIconOf(vars.id) }
  const info = TEMPLATE_INFOS.find((item) => item.template === template)
  const tokens: Record<string, string> = {
    id: resolved.id,
    title: resolved.title,
    titleJson: jsonEscape(resolved.title),
    description: resolved.description,
    descriptionJson: jsonEscape(resolved.description),
    pascal: pascalOf(resolved.id),
    sqlName: sqlNameOf(resolved.id),
    toolName: toolNameOf(resolved.id),
    itemsToolName: toolNameOf(resolved.id, 'items'),
    menuIcon: resolved.menuIcon ?? MENU_ICON_FALLBACK,
    template,
    templateLabel: info?.label ?? template,
    templateDescription: info?.description ?? '',
    templateRegisters: info?.registers ?? '',
    mainKeys: resolved.hostMainKeys.length
      ? resolved.hostMainKeys.map((key) => '- `' + key + '`').join('\n')
      : '- （宿主当前没有可用的主进程模块）',
    uiKeys: resolved.hostUiKeys.length
      ? resolved.hostUiKeys.map((key) => '- `' + key + '`').join('\n')
      : '- （宿主当前没有可用的渲染层模块）'
  }

  const files: Record<string, string> = {}
  for (const file of renderTemplateFiles(template, tokens)) files[file.path] = file.body
  files['plugin.json'] = manifestFile(resolved, manifestExtra(template, resolved))
  return files
}
