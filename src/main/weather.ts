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
/** 请求超时上限（open-meteo 无 AbortSignal 支持，用竞速兜底，防 IPC invoke 永久悬挂） */
const FETCH_TIMEOUT_MS = 15_000
let weatherTimer: ReturnType<typeof setInterval> | null = null

/** 给无超时机制的请求加墙钟超时（底层请求无法中止，但调用方能按时返回） */
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
        // 只存结构化数据（日期 + 天气码），文案由 localizeWeather 在下发前按语言渲染
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

/** 星期索引 → 词条键（Date.getDay()：0 = 周日） */
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/**
 * 下发前按当前语言渲染天气文案。
 *
 * 缓存里只存**结构化数据**（天气码 + 日期）：把文案写死在缓存里的话，切语言后要等
 * 下一次刷新（默认 60 分钟）才会更新。旧缓存里的 label/weatherDesc 作为兜底保留。
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
 * 自动刷新最近一次失败原因。
 *
 * 天气接口依赖外网（离线 / 被墙 / 临时故障都很常见），失败不是应用错误：
 * - 不写 `logger.error`（主进程日志里会带整段堆栈，像崩了一样）；
 * - 同一个原因只记一次，失败持续期间不按刷新周期反复刷日志；成功一次后重置。
 */
let lastAutoRefreshError: string | null = null

/** 天气自动刷新（创建主窗口后调用） */
export function startWeatherAutoRefresh(): void {
  const ip = settingsStore.get('ip') as Record<string, unknown> | undefined
  if (!ip) return

  const lat = ip.lat as number | undefined
  const lon = ip.lon as number | undefined
  const city = (ip.city as string) || (ip.regionName as string) || ''
  if (!lat || !lon) return

  const refreshMin = (settingsStore.get('weatherRefreshInterval') as number) || DEFAULT_REFRESH_MIN
  const lastFetched = settingsStore.get('weatherLastFetched') as number | undefined

  // 先推送缓存数据
  const cached = settingsStore.get('weatherData') as Record<string, unknown> | undefined
  const mainWindow = getMainWindow()
  if (cached && mainWindow && !mainWindow.isDestroyed()) {
    safeSend(mainWindow.webContents, 'weather-update', localizeWeather(cached))
  }

  let fetching = false
  const doFetch = async (): Promise<void> => {
    // 并发互斥（修复：手动刷新与自动定时叠加、上次请求超过刷新间隔时重复发起）
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
      // 同一失败原因只记一条 warn（离线/被墙时天气接口不可达是常态，不该刷 error + 堆栈）
      if (reason !== lastAutoRefreshError) {
        lastAutoRefreshError = reason
        logger.warn(`Weather auto-refresh failed (will retry later): ${reason}`)
      }
    } finally {
      fetching = false
    }
  }

  // 启动时检查是否需要立即拉取
  const shouldFetchNow = !lastFetched || Date.now() - lastFetched > 3 * 60 * 60 * 1000
  if (shouldFetchNow) {
    doFetch()
  }

  // 定时器
  if (weatherTimer) clearInterval(weatherTimer)
  weatherTimer = setInterval(doFetch, refreshMin * 60 * 1000)
}

/** 注册天气 IPC（手动刷新） */
export function registerWeatherIpc(): void {
  ipcMain.handle(
    'weather-get',
    async (_event, force?: boolean): Promise<Record<string, unknown>> => {
      if (!force) {
        const cached = settingsStore.get('weatherData') as Record<string, unknown> | undefined
        if (cached) return localizeWeather(cached)
      }

      let ip = settingsStore.get('ip') as Record<string, unknown> | undefined
      // 如果 IP 数据在初始化时没取到，尝试现场获取
      if (!ip) {
        try {
          ip = (await getIp()) as unknown as Record<string, unknown> | undefined
          if (ip) settingsStore.set('ip', ip)
        } catch {
          // getIp 失败（超时等），静默处理
        }
        if (!ip) return {}
      }
      const lat = ip.lat as number | undefined
      const lon = ip.lon as number | undefined
      const city = (ip.city as string) || (ip.regionName as string) || ''
      if (!lat || !lon) return {}
      const data = await fetchWeatherData(lat, lon, city)
      // 现场取到 IP 后补建自动刷新定时器（修复：冷启动时 ip 未就绪，
      // startWeatherAutoRefresh 提前 return，定时器本会话永不建立）
      startWeatherAutoRefresh()
      return localizeWeather(data)
    }
  )
}

/** 注册天气 IPC 并启动自动刷新（与 createMainWindow 原调用位置保持一致） */
export function setupWeather(): void {
  registerWeatherIpc()
  startWeatherAutoRefresh()
}
