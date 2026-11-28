import { Card } from 'antd'
import { useTranslation } from '@host/renderer/i18n'

/**
 * ${vars.title} 的设置页：这里**没有可配置项**，只有「这个工具在哪、叫什么」的只读信息。
 *
 * 写法说明（完整规则见 WORKSHOP.md 第 6.6 节）：
 * - 结构只在**携带信息**时才成立：两行键值（工具名 / 启用位置）+ 一句后果说明，
 *   不要写成一段「本插件给助手贡献了工具…」的说明文——用户扫一眼就要知道去哪启用；
 * - 分组用 `Card size="small"`，一行一个字段：标签在左、值在右，补充信息放下面一行灰字；
 * - 文案一律走词条（locales/），组件里不写死。
 */
function Section(props: { title: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <Card
      size="small"
      variant="outlined"
      title={props.title}
      styles={{
        header: { minHeight: 42, padding: '0 16px', fontSize: 13, fontWeight: 600 },
        body: { padding: '14px 16px' }
      }}
    >
      <div className="flex flex-col gap-3.5">{props.children}</div>
    </Card>
  )
}

function Row(props: {
  label: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-[24px] items-center justify-between gap-4">
        <span className="text-[13px]">{props.label}</span>
        <div className="flex min-w-0 shrink-0 items-center">{props.children}</div>
      </div>
      {props.hint ? <div className="text-[11px] opacity-60">{props.hint}</div> : null}
    </div>
  )
}

export default function Settings(): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="w-full">
      <Section title={t('${vars.id}.settingsPage.section.tool')}>
        <Row
          label={t('${vars.id}.settingsPage.toolNameLabel')}
          hint={t('${vars.id}.settingsPage.toolNameHint')}
        >
          <code className="text-[12px]">${vars.toolName}</code>
        </Row>
        <Row
          label={t('${vars.id}.settingsPage.enablePathLabel')}
          hint={t('${vars.id}.settingsPage.enablePathHint')}
        >
          <span className="text-[12px] opacity-70">{t('${vars.id}.settingsPage.enablePathValue')}</span>
        </Row>
        <div className="text-[11px] opacity-60">
          {t('${vars.id}.settingsPage.disabledHint')}
        </div>
      </Section>
    </div>
  )
}
