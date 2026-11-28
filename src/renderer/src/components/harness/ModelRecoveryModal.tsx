import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Modal, Button, Input, theme } from 'antd'
import {
  RiErrorWarningLine,
  RiSparkling2Line,
  RiSearchLine,
  RiArrowDownSLine
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

import type { PendingQuestionView } from '../../../../shared/harness/types'
import { harnessApi } from '../../api/harness'
import { useTopicPending } from '../../hooks/harness/useTopicPending'

/**
 * Dedicated dialog for model request failures (continue with another model).
 *
 * After a model request fails even after 2 automatic retries, the main process parks the model node
 * in the graph and raises a question with kind='model-recovery' to the user (reusing the ask
 * park/write-back channel); this component listens for that question and shows a dedicated picker:
 * **the tree comes directly from the query of enabled models in the database (grouped by
 * provider)**. Once the user picks one, the answer is written back by provider id → the main
 * process continues in place with the new model (without ending the turn, re-sending the question,
 * or re-running tools that already ran).
 *
 * Division of labor with the generic AskQuestionModal: kind='model-recovery' is handled here and
 * AskQuestionModal ignores it.
 * **Isolated per conversation** (like the other two dialogs, see hooks/useTopicPending): only the
 * question parked for the current conversation is shown; switching to another conversation collapses
 * it and switching back brings it up again (otherwise the question would stay parked forever, with
 * the user unable to see or answer it).
 */
interface ModelRecoveryModalProps {
  currentTopicId: number | null
}

/** Tree entry (from the providers query or the question payload; submit is the answer value written back to the main process) */
interface PickerItem {
  /** Value to write back: the provider id string when available; the option label on payload fallback */
  submit: string
  /** Group key (provider type, lowercase) */
  group: string
  /** Display text (model name only) */
  name: string
}

/** Group title: capitalize the provider's first letter (openai → OpenAI); multi-segment names are
 *  capitalized per segment (google-genai → Google-Genai).
 *  'other' is the fallback group name for "no provider" (a data identifier, not user-visible
 *  Chinese text) and is displayed with its first letter capitalized as-is. */
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

  const [selected, setSelected] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [query, setQuery] = useState('')
  /** Collapsed groups (all expanded by default); searching ignores the collapsed state and auto-expands matching groups */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** Enabled model list queried when the dialog opens (source: providers.getEnabled) */
  const [queriedItems, setQueriedItems] = useState<PickerItem[]>([])
  const [queryFailed, setQueryFailed] = useState(false)

  // The "continue with another model" question: only accept the current conversation (re-fetched
  // per topic when switching conversations, see useTopicPending)
  const { pending, clear: clearPending } = useTopicPending<PendingQuestionView>({
    currentTopicId,
    fetchPending: (topicId) => harnessApi.harness.getQuestion(topicId),
    subscribe: (listener) => harnessApi.harness.onQuestionAsked(listener),
    accept: (p) => p.questions.some((q) => q.kind === 'model-recovery')
  })

  const close = useCallback((): void => {
    clearPending()
    setSelected(null)
    setSubmitting(false)
    setQuery('')
    setCollapsed(new Set())
    setQueriedItems([])
    setQueryFailed(false)
  }, [clearPending])

  // A different question (or a dismissal) clears the temporary selection from the previous round
  useEffect(() => {
    setSelected(null)
  }, [pending?.requestId])

  // Once the dialog opens (question received), query the enabled model list and build the tree
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
          console.error('Failed to query available models:', err)
          setQueryFailed(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [question])

  // Stream finished/failed → re-check per topic; topic switched → swap in the question parked for
  // this topic: both are handled centrally in useTopicPending (this used to have its own copy here,
  // which caused "another conversation's done wrongly closed this dialog" and "after switching away
  // and back the dialog never appeared again")

  // Tree entries: prefer the query result; on query failure/empty, fall back to the options in the
  // question payload (submitted by label)
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

  // Search filter: filter by model name in real time
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
          console.error('Failed to submit model selection:', err)
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
      // antd 6: maskClosable is deprecated, use mask.closable instead
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
      classNames={{ body: 'custom-scrollbar app-modal-scroll' }}
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

        {/* Tree: collapsible groups by provider + models inside each group; the list scrolls on its own (thin scroll area) */}
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
                      {/* Group header: provider name + collapse arrow */}
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
