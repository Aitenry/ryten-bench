import { tool } from '@langchain/core/tools'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { fetchWeatherApi } from 'openmeteo'
import * as z from 'zod/v4'
import { mainFormat } from '../../i18n'
import {
  geocodeLocation,
  formatDate,
  getWeatherTexts,
  weatherCodeLabel,
  windDirectionLabelFor,
  weekdayLabelFor
} from '../../shared/weather-utils'

// ============================================================================
// Weather Tool — 天气查询
// ============================================================================

async function fetchWeather(location: string, forecastDays: number): Promise<string> {
  const tw = getWeatherTexts()
  const results = await geocodeLocation(location)
  if (!results.length) return mainFormat(tw.notFound, { location })
  const geo = results[0]
  const locationName = geo.admin1
    ? mainFormat(tw.locationWithAdmin, { name: geo.name, admin1: geo.admin1, country: geo.country })
    : mainFormat(tw.location, { name: geo.name, country: geo.country })

  const params = {
    latitude: [geo.lat],
    longitude: [geo.lon],
    current:
      'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m,apparent_temperature',
    daily:
      'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant',
    forecast_days: Math.max(forecastDays, 1),
    timezone: 'auto'
  }
  const responses = await fetchWeatherApi('https://api.open-meteo.com/v1/forecast', params)
  const response = responses[0]
  const utcOffset = response.utcOffsetSeconds() ?? 0
  const parts: string[] = [`**${locationName}**\n`]

  const current = response.current()
  if (current) {
    const temp = current.variables(0)!.value()
    const code = current.variables(1)!.value()
    const wSpeed = current.variables(2)!.value()
    const wDir = current.variables(3)!.value()
    const humidity = current.variables(4)!.value()
    const apparent = current.variables(5)!.value()
    parts.push(tw.currentHeader)
    parts.push(mainFormat(tw.condition, { condition: weatherCodeLabel(code, tw) }))
    parts.push(mainFormat(tw.temperature, { temp: temp.toFixed(1), apparent: apparent.toFixed(1) }))
    parts.push(mainFormat(tw.humidity, { humidity }))
    parts.push(
      mainFormat(tw.wind, { speed: wSpeed.toFixed(1), direction: windDirectionLabelFor(wDir, tw) })
    )
    parts.push('')
  }
  const daily = response.daily()
  if (daily) {
    const wc = daily.variables(0)!.valuesArray()!
    const tMax = daily.variables(1)!.valuesArray()!
    const tMin = daily.variables(2)!.valuesArray()!
    const aMax = daily.variables(3)!.valuesArray()!
    const aMin = daily.variables(4)!.valuesArray()!
    const precip = daily.variables(5)!.valuesArray()!
    const pProb = daily.variables(6)!.valuesArray()!
    const wMax = daily.variables(7)!.valuesArray()!
    const wDir = daily.variables(8)!.valuesArray()!
    const startTime = Number(daily.time())
    const interval = daily.interval()
    const todayStr = formatDate(new Date())
    parts.push(mainFormat(tw.forecastHeader, { days: wc.length }))
    for (let i = 0; i < wc.length; i++) {
      const dayTime = new Date((startTime + i * interval + utcOffset) * 1000)
      const dateStr = formatDate(dayTime)
      const label = dateStr === todayStr ? tw.today : weekdayLabelFor(dayTime, tw)
      parts.push(
        mainFormat(tw.daily, {
          date: dateStr,
          label,
          condition: weatherCodeLabel(Math.round(wc[i]), tw),
          min: tMin[i].toFixed(0),
          max: tMax[i].toFixed(0),
          feelsMin: aMin[i].toFixed(0),
          feelsMax: aMax[i].toFixed(0),
          precip: precip[i].toFixed(1),
          prob: pProb[i] ?? 0,
          speed: wMax[i].toFixed(1),
          direction: windDirectionLabelFor(wDir[i], tw)
        })
      )
    }
  }
  if (results.length > 1) {
    parts.push(tw.otherLocations)
    for (let i = 1; i < results.length; i++) {
      const r = results[i]
      parts.push(
        r.admin1
          ? mainFormat(tw.otherLocationWithAdmin, {
              name: r.name,
              admin1: r.admin1,
              country: r.country
            })
          : mainFormat(tw.otherLocation, { name: r.name, country: r.country })
      )
    }
  }
  return parts.join('\n')
}

// ============================================================================
// Tool Builder
// ============================================================================

export function buildGetWeatherTool(): StructuredToolInterface {
  return tool(async ({ location, forecast_days }) => fetchWeather(location, forecast_days ?? 3), {
    name: 'get_weather',
    description:
      'Get the current weather and the daily forecast for a location. Returns current conditions (temperature, apparent temperature, humidity, wind speed and direction, weather condition) and the daily forecast. Accepts city and district names, e.g. "Beijing", "Guangzhou Tianhe District", "Tokyo".',
    schema: z.object({
      location: z
        .string()
        .describe(
          'Location name. Accepts city and district names in any language, e.g. "Beijing", "Guangzhou", "Tokyo"'
        ),
      forecast_days: z
        .number()
        .int()
        .min(1)
        .max(16)
        .optional()
        .default(3)
        .describe(
          'Number of forecast days (1-16), default 3. For "today" or "now" use 1, "tomorrow" 2, "this week" 7'
        )
    })
  })
}
