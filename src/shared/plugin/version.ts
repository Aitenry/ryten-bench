/**
 * Plugin version comparison (locally installed version vs the latest version in the plugin
 * repository).
 *
 * Why it is needed: "update available" cannot be decided with `latest_version !== localVersion`.
 * Version numbers are just **strings**: when the local one is v0.4.1 and the repository's latest is
 * v0.3.0, `!==` holds, so the UI would flag "update available" and offer a **downgrade** entry
 * saying "update to v0.3.0" (user feedback on 2026-11-23: "why update when my local version is
 * clearly higher").
 *
 * Version source: workshop validation requires semver (`1.2.0`, optionally with a `-beta.1`
 * prerelease), and the plugin repository's version list follows semver as well; the list may also
 * contain prefixed forms such as `v0.4.1`, which are accepted here too.
 * The implementation follows the semver 2.0 precedence rules: major, minor and patch are compared
 * segment by segment; a version with a prerelease identifier is **lower than** the release with the
 * same numbers.
 */

interface ParsedVersion {
  /** Major / minor / patch (missing segments are padded with 0) */
  core: number[]
  /** Prerelease identifiers (empty array = release) */
  pre: string[]
}

/** Parse a version number; returns null unless it is in "number.number[.number]" form */
function parseVersion(input: string): ParsedVersion | null {
  const raw = input.trim().replace(/^v/i, '')
  if (raw === '') return null
  // Build metadata (+sha) does not participate in the comparison
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

/** Compare prerelease identifiers (semver 2.0 rule 11) */
function comparePrerelease(a: string[], b: string[]): number {
  // Having prerelease identifiers < having none
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i += 1) {
    const left = a[i]
    const right = b[i]
    // A shorter prefix (fewer identifiers) has lower precedence
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      const diff = Number.parseInt(left, 10) - Number.parseInt(right, 10)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    // A numeric identifier < an alphanumeric identifier
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/**
 * Compare two version numbers: -1 = `a` is older, 0 = identical, 1 = `a` is newer.
 * Returns null when either side cannot be parsed (e.g. odd forms such as the date-style version
 * `2026.11.23-rc`), and the caller decides how to degrade — do not treat it as "different means an
 * update is available".
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
 * Whether `candidate` is **strictly newer than** `base` (the sole criterion for "update
 * available").
 *
 * Returns false when either side is missing or unparsable: better to miss one update notice than
 * to hand the user a downgrade button.
 */
export function isVersionNewer(
  candidate: string | null | undefined,
  base: string | null | undefined
): boolean {
  if (!candidate || !base) return false
  return compareVersions(candidate, base) === 1
}
