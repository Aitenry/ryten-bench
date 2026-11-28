import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { PLUGIN_PURGE } from '@host/main/plugins/contributions'
import type { MainPluginContext } from './context'

/** Where settings are persisted (under userData, keeping the user's workspace clean) */
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
      // No file on first run: keep the defaults
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

  // Only reached when "delete data too" is checked on uninstall: remove this settings file
  ctx.contribute(PLUGIN_PURGE, {
    label: '本插件的设置（plugin-state/${vars.id}.json）',
    run: () => {
      if (settingsFile) fs.rmSync(settingsFile, { force: true })
    }
  })
}
