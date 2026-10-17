import type { zhCNShell } from '../zh-CN/shell'

/* App shell copy: window frame, route skeleton and build-progress notifications. */
export const enUSShell: typeof zhCNShell = {
  menu: {
    // Built-in plugins only; standalone plugins ship their own captions
    // (planner.menu.title / music.menu.title).
    notes: 'Notes',
    harness: 'Assistant'
  },
  titleBar: {
    minimize: 'Minimize',
    maximize: 'Maximize',
    restore: 'Restore',
    close: 'Close'
  },
  rightBar: {
    messages: 'Notifications',
    settings: 'Settings'
  },
  unlock: {
    title: 'Screen locked',
    prompt: 'Enter your password to unlock',
    hint: 'Enter the 6-digit code to unlock',
    success: 'Unlocked',
    failed: 'Incorrect password',
    verifyFailed: 'Unlock verification failed'
  },
  errorBoundary: {
    eyebrow: 'RUNTIME ERROR',
    title: 'Something unexpected happened while rendering the interface',
    reload: 'Reload'
  },
  pluginBoundary: {
    title: 'Plugin "{{name}}" failed to render',
    detail: 'This surface belongs to the plugin. The host isolated the failure, so everything else keeps working.',
    retry: 'Retry',
    disable: 'Disable plugin',
    disableFailed: 'Could not disable: {{error}}',
    unavailable: 'Plugin unavailable'
  },
  notificationList: {
    empty: 'No notifications',
    completed: 'Completed'
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
