import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef
} from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

/**
 * 终端渲染/输入组件（开源 xterm.js，MIT）——不再手写终端样式与光标。
 *
 * 分工：
 * - **xterm.js** 负责字体、选区、复制粘贴、ANSI 颜色/光标控制、滚动与输入事件；
 * - 本组件只做「行模式桥接」：把 xterm 的按键流攒成一行命令，Enter 时交给上层
 *   `onSend`（上层走已有 terminal-send 会话通道）。**不是真 PTY 流**：交互式全屏程序
 *   （vim/top 等）仍不支持，这一点与后端会话实现一致。
 * - 输出侧接收主进程的**原始快照**（保留 ANSI），按「新快照是否以旧快照开头」做增量
 *   write；被环形缓冲截断时 reset 重写。
 */

export interface TerminalEmulatorHandle {
  /** 追加一行系统提示（错误/超时等），走 xterm 自带换行 */
  writeLine: (text: string) => void
  /** 把焦点放回终端输入区 */
  focus: () => void
}

interface TerminalEmulatorProps {
  /** 最新输出快照（保留 ANSI 的原始文本） */
  output: string
  isDarkMode: boolean
  /** 命令发送：上层负责调用会话通道；返回后终端恢复输入 */
  onSend: (command: string) => void
  /** 命令执行中（期间仍可输入，但上层会拦截/报 busy） */
  busy?: boolean
}

const TerminalEmulator = forwardRef<TerminalEmulatorHandle, TerminalEmulatorProps>(
  ({ output, isDarkMode, onSend, busy = false }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const terminalRef = useRef<Terminal | null>(null)
    const fitRef = useRef<FitAddon | null>(null)
    const lastOutputRef = useRef('')
    const onSendRef = useRef(onSend)
    onSendRef.current = onSend
    const busyRef = useRef(busy)
    busyRef.current = busy

    useImperativeHandle(
      ref,
      () => ({
        writeLine: (text: string): void => {
          const terminal = terminalRef.current
          if (!terminal) return
          terminal.write(`\r\n${text.replace(/\r?\n/g, '\r\n')}`)
        },
        focus: (): void => terminalRef.current?.focus()
      }),
      []
    )

    // 创建 / 销毁 xterm 实例（只挂载一次）
    useEffect(() => {
      const container = containerRef.current
      if (!container) return
      const terminal = new Terminal({
        convertEol: true,
        cursorBlink: true,
        cursorStyle: 'bar',
        fontSize: 11.8,
        lineHeight: 1.25,
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

      // 行模式输入：本地回显 + Enter 提交；Ctrl+C 只清当前行（不中断远端命令）
      let line = ''
      const dataDisposable = terminal.onData((data) => {
        for (const char of data) {
          if (char === '\r' || char === '\n') {
            terminal.write('\r\n')
            const command = line
            line = ''
            if (command.trim()) {
              if (busyRef.current) {
                terminal.write('\x1b[33m上一条命令还在运行，等它结束后再发送\x1b[0m\r\n')
              } else {
                onSendRef.current(command)
              }
            }
            continue
          }
          if (char === '\u007f' || char === '\b') {
            if (line.length > 0) {
              line = line.slice(0, -1)
              terminal.write('\b \b')
            }
            continue
          }
          if (char === '\u0003') {
            line = ''
            terminal.write('^C\r\n')
            continue
          }
          if (char < ' ') continue
          if (line.length >= 4000) continue
          line += char
          terminal.write(char)
        }
      })

      const doFit = (): void => {
        try {
          fit.fit()
        } catch {
          // 容器暂时不可见（页签切换/收起）时 fit 会抛错：忽略，下次可见时再算
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
        resizeObserver.disconnect()
        dataDisposable.dispose()
        terminal.dispose()
        terminalRef.current = null
        fitRef.current = null
        lastOutputRef.current = ''
      }
      // isDarkMode 变化只更新主题，见下一个 effect；这里刻意不重建实例
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // 主题切换：原地更新 xterm 主题
    useEffect(() => {
      if (terminalRef.current) terminalRef.current.options.theme = terminalTheme(isDarkMode)
    }, [isDarkMode])

    // 输出同步：增量 write；快照回退（环形缓冲截断）时 reset 重写
    useEffect(() => {
      const terminal = terminalRef.current
      if (!terminal) return
      const previous = lastOutputRef.current
      if (output === previous) return
      if (output.startsWith(previous)) {
        const delta = output.slice(previous.length)
        if (delta) terminal.write(delta)
      } else {
        terminal.reset()
        terminal.write(output)
      }
      lastOutputRef.current = output
    }, [output])

    return (
      <div className="terminal-emulator" data-terminal-emulator="1">
        <div ref={containerRef} className="terminal-emulator-host" />
        {/* 供 E2E / 无障碍读取的纯文本镜像（xterm 用 canvas 渲染，DOM 里没有正文） */}
        <div
          className="terminal-emulator-mirror"
          data-terminal-text="1"
          aria-hidden="true"
        >
          {output}
        </div>
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
