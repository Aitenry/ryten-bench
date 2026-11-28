import { useContext } from 'react'
import { LatticeContext, type LatticeContextValue } from './LatticeContextCore'

/**
 * Read the plugin center context.
 *
 * Deliberately does not throw when the provider is missing: `LatticeContext` carries an
 * "unavailable" fallback value, so plugin center components rendered on their own (tests,
 * leftovers from an older layout) merely degrade instead of showing a blank screen.
 */
export function useLattice(): LatticeContextValue {
  return useContext(LatticeContext)
}
