import React from 'react'
import type { BuildProgressContextType } from './build-progress'

export type { BuildProgressContextType }

/** 图谱构建进度的上下文（Provider 与消费方都在 notes 插件内） */
export const BuildProgressContext = React.createContext<BuildProgressContextType | undefined>(
  undefined
)
