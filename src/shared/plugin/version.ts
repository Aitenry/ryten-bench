/**
 * 插件版本号比较（本机已装版本 vs 插件中心最新版本）。
 *
 * 为什么需要它：判断「可更新」不能用 `latest_version !== localVersion`。版本号只是**字符串**：
 * 本地 v0.4.1、插件中心最新 v0.3.0 时，`!==` 成立，界面就会打「可更新」并给一个
 * 「更新到 v0.3.0」的**降级**入口（2026-11-23 用户反馈：「明明本地版本号更高，为什么要更新」）。
 *
 * 版本来源：工坊验收要求 semver（`1.2.0`，可带 `-beta.1` 预发布），插件中心的版本清单同样
 * 按 semver 走；清单里也可能出现 `v0.4.1` 这种带前缀的写法，这里一并兼容。
 * 实现按 semver 2.0 的优先级规则：主次修订号逐段比；有预发布标识的版本**小于**同号的正式版。
 */

interface ParsedVersion {
  /** 主版本 / 次版本 / 修订号（缺失段按 0 补齐） */
  core: number[]
  /** 预发布标识（空数组 = 正式版） */
  pre: string[]
}

/** 解析版本号；不是「数字.数字[.数字]」形态时返回 null */
function parseVersion(input: string): ParsedVersion | null {
  const raw = input.trim().replace(/^v/i, '')
  if (raw === '') return null
  // 构建元数据（+sha）不参与比较
  const withoutBuild = raw.split('+')[0]
  const dash = withoutBuild.indexOf('-')
  const coreText = dash >= 0 ? withoutBuild.slice(0, dash) : withoutBuild
  const preText = dash >= 0 ? withoutBuild.slice(dash + 1) : ''
  const coreParts = coreText.split('.')
  if (coreParts.length === 0 || coreParts.some((part) => !/^\d+$/.test(part))) return null
  return {
    core: coreParts.map((part) => Number.parseInt(part, 10)),
    pre: preText === '' ? [] : preText.split('.')
  }
}

/** 预发布标识比较（semver 2.0 第 11 条） */
function comparePrerelease(a: string[], b: string[]): number {
  // 有预发布标识 < 没有预发布标识
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i += 1) {
    const left = a[i]
    const right = b[i]
    // 前缀更短的（标识更少的）优先级更低
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      const diff = Number.parseInt(left, 10) - Number.parseInt(right, 10)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    // 数字标识 < 字母标识
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/**
 * 比较两个版本号：-1 = `a` 更旧，0 = 相同，1 = `a` 更新。
 * 任一侧无法解析（例如日期式版本 `2026.11.23-rc` 之外的怪写法）返回 null，
 * 由调用方决定怎么退化——不要把它当成「不同即有更新」。
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  const max = Math.max(left.core.length, right.core.length)
  for (let i = 0; i < max; i += 1) {
    const x = left.core[i] ?? 0
    const y = right.core[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return comparePrerelease(left.pre, right.pre)
}

/**
 * `candidate` 是否**严格新于** `base`（=「可更新」的唯一判据）。
 *
 * 任一侧缺失或解析不了时返回 false：宁可少提示一次更新，也不能给用户一个降级按钮。
 */
export function isVersionNewer(
  candidate: string | null | undefined,
  base: string | null | undefined
): boolean {
  if (!candidate || !base) return false
  return compareVersions(candidate, base) === 1
}
