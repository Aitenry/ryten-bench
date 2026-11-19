import React from 'react'
import { Modal, Progress, Typography, Space, Tag, Button, Row, Col } from 'antd'
import { LoadingOutlined, MinusOutlined, DatabaseOutlined, LinkOutlined } from '@ant-design/icons'
import { useTranslation } from '@renderer/i18n'
import type { BuildProgressProps } from '../../types'

const { Text } = Typography

const BuildProgress: React.FC<BuildProgressProps> = ({
  open,
  wikiTitle,
  phaseLabel,
  phaseProgress,
  overallProgress,
  processedDocs,
  totalDocs,
  processedChunks,
  totalChunks,
  entityCount,
  relationCount,
  message,
  onMinimize
}) => {
  const { t } = useTranslation()
  return (
    <Modal
      title={
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space>
            <LoadingOutlined />
            <span>{wikiTitle}</span>
          </Space>
          <Button type="text" icon={<MinusOutlined />} onClick={onMinimize} size="small" />
        </Space>
      }
      open={open}
      footer={null}
      closable={false}
      mask={{ closable: false }}
      width={480}
    >
      <div style={{ padding: '8px 0' }}>
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {t('graph.progress.overallProgress')}
            </Text>
            <Text style={{ fontSize: 13, fontWeight: 500 }}>{overallProgress}%</Text>
          </div>
          <Progress
            percent={overallProgress}
            status="active"
            strokeColor="#1677ff"
            showInfo={false}
            strokeWidth={10}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <Tag color="processing">{phaseLabel}</Tag>
            <Text style={{ fontSize: 13 }}>{phaseProgress}%</Text>
          </div>
          <Progress
            percent={phaseProgress}
            status="active"
            strokeColor="#52c41a"
            showInfo={false}
            strokeWidth={6}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <Text style={{ fontSize: 14 }}>{message}</Text>
        </div>

        <Row gutter={16} style={{ marginBottom: 12 }}>
          <Col span={12}>
            <Space>
              <DatabaseOutlined style={{ color: '#1677ff' }} />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('graph.progress.entityLabel')}: <Text strong>{entityCount}</Text>
              </Text>
            </Space>
          </Col>
          <Col span={12}>
            <Space>
              <LinkOutlined style={{ color: '#52c41a' }} />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('graph.progress.relationLabel')}: <Text strong>{relationCount}</Text>
              </Text>
            </Space>
          </Col>
        </Row>

        {totalDocs > 0 && (
          <div style={{ marginBottom: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('graph.progress.documentsProcessed', {
                processed: processedDocs,
                total: totalDocs
              })}
            </Text>
          </div>
        )}

        {totalChunks > 0 && (
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('graph.progress.chunksProcessed', {
                processed: processedChunks,
                total: totalChunks
              })}
            </Text>
          </div>
        )}
      </div>
    </Modal>
  )
}

export default BuildProgress
