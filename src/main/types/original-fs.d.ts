/**
 * Electron exposes the unpatched Node `fs` as the built-in `original-fs` module. It is required
 * when reading a file that is itself an asar archive (`resources/app.asar`): Electron's normal `fs`
 * resolves paths *inside* asar archives and reports ENOENT for the archive file itself.
 */
declare module 'original-fs' {
  export * from 'node:fs'
}
