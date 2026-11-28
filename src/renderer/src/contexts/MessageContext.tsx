// contexts/MessageContext.tsx
import { createContext } from 'react'
import type { MessageContextType } from '@renderer/types/components'

export type { MessageContextType }

// Create the context
export const MessageContext = createContext<MessageContextType | undefined>(undefined)
