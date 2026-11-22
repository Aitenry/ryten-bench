import { useContext } from 'react'
import { LatticeContext, type LatticeContextValue } from './LatticeContextCore'

/**
 * 读取插件中心上下文。
 *
 * 故意不在缺少 Provider 时抛错：`LatticeContext` 自带「不可用」兜底值，
 * 这样插件中心相关组件被单独渲染（测试、旧布局残留）时也只是降级，不会白屏。
 */
export function useLattice(): LatticeContextValue {
  return useContext(LatticeContext)
}
