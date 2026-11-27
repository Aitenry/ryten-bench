import React, { useEffect, useRef, useState } from 'react'
import { theme } from 'antd'
import { RiSparkling2Line } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import type { PendingProposalView } from '../../utils/harness/proposal'

/**
 * propose_action 的**输入区预填条**（2026-11-27 用户口径，替代消息流卡片）。
 *
 * 形态：`[ ✦ <AI 推荐内容，可编辑>  ✕  › ]` —— 替换输入框、位于沙箱授权同一位置；
 * - 默认回填第一个动作的 reply（无则 label）；
 * - Enter / › 发送当前内容（走与手动发送同一条管线，生成中会排队）；
 * - ✕ 关闭：不发消息（模型本轮已结束，无需通知），普通输入框立即恢复；
 * - 消息流里不再保留任何 propose_action 卡片/问题/选项。
 */

interface ProposalPrefillBarProps {
  proposal: PendingProposalView
  onSend: (text: string) => void
  onDismiss: () => void
}

const ProposalPrefillBar: React.FC<ProposalPrefillBarProps> = ({
  proposal,
  onSend,
  onDismiss
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [value, setValue] = useState(proposal.recommendedText)
  const inputRef = useRef<HTMLInputElement>(null)

  // 换了一条提议：重新回填 AI 推荐内容并把光标放到末尾
  useEffect(() => {
    setValue(proposal.recommendedText)
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    })
  }, [proposal.key, proposal.recommendedText])

  const send = (): void => {
    const text = value.trim()
    if (!text) return
    onSend(text)
  }

  return (
    <div className="proposal-prefill-wrap" data-proposal-prefill="1">
      <div
        className="proposal-prefill-bar"
        style={{
          borderColor: token.colorPrimaryBorder,
          background: token.colorBgContainer,
          boxShadow: `0 0 0 3px ${token.colorPrimaryBg}`
        }}
      >
        <span
          className="proposal-prefill-spark"
          aria-hidden="true"
          style={{ color: token.colorPrimary, background: token.colorPrimaryBg }}
        >
          <RiSparkling2Line size={13} />
        </span>
        <input
          ref={inputRef}
          data-proposal-input="1"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onDismiss()
            }
          }}
          aria-label={t('harness.proposalBar.ariaLabel')}
          style={{ color: token.colorText }}
        />
        <button
          type="button"
          className="proposal-prefill-x"
          data-proposal-dismiss="1"
          title={t('harness.proposalBar.dismiss')}
          aria-label={t('harness.proposalBar.dismiss')}
          onClick={onDismiss}
          style={{
            color: token.colorTextTertiary,
            borderColor: token.colorBorderSecondary,
            background: token.colorFillQuaternary
          }}
        >
          ✕
        </button>
        <button
          type="button"
          className="proposal-prefill-send"
          data-proposal-send="1"
          title={t('harness.proposalBar.send')}
          aria-label={t('harness.proposalBar.send')}
          disabled={!value.trim()}
          onClick={send}
        >
          ›
        </button>
      </div>
      <style>{prefillStyles}</style>
    </div>
  )
}

const prefillStyles = `
.proposal-prefill-wrap { position: relative; }
.proposal-prefill-bar { display: flex; align-items: center; gap: 9px; min-height: 50px; padding: 0 9px 0 13px; border: 1px solid; border-radius: 14px; }
.proposal-prefill-spark { width: 20px; height: 20px; border-radius: 7px; display: grid; place-items: center; flex: 0 0 auto; }
.proposal-prefill-bar input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font: inherit; font-size: 13px; line-height: 1.5; padding: 12px 0; }
.proposal-prefill-x { width: 24px; height: 24px; border-radius: 50%; border: 1px solid; background: transparent; display: grid; place-items: center; font-size: 11px; cursor: pointer; flex: 0 0 auto; }
.proposal-prefill-send { width: 28px; height: 28px; border-radius: 50%; border: none; background: #1f2329; color: #fff; display: grid; place-items: center; font-size: 15px; font-weight: 600; cursor: pointer; flex: 0 0 auto; padding-bottom: 2px; }
.proposal-prefill-send:disabled { opacity: .45; cursor: default; }
`

export default ProposalPrefillBar
