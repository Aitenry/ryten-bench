import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Button, Input, theme } from 'antd'
import {
  RiErrorWarningLine,
  RiSparkling2Line,
  RiSearchLine,
  RiArrowDownSLine
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

import type { PendingQuestionView } from '../../shared/types'
import { harnessApi } from '../api'

/**
 * 模型请求失败专用弹窗（换模型继续）。
 *
 * 主进程在模型请求自动重试 2 次仍失败后，于图内 model 节点挂起并向用户发出
 * kind='model-recovery' 的提问（复用 ask 挂起/回写通道）；本组件监听该提问并展示
 * 专用选择窗口：**目录树直接来自数据库查询的已启用模型列表（按供应商分组）**，
 * 用户选好后按 provider id 回写答案 → 主进程用新模型在原位置继续执行
 * （不结束本轮、不重发问题、不重跑已执行工具）。
 *
 * 与通用 AskQuestionModal 分工：kind='model-recovery' 由本组件处理，AskQuestionModal 忽略。
 */
interface ModelRecoveryModalProps {
  currentTopicId: number | null
}

/** 目录树条目（来自 providers 查询或提问载荷，submit 为回写给主进程的答案值） */
interface PickerItem {
  /** 回写答案：优先 provider id 字符串；载荷兜底时为选项 label */
  submit: string
  /** 分组键（供应商类型，小写） */
  group: string
  /** 展示文本（只显示模型名称） */
  name: string
}

/** 分组标题：供应商首字母大写（openai → OpenAI）；多段名逐段大写（google-genai → Google-Genai）。
 *  'other' 是「无供应商」的兜底分组名（数据标识，非用户可见中文），原样首字母大写显示。 */
const displayGroup = (group: string): string => {
  const g = (group || '').trim().toLowerCase()
  if (!g) return ''
  return g
    .replaceAll('_', '-')
    .split('-')
    .map((seg) => (seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : seg))
    .join('-')
}

const ModelRecoveryModal: React.FC<ModelRecoveryModalProps> = ({ currentTopicId }) => {
  const {
    token: {
      colorText,
      colorTextSecondary,
      colorTextTertiary,
      colorBorderSecondary,
      colorFillTertiary,
      colorError
    }
  } = theme.useToken()
  const { t } = useTranslation()

  const currentTopicIdRef = useRef(currentTopicId)
  currentTopicIdRef.current = currentTopicId

  const [pending, setPending] = useState<PendingQuestionView | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [query, setQuery] = useState('')
  /** 折叠的分组（默认全部展开）；搜索时忽略折叠态并自动展开匹配组 */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** 弹窗打开时查询到的已启用模型列表（数据源：providers.getEnabled） */
  const [queriedItems, setQueriedItems] = useState<PickerItem[]>([])
  const [queryFailed, setQueryFailed] = useState(false)

  const close = useCallback((): void => {
    setPending(null)
    setSelected(null)
    setSubmitting(false)
    setQuery('')
    setCollapsed(new Set())
    setQueriedItems([])
    setQueryFailed(false)
  }, [])

  // 常驻监听：kind='model-recovery' 的提问 → 弹专用选择窗
  useEffect(() => {
    const unsubscribe = harnessApi.harness.onQuestionAsked((p) => {
      if (!p.questions.some((q) => q.kind === 'model-recovery')) return
      if (p.topicId !== currentTopicIdRef.current) return
      setPending(p)
      setSelected(null)
    })
    return unsubscribe
  }, [])

  // 弹窗打开（拿到提问）后查询已启用模型列表，构建目录树
  const question = pending?.questions.find((q) => q.kind === 'model-recovery')
  useEffect(() => {
    if (!question) return
    let cancelled = false
    setQueryFailed(false)
    ;(async () => {
      try {
        const rows = await window.api.providers.getEnabled()
        if (cancelled) return
        const items: PickerItem[] = (rows ?? [])
          .filter((r) => r && r.id > 0)
          .map((r) => ({
            submit: String(r.id),
            group: (r.provider || '').toLowerCase() || 'other',
            name: r.model
          }))
        setQueriedItems(items)
      } catch (err) {
        if (!cancelled) {
          console.error('查询可用模型失败:', err)
          setQueryFailed(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [question])

  // 流结束/出错 → 收起（提问已随流取消或不再有意义）；只响应当前话题，
  // 避免后台目标自动续跑轮的 done/error 误关本弹窗（主进程提问仍挂起）
  useEffect(() => {
    const closeForTopic = (payload?: { topicId?: number }): void => {
      if (
        payload &&
        typeof payload.topicId === 'number' &&
        payload.topicId !== currentTopicIdRef.current
      ) {
        return
      }
      close()
    }
    const unDone = harnessApi.harness.onStreamDone(closeForTopic)
    const unErr = harnessApi.harness.onStreamError(closeForTopic)
    return () => {
      unDone()
      unErr()
    }
  }, [close])

  // 切换话题时若弹窗还开着，自动关闭
  useEffect(() => {
    if (pending && pending.topicId !== currentTopicId) {
      close()
    }
  }, [currentTopicId, pending, close])

  // 目录树条目：优先查询结果；查询失败/为空时回退到提问载荷里的选项（按 label 提交）
  const treeItems = useMemo<PickerItem[]>(() => {
    if (!question) return []
    if (queriedItems.length > 0) return queriedItems
    if (queryFailed) {
      return (question.options ?? [])
        .filter((o) => o.label !== question.abandonLabel)
        .map((o) => ({
          submit: o.label,
          group: (o.group || '').toLowerCase() || 'other',
          name: o.label
        }))
    }
    return []
  }, [question, queriedItems, queryFailed])

  const hasAnyModel = treeItems.length > 0

  // 搜索过滤：按模型名称实时过滤
  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const grouped = new Map<string, PickerItem[]>()
    for (const item of treeItems) {
      const haystack = `${item.name} ${item.group}`.toLowerCase()
      if (q && !haystack.includes(q)) continue
      const list = grouped.get(item.group) ?? []
      list.push(item)
      grouped.set(item.group, list)
    }
    return [...grouped.entries()]
      .map(([group, items]) => ({ group, items }))
      .sort((a, b) => a.group.localeCompare(b.group))
  }, [treeItems, query])

  const searching = query.trim().length > 0

  const toggleGroup = (group: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(group)) {
        next.delete(group)
      } else {
        next.add(group)
      }
      return next
    })
  }

  const submit = useCallback(
    (submitValue: string): void => {
      if (!pending || submitting) return
      setSubmitting(true)
      const q = pending.questions.find((x) => x.kind === 'model-recovery')
      if (!q) {
        close()
        return
      }
      harnessApi.harness
        .answerQuestion(pending.requestId, [{ id: q.id, selected: [submitValue] }])
        .then(() => close())
        .catch((err) => {
          console.error('提交模型选择失败:', err)
          close()
        })
    },
    [pending, submitting, close]
  )

  if (!pending || !question) return null

  const errorText = question.error ?? ''
  const noResult = searching && filteredGroups.reduce((acc, g) => acc + g.items.length, 0) === 0
  const showEmptyState = !hasAnyModel || noResult

  return (
    <Modal
      open
      title={
        <span className="flex items-center gap-2">
          <RiErrorWarningLine size={18} style={{ color: colorError }} />
          <span>{t('harness.modelRecovery.title')}</span>
        </span>
      }
      width={560}
      centered
      closable={false}
      // antd 6：maskClosable 已弃用，改用 mask.closable
      mask={{ closable: false }}
      onCancel={() => undefined}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button disabled={submitting} onClick={() => submit(question.abandonLabel ?? '')}>
            {t('harness.modelRecovery.abandon')}
          </Button>
          <Button
            type="primary"
            icon={<RiSparkling2Line size={14} />}
            disabled={!selected || submitting}
            loading={submitting}
            onClick={() => selected != null && submit(selected)}
          >
            {t('harness.modelRecovery.continueWithModel')}
          </Button>
        </div>
      }
      styles={{ body: { maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' } }}
      classNames={{ body: 'custom-scrollbar' }}
    >
      <div className="flex flex-col gap-3 pt-1">
        <div style={{ color: colorTextSecondary, fontSize: 13, lineHeight: 1.7 }}>
          {question.question}
        </div>

        {errorText ? (
          <div
            className="model-picker-scroll max-h-16 overflow-y-auto px-2.5 py-1.5 rounded text-xs whitespace-pre-wrap break-words"
            style={{
              color: colorTextTertiary,
              background: 'rgba(211, 47, 47, 0.06)',
              border: `1px solid ${colorBorderSecondary}`
            }}
          >
            {errorText}
          </div>
        ) : null}

        <div>
          <Input
            allowClear
            prefix={<RiSearchLine size={14} style={{ color: colorTextTertiary }} />}
            placeholder={t('harness.modelRecovery.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            variant="filled"
            size="middle"
            style={{ borderRadius: 8 }}
          />
        </div>

        {/* 目录树：按供应商分组折叠 + 组内模型；列表独立滚动（细条滚动区） */}
        <div
          className="model-picker-scroll flex flex-col pr-1 -mr-1 overflow-y-auto"
          style={{
            maxHeight: 264,
            border: `1px solid ${colorBorderSecondary}`,
            borderRadius: 8,
            maxWidth: '100%',
            background: 'rgba(128, 128, 128, 0.04)'
          }}
        >
          {hasAnyModel
            ? filteredGroups.length > 0
              ? filteredGroups.map(({ group, items }) => {
                  const expanded = searching || !collapsed.has(group)
                  return (
                    <div key={group} className="flex flex-col">
                      {/* 分组头：供应商名 + 折叠箭头 */}
                      <button
                        type="button"
                        onClick={() => toggleGroup(group)}
                        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left border-0 bg-transparent cursor-pointer select-none hover:opacity-80"
                        style={{ color: colorTextSecondary }}
                      >
                        <RiArrowDownSLine
                          size={15}
                          style={{
                            color: colorTextTertiary,
                            flexShrink: 0,
                            transition: 'transform 0.15s ease',
                            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)'
                          }}
                        />
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            letterSpacing: '0.02em'
                          }}
                        >
                          {displayGroup(group)}
                        </span>
                      </button>

                      {expanded ? (
                        <div className="flex flex-col pb-1">
                          {items.map((item, oi) => {
                            const active = selected === item.submit
                            return (
                              <button
                                key={`${group}-${oi}`}
                                type="button"
                                onClick={() => setSelected(item.submit)}
                                className="flex w-full items-center rounded px-2.5 py-1 text-left border-0 bg-transparent cursor-pointer transition-colors"
                                style={{
                                  background: active ? colorFillTertiary : 'transparent'
                                }}
                                onMouseEnter={(e) => {
                                  if (!active) e.currentTarget.style.background = colorFillTertiary
                                }}
                                onMouseLeave={(e) => {
                                  if (!active) e.currentTarget.style.background = 'transparent'
                                }}
                              >
                                <span
                                  style={{
                                    color: active ? colorText : colorTextSecondary,
                                    fontSize: 13,
                                    lineHeight: '18px',
                                    wordBreak: 'break-all'
                                  }}
                                >
                                  {item.name}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      ) : null}
                    </div>
                  )
                })
              : null
            : null}
          {showEmptyState ? (
            <div
              className="px-3 py-4 text-center"
              style={{ color: colorTextTertiary, fontSize: 12 }}
            >
              {searching
                ? t('harness.modelRecovery.noMatch', { query: query.trim() })
                : t('harness.modelRecovery.noModels')}
            </div>
          ) : null}
        </div>

        <div style={{ color: colorTextTertiary, fontSize: 12 }}>
          {t('harness.modelRecovery.hint')}
        </div>
      </div>
    </Modal>
  )
}

export default ModelRecoveryModal
