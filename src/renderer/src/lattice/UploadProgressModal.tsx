import React, { useMemo } from 'react'
import { Modal, theme } from 'antd'
import { RiLoader4Line, RiUploadCloud2Line } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { useLattice } from './useLattice'
import { formatBytes } from './format'

/**
 * 发布插件到插件中心时的上传进度弹窗。
 *
 * 数据来自 Provider 订阅的 `lattice:upload-progress`（主进程按 zip → meta → upload
 * （契约 v2 还有 source）阶段推送），因此插件仓库页和插件详情页可以共用同一个弹窗，
 * 不必各自订阅。
 *
 * 上传无法从渲染层取消（取消发生在系统选择框里），所以弹窗不给「取消」按钮，
 * 只提示上传期间不要关闭窗口。
 */
/**
 * 上传阶段。主进程现有进度推送是 zip → meta → upload 三步（契约 v2 的源码包上传可能
 * 追加一个 `source` 阶段）；这里 UI 固定画三步，若收到 `source` 就把它当成「三步都已完成」，
 * 同时阶段标题换成「正在上传源码包」——旧/新主进程都不会把进度条画错。
 */
const PHASE_LABEL_KEY = {
  zip: 'lattice.upload.phaseZip',
  meta: 'lattice.upload.phaseMeta',
  upload: 'lattice.upload.phaseUpload',
  source: 'lattice.upload.phaseSource'
} as const

type UploadPhase = keyof typeof PHASE_LABEL_KEY

/** 进度条上的三步（source 是追加阶段，不单独占一格） */
const STEPS: UploadPhase[] = ['zip', 'meta', 'upload']

const UploadProgressModal: React.FC<{ open: boolean }> = ({ open }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { uploadProgress } = useLattice()

  /** 主进程现在的 phase 联合类型里没有 source：UI 按字符串收，多出来的阶段也能显示 */
  const phase = uploadProgress?.phase as UploadPhase | undefined

  const phaseLabel = useMemo(() => {
    if (phase && PHASE_LABEL_KEY[phase]) return t(PHASE_LABEL_KEY[phase])
    return t('lattice.upload.preparing')
  }, [t, phase])

  /** source 阶段 = 前三步都完成（索引落在末尾，三步都显示为 done） */
  const activeIndex = phase ? (phase === 'source' ? STEPS.length : STEPS.indexOf(phase)) : -1

  const hasByteTotal = Boolean(uploadProgress && uploadProgress.total > 0)
  const percent = hasByteTotal
    ? Math.min(100, Math.max(0, Math.round((uploadProgress!.sent / uploadProgress!.total) * 100)))
    : 0

  return (
    <Modal
      open={open}
      footer={null}
      closable={false}
      mask={{ closable: false }}
      keyboard={false}
      width={430}
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <RiUploadCloud2Line size={16} style={{ color: token.colorPrimary }} />
          {t('lattice.upload.modalTitle')}
        </span>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: 10,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: token.colorPrimaryBg,
              color: token.colorPrimary
            }}
          >
            <RiLoader4Line size={17} className="animate-spin" />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: token.colorText }}>
              {phaseLabel}
            </div>
            <div style={{ marginTop: 2, fontSize: 10.5, color: token.colorTextTertiary }}>
              {hasByteTotal
                ? t('lattice.upload.bytes', {
                    sent: formatBytes(uploadProgress!.sent),
                    total: formatBytes(uploadProgress!.total)
                  })
                : t('lattice.upload.keepOpen')}
            </div>
          </div>
        </div>

        {hasByteTotal ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="lattice-upload-bar" style={{ background: token.colorFillSecondary }}>
              <div
                className="lattice-upload-bar-fill"
                style={{ width: `${percent}%`, background: token.colorPrimary }}
              />
            </div>
            <span
              style={{
                fontSize: 10.5,
                fontVariantNumeric: 'tabular-nums',
                color: token.colorTextSecondary,
                minWidth: 32,
                textAlign: 'right'
              }}
            >
              {percent}%
            </span>
          </div>
        ) : (
          <div className="lattice-upload-bar" style={{ background: token.colorFillSecondary }}>
            <div
              className="lattice-upload-bar-indeterminate"
              style={{ background: token.colorPrimary }}
            />
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {STEPS.map((phase, index) => {
            const done = activeIndex > index
            const active = activeIndex === index
            const label = t(PHASE_LABEL_KEY[phase])
            return (
              <React.Fragment key={phase}>
                {index > 0 && (
                  <span
                    style={{
                      flex: 1,
                      height: 1,
                      background: done || active ? token.colorPrimaryBorder : token.colorSplit
                    }}
                  />
                )}
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    fontSize: 10,
                    flexShrink: 0,
                    color: done
                      ? token.colorTextSecondary
                      : active
                        ? token.colorPrimary
                        : token.colorTextQuaternary,
                    fontWeight: active ? 600 : 400
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: done
                        ? token.colorPrimary
                        : active
                          ? token.colorPrimary
                          : token.colorFillSecondary,
                      boxShadow: active ? `0 0 0 3px ${token.colorPrimaryBg}` : undefined
                    }}
                  />
                  {label}
                </span>
              </React.Fragment>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}

export default UploadProgressModal
