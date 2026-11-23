import { app } from 'electron'
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
