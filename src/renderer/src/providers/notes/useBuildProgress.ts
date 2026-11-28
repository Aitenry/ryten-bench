import React from 'react'
import { BuildProgressContext, type BuildProgressContextType } from './BuildProgressContext'

/** Read the graph build progress context (both provider and consumers live inside the notes plugin) */
export const useBuildProgress = (): BuildProgressContextType => {
  const context = React.useContext(BuildProgressContext)
  if (!context) {
    throw new Error('useBuildProgress must be used within a BuildProgressProvider')
  }
  return context
}
