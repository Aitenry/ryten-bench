import React from 'react'
import type { BuildProgressContextType } from './build-progress'

export type { BuildProgressContextType }

/** Graph build progress context (both the Provider and its consumers live in the notes plugin) */
export const BuildProgressContext = React.createContext<BuildProgressContextType | undefined>(
  undefined
)
