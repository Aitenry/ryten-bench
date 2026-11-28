import * as fs from 'fs'
import * as path from 'path'
import { app, BrowserWindow } from 'electron'
import { safeSend } from '@host/main/safe-send'
import type { ${vars.pascal}ItemInput, ${vars.pascal}Settings } from '../shared/types'
import { createItem, deleteItem, listItems, updateItem } from './db/mapper'
import type { MainPluginContext } from './context'

/**
 * Main-process channels for ${vars.title} (prefixed with `plugin:${vars.id}:`, otherwise loading
 * throws).
 *
 * Split: **data goes into the database** (./db/*, queryable and readable by AI tools), **settings go
 * into JSON** (userData/plugin-state/${vars.id}.json - it is configuration, not worth a table).
 * Push `plugin:${vars.id}:items-changed` whenever data changes so open pages refresh live.
 */

/** Main process -> renderer: records changed (send-only; must be declared via registerEvent in install) */
export const ITEMS_CHANGED = 'plugin:${vars.id}:items-changed'

const SETTINGS_FILE = (): string =>
  path.join(app.getPath('userData'), 'plugin-state', '${vars.id}.json')

const DEFAULT_SETTINGS: ${vars.pascal}Settings = { hideDone: false, note: '' }
let settings: ${vars.pascal}Settings = { ...DEFAULT_SETTINGS }

/** Read settings (no file on first run -> defaults) */
function loadSettings(): void {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf-8')) as Partial<${vars.pascal}Settings>
    settings = { ...DEFAULT_SETTINGS, ...saved }
  } catch {
    settings = { ...DEFAULT_SETTINGS }
  }
}

/** Write settings (create the directory if missing: data belongs in userData, not the user's workspace) */
function saveSettings(): void {
  const file = SETTINGS_FILE()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf-8')
}

/** Push a data change to all windows (host safe-send: sending to a stale renderer frame does not throw) */
export function broadcastItemsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win.webContents, ITEMS_CHANGED, { at: Date.now() })
  }
}

/** Channel table (handed to ctx.registerIpc in install; removed together with ctx.dispose on disable) */
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
        hideDone: typeof patch?.hideDone === 'boolean' ? patch.hideDone : settings.hideDone,
        note: typeof patch?.note === 'string' ? patch.note : settings.note
      }
      saveSettings()
      broadcastItemsChanged()
      return { ...settings }
    }
  }
}

/** Settings file path (used when clearing data) */
export function settingsFilePath(): string {
  return SETTINGS_FILE()
}

/** Load settings during install and make sure a file is written on first run (inside ctx.effect: rolled back on disable) */
export function initSettings(ctx: MainPluginContext): void {
  ctx.effect(() => {
    loadSettings()
    saveSettings()
    return () => {
      settings = { ...DEFAULT_SETTINGS }
    }
  })
}
