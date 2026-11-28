import { tool, type StructuredToolInterface } from '../../ai/tools'
import { createHash } from 'node:crypto'
import * as z from 'zod/v4'
import type { ToolInfo } from '../../plugins/tool-contract'
import { TEMPLATE_INFOS } from '../../workshop/templates'
import {
  build,
  buildStale,
  createDraftFromTemplate,
  disable,
  dirOf,
  draftDetail,
  draftSummary,
  enable,
  exportZip,
  lastReport,
  listDraftSummaries,
  metaOf,
  publish,
  publishGate,
  readFile,
  removeDraft,
  removeFile,
  unpublish,
  verify,
  workshopState,
  writeFile
} from '../../workshop/service'
import { formatReport } from '../../workshop/verify'
import {
  clearActiveWorkspaceIfRemoved,
  clearRememberedPluginContent
} from '../../workshop/active-workspace'
import type {
  WorkshopBuildInfo,
  WorkshopRendererProbe,
  WorkshopReport
} from '../../../shared/harness/workshop'

/**
 * The plugin workshop's AI tools (4 of them) — the "chat with the assistant and build the plugin"
 * pipeline.
 *
 * The tools are deliberately split by the **four workflow steps** instead of squeezing a dozen
 * actions into one tool:
 *
 * | Tool | Semantics |
 * |------|-----------|
 * | `plugin_draft` | Draft and files (create / list / tree / read / write / remove) |
 * | `plugin_build` | Build + static health check (host specifiers, third-party deps, syntax) |
 * | `plugin_verify` | Automated acceptance (build + full check battery: real-load smoke / style scoping / host safety) |
 * | `plugin_publish` | Install into the app and enable / re-enable / disable / uninstall / export zip |
 *
 * This way the model gets **diagnostics for that step** at every stage: a build failure reports
 * esbuild's file:line:column, and an acceptance failure reports per-item PASS/FAIL plus "how to
 * fix it". Merging the four steps into one action would leave the model with a pile of mixed
 * errors and make fixing a guessing game.
 *
 * Ownership: the workshop is the harness's own capability (a second "authoring target" outside
 * the virtual workspace), so it goes through the **local tool** registry in `tools/builders.ts`,
 * not the `harness.tool` contribution point (which is the entry for other plugins to contribute
 * tools).
 *
 * Mount timing (user requirement 2026-09-29 "don't require selecting tools here before they are
 * registered"): these 4 are **mode tools**, absent from the "Settings -> Assistant -> Default
 * tools" picklist and never enabled by user checkboxes — they are mounted automatically from the
 * turn that switches to **plugin mode** (detection = the session's memory scope is
 * `plugin:<id>`; implemented in `shared/mcp.ts`'s PLUGIN_MODE_TOOL_NAMES and the two places in
 * `ipc/harness.ts` that assemble tools by `pluginMode`).
 *
 * Also part of plugin mode is the plugin center's `plugin_release` (publish a version; see
 * `tools/harness/lattice.ts`): that one is "publish the version to the plugin center", as opposed
 * to this file's `plugin_publish` (install into the local app), and it is mounted only when
 * **signed in** (`LATTICE_MODE_TOOL_NAMES` + `signedIn` in `effectiveMainAgentTools`).
 */

/** Fallback metadata for the settings-page dropdown (main/i18n overrides it by UI language when actually sent) */
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
    description: '把插件装进应用并启用 / 重新启用 / 停用 / 卸载 / 导出',
    icon: 'RiUploadCloud2Line',
    color: '#52c41a'
  }
]

/** Unified reply when the workshop is not wired up (no throw: throwing would crash the whole turn and leave the model no actionable next step) */
function notReady(): string | null {
  const state = workshopState()
  if (state.ready) return null
  return (
    '插件工坊当前不可用：宿主没有注入工坊根目录（AI 助手插件可能刚被停用/重载）。' +
    '请让用户在 设置 → 插件 里确认「AI 助手」处于启用状态后重试。'
  )
}

/** Draft summary -> a single line of text */
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

/** Build result -> text for the model */
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

/** After publishing: when the plugin contributes AI tools, remind the user to enable them */
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

/** Renderer probe result -> one readable conclusion (used by both install and verify replies) */
function probeLine(probe: WorkshopRendererProbe): string {
  const registrations =
    probe.registrations && probe.registrations.length > 0
      ? `（注册项：${probe.registrations.join('、')}）`
      : ''
  if (probe.status === 'pass') return `渲染层探针：通过${registrations}`
  if (probe.status === 'skip') {
    return `渲染层探针：跳过（${probe.detail ?? '当前没有可用界面'}）——打开界面后重跑验收可覆盖`
  }
  return `渲染层探针：失败（${probe.detail ?? '未知原因'}）`
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
              // Defaults to full: a single skeleton already includes the page + settings page +
              // AI tool (user requirement: "by default include everything")
              template: (input.template as never) ?? 'full',
              description: input.description,
              css: input.css as never,
              overwrite: input.overwrite
            })
            return (
              `${result.overwritten ? '已按模板重建' : '已创建'}草稿 '${result.meta.id}'（模板 ${result.meta.template}）\n` +
              `目录：${result.dir}\n` +
              (result.backupDir ? `旧草稿已备份到：${result.backupDir}\n` : '') +
              `文件：${result.files.join('、')}\n` +
              `下一步：读 WORKSHOP.md 了解契约 → 按需要删掉骨架里用不上的部分 → plugin_build。\n` +
              `提示：默认模板 'full' 已经把页面/设置页/AI 工具/事件推送/卸载清数据都摆好了，` +
              `在它上面删比从零拼装可靠——不要重写整个骨架。`
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
            // Include a content digest: different content with the same path and size is still
            // recognized as progress by the anti-loop guard
            const contentDigest = createHash('sha1')
              .update(input.content, 'utf-8')
              .digest('hex')
              .slice(0, 8)
            return (
              `已写入 ${input.id}/${file.path}（${file.size}B，sha ${contentDigest}）。` +
              `下一步：plugin_build → plugin_verify。每次改完源码都要重新验收——` +
              `发布闸门按源码指纹核对，只重新构建不算。`
            )
          }
          case 'remove-file': {
            if (!input.id || !input.path) return '缺少 id 或 path'
            removeFile(input.id, input.path)
            return `已删除 ${input.id}/${input.path}`
          }
          case 'remove': {
            if (!input.id) return '缺少 id'
            let removedDir = ''
            try {
              removedDir = dirOf(input.id)
            } catch {
              // No plugins path configured: the delete itself fails with a readable error
            }
            removeDraft(input.id)
            if (removedDir) clearActiveWorkspaceIfRemoved(removedDir)
            clearRememberedPluginContent(input.id)
            return `已删除草稿 '${input.id}'（含它的源码目录、构建产物与验收报告；若它已装进应用，插件本体不受影响，需要的话用 plugin_publish 的 uninstall 卸掉）`
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
        '    create - Create a draft; requires id (lowercase kebab), optional title, template (defaults to full = page + settings page + AI tool + events + purge), description, overwrite\n' +
        '    list - List drafts with their build/install/verify status\n' +
        '    tree - List files of a draft; requires id\n' +
        '    read - Read a draft file; requires id, path (e.g. renderer/plugin.tsx)\n' +
        '    write - Create or overwrite a draft file; requires id, path, content (full file text)\n' +
        '    remove-file - Delete one draft file; requires id, path\n' +
        '    remove - Delete the whole draft (its folder under the configured plugins path included); requires id\n' +
        '  Drafts live under a plugins folder the USER configures (no default): if create/list reports that no ' +
        'plugins path is configured, ask the user to pick one in Settings -> Assistant -> Plugin Workshop.\n' +
        '  A draft is a real plugin source tree: plugin.json + main/index.ts + renderer/plugin.tsx.\n' +
        '  Every draft ships a WORKSHOP.md with the exact host contract (mount points, host module keys, smoke cases) - read it before writing code.\n' +
        '  After every source edit, run plugin_build, then plugin_verify, then plugin_publish install. ' +
        'The publish gate compares a source fingerprint: a report produced before your latest edit is not reusable, ' +
        'and rebuilding without re-verifying is not enough.',
      schema: z.object({
        action: z
          .enum(['create', 'list', 'tree', 'read', 'write', 'remove-file', 'remove'])
          .describe('要执行的动作'),
        id: z.string().optional().describe('插件 id（小写 kebab，= 目录名 = plugin.json.id）'),
        path: z.string().optional().describe('草稿内相对路径，如 renderer/plugin.tsx'),
        content: z.string().optional().describe('写文件时的完整文件内容'),
        title: z.string().optional().describe('展示名（create 时用）'),
        template: z
          .enum(['full', 'page', 'panel', 'tool', 'minimal'])
          .optional()
          .describe(
            "Skeleton kind; defaults to 'full' (page + settings page + AI tool + events + purge). " +
              'Narrow ones: page / panel / tool / minimal'
          ),
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
      try {
        const info = await build(input.id, { dev: input.dev })
        return buildText(info)
      } catch (err) {
        // buildDraft itself does not throw; this catches surprises such as metadata rewrite or
        // file I/O
        return `plugin_build 失败：${(err as Error).message}`
      }
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
      let report: WorkshopReport
      try {
        report = await verify(input.id, { probeRenderer: input.probe })
      } catch (err) {
        // File/permission/host surprises during verification: give the model a readable reason
        // instead of turning the whole tool call into a framework error
        return `plugin_verify 失败：${(err as Error).message}`
      }
      const text = [formatReport(report)]
      if (!report.ok) {
        text.push('验收未通过：按上面 FAIL 项的建议改代码，然后重新 plugin_verify。')
      } else {
        text.push('验收通过：可以 plugin_publish install 装进应用并启用。')
        // The pre-install probe can only SKIP (the plugin is not installed yet); make sure the
        // model/user knows this item was not missed
        if (report.renderer && report.renderer.status !== 'pass') {
          text.push(
            `说明：${probeLine(report.renderer)}。发布时会自动在真界面上复验一次，` +
              `失败会自动回滚卸载——所以这里 SKIP 不影响安装。`
          )
        }
      }
      const stale = buildStale(input.id)
      if (stale) {
        text.push('注意：产物比源码旧（验收过程中源码又被改过），发布前重新 plugin_verify。')
      }
      return text.join('\n')
    },
    {
      name: 'plugin_verify',
      description:
        'Run the automated acceptance battery on a plugin draft: rebuild, then check manifest, entry files, plugin identity, ' +
        'host runtime/UI contract, chunk specifiers, real main-process smoke (loads main.cjs and drives install(ctx), plus the ' +
        "draft's own workshop.smoke.mjs cases and cleanup), renderer load probe, CSS coverage/scope and host-safety " +
        '(process.exit / process.abort / direct ipcMain are fatal).\n' +
        'This is how you guarantee the plugin actually works without breaking the host - always run it before plugin_publish.',
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
      action: 'install' | 'enable' | 'disable' | 'uninstall' | 'export'
    }): Promise<string> => {
      const missing = notReady()
      if (missing) return missing
      try {
        switch (input.action) {
          case 'install': {
            // The gate only checks that all three pieces of evidence match the **current sources**:
            // verification passed + report fingerprint + artifact fingerprint. The specific reason
            // (not verified / verification failed / sources edited after verification / stale
            // artifact) is given by the service as actionable text.
            const gate = publishGate(input.id)
            if (!gate.ready) return gate.detail
            const result = await publish(input.id)
            const lines = [
              `${result.upgraded ? '已升级并启用' : '已安装并启用'}插件 '${result.id}' v${result.version}（${result.files} 个文件）`,
              `落地目录：${result.dest}`
            ]
            if (result.rendererProbe) {
              lines.push(probeLine(result.rendererProbe))
              // The publish flow re-checks in the real UI right after installing; the conclusion has
              // been written back to the latest verification report
              if (result.rendererProbe.status !== 'fail') {
                lines.push('最近一次验收报告已同步为发布后复验结果（renderer.probe）。')
              }
            }
            if (!result.enabled) {
              lines.push(
                '警告：安装完成但启用状态未生效——请让用户到 设置 → 插件 里手动启用，并查看主日志的 [Plugins] 行。'
              )
            }
            lines.push(
              '界面应该马上出现它的菜单/设置页；如果没出现，让用户看一眼主日志的 [Plugins] 行。'
            )
            return lines.join('\n') + contributionHint(lastReport(input.id))
          }
          case 'enable': {
            const result = await enable(input.id)
            const lines = [`已启用插件 '${result.id}'`]
            if (result.rendererProbe) lines.push(probeLine(result.rendererProbe))
            if (!result.enabled) {
              lines.push('警告：启用状态未生效——请检查主日志的 [Plugins] 行。')
            } else {
              lines.push('界面应该马上出现它的菜单/设置页。')
            }
            return lines.join('\n')
          }
          case 'disable':
            disable(input.id)
            return `已停用插件 '${input.id}'（目录与数据都还在，可用 plugin_publish enable 或面板开关重新启用）`
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
        '  install - Install (or upgrade) the built package into userData/plugins/<id>, enable it immediately, then re-check ' +
        'the renderer in the real UI (rolls back automatically if that fails). Refused unless the latest verification passed ' +
        'AND both the verification report and the built package were made from the current sources; when refused, follow the ' +
        'stated reason (usually plugin_verify again) instead of retrying the same install call\n' +
        '  enable - Turn an already installed plugin back on and re-check it in the real UI (auto-disables it again if that fails)\n' +
        '  disable - Turn the plugin off but keep its files and data\n' +
        '  uninstall - Remove the plugin code (data is kept)\n' +
        '  export - Write a distributable zip of the built package',
      schema: z.object({
        id: z.string().describe('插件 id'),
        action: z
          .enum(['install', 'enable', 'disable', 'uninstall', 'export'])
          .describe('要执行的动作')
      })
    }
  )

/** The four tools (the local tool table in `tools/builders.ts` looks them up by name) */
export const workshopToolBuilders: Record<string, () => StructuredToolInterface> = {
  plugin_draft: createDraftTool,
  plugin_build: buildTool,
  plugin_verify: verifyTool,
  plugin_publish: publishTool
}

/** Template name from the draft metadata (used in tool replies) */
export function draftTemplateOf(id: string): string {
  return metaOf(id)?.template ?? 'minimal'
}
