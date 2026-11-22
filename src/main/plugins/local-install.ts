import { dialog } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import {
  extractZipToTemp,
  installPackageDir,
  resolvePackageRoot,
  type InstalledPackageInfo
} from './package-install'

/**
 * **从本地安装插件**（用户 2026-09-26 要求）：一个入口，两种来源都支持。
 *
 * - `.zip` 压缩包：解压到临时目录再按插件包安装（拒绝目录穿越；「压缩整个文件夹」
 *   多出来的那层顶层目录会自动剥掉，见 `extractZipToTemp`）；
 * - 插件**文件夹**（构建产物目录，例如 `dist/<id>`）。
 *
 * 为什么入口只有**一个**按钮：Windows / Linux 的系统选择框**不能同时**是文件选择器与
 * 目录选择器（Electron 文档明说：两个属性同时给时只显示目录选择器）。所以单个对话框
 * 只能选一种形态，这里选**文件**（下载来的插件包绝大多数是 zip），文件夹形式则通过
 * 「进到文件夹里选它的 `plugin.json`」表达——对话框的筛选器名字把这件事写清楚，
 * 安装时按 `dirname` 取父目录（本文件的 `resolveSource`）。
 *
 * 也正因如此，`plugin.json` 这条路径是**可被工装覆盖**的（选择框本身点不了，但
 * 「拿到路径之后怎么判定」是纯逻辑）。
 *
 * 为什么不直接把用户选的目录当插件目录用（符号链接/就地启用）：卸载语义是「删掉
 * `userData/plugins/<id>/`」，就地启用会让「删掉的是用户自己的源码目录」——所以一律
 * **拷进** `userData/plugins/<id>/`，与从仓库安装走同一条落地路径。
 */

/**
 * 弹系统选择框拿到一个路径（取消返回 null）。
 *
 * 一个对话框、两个筛选器：`.zip` 压缩包，或插件文件夹里的 `plugin.json`。
 * 原生对话框**没法被自动化点击**，所以 CDP 工装走的是「按显式路径安装」的 IPC
 * （`plugins-install-local`）；这里只负责真实用户的交互入口。
 */
export async function pickLocalPluginSource(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: '选择插件压缩包（.zip），或插件文件夹里的 plugin.json',
    properties: ['openFile'],
    filters: [
      { name: '插件压缩包 (*.zip)', extensions: ['zip'] },
      { name: '插件文件夹里的 plugin.json', extensions: ['json'] }
    ]
  })
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}

/**
 * 把非 zip 路径解析成「插件包目录」：
 * - 目录 → 直接当包目录（允许选它的上一级，见 `resolvePackageRoot`）；
 * - 名为 `plugin.json` 的文件 → 用它的父目录（「从文件夹安装」在单对话框下的表达方式）。
 */
function resolveSource(source: string): string {
  let stat: fs.Stats
  try {
    stat = fs.statSync(source)
  } catch {
    throw new Error(`路径不存在：${source}`)
  }
  if (stat.isDirectory()) {
    return resolvePackageRoot(source)
  }
  if (!stat.isFile()) {
    throw new Error(`只支持插件压缩包（.zip）或插件文件夹：${source}`)
  }
  if (path.basename(source).toLowerCase() === 'plugin.json') {
    return resolvePackageRoot(path.dirname(source))
  }
  throw new Error(
    '请选择插件压缩包（.zip），或进入插件文件夹选择其中的 plugin.json（文件夹必须是插件的构建产物目录）'
  )
}

/** 按显式路径安装：`.zip`、插件目录，或插件目录里的 `plugin.json` */
export async function installPluginFromLocalPath(source: string): Promise<InstalledPackageInfo> {
  let stat: fs.Stats
  try {
    stat = fs.statSync(source)
  } catch {
    throw new Error(`路径不存在：${source}`)
  }

  // zip：解压到临时目录再安装，装完删掉临时目录
  if (stat.isFile() && source.toLowerCase().endsWith('.zip')) {
    const extracted = await extractZipToTemp(source)
    try {
      const info = installPackageDir(extracted)
      logger.info(`[Plugins] Local zip package installed: ${source} -> ${info.dest}`)
      return info
    } finally {
      fs.rmSync(extracted, { recursive: true, force: true })
    }
  }

  return installPackageDir(resolveSource(source))
}
