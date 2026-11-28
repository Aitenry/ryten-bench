/**
 * Bridge for "release the file watcher before replacing/deleting a draft directory".
 *
 * The workshop service (service/store/scaffold) deliberately does not import electron, so
 * offline tooling and unit tests can run the full generate → build → publish pipeline
 * against a temp directory. On Windows, however, the directory handle held by `fs.watch`
 * does not allow deleting/renaming the watched directory: deleting a draft while a plugin
 * workspace is open fails with EPERM.
 *
 * The main process injects the real workspace-watcher implementation during assembly
 * (system/harness.ts); when nothing is injected (offline tooling) it returns null and the
 * caller proceeds as usual. That way neither side needs to know about the other.
 */

type DirReleaseHook = (dir: string) => (() => void) | null
type DirResumeHook = () => void

let hook: DirReleaseHook | null = null
let resumeHook: DirResumeHook | null = null

/** Inject the implementation (called on main-process startup; pass null to clear) */
export function configureWorkshopDirReleaseHook(
  next: DirReleaseHook | null,
  resume: DirResumeHook | null = null
): void {
  hook = next
  resumeHook = resume
}

/**
 * The directory is about to be deleted/replaced: if it is currently held by the workspace
 * watcher, release the watcher first.
 *
 * @returns A function that restores watching (null when no restore is needed)
 */
export function releaseWorkshopDir(dir: string): (() => void) | null {
  try {
    return hook?.(dir) ?? null
  } catch {
    return null
  }
}

/**
 * Re-align workspace watchers after an operation completes (per the current settings).
 *
 * Used for the overwrite/rebuild case where the old directory was deleted and a
 * same-named directory was recreated at the same path: when `releaseWorkshopDir`'s restore
 * callback runs the directory does not exist yet, so watching naturally stops; after the
 * rebuild completes, sync once more.
 */
export function resumeWorkshopDirs(): void {
  try {
    resumeHook?.()
  } catch {
    // A failure to restore watching does not affect file operations already completed
  }
}
