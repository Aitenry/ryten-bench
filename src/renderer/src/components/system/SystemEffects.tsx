import { useEffect, type FC } from 'react'
import { harnessApi } from '@renderer/api/harness'
import { publishDocChanged, type DocChangedPayload } from '@renderer/events/doc-changed'
import { handleProbeRequest } from '@renderer/workshop/probe'

/**
 * 系统功能之间的两条进程内桥（挂载一次，随应用生命周期）：
 *
 * - AI 助手的主进程写文档 → `notes` 编辑器的 `doc:changed` 订阅表；
 * - 插件工坊对插件渲染模块的实时装载探针。
 *
 * 两者都是随应用编译进来的功能，直接调用公开的模块 API 即可——不再经插件的
 * 事件总线绕一圈，也没有“哪个插件订阅了哪个通道”的间接层。
 */
const SystemEffects: FC = () => {
  useEffect(() => {
    const unsubDoc = harnessApi.harness.onDocChanged((data) => {
      publishDocChanged(data as DocChangedPayload)
    })
    const unsubProbe = harnessApi.workshop.onProbe((payload) => {
      void handleProbeRequest(payload)
    })
    return () => {
      unsubDoc?.()
      unsubProbe?.()
    }
  }, [])
  return null
}

export default SystemEffects
