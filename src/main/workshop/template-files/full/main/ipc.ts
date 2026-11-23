import * as fs from 'fs'
import * as path from 'path'
import { app, BrowserWindow } from 'electron'
import { safeSend } from '@host/main/safe-send'
import type { ${vars.pascal}ItemInput, ${vars.pascal}Settings } from '../shared/types'
import { createItem, deleteItem, listItems, updateItem } from './db/mapper'
import type { MainPluginContext } from './context'

/**
 * ${vars.title} 的主进程通道（前缀 `plugin:${vars.id}:`，否则装载期就抛）。
 *
 * 分工：**数据进数据库**（./db/*，能查询、能被 AI 工具读），**设置进 JSON**
 * （userData/plugin-state/${vars.id}.json——它是配置，不值得为它建表）。
 * 数据一变就推 `plugin:${vars.id}:items-changed`，开着的页面实时刷新。
 */

/** 主进程 → 渲染层：记录变了（只有发送方，必须在 install 里 registerEvent 声明） */
export const ITEMS_CHANGED = 'plugin:${vars.id}:items-changed'

const SETTINGS_FILE = (): string =>
  path.join(app.getPath('userData'), 'plugin-state', '${vars.id}.json')

const DEFAULT_SETTINGS: ${vars.pascal}Settings = { enabled: true, note: '' }
let settings: ${vars.pascal}Settings = { ...DEFAULT_SETTINGS }

/** 读设置（首次运行没有文件 → 默认值） */
function loadSettings(): void {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf-8')) as Partial<${vars.pascal}Settings>
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
    'plugin:${vars.id}:items-create': async (input: ${vars.pascal}ItemInput) => {
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
    'plugin:${vars.id}:settings-set': (patch: Partial<${vars.pascal}Settings>) => {
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
