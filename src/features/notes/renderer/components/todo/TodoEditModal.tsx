import React, { useEffect } from 'react'
import { Modal, Form, Input, DatePicker, Select } from 'antd'
import type { TFunction } from 'i18next'
import dayjs from 'dayjs'
import { useTranslation } from '@renderer/i18n'
import type { TodoItem } from '../../types'

/* 模块级普通函数：不调 hook，译文函数由调用方以参数传入 */
const getStatusOptions = (
  t: TFunction,
  currentStatus: number
): { value: number; label: string }[] => {
  if (currentStatus === 1) {
    return [
      { value: 1, label: t('notes.status.doing') },
      { value: 2, label: t('notes.status.done') }
    ]
  }
  return [
    { value: 0, label: t('notes.status.pending') },
    { value: 1, label: t('notes.status.doing') },
    { value: 2, label: t('notes.status.done') }
  ]
}

/* ──────────── Types ──────────── */

export interface TodoFormValues {
  title: string
  due_date: string | null
  priority: number
  status: number
  category: string | null
}

export interface TodoEditModalProps {
  editModalOpen: boolean
  currentTodo: TodoItem | null
  onEditClose: () => void
  onEditSave: (values: TodoFormValues) => Promise<void>

  addModalOpen: boolean
  onAddClose: () => void
  onAddSave: (values: Omit<TodoFormValues, 'status'>) => Promise<void>
}

/* ──────────── Component ──────────── */

const TodoEditModal: React.FC<TodoEditModalProps> = ({
  editModalOpen,
  currentTodo,
  onEditClose,
  onEditSave,
  addModalOpen,
  onAddClose,
  onAddSave
}) => {
  const { t } = useTranslation()
  const [editForm] = Form.useForm<TodoFormValues>()
  const [addForm] = Form.useForm<Omit<TodoFormValues, 'status'>>()

  // Sync edit form when currentTodo changes
  useEffect(() => {
    if (editModalOpen && currentTodo) {
      editForm.setFieldsValue({
        title: currentTodo.title,
        due_date: currentTodo.due_date ? dayjs(currentTodo.due_date) : null,
        priority: currentTodo.priority,
        status: currentTodo.status,
        category: currentTodo.category
      } as unknown as TodoFormValues)
    }
  }, [editModalOpen, currentTodo, editForm])

  const handleEditOk = async (): Promise<void> => {
    try {
      const values = await editForm.validateFields()
      await onEditSave({
        title: values.title,
        due_date: values.due_date
          ? dayjs(values.due_date as unknown as string).format('YYYY-MM-DD')
          : null,
        priority: values.priority,
        status: values.status,
        category: values.category || null
      })
    } catch {
      // Validation failed — do nothing, form will show errors
    }
  }

  const handleAddOk = async (): Promise<void> => {
    try {
      const values = await addForm.validateFields()
      await onAddSave({
        title: values.title,
        due_date: values.due_date
          ? dayjs(values.due_date as unknown as string).format('YYYY-MM-DD')
          : null,
        priority: values.priority,
        category: values.category || null
      })
      // 修复：成功后表单不重置,下次新建预填上次内容（旧 priority/category 一并写入新待办）
      addForm.resetFields()
    } catch {
      // Validation failed
    }
  }

  const handleEditCancel = (): void => {
    editForm.resetFields()
    onEditClose()
  }

  const handleAddCancel = (): void => {
    addForm.resetFields()
    onAddClose()
  }

  return (
    <>
      {/* Edit / Preview Modal */}
      <Modal
        title={t('notes.todo.editTitle')}
        open={editModalOpen}
        onOk={handleEditOk}
        onCancel={handleEditCancel}
        width={600}
        okText={t('common.action.save')}
        cancelText={t('common.action.cancel')}
      >
        <Form
          key={currentTodo?.id ?? 'edit-form-empty'}
          form={editForm}
          layout="vertical"
          initialValues={
            currentTodo
              ? {
                  title: currentTodo.title,
                  due_date: currentTodo.due_date ? dayjs(currentTodo.due_date) : null,
                  priority: currentTodo.priority,
                  status: currentTodo.status,
                  category: currentTodo.category
                }
              : undefined
          }
        >
          {currentTodo && (
            <>
              <Form.Item
                name="title"
                label={t('notes.field.title')}
                rules={[
                  {
                    required: true,
                    message: t('common.message.pleaseInput', { field: t('notes.field.title') })
                  }
                ]}
              >
                <Input placeholder={t('notes.todo.titlePlaceholder')} />
              </Form.Item>

              <Form.Item name="due_date" label={t('notes.field.dueDate')}>
                <DatePicker
                  style={{ width: '100%' }}
                  placeholder={t('common.message.pleaseSelect', {
                    field: t('notes.field.dueDate')
                  })}
                  format="YYYY-MM-DD"
                />
              </Form.Item>

              <div className="grid grid-cols-3 gap-4">
                <Form.Item name="priority" label={t('notes.field.priority')} className="mb-0">
                  <Select
                    placeholder={t('common.message.pleaseSelect', {
                      field: t('notes.field.priority')
                    })}
                  >
                    {[0, 1, 2, 3, 4, 5, 6, 7].map((p) => (
                      <Select.Option key={p} value={p}>
                        P{p}
                      </Select.Option>
                    ))}
                  </Select>
                </Form.Item>

                <Form.Item name="status" label={t('notes.field.status')} className="mb-0">
                  <Select
                    placeholder={t('common.message.pleaseSelect', {
                      field: t('notes.field.status')
                    })}
                  >
                    {getStatusOptions(t, currentTodo.status ?? 0).map((option) => (
                      <Select.Option key={option.value} value={option.value}>
                        {option.label}
                      </Select.Option>
                    ))}
                  </Select>
                </Form.Item>

                <Form.Item name="category" label={t('notes.field.category')} className="mb-0">
                  <Input placeholder={t('notes.todo.categoryPlaceholder')} />
                </Form.Item>
              </div>
            </>
          )}
        </Form>
      </Modal>

      {/* Add Modal */}
      <Modal
        title={t('notes.todo.addTitle')}
        open={addModalOpen}
        onOk={handleAddOk}
        onCancel={handleAddCancel}
        width={600}
        okText={t('common.action.add')}
        cancelText={t('common.action.cancel')}
      >
        <Form form={addForm} layout="vertical">
          <Form.Item
            name="title"
            label={t('notes.field.title')}
            rules={[
              {
                required: true,
                message: t('common.message.pleaseInput', { field: t('notes.field.title') })
              }
            ]}
          >
            <Input placeholder={t('notes.todo.titlePlaceholder')} />
          </Form.Item>

          <Form.Item name="due_date" label={t('notes.field.dueDate')}>
            <DatePicker
              style={{ width: '100%' }}
              placeholder={t('common.message.pleaseSelect', { field: t('notes.field.dueDate') })}
              format="YYYY-MM-DD"
            />
          </Form.Item>

          <Form.Item name="priority" label={t('notes.field.priority')}>
            <Select
              placeholder={t('common.message.pleaseSelect', { field: t('notes.field.priority') })}
            >
              {[0, 1, 2, 3, 4, 5, 6, 7].map((p) => (
                <Select.Option key={p} value={p}>
                  P{p}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item name="category" label={t('notes.field.category')}>
            <Input placeholder={t('notes.todo.categoryPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

export default TodoEditModal
