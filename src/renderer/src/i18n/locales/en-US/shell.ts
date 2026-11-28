import type { zhCNShell } from '../zh-CN/shell'

/* App shell copy: window frame, route skeleton and build-progress notifications. */
export const enUSShell: typeof zhCNShell = {
  menu: {
    // Built-in plugins only; standalone plugins ship their own captions
    // (planner.menu.title / music.menu.title).
    notes: 'Notes',
    harness: 'Assistant'
  },
  nav: {
    library: 'Library',
    pluginRepo: 'Plugin repository',
    schedules: 'Schedules',
    more: 'More'
  },
  titleBar: {
    minimize: 'Minimize',
    maximize: 'Maximize',
    restore: 'Restore',
    close: 'Close',
    app: 'App',
    edit: 'Edit',
    settings: 'Settings…',
    reload: 'Reload',
    quit: 'Quit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select all'
  },
  rightBar: {
    messages: 'Notifications',
    settings: 'Settings'
  },
  unlock: {
    title: 'Screen locked',
    prompt: 'Enter your 6-digit passcode to continue',
    hint: 'Six digits · unlocks automatically',
    success: 'Unlocked',
    failed: 'Incorrect passcode, try again',
    attemptsLeft: 'Incorrect passcode · {{n}} attempts left',
    throttled: 'Too many attempts · try again in {{seconds}}s',
    unavailable: 'Passcode unavailable — restart the app and try again',
    verifying: 'Verifying…',
    verifyFailed: 'Unlock verification failed, try again',
    privacyNote: 'Verified locally only. Your passcode never leaves this device.'
  },
  errorBoundary: {
    eyebrow: 'RUNTIME ERROR',
    title: 'Something unexpected happened while rendering the interface',
    reload: 'Reload'
  },
  pluginBoundary: {
    title: 'Plugin "{{name}}" failed to render',
    detail:
      'This surface belongs to the plugin. The host isolated the failure, so everything else keeps working.',
    retry: 'Retry',
    disable: 'Disable plugin',
    disableFailed: 'Could not disable: {{error}}',
    unavailable: 'Plugin unavailable'
  },
  windowTitle: {
    library: 'Library',
    pluginRepo: 'Plugin repository',
    schedules: 'Schedules',
    more: 'More',
    chatMode: 'Chat mode',
    workMode: 'Work mode',
    pluginMode: 'Plugin mode'
  },
  appearance: {
    toLight: 'Switch to light',
    toDark: 'Switch to dark'
  },
  update: {
    action: 'Update',
    retry: 'Retry',
    retryTitle: 'The last update failed. Click to retry: {{error}}',
    contentUpdate: 'Content update',
    contentAvailableTitle: '{{version}} has a content update. Click to download',
    contentReadyTitle: 'The {{version}} content update is ready. Click to restart',
    availableTitle: 'Version {{version}} is available. Click to download',
    availableTitleNoVersion: 'A new version is available. Click to download',
    downloadingTitle: 'Downloading update {{percent}}% ({{version}})',
    readyAction: 'Restart',
    readyTitle: '{{version}} is ready. Click to restart the app',
    restartingAction: 'Restarting',
    restartingTitle: 'Restarting and installing the update…',
    modalTitle: 'Update ready',
    modalBody: 'Restart the app to finish installing. This window will reopen.',
    statusReady: 'Download complete',
    statusInstalling: 'Installing update…',
    later: 'Later',
    restart: 'Restart now',
    restartingModalTitle: 'Restarting…',
    restartingBody: 'Installing the update. The app will reopen shortly.',
    newVersionFallback: 'the new version'
  },
  startup: {
    title: 'RytenBench, I got you',
    preparing: 'Preparing your workspace…',
    failed: 'Startup failed'
  },
  notificationList: {
    title: 'Notifications',
    markAllRead: 'Mark all read',
    empty: 'No notifications',
    emptyHint: 'Task progress and system notices will show up here',
    completed: 'Completed',
    timeJustNow: 'Just now',
    timeMinutesAgo: '{{count}} min ago',
    timeHoursAgo: '{{count}} h ago'
  },
  miniPlayer: {
    idle: 'Nothing playing'
  },
  bottomBar: {
    music: 'Music',
    weather: 'Weather',
    refreshWeather: 'Refresh weather',
    weatherUnavailable: 'No weather data',
    apparentTemp: 'Feels like {{temp}}°C',
    humidity: 'Humidity {{percent}}%',
    windSpeed: 'Wind {{speed}}km/h'
  },
  routing: {
    loading: 'LOADING'
  },
  build: {
    initializing: 'Initializing',
    initializingMessage: 'Initializing...',
    unknownWiki: 'Knowledge base #{{id}}',
    progressSummary: '{{phase}} {{percent}}% — {{message}}',
    completedSummary: '{{entityCount}} entities, {{relationCount}} relations',
    completedSummary_one: '{{entityCount}} entities, {{relationCount}} relations',
    completedSummary_other: '{{entityCount}} entities, {{relationCount}} relations'
  }
}
