import React from 'react'
import { theme } from 'antd'
import { RiArrowDownLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

interface ScrollToBottomButtonProps {
  visible: boolean
  /** 当前话题是否正在流式输出：true 时按钮周边显示旋转光圈 */
  streaming: boolean
  isDarkMode: boolean
  onClick: () => void
}

/**
 * 滚动到底部悬浮按钮：圆形透明毛玻璃。
 * 点击回到最新消息；当前话题流式输出时，按钮周边有一圈沿主题色旋转的光弧。
 */
const ScrollToBottomButton: React.FC<ScrollToBottomButtonProps> = ({
  visible,
  streaming,
  isDarkMode,
  onClick
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const label = t('harness.messageArea.scrollToBottom')

  return (
    <div
      className={`harness-scroll-fab${visible ? ' visible' : ''}`}
      style={
        {
          '--fab-bg': isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.55)',
          '--fab-bg-hover': isDarkMode ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.8)',
          '--fab-border': isDarkMode ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.1)',
          '--fab-icon': isDarkMode ? 'rgba(255,255,255,0.72)' : 'rgba(0,0,0,0.55)',
          '--fab-shadow': isDarkMode ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.08)',
          '--fab-ring': token.colorPrimary
        } as React.CSSProperties
      }
    >
      {streaming && <span className="harness-scroll-fab-ring" />}
      <button
        type="button"
        className="harness-scroll-fab-btn"
        onClick={onClick}
        title={label}
        aria-label={label}
      >
        <RiArrowDownLine size={16} />
      </button>
      <style>{`
        .harness-scroll-fab {
          position: absolute;
          left: 50%;
          bottom: 20px;
          z-index: 30;
          opacity: 0;
          transform: translate(-50%, 10px) scale(0.92);
          pointer-events: none;
          transition: opacity 0.22s ease, transform 0.22s ease;
        }
        .harness-scroll-fab.visible {
          opacity: 1;
          transform: translate(-50%, 0) scale(1);
          pointer-events: auto;
        }
        .harness-scroll-fab-ring {
          position: absolute;
          inset: -4px;
          border-radius: 50%;
          background: conic-gradient(
            from 0deg,
            transparent 0deg,
            var(--fab-ring) 30deg,
            transparent 100deg,
            transparent 360deg
          );
          -webkit-mask: radial-gradient(
            farthest-side,
            transparent calc(100% - 3px),
            #000 calc(100% - 2px)
          );
          mask: radial-gradient(
            farthest-side,
            transparent calc(100% - 3px),
            #000 calc(100% - 2px)
          );
          animation: harness-scroll-fab-spin 1.4s linear infinite;
          pointer-events: none;
        }
        .harness-scroll-fab-btn {
          position: relative;
          width: 30px;
          height: 30px;
          border-radius: 50%;
          border: 1px solid var(--fab-border);
          background: var(--fab-bg);
          -webkit-backdrop-filter: blur(14px) saturate(1.3);
          backdrop-filter: blur(14px) saturate(1.3);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--fab-icon);
          cursor: pointer;
          box-shadow: 0 2px 10px var(--fab-shadow);
          transition: background 0.18s ease, transform 0.18s ease, border-color 0.18s ease;
        }
        .harness-scroll-fab-btn:hover {
          background: var(--fab-bg-hover);
          transform: translateY(-1px);
        }
        .harness-scroll-fab-btn:active {
          transform: scale(0.94);
        }
        @keyframes harness-scroll-fab-spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  )
}

export default ScrollToBottomButton
