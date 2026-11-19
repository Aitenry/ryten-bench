import React from 'react'
import { useTranslation } from '@renderer/i18n'
import { useTypewriter, useCyclingTypewriter } from '../hooks/useTypewriter'

interface WelcomeIntroProps {
  colorText: string
  colorTextSecondary: string
}

/** 欢迎语词条键：文案随语言切换，故只在模块级保存键名 */
const TITLE_KEY = 'harness.welcome.title' as const
const SUBTITLE_KEYS = [
  'harness.welcome.subtitleWeather',
  'harness.welcome.subtitleDocument',
  'harness.welcome.subtitleTodo',
  'harness.welcome.subtitleKnowledge'
] as const

/**
 * 空白会话欢迎语。
 *
 * 打字机是「每 40~60ms 一次 setState」的高频动画源，而循环打字机是**无限循环**的。
 * 因此这两个 hook 必须收敛在这个小组件内：若挂在 useHarnessHandlers 上，整个聊天视图
 * （消息区 / 输入框 / 侧边栏 / 搜索框）会被每秒重渲染约 25 次，永不停止。
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
