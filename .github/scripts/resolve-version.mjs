#!/usr/bin/env node
/**
 * Stable release version resolver (runs in GitHub Actions, and directly on a local machine).
 *
 * Policy (2026-10):
 * - **Real versions** start at 0.1.0 and increase as 0.1.1 / 0.2.0 / 1.0.0;
 *   no more fake `0.1.0-alpha.<commit-count>.<retry>` numbers assembled from a commit count.
 * - Development branches are **named after versions** (0.1.0, 0.2.0 …), so release tags always
 *   carry a `v` prefix (`v0.1.0`): when a branch and a tag share a name, git resolves the bare
 *   name to the tag first, and `git merge 0.2.0` on main silently merges nothing. With the `v`
 *   prefix the two are never ambiguous.
 *
 * Rules:
 * - The first stable release = the `package.json` version (0.1.0) — historical alpha tags do not
 *   participate in comparisons;
 * - After that, every push to main inspects the commits **after the previous stable tag** to decide
 *   the bump:
 *     · `BREAKING CHANGE:` / `BREAKING-CHANGE:` (body) or `<type>!:` (subject) → major
 *       (0.x also jumps straight to 1.0.0, as required)
 *     · `feat` → minor
 *     · anything else (fix / perf / chore / refactor / docs …) → patch
 *   - `[release:major]` / `[release:minor]` / `[release:patch]` in the commit message forces it;
 * - `chore(release): …` is the commit the release workflow writes back to package.json, and it does
 *   **not** participate in bump calculation (otherwise every release would compute another patch
 *   for itself);
 * - a `package.json` version newer than the last stable tag means someone is setting it manually
 *   (e.g. 0.2.x → 1.0.0): release it as-is, without automatic bump;
 * - a computed version that already has a tag of the same name (workflow rerun) →
 *   `should_release=false`, no duplicate release;
 * - manual `REPUBLISH=true` reuses the latest stable tag and forces a build so the release assets
 *   can be overwritten (same-version content update; detected by contentSha256, not semver).
 *
 * Output (written to `GITHUB_OUTPUT` when present, otherwise only printed):
 *   version / tag / previous_tag / bump / should_release / sha
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'

/** Stable release tag: `1.2.3`, also tolerates a hand-written `v1.2.3` (output is always without the v) */
const STABLE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/
/** Commit that writes package.json back after a release; not counted as a user change */
const RELEASE_STAMP = /^chore\(release\)/i
/** Forced bump in the commit message */
const FORCE_BUMP = /\[release:(major|minor|patch)\]/i
/** Breaking marker in the subject: `feat(api)!: …` */
const BREAKING_SUBJECT = /^[a-z]+(?:\([^)]*\))?!:/i
/** Breaking marker in the body (conventional commits footer) */
const BREAKING_BODY = /^BREAKING[ -]CHANGE:/im
/** feat in the subject */
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

/** Semantic comparison: returns a positive number when a > b */
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

/** Determine which bump level the commits call for */
function detectBump(commits) {
  let result = 'none'
  const raise = (type) => {
    if (RANK[type] > RANK[result]) result = type
  }

  for (const commit of commits) {
    // Version commits written back by the workflow do not count as changes
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
  const tags = git('tag', '--list').split(/\r?\n/).filter(Boolean)

  const stable = tags
    .map((tag) => {
      const match = STABLE_TAG.exec(tag)
      return match ? { tag, parts: [Number(match[1]), Number(match[2]), Number(match[3])] } : null
    })
    .filter(Boolean)
    .sort((a, b) => compare(b.parts, a.parts))

  const latest = stable[0] ?? null
  // Strip the BOM: a hand-written package.json on Windows may carry one and JSON.parse throws
  // right here, while a parse failure means "no release" — a BOM should not decide that
  const pkg = JSON.parse(readFileSync('package.json', 'utf8').replace(/^\uFEFF/, ''))
  const pkgVersion = pkg.version
  const pkgParts = parseVersion(pkgVersion)
  const sha = git('rev-parse', 'HEAD')
  const republish = process.env.REPUBLISH === 'true'

  let version
  let kind

  if (republish) {
    if (!latest) throw new Error('没有可复用的正式版本 tag，无法执行同版本重发')
    // Same-version content rebuild: reuse the latest stable version. The release job overwrites
    // the existing assets; clients see a new contentSha256 in latest*.yml.
    version = format(latest.parts)
    kind = 'republish'
  } else if (!latest) {
    // First stable release: package.json has the final say (0.1.0)
    version = format(pkgParts)
    kind = 'initial'
  } else if (compare(pkgParts, latest.parts) > 0) {
    // Manually set version is newer than the last tag: release it as-is, without stacking an automatic bump
    version = format(pkgParts)
    kind = 'manual'
  } else {
    const commits = readCommits(`${latest.tag}..HEAD`)
    kind = detectBump(commits)
    version = kind === 'none' ? format(latest.parts) : format(bump(latest.parts, kind))
  }

  const releaseTag = `v${version}`
  const alreadyReleased = tags.includes(releaseTag) || tags.includes(version)
  const shouldRelease = republish || (kind !== 'none' && !alreadyReleased)

  const outputs = {
    version,
    tag: releaseTag,
    previous_tag: latest ? latest.tag : '',
    bump: republish ? 'republish' : alreadyReleased ? 'none' : kind,
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
      ? `tag ${releaseTag} 已经存在（工作流重跑？）`
      : `上次发版（${latest ? latest.tag : '无'}）之后没有新的提交`
    console.log(`::notice::这次没有可发布的版本：${reason}`)
  }
}

main()
