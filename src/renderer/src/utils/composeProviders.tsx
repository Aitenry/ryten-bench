import React from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProviderTuple<P = any> =
  [React.ComponentType<P>, P?] | [React.ComponentType<{ children: React.ReactNode }>]

/**
 * Combine multiple Providers into one, removing nested levels
 * @example
 * const AppProviders = composeProviders(
 *   [ProviderA, { value: someValue }],
 *   [ProviderB],
 * )
 */
export function composeProviders(
  ...providers: ProviderTuple[]
): React.FC<{ children: React.ReactNode }> {
  return ({ children }) =>
    providers.reduceRight(
      (acc, [Provider, props = {}]) => <Provider {...props}>{acc}</Provider>,
      children
    )
}
