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
 * plugin:// custom protocol: serves a plugin's static files (renderer.js / main auxiliary
 * resources / icons) and the **renderer host UI bridge** (`plugin://host/ui.js?m=<key>`).
 * Security constraints:
 * - file serving is limited to "discovered and enabled" plugin directories;
 * - after resolution the path must fall inside the plugin root (traversal guard);
 * - serve the correct MIME per extension (renderer.js is served as text/javascript for
 *   fetch+blob import).
 *
 * Status code contract (consumers decide on it; do not change it to "500 when unreadable"):
 * missing file = **404**. Optional resources (`plugin.css` / icons) rely on it to "silently skip
 * when absent"; only a real read failure is a 5xx.
 *
 * All decision logic lives in the pure function `./protocol-routing.ts` (offline tooling
 * `test/verify-plugin-protocol-404.mjs` runs it directly); this file only handles "fetch the file
 * per the decision / generate the host UI bridge ESM".
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

/** Must be called before app ready (standard+secure makes fetch/import work) */
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
 * Whether this absolute path is a **servable file** (a directory or a nonexistent path counts as
 * "no such file").
 *
 * Why it must be checked here instead of leaving it to `net.fetch` (measured by the user on
 * 2026-09-26): `net.fetch('file:///…')` **throws** when the file cannot be fetched
 * (`Error: net::ERR_FILE_NOT_FOUND`) instead of returning a 404 response. Missing files would then
 * fall into the catch below and be treated as "read failed 500 + warn" - optional resources
 * (`plugin.css` / icons) are allowed to be absent, so every plugin load left a fake error with a
 * stack in the main log, and the consumer's (`plugin-host/plugin-css.ts`) `res.ok` check could
 * never be reached, so only its own catch could absorb it.
 */
function isServableFile(abs: string): boolean {
  try {
    return statSync(abs).isFile()
  } catch {
    return false
  }
}

/** Register the protocol handler after app ready */
export function registerPluginProtocolHandler(): void {
  protocol.handle('plugin', async (request) => {
    const decision = resolvePluginRequest({
      url: request.url,
      bridgeKey: parseHostUiKey(pluginQuery(request.url)),
      deps: {
        pluginDir: (id) => findExternalPlugin(id)?.dir ?? null,
        // A disabled plugin cannot access any file. Use isEnabledPlugin (rather than "override is
        // just truthy or not"): built-in plugin packages default to enabled after staging, and a
        // wrong default would make them unable to fetch even their own renderer.mjs (403).
        isEnabled: (id) => isEnabledPlugin(id),
        exists: isServableFile
      }
    })

    if (decision.kind === 'bridge') {
      // Host UI bridge: `plugin://host/ui.js?m=<key>` is generated as ESM by the host (not a file on disk).
      // The content depends on the **currently registered host module table**, so it must be
      // computed on the fly by the main process.
      return new Response(hostUiBridgeSource(decision.key), {
        status: 200,
        headers: { 'content-type': 'text/javascript' }
      })
    }

    if (decision.kind === 'error') {
      // Diagnostic logs speak only on the branches really worth checking: path traversal still
      // warns (security event), missing files (optional resources) drop to debug - it happens on
      // every package install and should not flood the main log.
      if (decision.reason === 'forbidden') {
        logger.warn(`[Plugins] plugin:// path traversal blocked: ${request.url}`)
      } else if (decision.reason === 'not-a-file') {
        logger.debug(`[Plugins] plugin:// file not found: ${request.url}`)
      }
      return new Response(decisionText(decision.reason), { status: decision.status })
    }

    try {
      const res = await net.fetch(pathToFileURL(decision.abs).toString())
      const mime = MIME[extname(decision.abs).toLowerCase()] ?? 'application/octet-stream'
      return new Response(res.body, { status: res.status, headers: { 'content-type': mime } })
    } catch (err) {
      logger.warn(`[Plugins] plugin:// read failed: ${decision.abs}`, err)
      return new Response('read failed', { status: 500 })
    }
  })
}

/** Get the query part from a `plugin://…` URL; return an empty string when the URL is invalid (routing treats it as 400) */
function pluginQuery(url: string): string {
  try {
    return new URL(url).search
  } catch {
    return ''
  }
}

/** Error response body: describes only the reason, never echoes an absolute path (avoid exposing the disk structure to the renderer) */
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
