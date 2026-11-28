import { useContext } from 'react'
import { MessageContext, MessageContextType } from '../contexts/MessageContext'

// Custom hook for using the message context in components
export const useMessage = (): MessageContextType => {
  const context = useContext(MessageContext)
  if (context === undefined) {
    throw new Error('useMessage must be used within a MessageProvider')
  }
  return context
}
