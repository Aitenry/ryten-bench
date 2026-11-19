import React, { useState, useEffect } from 'react'
import { Typography, Tag, Descriptions, Empty } from 'antd'
import {
  RiUserLine,
  RiBuildingLine,
  RiCodeLine,
  RiLightbulbLine,
  RiCalendarLine,
  RiMapPinLine,
  RiBox3Line,
  RiQuestionLine,
  RiDashboardLine,
  RiFileTextLine,
  RiScalesLine,
  RiBuilding2Line,
  RiFlaskLine,
  RiGitBranchLine,
  RiUserStarLine,
  RiStarLine,
  RiBarChartLine,
  RiSwordLine,
  RiBugLine,
  RiMedalLine
} from '@remixicon/react'
import { theme } from 'antd'
import { ENTITY_TYPE_COLORS, ENTITY_TYPE_LABEL_KEYS, RELATION_TYPE_LABEL_KEYS } from '../../types'
import { useTranslation } from '@renderer/i18n'
import { notesApi } from '../../api'
import type { EntityDetailProps } from '../../types'

const ENTITY_ICONS: Record<string, React.ReactNode> = {
  person: <RiUserLine />,
  organization: <RiBuildingLine />,
  technology: <RiCodeLine />,
  concept: <RiLightbulbLine />,
  event: <RiCalendarLine />,
  location: <RiMapPinLine />,
  product: <RiBox3Line />,
  system: <RiDashboardLine />,
  document: <RiFileTextLine />,
  standard: <RiScalesLine />,
  facility: <RiBuilding2Line />,
  substance: <RiFlaskLine />,
  process: <RiGitBranchLine />,
  role: <RiUserStarLine />,
  skill: <RiStarLine />,
  measure: <RiBarChartLine />,
  artifact: <RiSwordLine />,
  creature: <RiBugLine />,
  realm: <RiMedalLine />,
  other: <RiQuestionLine />
}

const { Title, Text, Paragraph } = Typography

const EntityDetail: React.FC<EntityDetailProps> = ({
  entity,
  entities,
  relations,
  onRelationClick,
  onDocClick,
  onClose
}) => {
  const {
    token: { colorBgContainer, borderRadiusLG }
  } = theme.useToken()
  const { t, i18n } = useTranslation()
  /** 时间戳按当前界面语言格式化（原先硬编码 zh-CN，英文界面下仍是中文习惯） */
  const dateLocale = i18n.resolvedLanguage === 'en-US' ? 'en-US' : 'zh-CN'

  // 构建 entity id → name 的快速查找表
  const entityNameMap = React.useMemo(() => {
    const map = new Map<number, string>()
    for (const e of entities) {
      map.set(e.id, e.name)
    }
    return map
  }, [entities])

  // 获取来源文档的标题
  const [docTitles, setDocTitles] = useState<Map<number, string>>(new Map())

  useEffect(() => {
    if (!entity) return

    const sourceDocIds: number[] = entity.source_note_ids
      ? (() => {
          try {
            return JSON.parse(entity.source_note_ids)
          } catch {
            return []
          }
        })()
      : []

    if (sourceDocIds.length === 0) return

    let cancelled = false
    const fetchTitles = async (): Promise<void> => {
      const titles = new Map<number, string>()
      await Promise.all(
        sourceDocIds.map(async (id) => {
          try {
            const doc = await notesApi.docs.getById(id)
            if (!cancelled && doc) {
              titles.set(id, doc.title)
            }
          } catch {
            // ignore fetch errors
          }
        })
      )
      if (!cancelled) {
        setDocTitles(titles)
      }
    }
    fetchTitles().then()
    return () => {
      cancelled = true
    }
  }, [entity])

  if (!entity) {
    return (
      <div
        style={{
          background: colorBgContainer,
          borderRadius: borderRadiusLG,
          padding: 16,
          height: '100%'
        }}
      >
        <Empty description={t('graph.empty.noSelection')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </div>
    )
  }

  const relatedRelations = relations.filter(
    (r) => r.source_id === entity.id || r.target_id === entity.id
  )

  const entityTypeLabelKey = ENTITY_TYPE_LABEL_KEYS[entity.type]
  const entityTypeLabel = entityTypeLabelKey ? t(entityTypeLabelKey) : entity.type

  const aliases: string[] = entity.aliases
    ? (() => {
        try {
          return JSON.parse(entity.aliases)
        } catch {
          return []
        }
      })()
    : []

  const sourceDocIds: number[] = entity.source_note_ids
    ? (() => {
        try {
          return JSON.parse(entity.source_note_ids)
        } catch {
          return []
        }
      })()
    : []

  return (
    <div
      className="custom-scrollbar"
      style={{
        background: colorBgContainer,
        borderRadius: borderRadiusLG,
        padding: 16,
        height: '100%',
        overflowY: 'auto'
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 8
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                color: ENTITY_TYPE_COLORS[entity.type] || ENTITY_TYPE_COLORS.other,
                fontSize: 20
              }}
            >
              {ENTITY_ICONS[entity.type] || ENTITY_ICONS.other}
            </span>
            <Title level={5} style={{ margin: 0 }}>
              {entity.name}
            </Title>
          </div>
          {onClose && (
            <Text type="secondary" style={{ cursor: 'pointer', fontSize: 18 }} onClick={onClose}>
              ✕
            </Text>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <Tag color={ENTITY_TYPE_COLORS[entity.type]}>{entityTypeLabel}</Tag>
          {/* confidence 库列为可空（DEFAULT 1），null 按默认置信度 1 处理 */}
          {(entity.confidence ?? 1) < 1 && (
            <Tag>
              {t('graph.detail.confidence', {
                percent: ((entity.confidence ?? 1) * 100).toFixed(0)
              })}
            </Tag>
          )}
        </div>
      </div>

      {/* Description */}
      {entity.description && (
        <div style={{ marginBottom: 16 }}>
          <Text strong>{t('graph.detail.description')}</Text>
          <Paragraph
            type="secondary"
            style={{ marginTop: 4, marginBottom: 0, fontSize: 13 }}
            ellipsis={{ rows: 4, expandable: true }}
          >
            {entity.description}
          </Paragraph>
        </div>
      )}

      {/* Aliases */}
      {aliases.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Text strong>{t('graph.detail.aliases')}</Text>
          <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {aliases.map((alias) => (
              <Tag key={alias} color="default">
                {alias}
              </Tag>
            ))}
          </div>
        </div>
      )}

      {/* Source Docs */}
      {sourceDocIds.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Text strong>{t('graph.detail.sourceDocs', { count: sourceDocIds.length })}</Text>
          <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {sourceDocIds.map((id) => (
              <Tag
                key={id}
                color="blue"
                style={{
                  cursor: onDocClick ? 'pointer' : 'default',
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
                onClick={() => onDocClick?.(id)}
              >
                {docTitles.get(id) || t('graph.detail.docFallback', { id })}
              </Tag>
            ))}
          </div>
        </div>
      )}

      {/* Related Relations */}
      <div style={{ marginBottom: 16 }}>
        <Text strong>{t('graph.detail.relatedRelations', { count: relatedRelations.length })}</Text>
        {relatedRelations.length > 0 ? (
          <div style={{ marginTop: 8 }}>
            {relatedRelations.map((rel) => {
              const isSource = rel.source_id === entity.id
              const otherId = isSource ? rel.target_id : rel.source_id
              const relationLabelKey = RELATION_TYPE_LABEL_KEYS[rel.relation_type]
              const relLabel = relationLabelKey ? t(relationLabelKey) : rel.relation_type

              return (
                <div
                  key={`${rel.source_id}-${rel.target_id}-${rel.relation_type}`}
                  style={{ cursor: onRelationClick ? 'pointer' : 'default', padding: '6px 0' }}
                  onClick={() => onRelationClick?.(otherId)}
                >
                  <Text style={{ fontSize: 12 }}>
                    {isSource
                      ? entity.name
                      : entityNameMap.get(rel.source_id) || `#${rel.source_id}`}
                    <Text type="secondary">
                      {' '}
                      {t('graph.detail.relationLine', { relation: relLabel })}{' '}
                    </Text>
                    {isSource
                      ? entityNameMap.get(rel.target_id) || `#${rel.target_id}`
                      : entity.name}
                  </Text>
                  {rel.description && (
                    <div style={{ marginTop: 2, fontSize: 11, color: '#999' }}>
                      {rel.description}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('graph.detail.noRelations')}
          </Text>
        )}
      </div>

      {/* Metadata */}
      <Descriptions size="small" column={1} style={{ marginTop: 8 }}>
        <Descriptions.Item label={t('graph.detail.createdAt')}>
          {entity.created_at ? new Date(entity.created_at).toLocaleString(dateLocale) : '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('graph.detail.updatedAt')}>
          {entity.updated_at ? new Date(entity.updated_at).toLocaleString(dateLocale) : '—'}
        </Descriptions.Item>
      </Descriptions>
    </div>
  )
}

export default EntityDetail
