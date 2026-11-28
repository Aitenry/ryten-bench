import React, { useMemo } from 'react'
import { Modal, theme } from 'antd'
import { RiLoader4Line, RiUploadCloud2Line } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { useLattice } from './useLattice'
import { formatBytes } from './format'

/**
 * Upload progress modal shown while publishing a plugin to the plugin center.
 *
 * The data comes from `lattice:upload-progress`, which the provider subscribes to (the main
 * process pushes per phase: zip → meta → upload, and the v2 API also has a source phase), so the
 * plugin repository page and the plugin detail page can share the same modal instead of each
 * subscribing on its own.
 *
 * Upload cannot be cancelled from the renderer (cancellation happens in the system dialog), so
 * the modal has no "cancel" button and only warns not to close the window while uploading.
 */
/**
 * Upload phases. The main-process progress pushes currently have three steps: zip → meta →
 * upload (a v2 source-package upload may append a `source` phase); the UI always draws three
 * steps, and if `source` arrives it treats it as "all three steps done" while switching the
 * phase title to "uploading source package" — so neither an old nor a new main process draws the
 * progress bar incorrectly.
 */
const PHASE_LABEL_KEY = {
  zip: 'lattice.upload.phaseZip',
  meta: 'lattice.upload.phaseMeta',
  upload: 'lattice.upload.phaseUpload',
  source: 'lattice.upload.phaseSource'
} as const

type UploadPhase = keyof typeof PHASE_LABEL_KEY

/** The three steps on the progress bar (source is an appended phase and does not get its own slot) */
const STEPS: UploadPhase[] = ['zip', 'meta', 'upload']

const UploadProgressModal: React.FC<{ open: boolean }> = ({ open }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { uploadProgress } = useLattice()

  /** The main process's current phase union has no source: the UI accepts a string so extra phases still render */
  const phase = uploadProgress?.phase as UploadPhase | undefined

  const phaseLabel = useMemo(() => {
    if (phase && PHASE_LABEL_KEY[phase]) return t(PHASE_LABEL_KEY[phase])
    return t('lattice.upload.preparing')
  }, [t, phase])

  /** source phase = the first three steps are all complete (the index falls past the end, so all three steps show as done) */
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
