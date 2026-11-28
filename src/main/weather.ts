import { ipcMain } from 'electron'
import logger from 'electron-log'
import { fetchWeatherApi } from 'openmeteo'
import { safeSend } from './safe-send'
import { mainMessages } from './i18n'
import { settingsStore } from './context'
import { getMainWindow } from './windows/window-manager'
import { getIp } from './address'
import { formatDate } from './shared/weather-utils'

const DEFAULT_REFRESH_MIN = 60
/** Request timeout cap (open-meteo has no AbortSignal support; race a timer so IPC does not hang) */
const FETCH_TIMEOUT_MS = 15_000
let weatherTimer: ReturnType<typeof setInterval> | null = null

/** Add a wall-clock timeout to a request without one (the request cannot be aborted, but the caller returns on time) */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`请求超时（${Math.round(ms / 1000)}s）`)), ms)
    )
  ])
}

async function fetchWeatherData(
  lat: number,
  lon: number,
  locationName: string
): Promise<Record<string, unknown>> {
  const params = {
    latitude: [lat],
    longitude: [lon],
    current:
      'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m,apparent_temperature',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    forecast_days: 3,
    timezone: 'auto'
  }
  const responses = await withTimeout(
    fetchWeatherApi('https://api.open-meteo.com/v1/forecast', params),
    FETCH_TIMEOUT_MS
  )
  const response = responses[0]

  const current = response.current()
  const daily = response.daily()

  const result: Record<string, unknown> = {
    location: locationName,
    current: {},
    daily: [] as Record<string, unknown>[]
  }

  if (current) {
    result.current = {
      temp: current.variables(0)!.value().toFixed(2),
      weatherCode: Math.round(current.variables(1)!.value()),
      windSpeed: current.variables(2)!.value().toFixed(2),
      humidity: Math.round(current.variables(4)!.value()),
      apparentTemp: current.variables(5)!.value().toFixed(2)
    }
  }

  if (daily) {
    const wc = daily.variables(0)!.valuesArray()!
    const tMax = daily.variables(1)!.valuesArray()!
    const tMin = daily.variables(2)!.valuesArray()!
    const pProb = daily.variables(3)!.valuesArray()!
    const startTime = Number(daily.time())
    const dayInterval = daily.interval()

    for (let i = 0; i < wc.length; i++) {
      const dayTime = new Date((startTime + i * dayInterval) * 1000)
      const dateStr = formatDate(dayTime)
      ;(result.daily as Record<string, unknown>[]).push({
        // Store structured data only (date + weather code); localizeWeather renders the text
        // in the current language before sending
        date: dateStr,
        weatherCode: Math.round(wc[i]),
        tempMax: tMax[i].toFixed(0),
        tempMin: tMin[i].toFixed(0),
        precipProb: pProb[i] ?? 0
      })
    }
  }

  settingsStore.set('weatherLastFetched', Date.now())
  settingsStore.set('weatherData', result)
  return result
}

/** Weekday index → message key (Date.getDay(): 0 = Sunday) */
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/**
 * Render the weather text in the current language before sending.
 *
 * The cache stores **structured data only** (weather code + date): text baked into the cache
 * would only update on the next refresh (default 60 minutes) after a language switch.
 * label/weatherDesc from older caches are kept as a fallback.
 */
export function localizeWeather(data: Record<string, unknown>): Record<string, unknown> {
  const w = mainMessages().weather
  const codes = w.codes as Record<string, string>
  const codeText = (code: unknown, fallback: unknown): unknown =>
    typeof code === 'number'
      ? (codes[`code${code}`] ?? fallback ?? w.unknown)
      : (fallback ?? w.unknown)
  const dayLabel = (date: unknown, fallback: unknown): unknown => {
    if (typeof date !== 'string') return fallback
    const [y, m, d] = date.split('-').map(Number)
    if (!y || !m || !d) return fallback
    const local = new Date(y, m - 1, d)
    if (formatDate(local) !== formatDate(new Date())) {
      return w.weekdays[WEEKDAY_KEYS[local.getDay()]]
    }
    return w.today
  }

  const current = data.current as Record<string, unknown> | undefined
  const daily = data.daily as Record<string, unknown>[] | undefined
  return {
    ...data,
    current: current
      ? { ...current, weatherDesc: codeText(current.weatherCode, current.weatherDesc) }
      : current,
    daily: Array.isArray(daily)
      ? daily.map((day) => ({
          ...day,
          label: dayLabel(day.date, day.label),
          weatherDesc: codeText(day.weatherCode, day.weatherDesc)
        }))
      : daily
  }
}

/**
 * Most recent auto-refresh failure reason.
 *
 * The weather API depends on the external network (offline / blocked / temporary outages are
 * common), so a failure is not an application error:
 * - no `logger.error` (the main-process log would carry a full stack trace and look like a crash);
 * - the same reason is logged once, not once per refresh cycle while the failure persists; reset
 *   after one success.
 */
let lastAutoRefreshError: string | null = null

/** Automatic weather refresh (called after the main window is created) */
export function startWeatherAutoRefresh(): void {
  const ip = settingsStore.get('ip') as Record<string, unknown> | undefined
  if (!ip) return

  const lat = ip.lat as number | undefined
  const lon = ip.lon as number | undefined
  const city = (ip.city as string) || (ip.regionName as string) || ''
  if (!lat || !lon) return

  const refreshMin = (settingsStore.get('weatherRefreshInterval') as number) || DEFAULT_REFRESH_MIN
  const lastFetched = settingsStore.get('weatherLastFetched') as number | undefined

  // Push cached data first
  const cached = settingsStore.get('weatherData') as Record<string, unknown> | undefined
  const mainWindow = getMainWindow()
  if (cached && mainWindow && !mainWindow.isDestroyed()) {
    safeSend(mainWindow.webContents, 'weather-update', localizeWeather(cached))
  }

  let fetching = false
  const doFetch = async (): Promise<void> => {
    // Mutual exclusion (a manual refresh can overlap the timer, and a request older than the
    // refresh interval could otherwise be started twice)
    if (fetching) return
    fetching = true
    try {
      const data = await fetchWeatherData(lat, lon, city)
      lastAutoRefreshError = null
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        safeSend(win.webContents, 'weather-update', localizeWeather(data))
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      // Log one warning per distinct reason (an unreachable weather API while offline/blocked is
      // normal; it should not produce errors with stack traces)
      if (reason !== lastAutoRefreshError) {
        lastAutoRefreshError = reason
        logger.warn(`Weather auto-refresh failed (will retry later): ${reason}`)
      }
    } finally {
      fetching = false
    }
  }

  // On start, check whether an immediate fetch is needed
  const shouldFetchNow = !lastFetched || Date.now() - lastFetched > 3 * 60 * 60 * 1000
  if (shouldFetchNow) {
    doFetch()
  }

  // Timer
  if (weatherTimer) clearInterval(weatherTimer)
  weatherTimer = setInterval(doFetch, refreshMin * 60 * 1000)
}

/** Register the weather IPC (manual refresh) */
export function registerWeatherIpc(): void {
  ipcMain.handle(
    'weather-get',
    async (_event, force?: boolean): Promise<Record<string, unknown>> => {
      if (!force) {
        const cached = settingsStore.get('weatherData') as Record<string, unknown> | undefined
        if (cached) return localizeWeather(cached)
      }

      let ip = settingsStore.get('ip') as Record<string, unknown> | undefined
      // If IP data was not obtained at init, try fetching it on demand
      if (!ip) {
        try {
          ip = (await getIp()) as unknown as Record<string, unknown> | undefined
          if (ip) settingsStore.set('ip', ip)
        } catch {
          // getIp failed (timeout, etc.); handle silently
        }
        if (!ip) return {}
      }
      const lat = ip.lat as number | undefined
      const lon = ip.lon as number | undefined
      const city = (ip.city as string) || (ip.regionName as string) || ''
      if (!lat || !lon) return {}
      const data = await fetchWeatherData(lat, lon, city)
      // Recreate the auto-refresh timer after fetching the IP on demand (on cold start the ip was
      // not ready, startWeatherAutoRefresh returned early and the timer was never established)
      startWeatherAutoRefresh()
      return localizeWeather(data)
    }
  )
}

/** Register the weather IPC and start auto refresh (same call site as createMainWindow) */
export function setupWeather(): void {
  registerWeatherIpc()
  startWeatherAutoRefresh()
}
