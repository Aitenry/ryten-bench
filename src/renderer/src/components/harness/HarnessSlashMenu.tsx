import React, { useMemo } from 'react'
import { theme } from 'antd'
import { useTranslation } from '@renderer/i18n'
import { filterSlashCommands, type HarnessSlashCommandId } from './slashCommands'

/**
 * 输入框命令面（slash menu）——在输入框**开头**输入 `/` 唤起。
 *
 * 形态参考 DSH 的输入框命令菜单：一个贴着输入卡片上沿的深色浮层，分组标题「添加」，
 * 每行从左到右是「图标 + 中文名 + 英文名 + 右侧说明」，第一行默认高亮，
 * 方向键移动、回车选中（键盘在输入框的 handleKeyDown 里统一处理）。
 *
 * 当前只保留两个与「目标 / 计划」相关的命令（截图里其余行被划掉）：
 * - 目标 goal：打开目标弹窗，设置或查看长期任务目标；
 * - 计划 plan：进入 / 退出计划模式。
 *
 * 过滤只按「`/` 后面的查询词」做子串匹配（中文名 / 英文名 / 说明），不区分大小写；
 * 查询词由父组件从编辑器文本里解析（遇到空白或过长就关闭菜单，避免压住正常输入）。
 */

interface HarnessSlashMenuProps {
  /** `/` 后面的查询文本 */
  query: string
  /** 键盘高亮下标（父组件维护，滚动/鼠标同步） */
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onPick: (id: HarnessSlashCommandId) => void
  /** 浮层容器 ref（父组件用它判断「点击在菜单内」） */
  menuRef?: React.RefObject<HTMLDivElement | null>
  style?: React.CSSProperties
}

const HarnessSlashMenu: React.FC<HarnessSlashMenuProps> = ({
  query,
  activeIndex,
  onActiveIndexChange,
  onPick,
  menuRef,
  style
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const rows = useMemo(() => filterSlashCommands((key) => t(key), query), [query, t])
  const active = rows.length === 0 ? -1 : Math.min(Math.max(activeIndex, 0), rows.length - 1)

  return (
    <div
      ref={menuRef}
      role="listbox"
      aria-label={t('harness.input.commands.aria')}
      data-harness-slash-menu="1"
      style={{
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 14,
        boxShadow: '0 18px 48px rgba(0, 0, 0, 0.32)',
        padding: '5px 0 4px',
        overflow: 'hidden',
        ...style
      }}
    >
      {/* 分组标题：与 DSH 的「添加」小节一致（当前两条命令都属于「添加」） */}
      <div
        style={{
          padding: '5px 14px 4px',
          fontSize: 11.5,
          lineHeight: '16px',
          color: token.colorTextTertiary,
          userSelect: 'none'
        }}
      >
        {t('harness.input.commands.groupAdd')}
      </div>

      {rows.length === 0 ? (
        <div
          style={{
            padding: '10px 14px 12px',
            fontSize: 12.5,
            color: token.colorTextTertiary
          }}
        >
          {t('harness.input.commands.empty')}
        </div>
      ) : (
        rows.map((command, index) => {
          const label = t(command.labelKey)
          // 本地化标题与英文名只差大小写时不重复显示（与 DSH 菜单同一规则）
          const showAlias = label.toLowerCase() !== command.alias.toLowerCase()
          const Icon = command.icon
          const selected = index === active
          return (
            <button
              key={command.id}
              type="button"
              role="option"
              aria-selected={selected}
              data-harness-slash-command={command.id}
              // mousedown 而不是 click：不让焦点离开编辑器（输入框保持光标/草稿状态）
              onMouseDown={(event) => {
                event.preventDefault()
                onPick(command.id)
              }}
              onMouseMove={() => {
                if (!selected) onActiveIndexChange(index)
              }}
              style={{
                width: '100%',
                height: 40,
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '0 14px',
                border: 'none',
                background: selected ? token.colorFillTertiary : 'transparent',
                color: token.colorText,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 0.12s'
              }}
            >
              <Icon size={16} style={{ color: token.colorTextSecondary, flexShrink: 0 }} />
              <span style={{ fontSize: 13.5, fontWeight: 500, lineHeight: '18px' }}>{label}</span>
              {showAlias ? (
                <span style={{ fontSize: 12, color: token.colorTextTertiary, lineHeight: '18px' }}>
                  {command.alias}
                </span>
              ) : null}
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 12,
                  color: token.colorTextTertiary,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  paddingLeft: 16
                }}
              >
                {t(command.descriptionKey)}
              </span>
            </button>
          )
        })
      )}
    </div>
  )
}

export default HarnessSlashMenu
