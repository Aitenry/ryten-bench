import { getMainLanguage, mainFormat } from '../i18n'
import { getWeatherToolTexts } from '../i18n/tool-results-weather'

// ============================================================================
// 天气工具公共模块 — 风向、地理编码、日期格式化
// 用于 harness tool (weather.ts) 和底栏组件（主进程 weather.ts）共享
// 天气码/风向/周几的**文案**都在 src/main/i18n/tool-results-weather.ts，按语言取
// ============================================================================

/** 16 方位缩写（度数与风向词表共用下标：`Math.round(degrees / 22.5) % 16`） */
const WIND_DIRECTION_CODES = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW'
] as const

/** 度数 → 风向描述（按当前界面语言取词表） */
export function windDirectionLabelFor(degrees: number, texts = getWeatherTexts()): string {
  const key = WIND_DIRECTION_CODES[Math.round(degrees / 22.5) % 16]
  const map = texts.windDirections as Record<string, string>
  return map[key] ?? `${degrees.toFixed(0)}°`
}

/** 地理编码：地点名 → 经纬度候选列表（返回的地名按界面语言本地化） */
export async function geocodeLocation(
  location: string
): Promise<Array<{ lat: number; lon: number; name: string; admin1?: string; country: string }>> {
  // 结果会作为地名渲染在工具卡片上，所以 language 跟随界面语言而不是写死 zh
  const lang = getMainLanguage() === 'en-US' ? 'en' : 'zh'
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=5&language=${lang}&format=json`
  // 网络/HTTP 错误交给调用方转成可读文案；只有「确实没匹配」才返回空数组
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) })
  if (!res.ok) throw new Error(`geocoding HTTP ${res.status}`)
  const json = await res.json()
  if (!json.results?.length) return []
  return json.results.map(
    (r: {
      latitude: number
      longitude: number
      name: string
      admin1?: string
      country: string
    }) => ({
      lat: r.latitude,
      lon: r.longitude,
      name: r.name,
      admin1: r.admin1,
      country: r.country
    })
  )
}

/** Date → "YYYY-MM-DD" */
export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// ============================================================================
// 语言感知文案 — 工具卡片跟随界面语言（词条见 i18n/tool-results-weather.ts）
// ============================================================================

/** Date.getDay() → 词条键（0 = 周日） */
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/** 当前语言的天气工具文案（含天气码、风向、周几词表） */
export function getWeatherTexts(): ReturnType<typeof getWeatherToolTexts> {
  return getWeatherToolTexts()
}

/** 天气码 → 当前语言描述；未收录时回落到词条里的「天气码 N」兜底 */
export function weatherCodeLabel(code: number, texts = getWeatherTexts()): string {
  const codes = texts.codes as Record<number, string>
  return codes[code] ?? mainFormat(texts.unknownCode, { code })
}

/** Date → 当前语言周几 */
export function weekdayLabelFor(date: Date, texts = getWeatherTexts()): string {
  return texts.weekdays[WEEKDAY_KEYS[date.getDay()]]
}
