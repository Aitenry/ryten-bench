/**
 * Stable gradient colors for entity cards.
 *
 * The same entity (plugin / agent / skill / MCP server…) gets the same color pair on every
 * render, so colors do not jump when the list refreshes. Kept in its own file instead of
 * EntityCard.tsx: a component file may only export components so it works with React Fast
 * Refresh (the eslint react-refresh rule).
 */

const GRADIENTS: [string, string][] = [
  ['#2dd4bf', '#0d9488'],
  ['#fb923c', '#ef4444'],
  ['#a78bfa', '#7c3aed'],
  ['#fbbf24', '#f59e0b'],
  ['#60a5fa', '#2563eb'],
  ['#34d399', '#059669']
]

export function entityGradient(id: string): [string, string] {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return GRADIENTS[hash % GRADIENTS.length] as [string, string]
}
