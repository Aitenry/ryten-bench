import { tool } from '../../ai/tools'
import type { StructuredToolInterface } from '../../ai/tools'
import * as z from 'zod/v4'
import { mainFormat } from '../../i18n'
import { settingsStore } from '../../context'
import {
  geocodeLocation,
  getWeatherTexts,
  weatherCodeLabel,
  weekdayLabelFor,
  windDirectionLabelFor
} from '../../shared/weather-utils'

// ============================================================================
// Weather Tool — 天气查询
//
// 2026-11 改造（用户反馈「天气查询也不好用」）：
// - 从 openmeteo SDK 改为直接请求 JSON：日出/日落是字符串，SDK 的数值数组取不到；
//   JSON 里的 time 已经是**地点本地时间**，不再用系统时区拼日期（跨时区地点不再错一天）；
// - 新增逐小时预报（回答「今天下午会下雨吗」）、紫外线、日出日落、阵风、降水量/概率；
// - 地点可省略：默认用启动时缓存的本机 IP 位置；也支持直接给经纬度；
// - 地理编码有多个同名地点时不再盲选第一个：结果列出候选，模型可用 location_index 重查；
// - 请求加超时/重试，失败返回可读文案而不是把异常抛给模型。
// ============================================================================

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const FETCH_TIMEOUT_MS = 15_000

const CURRENT_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'apparent_temperature',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'weather_code',
  'cloud_cover',
  'pressure_msl',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m'
]

const HOURLY_VARS = [
  'temperature_2m',
  'precipitation_probability',
  'precipitation',
  'weather_code',
  'wind_speed_10m',
  'wind_direction_10m'
]

const DAILY_VARS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'apparent_temperature_max',
  'apparent_temperature_min',
  'precipitation_sum',
  'precipitation_probability_max',
  'precipitation_hours',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
  'sunrise',
  'sunset',
  'uv_index_max'
]

interface CurrentBlock {
  time?: string
  temperature_2m?: number | null
  relative_humidity_2m?: number | null
  apparent_temperature?: number | null
  precipitation?: number | null
  rain?: number | null
  showers?: number | null
  snowfall?: number | null
  weather_code?: number | null
  cloud_cover?: number | null
  pressure_msl?: number | null
  wind_speed_10m?: number | null
  wind_direction_10m?: number | null
  wind_gusts_10m?: number | null
}

interface DailyBlock {
  time?: string[]
  weather_code?: Array<number | null>
  temperature_2m_max?: Array<number | null>
  temperature_2m_min?: Array<number | null>
  apparent_temperature_max?: Array<number | null>
  apparent_temperature_min?: Array<number | null>
  precipitation_sum?: Array<number | null>
  precipitation_probability_max?: Array<number | null>
  precipitation_hours?: Array<number | null>
  wind_speed_10m_max?: Array<number | null>
  wind_gusts_10m_max?: Array<number | null>
  wind_direction_10m_dominant?: Array<number | null>
  sunrise?: Array<string | null>
  sunset?: Array<string | null>
  uv_index_max?: Array<number | null>
}

interface HourlyBlock {
  time?: string[]
  temperature_2m?: Array<number | null>
  precipitation_probability?: Array<number | null>
  precipitation?: Array<number | null>
  weather_code?: Array<number | null>
  wind_speed_10m?: Array<number | null>
  wind_direction_10m?: Array<number | null>
}

interface ForecastResponse {
  timezone?: string
  utc_offset_seconds?: number
  current?: CurrentBlock
  daily?: DailyBlock
  hourly?: HourlyBlock
}

interface CachedIp {
  lat?: unknown
  lon?: unknown
  city?: unknown
  regionName?: unknown
  country?: unknown
}

type GeoCandidate = Awaited<ReturnType<typeof geocodeLocation>>[number]

type ResolvedLocation =
  | {
      ok: true
      label: string
      lat: number
      lon: number
      candidates?: GeoCandidate[]
    }
  | { ok: false; message: string }

interface WeatherParams {
  location?: string
  latitude?: number
  longitude?: number
  location_index?: number
  forecast_days?: number
  include_current?: boolean
  include_daily?: boolean
  include_hourly?: boolean
  hourly_hours?: number
  hourly_date?: string
}

// ============================================================================
// 请求与格式化小工具
// ============================================================================

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function fetchJson<T>(url: string, label: string): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`${label} HTTP ${res.status}`)
      return (await res.json()) as T
    } catch (error) {
      lastError = error
      if (attempt === 0) await sleep(300)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function fixed(value: number | null | undefined, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'
}

function rounded(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : '—'
}

function timePart(value: string | null | undefined): string {
  if (!value) return '—'
  const index = value.indexOf('T')
  return index >= 0 ? value.slice(index + 1, index + 6) : value
}

function datePart(value: string | null | undefined): string | null {
  if (!value) return null
  return value.length >= 10 ? value.slice(0, 10) : value
}

function offsetText(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '+00:00'
  const sign = seconds < 0 ? '-' : '+'
  const abs = Math.abs(Math.round(seconds))
  const hours = String(Math.floor(abs / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((abs % 3600) / 60)).padStart(2, '0')
  return `${sign}${hours}:${minutes}`
}

function at<T>(arr: T[] | undefined, index: number): T | null {
  if (!arr || index < 0 || index >= arr.length) return null
  return arr[index] ?? null
}

// ============================================================================
// 地点解析
// ============================================================================

function validCoordinate(lat: unknown, lon: unknown): { lat: number; lon: number } | null {
  const latitude = Number(lat)
  const longitude = Number(lon)
  if (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  ) {
    return { lat: latitude, lon: longitude }
  }
  return null
}

async function resolveLocation(
  params: WeatherParams,
  tw: ReturnType<typeof getWeatherTexts>
): Promise<ResolvedLocation> {
  const hasLat = params.latitude !== undefined
  const hasLon = params.longitude !== undefined
  if (hasLat !== hasLon) {
    return { ok: false, message: tw.invalidCoordinates }
  }
  if (hasLat && hasLon) {
    const coords = validCoordinate(params.latitude, params.longitude)
    if (!coords) return { ok: false, message: tw.invalidCoordinates }
    return {
      ok: true,
      lat: coords.lat,
      lon: coords.lon,
      label:
        params.location?.trim() ||
        mainFormat(tw.coordinatesLabel, {
          lat: coords.lat.toFixed(4),
          lon: coords.lon.toFixed(4)
        })
    }
  }

  const location = params.location?.trim()
  if (location) {
    let results: GeoCandidate[]
    try {
      results = await geocodeLocation(location)
    } catch (error) {
      return { ok: false, message: mainFormat(tw.apiError, { reason: reasonOf(error) }) }
    }
    if (!results.length) return { ok: false, message: mainFormat(tw.notFound, { location }) }
    const index = clamp(params.location_index ?? 1, 1, results.length)
    if ((params.location_index ?? 1) > results.length) {
      return {
        ok: false,
        message: mainFormat(tw.locationIndexOutOfRange, {
          index: params.location_index,
          count: results.length
        })
      }
    }
    const geo = results[index - 1]
    const label = geo.admin1
      ? mainFormat(tw.locationWithAdmin, {
          name: geo.name,
          admin1: geo.admin1,
          country: geo.country
        })
      : mainFormat(tw.location, { name: geo.name, country: geo.country })
    return { ok: true, lat: geo.lat, lon: geo.lon, label, candidates: results }
  }

  // 没给地点/坐标：用启动时缓存的 IP 位置（底栏天气用的同一份数据）
  const ip = settingsStore.get('ip') as CachedIp | undefined
  const coords = validCoordinate(ip?.lat, ip?.lon)
  if (!coords) return { ok: false, message: tw.locationRequired }
  const city = typeof ip?.city === 'string' ? ip.city : ''
  const region = typeof ip?.regionName === 'string' ? ip.regionName : ''
  const country = typeof ip?.country === 'string' ? ip.country : ''
  const name = city || region || tw.currentLocation
  const label =
    city && country && region
      ? mainFormat(tw.locationWithAdmin, { name, admin1: region, country })
      : country
        ? mainFormat(tw.location, { name, country })
        : name
  return { ok: true, lat: coords.lat, lon: coords.lon, label }
}

// ============================================================================
// 响应渲染
// ============================================================================

function renderCurrent(current: CurrentBlock, tw: ReturnType<typeof getWeatherTexts>): string[] {
  const parts = [tw.currentHeader]
  parts.push(
    mainFormat(tw.condition, {
      condition: weatherCodeLabel(
        typeof current.weather_code === 'number' ? Math.round(current.weather_code) : -1,
        tw
      )
    })
  )
  parts.push(
    mainFormat(tw.temperature, {
      temp: fixed(current.temperature_2m),
      apparent: fixed(current.apparent_temperature)
    })
  )
  parts.push(mainFormat(tw.humidity, { humidity: rounded(current.relative_humidity_2m) }))
  parts.push(
    mainFormat(tw.wind, {
      speed: fixed(current.wind_speed_10m),
      direction:
        typeof current.wind_direction_10m === 'number'
          ? windDirectionLabelFor(current.wind_direction_10m, tw)
          : '—',
      gust: fixed(current.wind_gusts_10m)
    })
  )
  parts.push(
    mainFormat(tw.precipitation, {
      precip: fixed(current.precipitation),
      rain: fixed(current.rain),
      showers: fixed(current.showers),
      snow: fixed(current.snowfall)
    })
  )
  parts.push(
    mainFormat(tw.cloudPressure, {
      cloud: rounded(current.cloud_cover),
      pressure: fixed(current.pressure_msl)
    })
  )
  return parts
}

/**
 * 逐日预报：日期/周几用 API 返回的本地日期字符串，不再用系统时区拼；
 * 日出日落/紫外线来自 daily 变量，逐条拆成多行避免一行过长。
 */
function renderDaily(
  daily: DailyBlock | undefined,
  displayDays: number,
  today: string | null,
  tw: ReturnType<typeof getWeatherTexts>
): string[] {
  const times = daily?.time ?? []
  if (!daily || times.length === 0) return [tw.noDaily]
  const count = Math.min(times.length, displayDays)
  const parts = [mainFormat(tw.forecastHeader, { days: count })]
  for (let i = 0; i < count; i++) {
    const date = times[i]
    const label = date === today ? tw.today : weekdayLabelFor(new Date(`${date}T12:00:00`), tw)
    parts.push(
      mainFormat(tw.daily, {
        date,
        label,
        condition: weatherCodeLabel(Math.round(at(daily.weather_code, i) ?? -1), tw),
        min: fixed(at(daily.temperature_2m_min, i), 0),
        max: fixed(at(daily.temperature_2m_max, i), 0),
        feelsMin: fixed(at(daily.apparent_temperature_min, i), 0),
        feelsMax: fixed(at(daily.apparent_temperature_max, i), 0)
      })
    )
    parts.push(
      mainFormat(tw.dailyDetails, {
        precip: fixed(at(daily.precipitation_sum, i)),
        prob: rounded(at(daily.precipitation_probability_max, i)),
        hours: rounded(at(daily.precipitation_hours, i)),
        speed: fixed(at(daily.wind_speed_10m_max, i)),
        direction:
          typeof at(daily.wind_direction_10m_dominant, i) === 'number'
            ? windDirectionLabelFor(at(daily.wind_direction_10m_dominant, i)!, tw)
            : '—',
        gust: fixed(at(daily.wind_gusts_10m_max, i))
      })
    )
    parts.push(
      mainFormat(tw.dailyAstronomy, {
        uv: fixed(at(daily.uv_index_max, i)),
        sunrise: timePart(at(daily.sunrise, i)),
        sunset: timePart(at(daily.sunset, i))
      })
    )
  }
  return parts
}

function renderHourly(
  hourly: HourlyBlock | undefined,
  options: {
    hourlyDate?: string
    hourlyHours: number
    currentTime?: string
    today: string | null
  },
  tw: ReturnType<typeof getWeatherTexts>
): string[] {
  const times = hourly?.time ?? []
  if (!hourly || times.length === 0) return [tw.noHourly]
  const targetDate = options.hourlyDate
  const nowHour = options.currentTime ? `${options.currentTime.slice(0, 13)}:00` : null

  let indices: number[] = []
  if (targetDate) {
    indices = times
      .map((time, index) => ({ time, index }))
      .filter((entry) => entry.time.startsWith(targetDate))
      .filter((entry) => targetDate !== options.today || !nowHour || entry.time >= nowHour)
      .slice(0, Math.min(24, options.hourlyHours))
      .map((entry) => entry.index)
  } else {
    const found = times.findIndex((time) => !nowHour || time >= nowHour)
    if (found === -1) return [tw.hourlyUnavailable]
    indices = Array.from(
      { length: Math.min(options.hourlyHours, times.length - found) },
      (_value, offset) => found + offset
    )
  }

  if (indices.length === 0) return [tw.hourlyUnavailable]
  const parts = [
    targetDate
      ? mainFormat(tw.hourlyHeaderDate, { date: targetDate })
      : mainFormat(tw.hourlyHeaderHours, { hours: indices.length })
  ]
  for (const index of indices) {
    parts.push(
      mainFormat(tw.hourly, {
        time: timePart(times[index]),
        condition: weatherCodeLabel(Math.round(at(hourly.weather_code, index) ?? -1), tw),
        temp: fixed(at(hourly.temperature_2m, index)),
        prob: rounded(at(hourly.precipitation_probability, index)),
        precip: fixed(at(hourly.precipitation, index)),
        speed: fixed(at(hourly.wind_speed_10m, index)),
        direction:
          typeof at(hourly.wind_direction_10m, index) === 'number'
            ? windDirectionLabelFor(at(hourly.wind_direction_10m, index)!, tw)
            : '—'
      })
    )
  }
  return parts
}

function renderCandidates(
  candidates: GeoCandidate[] | undefined,
  tw: ReturnType<typeof getWeatherTexts>
): string[] {
  if (!candidates || candidates.length <= 1) return []
  const parts = [tw.otherLocations]
  candidates.forEach((candidate, index) => {
    parts.push(
      candidate.admin1
        ? mainFormat(tw.otherLocationWithAdmin, {
            index: index + 1,
            name: candidate.name,
            admin1: candidate.admin1,
            country: candidate.country
          })
        : mainFormat(tw.otherLocation, {
            index: index + 1,
            name: candidate.name,
            country: candidate.country
          })
    )
  })
  return parts
}

// ============================================================================
// 主流程
// ============================================================================

async function fetchWeather(params: WeatherParams): Promise<string> {
  const tw = getWeatherTexts()
  const forecastDays = clamp(params.forecast_days ?? 3, 1, 16)
  const hourlyHours = clamp(params.hourly_hours ?? 24, 1, 48)
  const hourlyDate = params.hourly_date?.trim() || undefined
  if (hourlyDate && !/^\d{4}-\d{2}-\d{2}$/.test(hourlyDate)) {
    return tw.invalidDate
  }
  const includeCurrent = params.include_current !== false
  const includeDaily = params.include_daily !== false
  const includeHourly = params.include_hourly === true || Boolean(hourlyDate)
  if (!includeCurrent && !includeDaily && !includeHourly) return tw.noSections

  const resolved = await resolveLocation(params, tw)
  if (!resolved.ok) return resolved.message

  let requestDays = forecastDays
  if (includeHourly) requestDays = Math.max(requestDays, Math.ceil(hourlyHours / 24) + 1)
  if (hourlyDate) requestDays = 16
  requestDays = Math.min(16, requestDays)

  const query = new URLSearchParams({
    latitude: String(resolved.lat),
    longitude: String(resolved.lon),
    timezone: 'auto',
    forecast_days: String(requestDays),
    current: CURRENT_VARS.join(','),
    daily: DAILY_VARS.join(',')
  })
  if (includeHourly) query.set('hourly', HOURLY_VARS.join(','))

  let response: ForecastResponse
  try {
    response = await fetchJson<ForecastResponse>(`${FORECAST_URL}?${query.toString()}`, 'weather')
  } catch (error) {
    return mainFormat(tw.apiError, { reason: reasonOf(error) })
  }

  const current = response.current
  const daily = response.daily
  const today = datePart(current?.time) ?? datePart(daily?.time?.[0])
  const parts: string[] = [`**${resolved.label}**`]

  const timezone = response.timezone
  if (timezone) {
    const offset = offsetText(response.utc_offset_seconds)
    parts.push(
      current?.time
        ? mainFormat(tw.timezoneLine, {
            timezone,
            offset,
            observedAt: current.time.replace('T', ' ')
          })
        : mainFormat(tw.timezoneLineNoObservation, { timezone, offset })
    )
  }
  parts.push('')

  if (includeCurrent) {
    parts.push(...(current ? renderCurrent(current, tw) : [tw.noCurrent]))
    parts.push('')
  }

  if (includeDaily) {
    // daily 只显示用户要的天数；hourly_date 落在更远日期时由逐小时段单独覆盖
    parts.push(...renderDaily(daily, forecastDays, today, tw))
    parts.push('')
  }

  if (includeHourly) {
    if (hourlyDate && !(daily?.time ?? []).includes(hourlyDate)) {
      parts.push(tw.hourlyUnavailable)
    } else {
      parts.push(
        ...renderHourly(
          response.hourly,
          {
            hourlyDate,
            hourlyHours,
            currentTime: current?.time,
            today
          },
          tw
        )
      )
    }
    parts.push('')
  }

  const candidates = renderCandidates(resolved.candidates, tw)
  if (candidates.length) parts.push(...candidates)

  return parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ============================================================================
// Tool Builder
// ============================================================================

export function buildGetWeatherTool(): StructuredToolInterface {
  return tool(async (params) => fetchWeather(params as WeatherParams), {
    name: 'get_weather',
    description:
      'Get current weather and forecasts for a location. Accepts a city/district name, latitude/longitude, or no location (uses the current IP-based location when available). Returns timezone and observation time, current conditions, a daily forecast (high/low, feels-like, precipitation, wind/gusts, UV, sunrise/sunset) and, when requested, hourly rows. Use include_hourly=true for rain timing questions; use hourly_date=YYYY-MM-DD for a specific day within 16 days. If geocoding is ambiguous the result lists candidates; call again with location_index to choose one.',
    schema: z.object({
      location: z
        .string()
        .optional()
        .describe(
          'City/district name in any language, e.g. "Beijing", "Guangzhou Tianhe District", "Tokyo". Omit to use the current IP-based location'
        ),
      latitude: z
        .number()
        .min(-90)
        .max(90)
        .optional()
        .describe('Latitude (-90..90); provide together with longitude'),
      longitude: z
        .number()
        .min(-180)
        .max(180)
        .optional()
        .describe('Longitude (-180..180); provide together with latitude'),
      location_index: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .default(1)
        .describe(
          'Which geocoding candidate to use (1-based, default 1). The result lists candidates when the name is ambiguous'
        ),
      forecast_days: z
        .number()
        .int()
        .min(1)
        .max(16)
        .optional()
        .default(3)
        .describe('Daily forecast days (1-16), default 3'),
      include_current: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include current conditions (default true)'),
      include_daily: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include the daily forecast (default true)'),
      include_hourly: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include hourly forecast (default false); use for rain timing'),
      hourly_hours: z
        .number()
        .int()
        .min(1)
        .max(48)
        .optional()
        .default(24)
        .describe('Hourly rows to return starting from now (1-48, default 24)'),
      hourly_date: z
        .string()
        .optional()
        .describe(
          "Local date YYYY-MM-DD within 16 days; returns that day's hourly rows and implies include_hourly=true"
        )
    })
  })
}
