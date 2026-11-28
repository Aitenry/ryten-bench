#!/usr/bin/env node
/**
 * Stamp the packaged app's SHA-256 content fingerprint into electron-builder's update metadata.
 *
 * Why: some fixes ship without a version bump. electron-updater compares semver and would reject
 * an equal version, so the app uses `contentSha256` (SHA-256 of the installed app.asar) as a
 * second availability signal. The runtime computes the same hash from `app.getAppPath()`.
 *
 * This script runs after `electron-builder` has produced the platform package and its
 * `latest*.yml`; it must run before the artifacts are uploaded.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DIST = resolve('dist')
const MANIFEST_RE = /^latest(?:-mac|-linux)?\.yml$/

async function findAppAsar(dir, depth = 0) {
  if (depth > 8) return []
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // Skip huge package trees: only the packaged app's resources/app.asar is relevant.
    if (entry.name === 'node_modules' || entry.name === 'app.asar.unpacked') continue
    const full = join(dir, entry.name)
    if (entry.isFile() && entry.name === 'app.asar') {
      found.push(full)
    } else if (entry.isDirectory()) {
      found.push(...(await findAppAsar(full, depth + 1)))
    }
  }
  return found
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function main() {
  const appAsars = await findAppAsar(DIST)
  if (appAsars.length === 0) {
    throw new Error('No packaged app.asar found under dist')
  }

  const hashes = new Map()
  for (const file of appAsars) {
    hashes.set(file, await sha256File(file))
  }
  const unique = new Set(hashes.values())
  if (unique.size !== 1) {
    throw new Error(
      `Multiple app.asar content hashes were built; cannot stamp one manifest:\n${[...hashes]
        .map(([file, hash]) => `  ${hash}  ${file}`)
        .join('\n')}`
    )
  }
  const contentSha256 = [...unique][0]

  const manifests = (await readdir(DIST)).filter((name) => MANIFEST_RE.test(name))
  if (manifests.length === 0) {
    throw new Error('No latest.yml / latest-mac.yml / latest-linux.yml found under dist')
  }

  for (const name of manifests) {
    const file = join(DIST, name)
    let text = await readFile(file, 'utf8')
    // Idempotent: overwrite an existing stamp rather than appending duplicates.
    text = text.replace(/^contentSha256:.*\r?\n?/gm, '')
    if (!text.endsWith('\n')) text += '\n'
    // Quote it: a purely numeric hexadecimal hash would otherwise be parsed as a YAML number and
    // lose precision / become a number instead of a string.
    text += `contentSha256: '${contentSha256}'\n`
    await writeFile(file, text, 'utf8')
    console.log(`[update] ${name}: contentSha256=${contentSha256}`)
  }
}

main().catch((error) => {
  console.error('[update] Failed to stamp content hash:', error)
  process.exitCode = 1
})
