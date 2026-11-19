import React, { useMemo } from 'react'
import { theme, Button } from 'antd'
import {
  RiFileTextLine,
  RiCheckboxCircleLine,
  RiBook2Line,
  RiAddLine,
  RiTimeLine
} from '@remixicon/react'
import dayjs from 'dayjs'
import { useTranslation } from '@renderer/i18n'
import type { DocListItem, TodoItemRow, WikiRow } from '../../shared/types'

interface EmptyDashboardProps {
  docs: DocListItem[]
  todos: TodoItemRow[]
  wikis: WikiRow[]
  onOpenDoc: (docId: number) => void
  onOpenTodo: (todoId: number) => void
  onCreateDoc: () => void
  onCreateTodo: () => void
  onCreateWiki: () => void
}

const EmptyDashboard: React.FC<EmptyDashboardProps> = ({
  docs,
  todos,
  wikis,
  onOpenDoc,
  onOpenTodo,
  onCreateDoc,
  onCreateTodo,
  onCreateWiki
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const hour = new Date().getHours()
  const greeting =
    hour < 6
      ? t('notes.dashboard.greetingNight')
      : hour < 12
        ? t('notes.dashboard.greetingMorning')
        : hour < 18
          ? t('notes.dashboard.greetingAfternoon')
          : t('notes.dashboard.greetingEvening')

  const pendingTodos = useMemo(() => {
    return todos
      .filter((t) => t.status !== 2)
      .sort((a, b) => String(a.due_date ?? '9999').localeCompare(String(b.due_date ?? '9999')))
      .slice(0, 6)
  }, [todos])

  const overdueCount = useMemo(
    () =>
      todos.filter(
        (t) => t.status !== 2 && t.due_date && dayjs(t.due_date).isBefore(dayjs(), 'day')
      ).length,
    [todos]
  )

  const recentDocs = useMemo(
    () =>
      [...docs]
        .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
        .slice(0, 6),
    [docs]
  )

  const statBlock = (
    icon: React.ReactNode,
    color: string,
    value: string | number,
    label: string,
    sub?: string
  ): React.ReactNode => (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        padding: '16px 18px',
        borderRadius: 12,
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary}`
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `${color}1a`,
            color
          }}
        >
          {icon}
        </span>
        <span style={{ fontSize: 12.5, color: token.colorTextSecondary, fontWeight: 500 }}>
          {label}
        </span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: token.colorText, lineHeight: 1.2 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 12, color: token.colorTextTertiary, marginTop: 3 }}>{sub}</div>
      )}
    </div>
  )

  return (
    <div
      className="custom-scrollbar"
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflowY: 'auto'
      }}
    >
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '36px 40px 56px' }}>
        {/* 问候 */}
        <div
          style={{ fontSize: 26, fontWeight: 700, color: token.colorText, letterSpacing: -0.01 }}
        >
          {t('notes.dashboard.welcomeBack', { greeting })}
        </div>
        <div
          style={{ fontSize: 13, color: token.colorTextTertiary, marginTop: 6, marginBottom: 24 }}
        >
          {dayjs().format(t('notes.dashboard.dateFormat'))} · {t('notes.dashboard.subtitle')}
        </div>

        {/* 统计 */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
          {statBlock(
            <RiFileTextLine size={15} />,
            token.colorPrimary,
            docs.length,
            t('notes.term.doc'),
            t('notes.dashboard.recentUpdate', {
              date: docs.length > 0 ? dayjs(recentDocs[0].updated_at).format('MM-DD') : '—'
            })
          )}
          {statBlock(
            <RiCheckboxCircleLine size={15} />,
            '#fa8c16',
            todos.filter((t) => t.status !== 2).length,
            t('notes.dashboard.pendingTodos'),
            overdueCount > 0
              ? t('notes.dashboard.overdueCount', { count: overdueCount })
              : t('notes.dashboard.noOverdue')
          )}
          {statBlock(
            <RiBook2Line size={15} />,
            '#722ed1',
            wikis.length,
            t('notes.term.wiki'),
            t('notes.dashboard.wikiSubtitle')
          )}
        </div>

        {/* 快速新建 */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 28 }}>
          <QuickCreate
            token={token}
            icon={<RiFileTextLine size={15} />}
            label={t('notes.doc.create')}
            onClick={onCreateDoc}
          />
          <QuickCreate
            token={token}
            icon={<RiCheckboxCircleLine size={15} />}
            label={t('notes.todo.create')}
            onClick={onCreateTodo}
          />
          <QuickCreate
            token={token}
            icon={<RiBook2Line size={15} />}
            label={t('notes.wiki.create')}
            onClick={onCreateWiki}
          />
        </div>

        {/* 两栏：待办 / 最近文档 */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <section>
            <SectionTitle
              token={token}
              label={t('notes.dashboard.todoSection')}
              count={pendingTodos.length}
            />
            {pendingTodos.length === 0 ? (
              <EmptyHint token={token} text={t('notes.dashboard.noPendingTodos')} />
            ) : (
              pendingTodos.map((t) => {
                const overdue = t.due_date && dayjs(t.due_date).isBefore(dayjs(), 'day')
                return (
                  <div
                    key={t.id}
                    onClick={() => onOpenTodo(t.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '9px 10px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      fontSize: 13,
                      color: token.colorText,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      marginBottom: 8,
                      background: token.colorBgContainer
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = token.colorPrimary
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = token.colorBorderSecondary
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background:
                          t.status === 1
                            ? '#fa8c16'
                            : overdue
                              ? token.colorError
                              : token.colorPrimary
                      }}
                    />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {t.title}
                    </span>
                    {t.due_date && (
                      <span
                        style={{
                          fontSize: 11,
                          flexShrink: 0,
                          color: overdue ? token.colorError : token.colorTextTertiary,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 3
                        }}
                      >
                        <RiTimeLine size={11} />
                        {t.due_date.slice(5)}
                      </span>
                    )}
                  </div>
                )
              })
            )}
          </section>

          <section>
            <SectionTitle
              token={token}
              label={t('notes.dashboard.recentDocsSection')}
              count={recentDocs.length}
            />
            {recentDocs.length === 0 ? (
              <EmptyHint token={token} text={t('notes.dashboard.noDocsHint')} />
            ) : (
              recentDocs.map((d) => (
                <div
                  key={d.id}
                  onClick={() => onOpenDoc(d.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '9px 10px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    fontSize: 13,
                    color: token.colorText,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    marginBottom: 8,
                    background: token.colorBgContainer
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = token.colorPrimary
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = token.colorBorderSecondary
                  }}
                >
                  <RiFileTextLine
                    size={13}
                    style={{ color: token.colorTextTertiary, flexShrink: 0 }}
                  />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {d.title}
                  </span>
                  <span style={{ fontSize: 11, flexShrink: 0, color: token.colorTextTertiary }}>
                    {d.updated_at ? dayjs(d.updated_at).format('MM-DD HH:mm') : ''}
                  </span>
                </div>
              ))
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

/* ──────────── 子组件 ──────────── */

const SectionTitle: React.FC<{
  token: ReturnType<typeof theme.useToken>['token']
  label: string
  count: number
}> = ({ token, label, count }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 13,
      fontWeight: 600,
      color: token.colorText,
      marginBottom: 12
    }}
  >
    {label}
    <span style={{ fontSize: 11, color: token.colorTextTertiary, fontWeight: 400 }}>{count}</span>
  </div>
)

const EmptyHint: React.FC<{ token: ReturnType<typeof theme.useToken>['token']; text: string }> = ({
  token,
  text
}) => (
  <div
    style={{
      padding: '20px 10px',
      fontSize: 12.5,
      color: token.colorTextTertiary,
      textAlign: 'center',
      border: `1px dashed ${token.colorBorderSecondary}`,
      borderRadius: 10
    }}
  >
    {text}
  </div>
)

const QuickCreate: React.FC<{
  token: ReturnType<typeof theme.useToken>['token']
  icon: React.ReactNode
  label: string
  onClick: () => void
}> = ({ token, icon, label, onClick }) => (
  <Button
    onClick={onClick}
    style={{
      height: 40,
      flex: 1,
      borderRadius: 10,
      border: `1px dashed ${token.colorBorderSecondary}`,
      background: 'transparent',
      color: token.colorTextSecondary,
      fontSize: 13
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.borderColor = token.colorPrimary
      e.currentTarget.style.color = token.colorPrimary
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.borderColor = token.colorBorderSecondary
      e.currentTarget.style.color = token.colorTextSecondary
    }}
  >
    <RiAddLine size={14} />
    {icon}
    {label}
  </Button>
)

export default EmptyDashboard
