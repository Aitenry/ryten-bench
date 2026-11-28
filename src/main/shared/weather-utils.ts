import { getMainLanguage, mainFormat } from '../i18n'
import { getWeatherToolTexts } from '../i18n/tool-results-weather'

// ============================================================================
// Shared weather tool module — wind direction, geocoding, date formatting
// Used by both the harness tool (weather.ts) and the status bar component (main-process weather.ts)
// The **text** for weather codes / wind directions / weekdays lives in
// src/main/i18n/tool-results-weather.ts and is looked up per language
// ============================================================================

/**
 * 16-point compass abbreviations (shared index with the wind-direction word list:
 * `Math.round(degrees / 22.5) % 16`)
 */
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

/** Degrees → wind direction description (word list taken in the current UI language) */
export function windDirectionLabelFor(degrees: number, texts = getWeatherTexts()): string {
  const key = WIND_DIRECTION_CODES[Math.round(degrees / 22.5) % 16]
  const map = texts.windDirections as Record<string, string>
  return map[key] ?? `${degrees.toFixed(0)}°`
}

/** Geocoding: place name → candidate lat/lon list (returned names are localized to the UI language) */
export async function geocodeLocation(
  location: string
): Promise<Array<{ lat: number; lon: number; name: string; admin1?: string; country: string }>> {
  // Results are rendered as place names on the tool card, so language follows the UI language
  // instead of being hard-coded to zh
  const lang = getMainLanguage() === 'en-US' ? 'en' : 'zh'
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=5&language=${lang}&format=json`
  // Network / HTTP errors are left to the caller to turn into readable text; only "really no match"
  // returns an empty array
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
// Language-aware text — tool cards follow the UI language (entries in i18n/tool-results-weather.ts)
// ============================================================================

/** Date.getDay() → entry key (0 = Sunday) */
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/** Weather tool text for the current language (incl. weather code, wind direction, weekday tables) */
export function getWeatherTexts(): ReturnType<typeof getWeatherToolTexts> {
  return getWeatherToolTexts()
}

/** Weather code → description in the current language; falls back to the "weather code N" entry when unknown */
export function weatherCodeLabel(code: number, texts = getWeatherTexts()): string {
  const codes = texts.codes as Record<number, string>
  return codes[code] ?? mainFormat(texts.unknownCode, { code })
}

/** Date → weekday name in the current language */
export function weekdayLabelFor(date: Date, texts = getWeatherTexts()): string {
  return texts.weekdays[WEEKDAY_KEYS[date.getDay()]]
}
