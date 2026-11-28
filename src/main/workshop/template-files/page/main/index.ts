import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { PLUGIN_PURGE } from '@host/main/plugins/contributions'
import type { MainPluginContext } from './context'

/**
 * Main-process entry: install(ctx) must be **reversible** - everything registered hangs off
 * ctx, and the host rolls it all back at once when the plugin is disabled or uninstalled
 * (effects run LIFO).
 *
 * Data lives in userData/plugin-state/${vars.id}.json (not in the workspace, which is the
 * user's project directory), and the PLUGIN_PURGE contribution declares what gets removed when
 * "delete data" is checked during uninstall - the host's uninstall confirmation shows the label
 * text to the user verbatim.
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
  // effect: registers how to initialize and how to undo. Writing the file needs the directory, so it lives in the effect.
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

  // Only reached when "also delete this plugin's data" is checked during uninstall (the plugin is still loaded at that point)
  ctx.contribute(PLUGIN_PURGE, {
    label: '保存的内容（plugin-state/${vars.id}.json）',
    run: () => {
      if (stateFile) fs.rmSync(stateFile, { force: true })
    }
  })
}
