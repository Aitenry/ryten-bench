import type { zhCNLattice } from '../zh-CN/lattice'

/**
 * Copy for the login page, the account area, the Lattice plugin hub and sync.
 * Keys mirror `zh-CN/lattice.ts` exactly (`typeof zhCNLattice`).
 */
export const enUSLattice: typeof zhCNLattice = {
  login: {
    windowTitle: 'Sign in',
    title: 'Sign in to RytenBench',
    subtitle: 'Use your Lattice account to unlock the plugin hub and cross-device sync.',
    username: 'Username',
    usernamePlaceholder: 'Enter your username',
    usernameRequired: 'Please enter your username',
    password: 'Password',
    passwordPlaceholder: 'Enter your password',
    passwordRequired: 'Please enter your password',
    remember: 'Remember me',
    submit: 'Sign in',
    submitting: 'Signing in…',
    success: 'Signed in. Welcome back',
    failure: 'Sign-in failed. Check your username and password',
    errorTitle: 'Unable to sign in',
    back: 'Back to workspace',
    bridgeUnavailableTitle: 'Plugin hub not ready',
    bridgeUnavailableDesc:
      'The main process hub bridge is not ready yet, so signing in is unavailable. Restart the app and try again.',
    server: {
      label: 'Server address',
      placeholder: 'http://127.0.0.1:8080',
      hint: 'Advanced: leave empty to use the default address. Usually no change needed.'
    },
    brand: {
      tagline:
        'The assistant can build your own workspace in the app and take care of your other needs.',
      point1Title: 'Plugin hub',
      point1Desc: 'Discover, install and update team plugins in one place.',
      point2Title: 'Cross-device sync',
      point2Desc: 'Plugin lists and settings stay the same on every device.',
      point3Title: 'Local first',
      point3Desc: 'Data stays on this machine and syncs only when you need it.',
      footer: 'RytenBench · Lattice platform'
    }
  },
  lattice: {
    account: {
      guest: 'Not signed in',
      goLogin: 'Click to sign in',
      connecting: 'Connecting…',
      bridgeUnavailable: 'Plugin hub not ready',
      bridgeHint: 'Main process bridge offline',
      title: 'Account',
      username: 'Username',
      displayName: 'Display name',
      userId: 'User ID',
      role: 'Role',
      server: 'Server',
      lastSync: 'Last sync',
      conflicts: 'Data conflicts',
      roleAdmin: 'Administrator',
      roleMaintainer: 'Operations',
      roleMember: 'User',
      connected: 'Plugin hub connected',
      localStatus: 'Local workspace',
      logout: 'Sign out',
      logoutTitle: 'Sign out',
      logoutBody:
        'Installed plugins stay on this machine, but nothing will sync with the plugin hub anymore.',
      logoutSuccess: 'Signed out',
      logoutFail: 'Could not sign out',
      logoutConfirm: 'Sign out',
      hub: 'Plugin hub',
      accountInfo: 'Account info',
      syncNow: 'Sync now'
    },
    errors: {
      bridgeUnavailable:
        'No plugin hub bridge detected: the main process hub channels are not ready. Restart the app and try again.',
      requestFailed: 'Request failed: {{reason}}',
      loginRequired: 'Sign in to the plugin hub first'
    },
    hub: {
      latestVersion: 'Hub version',
      notPublished: 'Not published yet',
      updateAvailable: 'Hub update available: v{{version}}',
      notLoggedIn: 'Sign in to see the hub version'
    },
    upload: {
      modalTitle: 'Publish to plugin hub',
      preparing: 'Preparing to publish…',
      phaseZip: 'Packaging plugin',
      phaseMeta: 'Writing plugin metadata',
      phaseUpload: 'Uploading plugin package',
      phaseSource: 'Uploading source package',
      bytes: '{{sent}} / {{total}}',
      keepOpen: 'Please keep the window open while uploading',
      success: 'Published {{name}} v{{version}}',
      submitted: '{{name}} v{{version}} submitted — waiting for an administrator to approve it',
      canceled: 'Upload canceled',
      fail: 'Upload failed',
      publishAction: 'Publish to plugin hub',
      publishActionDesc:
        'Pick a plugin package folder (its plugin.json and README.md are read). The package and its source code are uploaded together to the Lattice plugin hub.'
    }
  },
  plugins: {
    hub: {
      searchPlaceholder: 'Search name, author or tag…',
      categoryLabel: 'Category',
      categoryAll: 'All categories',
      refresh: 'Refresh',
      upload: 'Upload',
      uploadZipHint: 'Upload .zip package',
      uploadWithSourceHint: 'Publish install package + source folder (two separate zips)',
      /** Header "Publish" dropdown: three publish variants + local folder import in one menu */
      publishMenu: 'Publish',
      publishMenuTitle: 'Publish plugins to the hub',
      publishDir: 'Publish a plugin folder…',
      publishZip: 'Publish a .zip package…',
      publishWithSource: 'Publish package + source folders…',
      installLocal: 'Install local',
      importLocalDir: 'Import plugin folder…',
      total: '{{n}} plugins',
      loading: 'Loading plugin hub…',
      loadFail: 'Could not load the plugin hub catalog: {{reason}}',
      loadFailTitle: 'Plugin hub failed to load',
      retry: 'Retry',
      loginRequiredTitle: 'Sign in to use the plugin hub',
      loginRequiredDesc:
        'Sign in with your Lattice account to browse, install, update and publish team plugins, and sync plugin settings across devices.',
      goLogin: 'Sign in',
      unavailableTitle: 'Plugin hub unavailable',
      unavailableDesc:
        'The main process hub channels are not ready. Restart the app and try again.',
      empty: 'No plugins in the hub yet',
      emptyHint: 'Upload a local plugin package, or import a plugin folder and look again.',
      noMatch: 'No matching plugins',
      install: 'Install',
      update: 'Update',
      reinstall: 'Reinstall',
      installFail: 'Could not install the plugin',
      installSuccess: 'Installed "{{name}}"',
      updateSuccess: '"{{name}}" updated to v{{version}}',
      installVersionSuccess: '"{{name}}" installed as v{{version}}',
      updateAvailable: 'Update',
      updateTo: 'Update to v{{version}}',
      updateAll: {
        button: 'Update all ({{n}})',
        done: 'Updated {{n}} plugin(s)',
        partial: 'Update finished: {{ok}} succeeded, {{fail}} failed'
      },
      installed: 'Installed',
      installedVersion: 'Local v{{version}}',
      enabled: 'Enabled',
      disabled: 'Disabled',
      downloads: '{{n}} downloads',
      versions: '{{n}} versions',
      owner: 'Author',
      installDisabled: 'This plugin cannot be installed right now',
      openDetail: 'Open plugin details',
      v2Unsupported:
        'This main process build does not support this capability yet (restart the updated app)',
      source: {
        badge: 'Source',
        hasSource: 'With source',
        noSource: 'No source',
        open: 'Open source',
        size: 'Source {{size}}',
        hint: 'Hub versions ship both the plugin package and a source package',
        downloadFailed: 'Package installed, but the source download failed: {{reason}}'
      },
      local: {
        badge: 'Local install',
        desc: 'Installed from a local package and not published to the hub yet',
        detail: 'View details',
        empty: 'No locally installed plugins'
      },
      versionTable: {
        title: 'Version history',
        version: 'Version',
        size: 'Size',
        source: 'Source',
        publishedAt: 'Published',
        changelog: 'Changelog',
        actions: 'Actions',
        downloadPackage: 'Download package',
        downloadSource: 'Download source',
        installVersion: 'Install this version',
        currentVersion: 'Current',
        latest: 'Latest',
        noChangelog: '—',
        empty: 'No version info yet'
      },
      detail: {
        readmeTitle: 'About this plugin',
        latestVersion: 'Latest on hub',
        notPublished: 'Not published to the hub',
        localVersion: 'Local version',
        sourcePath: 'Source path',
        noSourcePath: 'Source not downloaded (this version has no source package)',
        localSourcePath: 'Local install directory',
        downloads: '{{n}} downloads',
        downloadsLabel: 'Downloads',
        category: 'Category',
        tags: 'Tags',
        publishedAt: 'Published',
        updateAvailable: 'New version on hub: v{{version}}',
        installVersion: 'Install v{{version}}',
        openInChat: 'Edit in chat',
        openInChatDesc: 'Open the source workspace and let the model modify this plugin',
        publishNewVersion: 'Publish new version',
        publishNewVersionDesc:
          'Read the local source folder, repackage the plugin and source, and publish to the hub',
        publishLocal: 'Publish to plugin hub',
        publishLocalDesc:
          'Publish the installed copy of this plugin directly (package and source are attached; no folder picking)',
        notPublishedHint:
          'This plugin is not published to the hub yet; publish it so others can install it.',
        workflowTitle: 'Source & publishing',
        workflowDesc:
          'Installing downloads the source to this machine. Edit it in chat, then use "Publish new version" to upload the new package and source together.'
      },
      publish: {
        title: 'Publish new version',
        version: 'Version',
        versionPlaceholder: 'e.g. 1.4.2',
        versionHint: 'Must be higher than the current latest hub version v{{version}}',
        versionRequired: 'Please enter a version',
        versionInvalid: 'Invalid version format (example: 1.4.2)',
        changelog: 'Changelog',
        changelogPlaceholder: 'What changed? (optional)',
        submit: 'Publish',
        success: 'Published v{{version}}',
        submitted: 'v{{version}} submitted — waiting for an administrator to approve it',
        fail: 'Publish failed: {{reason}}'
      },
      openSource: {
        success: 'Source opened; you can ask the model to modify it in chat',
        folderFallback: 'Source opened in the file manager (could not create a chat automatically)',
        fail: 'Could not open the source: {{reason}}',
        unsupported:
          'This main process build does not support opening source (restart the updated app)',
        noSource: 'This version has no source package to open'
      },
      download: {
        success: 'Saved to {{path}}',
        canceled: 'Download canceled',
        fail: 'Download failed: {{reason}}',
        unsupported: 'This main process build does not support downloads (restart the updated app)'
      },
      import: {
        success: 'Import finished: {{imported}} imported, {{skipped}} skipped',
        empty: 'No plugin with a plugin.json was found in the selected folder',
        fail: 'Import failed: {{reason}}',
        unsupported:
          'This main process build does not support importing a plugin folder (restart the updated app)'
      }
    }
  },
  sync: {
    title: 'Sync',
    lastSync: 'Last sync {{time}}',
    never: 'Never synced',
    now: 'Sync now',
    merge: {
      button: 'Merge cloud data',
      success: 'Merge complete: {{merged}} plugin(s) / {{rows}} new record(s)',
      partial: 'Merge complete: {{merged}} plugin(s) / {{rows}} new record(s), {{failed}} failed',
      failed: 'Merge failed: {{failed}} plugin(s) were not merged',
      empty: 'Nothing to merge (not installed, merging unsupported, or no cloud snapshot)',
      hint: 'Merge the cloud snapshots of all installed plugins into this device (local data is never overwritten: cloud-only rows are added and deduplicated by natural keys), then push the merged result back to the cloud.'
    },
    syncing: 'Syncing…',
    success:
      'Sync complete: pushed {{pushed}} plugin(s) / {{pushedRows}} record(s), pulled {{pulled}} plugin(s) / {{pulledRows}} record(s)',
    rowsSummary: '↑{{pushed}} · ↓{{pulled}} records',
    conflicts: '{{n}} data conflicts',
    conflictsShort: '{{n}} conflicts',
    error: 'Sync failed: {{reason}}',
    justNow: 'just now',
    autoInstall: {
      toggle: 'Auto-restore plugins',
      toggleHint:
        'After moving to a new machine, reinstalling, or deleting a plugin folder, sync automatically reinstalls missing plugins from the hub (on by default). When off, sync only lists missing plugins without installing them.',
      on: 'Auto-restore: on',
      off: 'Auto-restore: off',
      done: '{{n}} plugin(s) restored automatically',
      partial: '{{ok}} plugin(s) restored, {{fail}} failed (view reasons)',
      allFailed: '{{fail}} plugin(s) failed to restore (view reasons)',
      failed: '{{fail}} auto-restore failure(s) (view reasons)',
      orphaned: '{{n}} install record(s) point to plugins removed from the hub',
      viewDetails: 'View sync details',
      unsupported: 'This main process build does not support auto-restore (restart the updated app)'
    },
    details: {
      title: 'Sync details',
      description:
        'Details of this sync: auto-restored plugins, install records for removed plugins, and data conflicts.',
      autoInstallTitle: 'Auto-restore',
      autoInstallEmpty: 'Nothing needed restoring in this sync',
      installedTitle: 'Restored ({{n}})',
      failedTitle: 'Restore failures ({{n}})',
      failedHint:
        'A single failure does not stop other plugins. Retry sync later or install it manually from the hub.',
      orphanedTitle: 'Install records for removed plugins ({{n}})',
      orphanedHint:
        'These install records point to plugins removed from the hub. Local plugin folders and data are kept and never deleted automatically (marked as orphaned).',
      orphanedEmpty: 'No install records for removed plugins',
      conflictsTitle: 'Data conflicts ({{n}})',
      conflictsHint:
        'The same plugin data was changed both locally and in the cloud. Use "Resolve conflicts" to pick a side for each one.',
      retry: 'Sync again',
      unsupported:
        'This main process build does not support sync details (restart the updated app)',
      close: 'Close'
    },
    resolve: {
      button: 'Resolve conflicts ({{n}})',
      title: 'Resolve plugin data conflicts',
      description:
        'The same plugin was changed on both this device and the cloud. Pick a side for each conflict, or merge both sides (plugins that support merging: local data is kept and cloud-only rows are added, deduplicated by natural keys).',
      localRev: 'Local rev {{n}}',
      serverRev: 'Cloud rev {{n}}',
      localData: 'Local data',
      serverData: 'Cloud data',
      noData: '(no data)',
      useLocal: 'Keep local (overwrite cloud)',
      useCloud: 'Keep cloud (overwrite local)',
      merge: 'Merge both sides',
      done: 'Conflict resolved',
      empty: 'No unresolved conflicts'
    },
    pushed: 'Pushed {{n}}',
    pulled: 'Pulled {{n}}'
  }
}
