#!/usr/bin/env node
/**
 * 正式版版本号解析器（GitHub Actions 里跑，本机也能直接跑）。
 *
 * 用户口径（2026-10）：从 0.1.0 开始发**真实版本**，之后按 0.1.1 / 0.2.0 / 1.0.0 这样递增；
 * 不再有 `0.1.0-alpha.<提交数>.<重试数>` 那种拿提交数量拼出来的假号。
 *
 * 规则：
 * - 第一个正式版 = `package.json` 的版本（0.1.0）——历史 alpha tag 不参与比较；
 * - 之后每次推 main，看**上一个正式 tag 之后**的提交信息决定 bump：
 *     · `BREAKING CHANGE:` / `BREAKING-CHANGE:`（正文）或 `<type>!:`（标题）→ major
 *       （0.x 也直接进 1.0.0，用户就是这么要求的）
 *     · `feat` → minor
 *     · 其余（fix / perf / chore / refactor / docs …）→ patch
 *   - 提交信息里写 `[release:major]` / `[release:minor]` / `[release:patch]` 可强制指定；
 * - `chore(release): …` 是发版后工作流把 package.json 回写的提交，**不参与** bump 计算
 *   （否则每次发版都会给自己再算一次 patch）；
 * - `package.json` 的版本比最后一个正式 tag 还新 = 有人在手动定版本（比如把 0.2.x 定到 1.0.0），
 *   直接按它发，不再自动 bump；
 * - 算出来的版本已经有同名 tag（工作流重跑）→ `should_release=false`，不重复发版。
 *
 * 输出（有 `GITHUB_OUTPUT` 就写进去，否则只打印）：
 *   version / tag / previous_tag / bump / should_release / sha
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'

/** 正式版本 tag：`1.2.3`，也容忍有人手打 `v1.2.3`（统一输出不带 v） */
const STABLE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/
/** 发版后回写 package.json 的提交，不算用户改动 */
const RELEASE_STAMP = /^chore\(release\)/i
/** 提交信息里的强制指定 */
const FORCE_BUMP = /\[release:(major|minor|patch)\]/i
/** 标题里的破坏性标记：`feat(api)!: …` */
const BREAKING_SUBJECT = /^[a-z]+(?:\([^)]*\))?!:/i
/** 正文里的破坏性标记（conventional commits 的 footer） */
const BREAKING_BODY = /^BREAKING[ -]CHANGE:/im
/** 标题里的 feat */
const FEAT_SUBJECT = /^feat(?:\([^)]*\))?!?:/i

const RANK = { none: 0, patch: 1, minor: 2, major: 3 }

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function parseVersion(raw) {
  const text = String(raw).trim()
  const match = STABLE_TAG.exec(text)
  if (!match) throw new Error(`不是合法的正式版本号：${JSON.stringify(raw)}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** 语义化比较：a > b 返回正数 */
function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

function format(parts) {
  return parts.join('.')
}

function bump(parts, type) {
  const [major, minor, patch] = parts
  if (type === 'major') return [major + 1, 0, 0]
  if (type === 'minor') return [major, minor + 1, 0]
  return [major, minor, patch + 1]
}

/** 从提交信息里判定这次该 bump 到哪一档 */
function detectBump(commits) {
  let result = 'none'
  const raise = (type) => {
    if (RANK[type] > RANK[result]) result = type
  }

  for (const commit of commits) {
    // 工作流自己回写的版本提交不算改动
    if (RELEASE_STAMP.test(commit.subject)) continue

    const forced = FORCE_BUMP.exec(`${commit.subject}\n${commit.body}`)
    if (forced) raise(forced[1].toLowerCase())
    if (BREAKING_SUBJECT.test(commit.subject) || BREAKING_BODY.test(commit.body)) raise('major')
    else if (FEAT_SUBJECT.test(commit.subject)) raise('minor')
    else raise('patch')
  }

  return result
}

function readCommits(range) {
  const raw = git('log', '--no-merges', '--pretty=format:%s%x1f%b%x1e', range)
  if (!raw) return []
  return raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [subject = '', body = ''] = record.split('\x1f')
      return { subject: subject.trim(), body: body.trim() }
    })
}

function main() {
  const tags = git('tag', '--list')
    .split(/\r?\n/)
    .filter(Boolean)

  const stable = tags
    .map((tag) => {
      const match = STABLE_TAG.exec(tag)
      return match ? { tag, parts: [Number(match[1]), Number(match[2]), Number(match[3])] } : null
    })
    .filter(Boolean)
    .sort((a, b) => compare(b.parts, a.parts))

  const latest = stable[0] ?? null
  // 去 BOM：Windows 下手写的 package.json 可能带 BOM，JSON.parse 会直接炸在这里，
  // 而解析失败意味着「发不出包」，没必要让一个 BOM 决定发布成败
  const pkg = JSON.parse(readFileSync('package.json', 'utf8').replace(/^\uFEFF/, ''))
  const pkgVersion = pkg.version
  const pkgParts = parseVersion(pkgVersion)
  const sha = git('rev-parse', 'HEAD')

  let version
  let kind

  if (!latest) {
    // 首个正式版：package.json 说了算（0.1.0）
    version = format(pkgParts)
    kind = 'initial'
  } else if (compare(pkgParts, latest.parts) > 0) {
    // 手动定的版本比最后一个 tag 新：按它发，不再叠加自动 bump
    version = format(pkgParts)
    kind = 'manual'
  } else {
    const commits = readCommits(`${latest.tag}..HEAD`)
    kind = detectBump(commits)
    version = kind === 'none' ? format(latest.parts) : format(bump(latest.parts, kind))
  }

  const alreadyReleased = tags.includes(version) || tags.includes(`v${version}`)
  const shouldRelease = kind !== 'none' && !alreadyReleased

  const outputs = {
    version,
    tag: version,
    previous_tag: latest ? latest.tag : '',
    bump: alreadyReleased ? 'none' : kind,
    should_release: String(shouldRelease),
    sha
  }

  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  }

  console.log(lines.join('\n'))
  if (!shouldRelease) {
    const reason = alreadyReleased
      ? `tag ${version} 已经存在（工作流重跑？）`
      : `上次发版（${latest ? latest.tag : '无'}）之后没有新的提交`
    console.log(`::notice::这次没有可发布的版本：${reason}`)
  }
}

main()
