import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { theme } from 'antd'
import { useTranslation } from '@renderer/i18n'
import { useTheme } from '@renderer/hooks/useTheme'
import foxImage from '@renderer/assets/startup/fox.webp'
import type { Window } from '../../../resource/types/window'

/**
 * 主窗口内的启动页（用户 2026-11-20 口径）。
 *
 * 背景：原先是一个独立的「加载窗口」在初始化时显示，初始化完成后再交接主窗口。
 * 现在把启动页搬进主窗口：主窗口先显示（盖着这一页），所有初始化任务
 * （数据库 / 迁移 / 工作区 / 插件预取）完成、主界面首帧就绪后，这里淡出进入主界面。
 *
 * 吉祥物动画：把 GIF 拆成帧放在 `assets/startup/frames/` 下（文件名排序即播放顺序）。
 * 加载中用「反复看内容」的那段循环；初始化完成后按顺序播到最后一张再淡出。
 * 目前帧文件还没放进来（原始 GIF 附件转码后丢了动画），没有帧时退回静态图 + 轻微浮动。
 */
interface StartupSplashProps {
  /** 淡出结束后通知根组件移除启动页 */
  onDone: () => void
}

/** 启动页最短展示时间（初始化再快也别一闪而过） */
const MIN_SPLASH_MS = 450
/** 淡出动画时长（与 main.css 里的 transition 一致） */
const LEAVE_MS = 420
/** 动画帧间隔（毫秒/帧） */
const FRAME_INTERVAL_MS = 90
/** 循环段：加载中反复播放的「看内容」区间（帧序号，含端点；帧数量确定后再微调） */
const LOOP_START_FRAME = 0
const LOOP_END_FRAME = Number.MAX_SAFE_INTEGER
/** 完成播放的最后一段留一点时间展示末帧 */
const FINAL_HOLD_MS = 260

/** GIF 拆帧：文件名排序即播放顺序；目录为空时返回空数组 */
const frameModules = import.meta.glob('../../assets/startup/frames/*.{png,webp}', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>
const FRAME_URLS: string[] = Object.keys(frameModules)
  .sort()
  .map((key) => frameModules[key])

/** 吉祥物：有帧时按进度播放；没有帧时用静态图（CSS 负责轻微浮动） */
const SplashMascot: React.FC<{ complete: boolean; error: boolean }> = ({ complete, error }) => {
  const [index, setIndex] = useState(0)
  const frameRef = useRef(0)
  const frames = FRAME_URLS

  useEffect(() => {
    if (frames.length < 2) return
    let raf = 0
    let last = 0
    const loopEnd = Math.min(LOOP_END_FRAME, frames.length - 1)
    const step = (now: number): void => {
      if (now - last >= FRAME_INTERVAL_MS) {
        last = now
        if (complete || error) {
          // 完成/失败：播到最后一张后停住
          if (frameRef.current < frames.length - 1) {
            frameRef.current += 1
            setIndex(frameRef.current)
          }
        } else {
          // 加载中：在「反复看内容」的区间里循环
          frameRef.current = frameRef.current >= loopEnd ? LOOP_START_FRAME : frameRef.current + 1
          setIndex(frameRef.current)
        }
      }
      if (complete || error) {
        if (frameRef.current < frames.length - 1) raf = requestAnimationFrame(step)
        return
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [frames, complete, error])

  return (
    <div className={`startup-splash-mascot${error ? ' is-error' : ''}`}>
      {frames.length > 0 ? (
        <img src={frames[index]} alt="" draggable={false} />
      ) : (
        <img src={foxImage} alt="" draggable={false} />
      )}
    </div>
  )
}

const StartupSplash: React.FC<StartupSplashProps> = ({ onDone }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { effectiveTheme } = useTheme()
  const isDark = effectiveTheme === 'dark'
  const [progress, setProgress] = useState(0)
  const [task, setTask] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [complete, setComplete] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const mountedAtRef = useRef(performance.now())
  const finishedRef = useRef(false)

  /** 启动页配色跟随应用主题（黑/白两套都由 antd token 派生） */
  const splashVars = useMemo(
    () =>
      ({
        '--startup-bg': token.colorBgLayout,
        '--startup-title': token.colorText,
        '--startup-sub': token.colorTextSecondary,
        '--startup-track': token.colorFillTertiary,
        '--startup-fill': token.colorText,
        '--startup-percent': token.colorTextTertiary,
        '--startup-error': token.colorError,
        '--startup-mascot-shadow': isDark ? 'rgba(0, 0, 0, 0.55)' : 'rgba(28, 24, 18, 0.16)'
      }) as React.CSSProperties,
    [token, isDark]
  )

  const finish = useCallback(() => {
    if (finishedRef.current) return
    finishedRef.current = true
    setProgress(100)
    setTask('')
    setComplete(true)
    // 完成后再给末帧一点播放/停留时间，然后淡出
    const elapsed = performance.now() - mountedAtRef.current
    const wait = Math.max(0, MIN_SPLASH_MS - elapsed) + FINAL_HOLD_MS
    window.setTimeout(() => {
      setLeaving(true)
      window.setTimeout(onDone, LEAVE_MS)
    }, wait)
  }, [onDone])

  useEffect(() => {
    const loading = (window as unknown as Window).loading
    if (!loading) {
      onDone()
      return
    }
    let disposed = false
    const offProgress = loading.onInitProgress((data) => {
      if (disposed) return
      setProgress(Math.max(4, Math.min(99, data.progress)))
      if (data.currentTask) setTask(data.currentTask)
    })
    const offComplete = loading.onInitComplete(() => {
      if (!disposed) finish()
    })
    const offError = loading.onInitError((message) => {
      if (!disposed) setError(message)
    })
    // 启动页可能晚于初始化开始（极端情况下甚至已完成）：先取一次快照
    void loading
      .getInitState()
      .then((snapshot) => {
        if (disposed) return
        if (snapshot.error) {
          setError(snapshot.error)
          return
        }
        if (snapshot.complete) {
          finish()
          return
        }
        setProgress(Math.max(4, Math.min(99, snapshot.progress)))
        if (snapshot.currentTask) setTask(snapshot.currentTask)
      })
      .catch(() => {})
    return () => {
      disposed = true
      offProgress?.()
      offComplete?.()
      offError?.()
    }
  }, [finish, onDone])

  const subtitle = useMemo(() => {
    if (error) return t('shell.startup.failed')
    return task || t('shell.startup.preparing')
  }, [error, task, t])

  return (
    <div
      className={`startup-splash${leaving ? ' is-leaving' : ''}`}
      style={splashVars}
      role="status"
      aria-live="polite"
      aria-busy={!error}
    >
      <div className="startup-splash-inner">
        <SplashMascot complete={complete} error={Boolean(error)} />
        <h1 className="startup-splash-title">{t('shell.startup.title')}</h1>
        <p className={`startup-splash-subtitle${error ? ' is-error' : ''}`}>{subtitle}</p>
        {error ? (
          <div className="startup-splash-error">{error}</div>
        ) : (
          <>
            <div className="startup-splash-track">
              <div className="startup-splash-fill" style={{ width: `${Math.max(4, progress)}%` }} />
            </div>
            <div className="startup-splash-percent">{Math.round(progress)}%</div>
          </>
        )}
      </div>
    </div>
  )
}

export default StartupSplash
