/**
 * 天气工具回归（离线）：
 * - 地点解析：名称/经纬度/本机 IP 兜底、候选地点 location_index；
 * - 输出：当前实况、逐日（紫外线/日出日落/阵风）、逐小时（指定日期/未来 N 小时）；
 * - 失败路径：无地点、非法坐标、非法日期、上游 5xx。
 *
 * fetch 用本地假响应替换；electron / electron-store / electron-log 用 ai-selftest 的 stubPlugin。
 * 不访问真实 Open-Meteo。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildGetWeatherTool } from '../../src/main/tools/harness/weather'
import { settingsStore } from '../../src/main/context'

const GEO_URL = 'geocoding-api.open-meteo.com'
const FORECAST_URL = 'api.open-meteo.com/v1/forecast'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function hoursFor(startDate: string, count: number): string[] {
  const out: string[] = []
  const [year, month, day] = startDate.split('-').map((part) => Number(part))
  for (let i = 0; i < count; i++) {
    const date = new Date(Date.UTC(year, month - 1, day + Math.floor(i / 24)))
    const hour = String(i % 24).padStart(2, '0')
    out.push(
      `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
        date.getUTCDate()
      ).padStart(2, '0')}T${hour}:00`
    )
  }
  return out
}

function forecastFixture(): Record<string, unknown> {
  const times = hoursFor('2026-11-24', 48)
  return {
    timezone: 'Asia/Shanghai',
    utc_offset_seconds: 28800,
    current: {
      time: '2026-11-24T14:30',
      temperature_2m: 12.3,
      relative_humidity_2m: 45,
      apparent_temperature: 10.8,
      precipitation: 0,
      rain: 0,
      showers: 0,
      snowfall: 0,
      weather_code: 0,
      cloud_cover: 10,
      pressure_msl: 1020.1,
      wind_speed_10m: 15.2,
      wind_direction_10m: 180,
      wind_gusts_10m: 25
    },
    daily: {
      time: ['2026-11-24', '2026-11-25', '2026-11-26'],
      weather_code: [0, 61, 3],
      temperature_2m_max: [15, 14, 16],
      temperature_2m_min: [5, 6, 7],
      apparent_temperature_max: [14, 13, 15],
      apparent_temperature_min: [3, 4, 5],
      precipitation_sum: [0, 2.4, 0],
      precipitation_probability_max: [10, 80, 20],
      precipitation_hours: [0, 3, 0],
      wind_speed_10m_max: [20, 18, 22],
      wind_gusts_10m_max: [35, 30, 40],
      wind_direction_10m_dominant: [180, 90, 270],
      sunrise: ['2026-11-24T07:00', '2026-11-25T06:59', '2026-11-26T06:58'],
      sunset: ['2026-11-24T17:00', '2026-11-25T17:01', '2026-11-26T17:02'],
      uv_index_max: [3, 1, 4]
    },
    hourly: {
      time: times,
      temperature_2m: times.map((_time, index) => 10 + index * 0.1),
      precipitation_probability: times.map((_time, index) => (index % 4) * 10),
      precipitation: times.map((_time, index) => (index % 3 === 0 ? 0.2 : 0)),
      weather_code: times.map((_time, index) => (index % 4 === 0 ? 61 : 0)),
      wind_speed_10m: times.map((_time, index) => 8 + index * 0.1),
      wind_direction_10m: times.map(() => 180)
    }
  }
}

function geocodeFixture(): Record<string, unknown> {
  return {
    results: [
      { latitude: 39.9, longitude: 116.4, name: '北京', admin1: '北京市', country: '中国' },
      { latitude: 31.2, longitude: 121.5, name: '北京', admin1: '上海市', country: '中国' }
    ]
  }
}

function installFetch(handler: (url: string) => Response | Promise<Response>): {
  calls: string[]
  restore: () => void
} {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url)
    return handler(url)
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    }
  }
}

const baseHandler = (url: string): Response => {
  if (url.includes(GEO_URL)) return jsonResponse(geocodeFixture())
  if (url.includes(FORECAST_URL)) return jsonResponse(forecastFixture())
  return jsonResponse({}, 404)
}

test('天气：按名称查询并输出当前、逐日、指定日期逐小时', async () => {
  settingsStore.delete('ip')
  const fetchMock = installFetch(baseHandler)
  try {
    const tool = buildGetWeatherTool()
    const output = await tool.invoke({
      location: '北京',
      forecast_days: 2,
      include_hourly: true,
      hourly_date: '2026-11-25'
    } as never)
    const text = String(output)

    assert.match(text, /\*\*北京，北京市（中国）\*\*/)
    assert.match(text, /时区：Asia\/Shanghai（UTC\+08:00）/)
    assert.match(text, /观测时间：2026-11-24 14:30/)
    assert.match(text, /当前实况/)
    assert.match(text, /气温：12\.3°C（体感 10\.8°C）/)
    assert.match(text, /阵风 25\.0 km\/h/)
    assert.match(text, /未来 2 天预报/)
    assert.match(text, /紫外线 3\.0 · 日出 07:00 · 日落 17:00/)
    assert.match(text, /逐小时预报（2026-11-25）/)
    assert.match(text, /00:00 小雨，12\.4°C/) // 48 小时里的第 25 小时
    assert.match(text, /\[1\] 北京, 北京市, 中国/)
    assert.match(text, /\[2\] 北京, 上海市, 中国/)

    const forecastCall = fetchMock.calls.find((url) => url.includes(FORECAST_URL))
    assert.ok(forecastCall, 'forecast endpoint should be called')
    assert.match(forecastCall!, /forecast_days=16/)
    assert.match(forecastCall!, /hourly=/)
  } finally {
    fetchMock.restore()
  }
})

test('天气：location_index 选择候选地点', async () => {
  settingsStore.delete('ip')
  const fetchMock = installFetch(baseHandler)
  try {
    const tool = buildGetWeatherTool()
    const output = String(await tool.invoke({ location: '北京', location_index: 2 } as never))
    assert.match(output, /\*\*北京，上海市（中国）\*\*/)
  } finally {
    fetchMock.restore()
  }
})

test('天气：省略地点时使用缓存的 IP 位置，且不再请求地理编码', async () => {
  settingsStore.set('ip', {
    lat: 31.2,
    lon: 121.5,
    city: '上海',
    regionName: '上海市',
    country: '中国'
  })
  const fetchMock = installFetch(baseHandler)
  try {
    const tool = buildGetWeatherTool()
    const output = String(await tool.invoke({} as never))
    assert.match(output, /\*\*上海，上海市（中国）\*\*/)
    assert.equal(
      fetchMock.calls.some((url) => url.includes(GEO_URL)),
      false,
      'IP fallback should not geocode'
    )
  } finally {
    fetchMock.restore()
    settingsStore.delete('ip')
  }
})

test('天气：没有地点也没有 IP 时给出可操作提示', async () => {
  settingsStore.delete('ip')
  const fetchMock = installFetch(baseHandler)
  try {
    const tool = buildGetWeatherTool()
    const output = String(await tool.invoke({} as never))
    assert.match(output, /请提供地点名称、经纬度/)
    assert.equal(fetchMock.calls.length, 0)
  } finally {
    fetchMock.restore()
  }
})

test('天气：非法经纬度与非法日期在请求前就拒绝', async () => {
  settingsStore.delete('ip')
  const fetchMock = installFetch(baseHandler)
  try {
    const tool = buildGetWeatherTool()
    assert.match(String(await tool.invoke({ latitude: 39.9 } as never)), /必须同时提供 latitude/)
    assert.match(
      String(await tool.invoke({ location: '北京', hourly_date: '11-25' } as never)),
      /hourly_date 必须是 YYYY-MM-DD/
    )
    assert.equal(fetchMock.calls.length, 0)
  } finally {
    fetchMock.restore()
  }
})

test('天气：上游 5xx 返回可读错误而不是抛异常', async () => {
  settingsStore.delete('ip')
  const fetchMock = installFetch((url) => {
    if (url.includes(GEO_URL)) return jsonResponse(geocodeFixture())
    return jsonResponse({}, 500)
  })
  try {
    const tool = buildGetWeatherTool()
    const output = String(await tool.invoke({ location: '北京' } as never))
    assert.match(output, /天气服务请求失败/)
    assert.match(output, /HTTP 500/)
  } finally {
    fetchMock.restore()
  }
})
