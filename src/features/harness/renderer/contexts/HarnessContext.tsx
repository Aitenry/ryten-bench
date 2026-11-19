import React from 'react'
import { useHarnessHandlers } from '../hooks/useHarnessHandlers'
import { HarnessCtx } from './HarnessContextCore'

export const HarnessProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const harness = useHarnessHandlers()

  return <HarnessCtx.Provider value={harness}>{children}</HarnessCtx.Provider>
}
