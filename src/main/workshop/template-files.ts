/// <reference types="vite/client" />

/**
 * 草稿模板的**文本资产加载器**。
 *
 * 模板正文不再以模板字符串的形式内联在 `templates.ts` 里，而是按草稿真实布局放在
 * `template-files/` 下、保留各自的扩展名（`.ts` / `.tsx` / `.mjs` / `.md`）：
 *
 * ```
 * template-files/
 *   _shared/WORKSHOP.md          契约单（五个模板共用；只有「模板 / 已注册」两行随模板变）
 *   _shared/main/context.ts      宿主主进程上下文的最小类型声明
 *   _shared/renderer/context.ts  宿主渲染层上下文的最小类型声明
 *   full/...                     完整骨架的代码
 *   page/ panel/ tool/ minimal/  其余模板
 * ```
 *
 * **统一按路径匹配**（`import.meta.glob`，构建期把文本内联进主进程产物）：同一路径
 * `_shared` 先、模板目录后（模板可覆盖共享文件）；`plugin.json` 仍由 `manifestFile()`
 * 生成（清单是数据，不是文本）。
 *
 * 占位符写法 `${vars.<name>}`：只替换这一种前缀，生成代码里自带的 `${...}` 与 i18n 的
 * `{{...}}` 原样保留。缺值直接抛错——宁可草稿创建失败，也不要生成一份带 `${vars.xxx}`
 * 半成品的源码给模型。
 */

const RAW_FILES = import.meta.glob('./template-files/**/*', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

const GLOB_PREFIX = './template-files/'
const TOKEN_RE = /\$\{vars\.([A-Za-z][A-Za-z0-9_]*)\}/g

/** 一条待渲染的模板文件（`path` 是草稿内相对路径，POSIX 分隔符） */
export interface TemplateFileSource {
  path: string
  body: string
}

/** 把某个目录前缀下的文本资产读成「相对路径 → 正文」 */
function filesUnder(prefix: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, body] of Object.entries(RAW_FILES)) {
    if (!key.startsWith(GLOB_PREFIX)) continue
    const rel = key.slice(GLOB_PREFIX.length)
    if (!rel.startsWith(`${prefix}/`)) continue
    out.set(rel.slice(prefix.length + 1), body)
  }
  return out
}

/** 替换 `${vars.<name>}`；未知占位符直接抛错（生成半成品比失败更难查） */
function fillTokens(body: string, vars: Record<string, string>, file: string): string {
  return body.replace(TOKEN_RE, (whole, name: string) => {
    const value = vars[name]
    if (value === undefined) {
      throw new Error(`草稿模板占位符缺值：${whole}（文件 ${file}）`)
    }
    return value
  })
}

/**
 * 取某模板的全部文本文件并按路径排序。
 *
 * `_shared` 与 `<template>` 合并，后者覆盖前者（当前没有同名文件，留作扩展位）；
 * 模板目录为空说明模板名不合法——这里报错而不是静默产出只有共享文件的草稿。
 */
export function renderTemplateFiles(
  template: string,
  vars: Record<string, string>
): TemplateFileSource[] {
  const shared = filesUnder('_shared')
  const own = filesUnder(template)
  if (own.size === 0) {
    throw new Error(`草稿模板 '${template}' 不存在：template-files/${template}/ 下没有任何文件`)
  }
  const merged = new Map<string, string>([...shared, ...own])
  return [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([path, body]) => ({ path, body: fillTokens(body, vars, path) }))
}
