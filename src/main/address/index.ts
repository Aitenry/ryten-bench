import logger from 'electron-log'
import axios from 'axios'
import { getMainLanguage } from '../i18n'

interface IpApiResponse {
  status: string
  country: string
  countryCode: string
  region: string
  regionName: string
  city: string
  zip: string
  lat: number
  lon: number
  timezone: string
  isp: string
  org: string
  as: string
  query: string
}

export const getIp = async (): Promise<IpApiResponse | null> => {
  try {
    // 国家/地区/城市名会显示在底栏天气与「系统信息」页，所以查询语言跟随界面语言
    const lang = getMainLanguage() === 'en-US' ? 'en' : 'zh-CN'
    const response = await axios.get(`http://ip-api.com/json/?lang=${lang}`, {
      timeout: 3000
    })
    return response.data
  } catch (error) {
    logger.error('Error fetching IP data:', (error as Error).message)
    return null
  }
}