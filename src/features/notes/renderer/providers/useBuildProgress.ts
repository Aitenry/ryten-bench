import React from 'react'
import { BuildProgressContext, type BuildProgressContextType } from './BuildProgressContext'

/** 读图谱构建进度上下文（Provider 与消费方都在 notes 插件内） */
export const useBuildProgress = (): BuildProgressContextType => {
  const context = React.useContext(BuildProgressContext)
  if (!context) {
    throw new Error('useBuildProgress must be used within a BuildProgressProvider')
  }
  return context
}
