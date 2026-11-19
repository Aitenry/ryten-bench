import React from 'react'
import { RiSparkling2Line } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { ShinyIcon, ShinyText } from '@renderer/components/effects/ShinyText'

interface LoadingMessageProps {
  colorTextSecondary: string
}

const LoadingMessage: React.FC<LoadingMessageProps> = ({ colorTextSecondary }) => {
  const { t } = useTranslation()

  return (
    <div className="flex mb-6">
      <div className="w-full">
        <div className="flex items-center gap-2" style={{ color: colorTextSecondary }}>
          <ShinyIcon icon={RiSparkling2Line} size={16} baseColor={colorTextSecondary} />
          <ShinyText baseColor={colorTextSecondary}>{t('harness.loading.generating')}</ShinyText>
        </div>
      </div>
    </div>
  )
}

export default LoadingMessage
