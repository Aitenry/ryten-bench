import { protocol, net } from 'electron'
import { statSync } from 'fs'
import { extname } from 'path'
import { pathToFileURL } from 'url'
import logger from 'electron-log'
import { findExternalPlugin } from './scanner'
import { isEnabledPlugin } from './host'
import { hostUiBridgeSource, parseHostUiKey } from './host-ui-bridge'
import { resolvePluginRequest } from './protocol-routing'

/**
 * plugin:// 自定义协议：服务插件的静态文件（renderer.js/main 附属资源/图标）
 * 以及**渲染层宿主 UI 桥**（`plugin://host/ui.js?m=<key>`）。
 * 安全约束：
 * - 文件服务仅限「已发现且已启用」的插件目录；
 * - 路径解析后必须落在插件根目录内（防目录穿越）；
 * - 按扩展名提供正确 MIME（renderer.js 以 text/javascript 供 fetch+blob import）。
 *
 * 状态码契约（消费方按此判定，别改成「读不到就 500」）：缺失文件 = **404**。
 * 可选资源（`plugin.css` / 图标）靠它走「没有就静默跳过」；只有真实读取故障才是 5xx。
 *
 * 判定逻辑全在纯函数 `./protocol-routing.ts`（离线工装 `test/verify-plugin-protocol-404.mjs`
 * 直接跑它）；本文件只负责「按判定取文件 / 生成宿主 UI 桥 ESM」。
 */

const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.css': 'text/css',
  '.html': 'text/html',
  '.map': 'application/json'
}

/** 必须在 app ready 之前调用（standard+secure 使 fetch/import 可用） */
export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'plugin',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    }
  ])
}

/**
 * 该绝对路径是否是**可服务的文件**（目录 / 不存在的路径都算「没有这个文件」）。
 *
 * 为什么必须自己判而不是交给 `net.fetch`（2026-09-26 用户实测）：`net.fetch('file:///…')`
 * 取不到文件时是**抛异常**（`Error: net::ERR_FILE_NOT_FOUND`），不是返回 404 响应。于是
 * 缺失文件会掉进下面的 catch 被当成「读取失败 500 + warn」——内置插件包的 `plugin.css`
 * 本来就不随包分发（类名由宿主构建期 Tailwind 扫 `src/plugins/**` 编译进宿主 CSS），
 * 每次启用插件都在主日志里留一条带堆栈的假报错；消费方（`plugin-host/plugin-css.ts`）
 * 的 `res.ok` 判断也永远走不到，只能被自己的 catch 兜住。
 */
function isServableFile(abs: string): boolean {
  try {
    return statSync(abs).isFile()
  } catch {
    return false
  }
}

/** app ready 之后注册协议处理器 */
export function registerPluginProtocolHandler(): void {
  protocol.handle('plugin', async (request) => {
    const decision = resolvePluginRequest({
      url: request.url,
      bridgeKey: parseHostUiKey(pluginQuery(request.url)),
      deps: {
        pluginDir: (id) => findExternalPlugin(id)?.dir ?? null,
        // 停用状态不可访问任何文件。用 isEnabledPlugin（而不是「覆写非真即假」）：
        // 内置插件铺包后默认启用，用错默认值会让它们连自己的 renderer.mjs 都取不到（403）。
        isEnabled: (id) => isEnabledPlugin(id),
        exists: isServableFile
      }
    })

    if (decision.kind === 'bridge') {
      // 宿主 UI 桥：`plugin://host/ui.js?m=<key>` 由宿主生成 ESM（不是磁盘文件）。
      // 内容取决于**当前注册的宿主模块表**，所以必须由主进程现算。
      return new Response(hostUiBridgeSource(decision.key), {
        status: 200,
        headers: { 'content-type': 'text/javascript' }
      })
    }

    if (decision.kind === 'error') {
      // 诊断日志只在真正值得查的分支留声：目录穿越照旧 warn（安全事件），
      // 缺失文件（可选资源）降级到 debug——它每次装包都会发生，不该刷主日志。
      if (decision.reason === 'forbidden') {
        logger.warn(`[Plugins] plugin:// 目录穿越被拦截: ${request.url}`)
      } else if (decision.reason === 'not-a-file') {
        logger.debug(`[Plugins] plugin:// 文件不存在: ${request.url}`)
      }
      return new Response(decisionText(decision.reason), { status: decision.status })
    }

    try {
      const res = await net.fetch(pathToFileURL(decision.abs).toString())
      const mime = MIME[extname(decision.abs).toLowerCase()] ?? 'application/octet-stream'
      return new Response(res.body, { status: res.status, headers: { 'content-type': mime } })
    } catch (err) {
      logger.warn(`[Plugins] plugin:// 读取失败: ${decision.abs}`, err)
      return new Response('read failed', { status: 500 })
    }
  })
}

/** 从 `plugin://…` URL 取 query 部分；URL 非法时返回空串（路由会按 400 处理） */
function pluginQuery(url: string): string {
  try {
    return new URL(url).search
  } catch {
    return ''
  }
}

/** 错误响应正文：只描述原因，不回显绝对路径（避免把磁盘结构暴露给渲染层） */
function decisionText(reason: string): string {
  switch (reason) {
    case 'bad-url':
      return 'bad plugin url'
    case 'bad-bridge-path':
      return 'host module not found'
    case 'missing-key':
      return 'missing ?m=<key>'
    case 'disabled':
      return 'plugin disabled'
    case 'forbidden':
      return 'forbidden'
    default:
      return 'not found'
  }
}
