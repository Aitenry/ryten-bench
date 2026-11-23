import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { PLUGIN_PURGE } from '@host/main/plugins/contributions'
import type { MainPluginContext } from './context'

/**
 * 主进程入口：install(ctx) 必须**可逆**——注册的东西都挂在 ctx 上，
 * 插件停用/卸载时由宿主一次性回滚（effect 是 LIFO）。
 *
 * 数据落在 userData/plugin-state/${vars.id}.json（不写工作区：那是用户的项目目录），
 * 并用 PLUGIN_PURGE 贡献声明「卸载时勾了删数据要清掉什么」——
 * 宿主的卸载确认框会把 label 原文显示给用户看。
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
  // effect：登记「怎么初始化」与「怎么撤销」。写文件要建目录，因此放在 effect 里。
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

  // 卸载时「同时删除该插件的数据」被勾上才会跑到这里（插件当时仍是装载状态）
  ctx.contribute(PLUGIN_PURGE, {
    label: '保存的内容（plugin-state/${vars.id}.json）',
    run: () => {
      if (stateFile) fs.rmSync(stateFile, { force: true })
    }
  })
}
