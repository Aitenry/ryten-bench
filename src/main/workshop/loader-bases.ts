import * as fs from 'fs'
import * as path from 'path'

/**
 * **Candidate bases** for the workshop module loader (order is priority).
 *
 * Why a separate file: this ordering carries a constraint that has **been hit twice on real
 * hardware**, and importing `wiring.ts` pulls in electron plus the whole IPC chain, which
 * offline tooling cannot test. Split out, `test/verify-plugin-workshop.mjs` can assert the
 * order directly without an actual package.
 *
 * ## Constraint: `app.asar.unpacked` must come before `app.asar`
 *
 * Files inside asar are **visible** to `require` (Electron patches fs) but not to `spawn`.
 * Reversing the order therefore produces this false success: `esbuild` resolves fine out of
 * asar → its JS main module then runs `spawn(<package dir>/…/@esbuild/win32-x64/esbuild.exe)`
 * → that path inside asar is only a virtual entry → it necessarily reports
 *
 * ```
 * The service is no longer running: spawn …\resources\app.asar\node_modules\@esbuild\win32-x64\esbuild.exe ENOENT
 * ```
 *
 * The investigation order on 2026-09-29 is worth remembering: first it turned out "there is no
 * esbuild at all after packaging" (it was only in devDependencies and excluded by the files
 * rules); after adding it to dependencies and asarUnpack **the same shape of error persisted** —
 * because what was loaded was still the copy inside asar. **"Whether it exists" and "where it is
 * loaded from" are two different things**.
 */
export function resolveLoaderBases(options: {
  /** Packaged-mode `process.resourcesPath`; omitted in development */
  resourcesPath?: string
  /** `app.getAppPath()` (dev = repo root; packaged = …/resources/app.asar) */
  appPath: string
  /** Injection point for checking whether a directory exists (for offline tests) */
  exists?: (dir: string) => boolean
}): string[] {
  const exists = options.exists ?? fs.existsSync
  const bases: string[] = []
  if (options.resourcesPath) {
    const unpacked = path.join(options.resourcesPath, 'app.asar.unpacked')
    // Use it as a base only when it really exists: dev has no such directory, so there is no need to try an extra empty path on every resolve
    if (exists(unpacked)) bases.push(unpacked)
    bases.push(path.join(options.resourcesPath, 'app'))
  }
  // In development: the repo's node_modules lives under the app root
  bases.push(options.appPath)
  return bases
}
