import { getMainLanguage } from './index'

/**
 * 天气工具（get_weather）的返回文案——**会渲染在聊天的工具调用卡片上**，因此跟随界面语言。
 *
 * 与 `messages.ts` 的 `weather` 分工：那边是底栏天气组件（主进程把缓存下发给渲染层前用它
 * 渲染 weatherDesc / label）；这里是工具把手里的结果告诉用户的话术，含天气码、风向、周几
 * 三张词表——`shared/weather-utils.ts` 的 weatherCodeMap / windDirectionLabel / weekdayLabel
 * 是这一路的旧中文表，只服务于主进程缓存的历史字段。
 *
 * 中文是源语言，`enUSWeatherToolTexts` 用 `typeof` 约束，缺键/多键都是编译期错误。
 * 插值统一 `{{name}}`，由 `mainFormat` 替换（中英句式不同，占位符顺序由词条决定）。
 */
export const zhCNWeatherToolTexts = {
  // ----- 地点 -----
  /** 地理编码没命中 */
  notFound: '未找到地点 "{{location}}" 的天气信息。',
  /** 首选地点显示名：中文用全角顿号与括号，英文用半角逗号与括号 */
  locationWithAdmin: '{{name}}，{{admin1}}（{{country}}）',
  location: '{{name}}（{{country}}）',
  coordinatesLabel: '经纬度 {{lat}}, {{lon}}',
  currentLocation: '当前位置',
  locationIndexOutOfRange: 'location_index={{index}} 超出范围（可用 1–{{count}}）。',
  locationRequired: '请提供地点名称、经纬度，或先让应用获取到本机位置。',
  invalidCoordinates: '经纬度不合法：必须同时提供 latitude（-90~90）与 longitude（-180~180）。',
  apiError: '天气服务请求失败：{{reason}}。请稍后重试。',
  invalidDate: 'hourly_date 必须是 YYYY-MM-DD 格式。',
  noSections: 'include_current / include_daily / include_hourly 不能同时为 false。',
  noCurrent: '天气服务没有返回当前实况。',
  noDaily: '天气服务没有返回逐日预报。',
  noHourly: '天气服务没有返回逐小时预报。',
  hourlyUnavailable: '指定日期没有可用的逐小时数据（预报范围最长 16 天）。',
  /** 其他匹配地点（用 location_index 选择） */
  otherLocations: '\n**匹配地点（用 location_index 选择）：**',
  otherLocationWithAdmin: '  [{{index}}] {{name}}, {{admin1}}, {{country}}',
  otherLocation: '  [{{index}}] {{name}}, {{country}}',

  // ----- 当前实况 -----
  timezoneLine: '时区：{{timezone}}（UTC{{offset}}） · 观测时间：{{observedAt}}',
  timezoneLineNoObservation: '时区：{{timezone}}（UTC{{offset}}）',
  currentHeader: '**当前实况**',
  condition: '  天气：{{condition}}',
  temperature: '  气温：{{temp}}°C（体感 {{apparent}}°C）',
  humidity: '  湿度：{{humidity}}%',
  wind: '  风：{{direction}} {{speed}} km/h（阵风 {{gust}} km/h）',
  precipitation: '  降水：{{precip}} mm（雨 {{rain}} mm / 阵雨 {{showers}} mm / 雪 {{snow}} cm）',
  cloudPressure: '  云量：{{cloud}}% · 气压：{{pressure}} hPa',

  // ----- 未来预报 -----
  forecastHeader: '**未来 {{days}} 天预报**\n',
  today: '今天',
  daily:
    '  **{{date}} {{label}}**：{{condition}}，{{min}}～{{max}}°C（体感 {{feelsMin}}～{{feelsMax}}°C）',
  dailyDetails:
    '    降水 {{precip}}mm（概率 {{prob}}%，{{hours}} 小时） · 风 {{speed}}km/h {{direction}}（阵风 {{gust}}km/h）',
  dailyAstronomy: '    紫外线 {{uv}} · 日出 {{sunrise}} · 日落 {{sunset}}',
  hourlyHeaderHours: '**逐小时预报（未来 {{hours}} 小时）**',
  hourlyHeaderDate: '**逐小时预报（{{date}}）**',
  hourly:
    '  {{time}} {{condition}}，{{temp}}°C，降水概率 {{prob}}% / {{precip}}mm，风 {{speed}}km/h {{direction}}',

  /** 天气码不在词表里时的兜底（weatherCodeLabel 用） */
  unknownCode: '天气码 {{code}}',

  /** WMO 天气码 → 描述（28 条，与 shared/weather-utils.ts 的 weatherCodeMap 同集） */
  codes: {
    0: '晴天',
    1: '大部晴朗',
    2: '局部多云',
    3: '多云',
    45: '有雾',
    48: '冰雾',
    51: '小毛毛雨',
    53: '中毛毛雨',
    55: '大毛毛雨',
    56: '小冻毛毛雨',
    57: '大冻毛毛雨',
    61: '小雨',
    63: '中雨',
    65: '大雨',
    66: '小冻雨',
    67: '大冻雨',
    71: '小雪',
    73: '中雪',
    75: '大雪',
    77: '雪粒',
    80: '小阵雨',
    81: '中阵雨',
    82: '大阵雨',
    85: '小阵雪',
    86: '大阵雪',
    95: '雷暴',
    96: '小冰雹雷暴',
    99: '大冰雹雷暴'
  },

  /** 16 方位缩写 → 风向描述 */
  windDirections: {
    N: '北风',
    NNE: '北东北风',
    NE: '东北风',
    ENE: '东东北风',
    E: '东风',
    ESE: '东东南风',
    SE: '东南风',
    SSE: '南东南风',
    S: '南风',
    SSW: '南西南风',
    SW: '西南风',
    WSW: '西西南风',
    W: '西风',
    WNW: '西西北风',
    NW: '西北风',
    NNW: '北西北风'
  },

  /** Date.getDay() 键（0 = 周日）→ 周几 */
  weekdays: {
    sun: '周日',
    mon: '周一',
    tue: '周二',
    wed: '周三',
    thu: '周四',
    fri: '周五',
    sat: '周六'
  }
}

export const enUSWeatherToolTexts: typeof zhCNWeatherToolTexts = {
  notFound: 'No weather information found for "{{location}}".',
  locationWithAdmin: '{{name}}, {{admin1}} ({{country}})',
  location: '{{name}} ({{country}})',
  coordinatesLabel: 'latitude {{lat}}, longitude {{lon}}',
  currentLocation: 'current location',
  locationIndexOutOfRange: 'location_index={{index}} is out of range (available: 1–{{count}}).',
  locationRequired:
    'Provide a location name or latitude/longitude, or let the app resolve the current IP-based location first.',
  invalidCoordinates:
    'Invalid coordinates: provide both latitude (-90..90) and longitude (-180..180).',
  apiError: 'Weather service request failed: {{reason}}. Please try again later.',
  invalidDate: 'hourly_date must use the YYYY-MM-DD format.',
  noSections: 'include_current / include_daily / include_hourly cannot all be false.',
  noCurrent: 'The weather service did not return current conditions.',
  noDaily: 'The weather service did not return a daily forecast.',
  noHourly: 'The weather service did not return an hourly forecast.',
  hourlyUnavailable:
    'No hourly data is available for that date (the forecast range is at most 16 days).',
  otherLocations: '\n**Matching locations (choose with location_index):**',
  otherLocationWithAdmin: '  [{{index}}] {{name}}, {{admin1}}, {{country}}',
  otherLocation: '  [{{index}}] {{name}}, {{country}}',

  timezoneLine: 'Timezone: {{timezone}} (UTC{{offset}}) · Observed: {{observedAt}}',
  timezoneLineNoObservation: 'Timezone: {{timezone}} (UTC{{offset}})',
  currentHeader: '**Current conditions**',
  condition: '  Condition: {{condition}}',
  temperature: '  Temperature: {{temp}}°C (feels like {{apparent}}°C)',
  humidity: '  Humidity: {{humidity}}%',
  wind: '  Wind: {{direction}} {{speed}} km/h (gusts {{gust}} km/h)',
  precipitation:
    '  Precipitation: {{precip}} mm (rain {{rain}} mm / showers {{showers}} mm / snow {{snow}} cm)',
  cloudPressure: '  Cloud cover: {{cloud}}% · Pressure: {{pressure}} hPa',

  forecastHeader: '**{{days}}-day forecast**\n',
  today: 'Today',
  daily:
    '  **{{date}} {{label}}**: {{condition}}, {{min}}-{{max}}°C (feels like {{feelsMin}}-{{feelsMax}}°C)',
  dailyDetails:
    '    Precipitation {{precip}}mm ({{prob}}% chance, {{hours}} h) · Wind {{speed}}km/h {{direction}} (gusts {{gust}}km/h)',
  dailyAstronomy: '    UV {{uv}} · Sunrise {{sunrise}} · Sunset {{sunset}}',
  hourlyHeaderHours: '**Hourly forecast (next {{hours}} hours)**',
  hourlyHeaderDate: '**Hourly forecast ({{date}})**',
  hourly:
    '  {{time}} {{condition}}, {{temp}}°C, precipitation {{prob}}% / {{precip}}mm, wind {{speed}}km/h {{direction}}',

  unknownCode: 'Weather code {{code}}',

  codes: {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail'
  },

  windDirections: {
    N: 'North',
    NNE: 'North-northeast',
    NE: 'Northeast',
    ENE: 'East-northeast',
    E: 'East',
    ESE: 'East-southeast',
    SE: 'Southeast',
    SSE: 'South-southeast',
    S: 'South',
    SSW: 'South-southwest',
    SW: 'Southwest',
    WSW: 'West-southwest',
    W: 'West',
    WNW: 'West-northwest',
    NW: 'Northwest',
    NNW: 'North-northwest'
  },

  weekdays: {
    sun: 'Sun',
    mon: 'Mon',
    tue: 'Tue',
    wed: 'Wed',
    thu: 'Thu',
    fri: 'Fri',
    sat: 'Sat'
  }
}

export function getWeatherToolTexts(): typeof zhCNWeatherToolTexts {
  return getMainLanguage() === 'en-US' ? enUSWeatherToolTexts : zhCNWeatherToolTexts
}
