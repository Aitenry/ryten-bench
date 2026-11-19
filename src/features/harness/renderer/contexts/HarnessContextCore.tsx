import { createContext, useContext } from 'react'
import type { UseHarnessHandlersReturn } from '../hooks/useHarnessHandlers'

export type HarnessContextType = UseHarnessHandlersReturn

export const HarnessCtx = createContext<HarnessContextType | undefined>(undefined)

export const useHarness = (): HarnessContextType => {
  const ctx = useContext(HarnessCtx)
  if (!ctx) throw new Error('useHarness must be used within HarnessProvider')
  return ctx
}
