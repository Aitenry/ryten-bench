import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import * as z from 'zod/v4'
import type { ToolInfo } from '../../../../main/plugins/tool-contract'
import { TEMPLATE_INFOS } from '../workshop/templates'
import {
  build,
  buildStale,
  createDraftFromTemplate,
  disable,
  draftDetail,
  draftSummary,
  exportZip,
  lastReport,
  listDraftSummaries,
  metaOf,
  publish,
  readFile,
  removeDraft,
  removeFile,
  unpublish,
  verify,
  workshopState,
  writeFile
} from '../workshop/service'
import { formatReport } from '../workshop/verify'
import type { WorkshopBuildInfo, WorkshopReport } from '../../shared/workshop'

/**
 * 插件工坊的 AI 工具（4 个）——「和助手对话，把插件做出来」的那条链路。
 *
 * 工具分工刻意按**工作流的四步**切，而不是把十几个动作塞进一个工具：
 *
 * | 工具 | 语义 |
 * |------|------|
 * | `plugin_draft` | 草稿与文件（create / list / tree / read / write / remove） |
 * | `plugin_build` | 构建 + 静态体检（宿主说明符、第三方依赖、语法） |
 * | `plugin_verify` | 自动化验收（构建 + 十项检查电池，含真实装载冒烟） |
 * | `plugin_publish` | 装进应用并启用 / 停用 / 卸载 / 导出 zip |
 *
 * 这样模型在每一步都拿到**针对那一步的诊断**：构建失败给的是 esbuild 的文件:行:列，
 * 验收失败给的是逐项 PASS/FAIL 与「建议怎么改」。把四步合成一个动作，
 * 模型就只能看到一坨混合错误，改起来全靠猜。
 *
 * 归属：工坊是 harness 自己的能力（虚拟工作区之外的第二个「写作对象」），
 * 因此走 `tools/builders.ts` 的**本地工具**注册表，而不是 `harness.tool` 贡献点
 * （那是给别的插件贡献工具的入口）。
 */

/** 工具在设置页下拉里的兜底元数据（真正下发时由 main/i18n 按界面语言覆盖） */
export const workshopToolInfos: ToolInfo[] = [
  {
    name: 'plugin_draft',
    label: '插件草稿',
    description: '新建插件草稿、读写草稿里的文件',
    icon: 'RiFileEditLine',
    color: '#722ed1'
  },
  {
    name: 'plugin_build',
    label: '构建插件',
    description: '把草稿构建成可安装的插件包并做静态体检',
    icon: 'RiHammerLine',
    color: '#fa8c16'
  },
  {
    name: 'plugin_verify',
    label: '验收插件',
    description: '跑自动化验收电池（含真实装载冒烟），确认插件可用',
    icon: 'RiShieldCheckLine',
    color: '#13c2c2'
  },
  {
    name: 'plugin_publish',
    label: '发布插件',
    description: '把插件装进应用并启用 / 停用 / 卸载 / 导出',
    icon: 'RiUploadCloud2Line',
    color: '#52c41a'
  }
]

/** 工坊没接线时的统一回复（不抛错：抛错会让整轮对话崩，模型也拿不到可执行的下一步） */
function notReady(): string | null {
  const state = workshopState()
  if (state.ready) return null
  return (
    '插件工坊当前不可用：宿主没有注入工坊根目录（AI 助手插件可能刚被停用/重载）。' +
    '请让用户在 设置 → 插件 里确认「AI 助手」处于启用状态后重试。'
  )
}

/** 草稿摘要 → 一行文本 */
function draftLine(item: ReturnType<typeof draftSummary>): string {
  const flags: string[] = [item.template, `v${item.version}`]
  if (item.built) flags.push('已构建')
  if (item.installed) flags.push(item.enabled ? '已安装·启用中' : '已安装·已停用')
  if (item.lastReport) {
    flags.push(
      item.lastReport.ok
        ? '验收通过'
        : `验收未通过（${item.lastReport.failed}/${item.lastReport.total} 项失败）`
    )
  }
  return `- ${item.id}（${item.title}）[${flags.join('，')}] ${item.fileCount} 个文件`
}

/** 构建结果 → 给模型看的文本 */
function buildText(info: WorkshopBuildInfo): string {
  if (!info.ok) {
    return (
      `构建失败（${info.durationMs}ms）：\n` +
      info.errors.map((e) => `- ${e}`).join('\n') +
      '\n下一步：按上面的文件:行:列改代码；宿主说明符清单见草稿里的 WORKSHOP.md。'
    )
  }
  const totalKb = Math.round(info.files.reduce((sum, f) => sum + f.size, 0) / 1024)
  const lines = [
    `构建成功（${info.durationMs}ms）：${info.files.length} 个文件 / ${totalKb}KB`,
    `产物：${info.files.map((f) => `${f.path} ${Math.round(f.size / 1024)}KB`).join('、')}`
  ]
  if (info.css) {
    lines.push(
      `样式：${info.css.mode} 模式，扫到 ${info.css.candidates} 个候选，plugin.css ${info.css.bytes}B` +
        (info.css.missing.length > 0 ? `；缺规则：${info.css.missing.join('、')}` : '')
    )
  }
  if (info.warnings.length > 0)
    lines.push('警告：\n' + info.warnings.map((w) => `- ${w}`).join('\n'))
  lines.push('下一步：plugin_verify 跑验收（含真实装载冒烟），通过后 plugin_publish 装进应用。')
  return lines.join('\n')
}

/** 发布后：插件贡献了 AI 工具时，提醒用户去启用 */
function contributionHint(report: WorkshopReport | null): string {
  const tools = (report?.main?.contributions ?? [])
    .filter((c) => c.key === 'harness.tool')
    .flatMap((c) => c.labels)
  if (tools.length === 0) return ''
  return (
    `\n本插件给助手贡献了工具：${tools.join('、')}。` +
    `用户需要到「设置 → 智能体 → 工具」里勾选它们，下一轮对话才能调用。`
  )
}

// ============================================================================
// plugin_draft
// ============================================================================

const createDraftTool = (): StructuredToolInterface =>
  tool(
    async (input: {
      action: 'create' | 'list' | 'tree' | 'read' | 'write' | 'remove-file' | 'remove'
      id?: string
      path?: string
      content?: string
      title?: string
      template?: string
      description?: string
      overwrite?: boolean
      css?: string
    }): Promise<string> => {
      const missing = notReady()
      if (missing) return missing
      try {
        switch (input.action) {
          case 'create': {
            if (!input.id) return '缺少 id（插件 id，小写 kebab，例如 pomodoro-timer）'
            const result = createDraftFromTemplate({
              id: input.id,
              title: input.title,
              template: (input.template as never) ?? 'page',
              description: input.description,
              css: input.css as never,
              overwrite: input.overwrite
            })
            return (
              `${result.overwritten ? '已按模板重建' : '已创建'}草稿 '${result.meta.id}'（模板 ${result.meta.template}）\n` +
              `目录：${result.dir}\n` +
              `文件：${result.files.join('、')}\n` +
              `下一步：读 WORKSHOP.md 了解契约 → 改写 renderer/main 里的文件 → plugin_build。\n` +
              `提示：模板里已经有一份能跑通的骨架与冒烟用例，先在它上面改，不要从零重写。`
            )
          }
          case 'list': {
            const items = listDraftSummaries()
            if (items.length === 0) {
              return `工坊里还没有草稿。可用模板：${TEMPLATE_INFOS.map((t) => `${t.template}（${t.label}：${t.description}）`).join('；')}`
            }
            return `工坊里有 ${items.length} 份草稿：\n${items.map(draftLine).join('\n')}`
          }
          case 'tree': {
            if (!input.id) return '缺少 id'
            const detail = draftDetail(input.id)
            return (
              `草稿 '${input.id}'：${detail.files.length} 个文件\n` +
              detail.files.map((f) => `- ${f.path}（${f.size}B）`).join('\n') +
              `\n目录：${detail.dir}\n样式模式：${detail.css}`
            )
          }
          case 'read': {
            if (!input.id || !input.path) return '缺少 id 或 path'
            return readFile(input.id, input.path)
          }
          case 'write': {
            if (!input.id || !input.path) return '缺少 id 或 path'
            if (typeof input.content !== 'string') return '缺少 content'
            const file = writeFile(input.id, input.path, input.content)
            return `已写入 ${input.id}/${file.path}（${file.size}B）。改完记得 plugin_build 重新构建。`
          }
          case 'remove-file': {
            if (!input.id || !input.path) return '缺少 id 或 path'
            removeFile(input.id, input.path)
            return `已删除 ${input.id}/${input.path}`
          }
          case 'remove': {
            if (!input.id) return '缺少 id'
            removeDraft(input.id)
            return `已删除草稿 '${input.id}'（含构建产物与验收报告；若它已装进应用，插件本体不受影响，需要的话用 plugin_publish 的 uninstall 卸掉）`
          }
          default:
            return `未知 action：${String(input.action)}`
        }
      } catch (err) {
        return `plugin_draft 失败：${(err as Error).message}`
      }
    },
    {
      name: 'plugin_draft',
      description:
        'Author a plugin draft inside the app plugin workshop.\n' +
        '  Commands:\n' +
        '    create - Create a draft from a template; requires id (lowercase kebab), optional title, template (page|panel|tool|minimal), description, overwrite\n' +
        '    list - List drafts with their build/install/verify status\n' +
        '    tree - List files of a draft; requires id\n' +
        '    read - Read a draft file; requires id, path (e.g. renderer/plugin.tsx)\n' +
        '    write - Create or overwrite a draft file; requires id, path, content (full file text)\n' +
        '    remove-file - Delete one draft file; requires id, path\n' +
        '    remove - Delete the whole draft; requires id\n' +
        '  A draft is a real plugin source tree: plugin.json + main/index.ts + renderer/plugin.tsx.\n' +
        '  Every draft ships a WORKSHOP.md with the exact host contract (mount points, host module keys, smoke cases) - read it before writing code.\n' +
        '  After editing, run plugin_build, then plugin_verify, then plugin_publish.',
      schema: z.object({
        action: z
          .enum(['create', 'list', 'tree', 'read', 'write', 'remove-file', 'remove'])
          .describe('要执行的动作'),
        id: z.string().optional().describe('插件 id（小写 kebab，= 目录名 = plugin.json.id）'),
        path: z.string().optional().describe('草稿内相对路径，如 renderer/plugin.tsx'),
        content: z.string().optional().describe('写文件时的完整文件内容'),
        title: z.string().optional().describe('展示名（create 时用）'),
        template: z
          .enum(['page', 'panel', 'tool', 'minimal'])
          .optional()
          .describe('模板：page=页面+菜单 / panel=设置页 / tool=给助手加工具 / minimal=空骨架'),
        description: z.string().optional().describe('插件说明（写入 plugin.json）'),
        overwrite: z.boolean().optional().describe('create 时是否覆盖已存在的草稿（默认 false）'),
        css: z
          .enum(['auto', 'file', 'off'])
          .optional()
          .describe(
            '样式模式：auto=工坊用 Tailwind 生成 / file=用草稿里的 plugin.css / off=不要样式表'
          )
      })
    }
  )

// ============================================================================
// plugin_build
// ============================================================================

const buildTool = (): StructuredToolInterface =>
  tool(
    async (input: { id: string; dev?: boolean }): Promise<string> => {
      const missing = notReady()
      if (missing) return missing
      const info = await build(input.id, { dev: input.dev })
      return buildText(info)
    },
    {
      name: 'plugin_build',
      description:
        'Build a plugin draft into an installable package (plugin.json + main.cjs + renderer.mjs + chunks + plugin.css) ' +
        'and statically audit it: manifest, host module keys, third-party imports, relative chunk specifiers, CSS coverage.\n' +
        'Use it after every source edit; it returns esbuild diagnostics with file:line:column.',
      schema: z.object({
        id: z.string().describe('插件 id'),
        dev: z.boolean().optional().describe('dev 模式：不压缩 + inline sourcemap（默认 false）')
      })
    }
  )

// ============================================================================
// plugin_verify
// ============================================================================

const verifyTool = (): StructuredToolInterface =>
  tool(
    async (input: { id: string; probe?: boolean }): Promise<string> => {
      const missing = notReady()
      if (missing) return missing
      const report = await verify(input.id, { probeRenderer: input.probe })
      const text = [formatReport(report)]
      if (!report.ok) {
        text.push('验收未通过：按上面 FAIL 项的建议改代码，然后重新 plugin_verify。')
      } else {
        text.push('验收通过：可以用 plugin_publish 装进应用并启用。')
      }
      const stale = buildStale(input.id)
      if (stale) text.push('注意：产物比源码旧（验收后草稿又改过），发布前重新验收一次。')
      return text.join('\n')
    },
    {
      name: 'plugin_verify',
      description:
        'Run the automated acceptance battery on a plugin draft: rebuild, then check manifest, entry files, plugin identity, ' +
        'host runtime/UI contract, chunk specifiers, real main-process smoke (loads main.cjs and drives install(ctx), plus the ' +
        "draft's own workshop.smoke.mjs cases), renderer load probe, CSS coverage and risky API usage.\n" +
        'This is how you guarantee the plugin actually works before publishing - always run it before plugin_publish.',
      schema: z.object({
        id: z.string().describe('插件 id'),
        probe: z
          .boolean()
          .optional()
          .describe('是否跑渲染层实时探针（默认跑；没有可用界面时该检查会显示 SKIP）')
      })
    }
  )

// ============================================================================
// plugin_publish
// ============================================================================

const publishTool = (): StructuredToolInterface =>
  tool(
    async (input: {
      id: string
      action: 'install' | 'disable' | 'uninstall' | 'export'
    }): Promise<string> => {
      const missing = notReady()
      if (missing) return missing
      try {
        switch (input.action) {
          case 'install': {
            const report = lastReport(input.id)
            if (!report || !report.ok) {
              return (
                `拒绝安装：'${input.id}' 还没有一次通过的验收。先跑 plugin_verify（构建 + 十项检查），` +
                `全绿再安装——没验过的插件装上去大概率是「菜单不出现 / 调用报无处理器」。`
              )
            }
            if (buildStale(input.id)) {
              return `拒绝安装：产物比源码旧（验收之后草稿又被改过）。先重新 plugin_verify。`
            }
            const result = await publish(input.id)
            return (
              `${result.upgraded ? '已升级并启用' : '已安装并启用'}插件 '${result.id}' v${result.version}（${result.files} 个文件）\n` +
              `落地目录：${result.dest}\n` +
              `界面应该马上出现它的菜单/设置页；如果没出现，让用户看一眼主日志的 [Plugins] 行。` +
              contributionHint(report)
            )
          }
          case 'disable':
            disable(input.id)
            return `已停用插件 '${input.id}'（目录与数据都还在，可在 设置 → 插件 里重新启用）`
          case 'uninstall':
            unpublish(input.id)
            return `已卸载插件 '${input.id}'（删掉插件代码；数据未动）`
          case 'export': {
            const result = await exportZip(input.id)
            return `已导出 ${result.files.length} 个文件到：${result.file}（${Math.round(result.bytes / 1024)}KB）。用户可以用 设置 → 插件 →「从本地安装」选这个 zip 装到别的机器上。`
          }
          default:
            return `未知 action：${String(input.action)}`
        }
      } catch (err) {
        return `plugin_publish 失败：${(err as Error).message}`
      }
    },
    {
      name: 'plugin_publish',
      description:
        'Publish a verified plugin draft into the running app, or manage an already published one.\n' +
        '  install - Install (or upgrade) the built package into userData/plugins/<id> and enable it immediately; ' +
        'refused unless the latest verification passed and the build is not stale\n' +
        '  disable - Turn the plugin off but keep its files and data\n' +
        '  uninstall - Remove the plugin code (data is kept)\n' +
        '  export - Write a distributable zip of the built package',
      schema: z.object({
        id: z.string().describe('插件 id'),
        action: z.enum(['install', 'disable', 'uninstall', 'export']).describe('要执行的动作')
      })
    }
  )

/** 四个工具（`tools/builders.ts` 的本地工具表按名字取用） */
export const workshopToolBuilders: Record<string, () => StructuredToolInterface> = {
  plugin_draft: createDraftTool,
  plugin_build: buildTool,
  plugin_verify: verifyTool,
  plugin_publish: publishTool
}

/** 草稿元数据里的模板名（工具回复里用） */
export function draftTemplateOf(id: string): string {
  return metaOf(id)?.template ?? 'minimal'
}
