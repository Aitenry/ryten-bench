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
    // Country/region/city names appear in the footer weather and the System Info page, so the query language follows the UI language
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