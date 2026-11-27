import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef
} from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { harnessApi } from '../../api/harness'

/**
 * 终端组件：开源 xterm.js（MIT）+ 主进程 node-pty（真 PTY）。
 *
 * 与上一版「行模式桥接」不同：xterm 的 onData 原样写入 PTY（方向键、Ctrl+C、粘贴、
 * Tab 补全都由 shell 自己处理），PTY 原始输出直接回写 xterm（颜色/prompt/进度条/全屏
 * 程序都能工作）。切换页签或重开面板时先拉主进程的回放缓冲，再续实时流。
 *
 * 无障碍/E2E：xterm 用 canvas 渲染、DOM 里没有正文，因此维护一个 1px 隐藏文本镜像
 * `[data-terminal-text]`，内容与缓冲同源。
 */

export interface TerminalEmulatorHandle {
  focus: () => void
}

interface TerminalEmulatorProps {
  sessionId: string
  isDarkMode: boolean
  /** 进程退出（父组件刷新页签状态） */
  onExited?: (exitCode: number | null) => void
}

const TerminalEmulator = forwardRef<TerminalEmulatorHandle, TerminalEmulatorProps>(
  ({ sessionId, isDarkMode, onExited }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const mirrorRef = useRef<HTMLDivElement>(null)
    const terminalRef = useRef<Terminal | null>(null)
    const fitRef = useRef<FitAddon | null>(null)
    const mirrorTextRef = useRef('')
    const readyRef = useRef(false)
    const queuedRef = useRef<string[]>([])
    const onExitedRef = useRef(onExited)
    onExitedRef.current = onExited

    useImperativeHandle(ref, () => ({
      focus: (): void => terminalRef.current?.focus()
    }))

    useEffect(() => {
      const container = containerRef.current
      if (!container) return
      const terminal = new Terminal({
        convertEol: false,
        cursorBlink: true,
        cursorStyle: 'bar',
        fontSize: 12,
        lineHeight: 1.2,
        fontFamily: '"Cascadia Mono", Consolas, "SFMono-Regular", monospace',
        scrollback: 5000,
        allowTransparency: true,
        theme: terminalTheme(isDarkMode)
      })
      const fit = new FitAddon()
      terminal.loadAddon(fit)
      terminal.open(container)
      terminalRef.current = terminal
      fitRef.current = fit
      readyRef.current = false
      queuedRef.current = []
      mirrorTextRef.current = ''

      const appendMirror = (data: string): void => {
        mirrorTextRef.current += data
        if (mirrorTextRef.current.length > 200_000) {
          mirrorTextRef.current = mirrorTextRef.current.slice(-200_000)
        }
        if (mirrorRef.current) mirrorRef.current.textContent = mirrorTextRef.current
      }
      const write = (data: string): void => {
        if (!data) return
        terminal.write(data)
        appendMirror(data)
      }

      // xterm 输入 → PTY 原样写入
      const dataDisposable = terminal.onData((data) => {
        void harnessApi.ptyTerminal.write(sessionId, data)
      })
      // 窗口尺寸 → PTY resize（fit 后会自动触发）
      const resizeDisposable = terminal.onResize(({ cols, rows }) => {
        void harnessApi.ptyTerminal.resize(sessionId, cols, rows)
      })

      // 实时输出（先排队，回放缓冲写完再放行，避免顺序错乱）
      const unsubscribeData = harnessApi.ptyTerminal.onData((payload) => {
        if (payload.sessionId !== sessionId) return
        if (!readyRef.current) {
          queuedRef.current.push(payload.data)
          return
        }
        write(payload.data)
      })
      const unsubscribeExit = harnessApi.ptyTerminal.onExit((payload) => {
        if (payload.sessionId !== sessionId) return
        const code = payload.exitCode
        write(
          code == null
            ? '\r\n\x1b[33m[终端已关闭]\x1b[0m\r\n'
            : `\r\n\x1b[33m[进程已退出，退出码 ${code}]\x1b[0m\r\n`
        )
        onExitedRef.current?.(code)
      })

      // 先回放历史缓冲，再放行实时流
      void harnessApi.ptyTerminal
        .buffer(sessionId)
        .then((result) => {
          if (terminalRef.current !== terminal) return
          if (result.ok && result.data) write(result.data)
          readyRef.current = true
          const queued = queuedRef.current
          queuedRef.current = []
          for (const chunk of queued) write(chunk)
        })
        .catch(() => {
          readyRef.current = true
          const queued = queuedRef.current
          queuedRef.current = []
          for (const chunk of queued) write(chunk)
        })

      const doFit = (): void => {
        try {
          fit.fit()
        } catch {
          // 容器暂时不可见（页签切换/收起）：忽略，下次可见再算
        }
      }
      doFit()
      const resizeObserver = new ResizeObserver(doFit)
      resizeObserver.observe(container)
      window.setTimeout(() => {
        doFit()
        terminal.focus()
      }, 30)

      return () => {
        unsubscribeData()
        unsubscribeExit()
        resizeObserver.disconnect()
        dataDisposable.dispose()
        resizeDisposable.dispose()
        terminal.dispose()
        terminalRef.current = null
        fitRef.current = null
      }
      // 主题切换只更新 options，见下一个 effect
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId])

    useEffect(() => {
      if (terminalRef.current) terminalRef.current.options.theme = terminalTheme(isDarkMode)
    }, [isDarkMode])

    return (
      <div className="terminal-emulator" data-terminal-emulator="1">
        <div ref={containerRef} className="terminal-emulator-host" />
        <div
          ref={mirrorRef}
          className="terminal-emulator-mirror"
          data-terminal-text="1"
          aria-hidden="true"
        />
        <style>{terminalEmulatorStyles}</style>
      </div>
    )
  }
)

function terminalTheme(isDarkMode: boolean): Record<string, string> {
  return isDarkMode
    ? {
        background: '#16181d',
        foreground: '#d7dae0',
        cursor: '#7ee787',
        cursorAccent: '#16181d',
        selectionBackground: 'rgba(121,192,255,.28)',
        black: '#484f58',
        red: '#ff7b72',
        green: '#7ee787',
        yellow: '#e3b341',
        blue: '#79c0ff',
        magenta: '#d2a8ff',
        cyan: '#56d4dd',
        white: '#d7dae0',
        brightBlack: '#8b949e',
        brightRed: '#ffa198',
        brightGreen: '#b3f0ae',
        brightYellow: '#f2cc60',
        brightBlue: '#a5d6ff',
        brightMagenta: '#e2c5ff',
        brightCyan: '#9aeef4',
        brightWhite: '#ffffff'
      }
    : {
        background: '#f7f8fa',
        foreground: '#2b3038',
        cursor: '#2b3038',
        cursorAccent: '#f7f8fa',
        selectionBackground: 'rgba(77,107,254,.18)',
        black: '#2b3038',
        red: '#c0392b',
        green: '#0b7a3b',
        yellow: '#a86f0d',
        blue: '#0b5cad',
        magenta: '#7b3fbf',
        cyan: '#0d7f8f',
        white: '#f7f8fa',
        brightBlack: '#9298a4',
        brightRed: '#d64545',
        brightGreen: '#11994d',
        brightYellow: '#c08a12',
        brightBlue: '#1a74c9',
        brightMagenta: '#9455d6',
        brightCyan: '#1a9aab',
        brightWhite: '#ffffff'
      }
}

const terminalEmulatorStyles = `
.terminal-emulator { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; margin: 10px; border-radius: 10px; overflow: hidden; border: 1px solid rgba(127,127,127,.22); }
.terminal-emulator-host { flex: 1; min-height: 0; padding: 8px 4px 8px 10px; }
.terminal-emulator-host .xterm { height: 100%; }
.terminal-emulator-host .xterm-viewport { background: transparent !important; }
.terminal-emulator-mirror { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: pre; pointer-events: none; }
`

TerminalEmulator.displayName = 'TerminalEmulator'

export default TerminalEmulator
