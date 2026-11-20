/**
 * 实体卡的稳定渐变色。
 *
 * 同一实体（插件 / 智能体 / 技能 / MCP 服务器…）每次渲染都取到同一组颜色，
 * 列表刷新时不会出现「颜色跳变」。放在独立文件里而不是 EntityCard.tsx：
 * 组件文件只导出组件，才能配合 React Fast Refresh（eslint react-refresh 规则）。
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
