import React from 'react'
import { useTranslation } from '@renderer/i18n'
import { useTypewriter, useCyclingTypewriter } from '../../hooks/harness/useTypewriter'

interface WelcomeIntroProps {
  colorText: string
  colorTextSecondary: string
}

/** Welcome copy keys: the text follows the active language, so only the keys are kept at module level */
const TITLE_KEY = 'harness.welcome.title' as const
const SUBTITLE_KEYS = [
  'harness.welcome.subtitleWeather',
  'harness.welcome.subtitleDocument',
  'harness.welcome.subtitleTodo',
  'harness.welcome.subtitleKnowledge'
] as const

/**
 * Welcome copy for an empty session.
 *
 * The typewriter is a high-frequency animation source that calls setState every 40–60ms, and the
 * cycling typewriter loops **forever**. So these two hooks must stay confined to this small
 * component: if mounted on useHarnessHandlers, the whole chat view (message area / input box /
 * sidebar / search box) would re-render roughly 25 times per second and never stop.
 */
const WelcomeIntro: React.FC<WelcomeIntroProps> = ({ colorText, colorTextSecondary }) => {
  const { t } = useTranslation()

  const titleText = t(TITLE_KEY)
  const subtitleTexts = SUBTITLE_KEYS.map((key) => t(key))

  const { displayedText: titleDisplayed, isDone: titleDone } = useTypewriter(titleText, 100)
  const { displayedText: subtitleDisplayed, isDone: subtitleDone } = useCyclingTypewriter(
    subtitleTexts,
    60,
    40,
    2000,
    titleText.length * 100
  )

  return (
    <div className="h-full flex flex-col items-center justify-center">
      <h1 className="text-2xl font-semibold mb-2 h-8" style={{ color: colorText }}>
        {titleDisplayed}
        {!titleDone && <span className="animate-pulse">|</span>}
      </h1>
      <p className="text-center max-w-md h-6" style={{ color: colorTextSecondary }}>
        {subtitleDisplayed}
        {titleDone && !subtitleDone && <span className="animate-pulse">|</span>}
      </p>
    </div>
  )
}

export default React.memo(WelcomeIntro)
