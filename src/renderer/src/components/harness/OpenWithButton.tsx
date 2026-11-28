/**
 * "Open with" split button for a workspace file.
 *
 * The primary button keeps the in-app action (open in the workspace editor); the caret opens a menu
 * with the **system apps** that can open this file, each with the OS-provided icon:
 *
 * - `在应用内打开` — only when an in-app handler was passed;
 * - `系统默认应用` — `shell.openPath` (Windows default program / macOS `open` / Linux `xdg-open`);
 * - one row per registered app (Windows) — launches that executable with the file.
 *
 * The app list is fetched lazily on first open (a registry scan is not free) and cached per path by
 * the main process; macOS/Linux return only the default row, so the menu degrades gracefully.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { App, Dropdown, theme } from 'antd'
import { RiArrowDownSLine, RiArrowRightSLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { harnessApi, type FileOpenTargetView } from '../../api/harness'
import { getMemoryScope } from '../../utils/harness/memory-scope'

interface Props {
  /** Workspace virtual path (e.g. `/docs/report.md`) */
  virtualPath: string
  /** Primary button label (the in-app action), e.g. "打开" */
  label: string
  /** In-app action; omitted → the primary button opens with the system default app */
  onOpenInApp?: () => void
  /** Compact sizing for dense rows */
  small?: boolean
}

const OpenWithButton: React.FC<Props> = ({ virtualPath, label, onOpenInApp, small = false }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message } = App.useApp()
  const [targets, setTargets] = useState<FileOpenTargetView[] | null>(null)
  const loadingRef = useRef(false)

  // A different file means a different app list
  useEffect(() => {
    setTargets(null)
    loadingRef.current = false
  }, [virtualPath])

  const loadTargets = useCallback(async (): Promise<void> => {
    if (targets || loadingRef.current) return
    loadingRef.current = true
    try {
      const result = await harnessApi.harness.getFileOpenTargets(virtualPath, getMemoryScope())
      setTargets(result.targets ?? [])
    } catch {
      setTargets([])
    } finally {
      loadingRef.current = false
    }
  }, [targets, virtualPath])

  const openWith = useCallback(
    async (targetId: string): Promise<void> => {
      const result = await harnessApi.harness
        .openFileWith(virtualPath, targetId, getMemoryScope())
        .catch((err: unknown) => ({ ok: false, error: String(err) }))
      if (!result.ok) {
        message.error(t('harness.assistantMessage.openWithFailed', { reason: result.error ?? '' }))
      }
    },
    [message, t, virtualPath]
  )

  const menuItems = [
    ...(onOpenInApp
      ? [
          {
            key: 'in-app',
            label: t('harness.assistantMessage.openInApp'),
            onClick: () => onOpenInApp()
          }
        ]
      : []),
    {
      key: 'default',
      label: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 16, height: 16, display: 'inline-flex', flex: '0 0 auto' }}>
            {targets?.find((item) => item.kind === 'default')?.icon ? (
              <img
                src={targets.find((item) => item.kind === 'default')?.icon}
                alt=""
                width={16}
                height={16}
                style={{ borderRadius: 3 }}
              />
            ) : null}
          </span>
          {t('harness.assistantMessage.openWithDefault')}
        </span>
      ),
      onClick: () => void openWith('default')
    },
    ...(targets ?? [])
      .filter((item) => item.kind === 'app')
      .map((item) => ({
        key: item.id,
        label: (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 16,
                height: 16,
                display: 'inline-flex',
                flex: '0 0 auto',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              {item.icon ? (
                <img
                  src={item.icon}
                  alt=""
                  width={16}
                  height={16}
                  style={{ borderRadius: 3 }}
                />
              ) : (
                <RiArrowRightSLine size={12} style={{ color: token.colorTextTertiary }} />
              )}
            </span>
            <span
              style={{
                maxWidth: 200,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {item.label}
            </span>
          </span>
        ),
        onClick: () => void openWith(item.id)
      }))
  ]

  const height = small ? 24 : 26
  const fontSize = small ? 11 : 11.5

  return (
    <span style={{ display: 'inline-flex', flex: '0 0 auto' }} data-open-with="button">
      <button
        type="button"
        onClick={() => (onOpenInApp ? onOpenInApp() : void openWith('default'))}
        style={{
          height,
          padding: '0 9px',
          borderRadius: '7px 0 0 7px',
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRight: 'none',
          background: token.colorFillTertiary,
          color: token.colorTextSecondary,
          fontSize,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center'
        }}
      >
        {label}
      </button>
      <Dropdown
        trigger={['click']}
        onOpenChange={(open) => {
          if (open) void loadTargets()
        }}
        menu={{ items: menuItems }}
      >
        <button
          type="button"
          title={t('harness.assistantMessage.openWith')}
          style={{
            height,
            width: 18,
            borderRadius: '0 7px 7px 0',
            border: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorFillTertiary,
            color: token.colorTextTertiary,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <RiArrowDownSLine size={11} />
        </button>
      </Dropdown>
    </span>
  )
}

export default OpenWithButton
