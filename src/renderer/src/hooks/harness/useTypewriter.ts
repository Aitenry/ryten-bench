import { useState, useRef, useEffect } from 'react'

/** 打字机效果 Hook：逐字输出文本 */
export const useTypewriter = (
  text: string,
  speed = 80,
  startDelay = 0
): { displayedText: string; isDone: boolean } => {
  const [displayedText, setDisplayedText] = useState('')
  const [isDone, setIsDone] = useState(false)

  useEffect(() => {
    setDisplayedText('')
    setIsDone(false)
    let i = 0
    let cancelled = false
    let interval: ReturnType<typeof setInterval> | null = null

    const timeout = setTimeout(() => {
      interval = setInterval(() => {
        if (cancelled) return
        if (i < text.length) {
          setDisplayedText(text.slice(0, i + 1))
          i++
        } else {
          if (interval) clearInterval(interval)
          setIsDone(true)
        }
      }, speed)
    }, startDelay)

    // 修复：interval 句柄提升到 effect 作用域,cleanup 时一并清除
    //（此前外层 return 只清 timeout,已启动的 interval 永久空转）
    return () => {
      cancelled = true
      clearTimeout(timeout)
      if (interval) clearInterval(interval)
    }
  }, [text, speed, startDelay])

  return { displayedText, isDone }
}

/** 循环打字机 Hook：逐字输出 → 暂停 → 从右删 → 切下一句 → 循环 */
export const useCyclingTypewriter = (
  texts: string[],
  typeSpeed = 60,
  deleteSpeed = 40,
  pauseMs = 1500,
  startDelay = 0
): { displayedText: string; isDone: boolean } => {
  const [displayedText, setDisplayedText] = useState('')
  const [isDone, setIsDone] = useState(false)
  const textsRef = useRef(texts)
  textsRef.current = texts

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let currentIdx = 0
    const list = textsRef.current
    if (list.length === 0) return

    const typeChar = (charIdx: number): void => {
      if (cancelled) return
      const text = list[currentIdx]
      if (charIdx < text.length) {
        setDisplayedText(text.slice(0, charIdx + 1))
        timer = setTimeout(() => typeChar(charIdx + 1), typeSpeed)
      } else {
        setIsDone(true)
        timer = setTimeout(deleteChar, pauseMs)
      }
    }

    const deleteChar = (charIdx?: number): void => {
      if (cancelled) return
      const text = list[currentIdx]
      const idx = charIdx ?? text.length
      if (idx > 0) {
        setDisplayedText(text.slice(0, idx - 1))
        timer = setTimeout(() => deleteChar(idx - 1), deleteSpeed)
      } else {
        setDisplayedText('')
        currentIdx = (currentIdx + 1) % list.length
        setIsDone(false)
        timer = setTimeout(() => typeChar(0), 200)
      }
    }

    const timeout = setTimeout(() => typeChar(0), startDelay)

    return () => {
      cancelled = true
      clearTimeout(timeout)
      if (timer) clearTimeout(timer)
    }
  }, [typeSpeed, deleteSpeed, pauseMs, startDelay])

  return { displayedText, isDone }
}
