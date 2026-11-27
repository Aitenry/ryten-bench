/**
 * manage_materials（资料整理）工具装配回归：
 * - 工具名 / schema 里的命令枚举 / 顶层描述确实指向统一入口；
 * - 缺参分支在**不碰数据库**的情况下就能返回可读提示（zod 通过后由 dispatch 守卫）。
 *
 * 这个套件需要 electron / electron-store / electron-log 的替身，见 scripts/ai-selftest.mjs
 * 的 stubPlugin；不执行任何真实 DB 查询。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildManageMaterialsTool } from '../../src/main/tools/notes/materials'
import { notesToolContributions } from '../../src/main/tools/notes'
import {
  buildTools,
  expandSelectionToolNames,
  listAvailableTools,
  registerBuiltinHarnessTools,
  setMcpResourceOps,
  setMcpToolProvider,
  unregisterBuiltinHarnessTools
} from '../../src/main/tools/harness/builders'
import type { McpResourceOps } from '../../src/main/tools/harness/mcp-resources'
import {
  MATERIALS_TOOL_NAME,
  MCP_TOOL_GROUP,
  WEB_TOOL_GROUP,
  canonicalToolName
} from '../../src/shared/harness/mcp'

test('工具下拉：四个旧工具消失，只留一个 manage_materials', () => {
  registerBuiltinHarnessTools(notesToolContributions)
  try {
    const names = listAvailableTools().map((tool) => tool.name)
    assert.deepEqual(names, [
      'get_weather',
      'get_time',
      WEB_TOOL_GROUP,
      'present',
      MATERIALS_TOOL_NAME,
      'schedule-tasks'
    ])
    // 定时任务 4 个工具合并成一个选择项，展开后仍是 4 个真实工具
    const expandedSchedule = buildTools(['schedule-tasks']).map((tool) => tool.name).sort()
    assert.deepEqual(expandedSchedule, [
      'schedule_create',
      'schedule_edit',
      'schedule_list',
      'schedule_view'
    ])
    // 旧名与分组项同时选中时也不重复挂载
    const deduped = expandSelectionToolNames(['schedule-tasks', 'schedule_create'])
    assert.equal(deduped.filter((name) => name === 'schedule_create').length, 1)
    for (const legacy of ['manage_docs', 'manage_todos', 'manage_wikis', 'search_graph']) {
      assert.equal(names.includes(legacy), false, `${legacy} should no longer be selectable`)
    }

    // 执行点同样迁移：旧名 + 新名同时出现也只建一个实例
    const instances = buildTools(['manage_docs', MATERIALS_TOOL_NAME, 'manage_todos'])
    assert.deepEqual(
      instances.map((tool) => tool.name),
      [MATERIALS_TOOL_NAME]
    )
  } finally {
    unregisterBuiltinHarnessTools(notesToolContributions)
  }
})

test('工具下拉：网页抓取 / 网页搜索合并成一项 web-tools，运行时展开回两个工具', () => {
  registerBuiltinHarnessTools(notesToolContributions)
  try {
    const infos = listAvailableTools()
    const web = infos.find((tool) => tool.name === WEB_TOOL_GROUP)
    assert.ok(web, 'web-tools 应该出现在清单里')
    assert.equal(web.source, 'system')
    // 合成一项：清单里不再单独出现 web_fetch / web_search
    assert.equal(
      infos.some((tool) => tool.name === 'web_fetch'),
      false
    )
    assert.equal(
      infos.some((tool) => tool.name === 'web_search'),
      false
    )
    // 位置仍是本地工具那一档（天气、时间、网页、交付文件），不被推到插件工具后面
    assert.deepEqual(
      infos.map((tool) => tool.name).slice(0, 4),
      ['get_weather', 'get_time', WEB_TOOL_GROUP, 'present']
    )

    // 展开后仍是两个真实工具
    assert.deepEqual(buildTools([WEB_TOOL_GROUP]).map((tool) => tool.name).sort(), [
      'web_fetch',
      'web_search'
    ])
    // 旧配置里逐个勾的两个名字：归一到分组项，运行时只挂一份、不重复
    assert.equal(canonicalToolName('web_fetch'), WEB_TOOL_GROUP)
    assert.equal(canonicalToolName('web_search'), WEB_TOOL_GROUP)
    assert.deepEqual(
      expandSelectionToolNames([WEB_TOOL_GROUP, 'web_fetch', 'web_search']).sort(),
      ['web_fetch', 'web_search']
    )
  } finally {
    unregisterBuiltinHarnessTools(notesToolContributions)
  }
})

test('工具清单：每项都带来源标签（系统 / 插件 / MCP）', () => {
  registerBuiltinHarnessTools(notesToolContributions)
  try {
    const infos = listAvailableTools()
    // 插件与 MCP 在离线环境里都不存在，但来源字段必须统一写上（界面靠它出标签）
    assert.equal(
      infos.every((tool) => tool.source !== undefined),
      true,
      infos
        .filter((tool) => tool.source === undefined)
        .map((tool) => tool.name)
        .join(',')
    )
    assert.equal(
      infos.every((tool) => ['system', 'plugin', 'mcp'].includes(tool.source ?? '')),
      true
    )
    for (const name of ['get_weather', 'get_time', WEB_TOOL_GROUP, 'present', 'schedule-tasks']) {
      assert.equal(infos.find((tool) => tool.name === name)?.source, 'system', name)
    }
    assert.equal(infos.find((tool) => tool.name === MATERIALS_TOOL_NAME)?.source, 'system')
  } finally {
    unregisterBuiltinHarnessTools(notesToolContributions)
  }
})

test('MCP：工具清单里不再有「MCP 服务器」全选项，只能按服务器选', () => {
  registerBuiltinHarnessTools(notesToolContributions)
  /** 资源工具的数据源替身（只关心「当前连了哪几台」） */
  const ops = (servers: string[]): McpResourceOps => ({
    servers: () => servers,
    listResources: async () => ({ resources: [] }),
    listTemplates: async () => ({ templates: [] }),
    read: async () => ({ contents: [] })
  })
  try {
    // 一台服务器都没连：清单里当然没有 MCP 相关项
    setMcpResourceOps(ops([]))
    assert.equal(
      listAvailableTools().some((tool) => tool.name === MCP_TOOL_GROUP),
      false
    )

    // 连上一台之后：清单里**依然不列**全选项，也不列按服务器的分组项
    setMcpResourceOps(ops(['demo']))
    const names = listAvailableTools().map((tool) => tool.name)
    assert.equal(names.includes(MCP_TOOL_GROUP), false, '全选项已从工具清单里删掉')
    assert.equal(
      names.some((name) => name.startsWith('mcp@')),
      false,
      '按服务器的分组项只在输入框的 MCP 选择器里'
    )

    // 运行时：勾一台服务器 = 那台服务器的工具 + 资源三件套
    setMcpToolProvider(() => ({
      tools: [],
      infos: [
        { name: 'mcp__demo__search', label: 'search', description: '', icon: '', color: '' }
      ]
    }))
    assert.deepEqual(expandSelectionToolNames(['mcp@demo']).sort(), [
      'list_mcp_resource_templates',
      'list_mcp_resources',
      'mcp__demo__search',
      'read_mcp_resource'
    ])

    // 历史配置里的 `mcp`（全选）仍能展开，不报错、不丢资源能力
    assert.deepEqual(expandSelectionToolNames([MCP_TOOL_GROUP]).sort(), [
      'list_mcp_resource_templates',
      'list_mcp_resources',
      'mcp__demo__search',
      'read_mcp_resource'
    ])
  } finally {
    setMcpToolProvider(undefined)
    setMcpResourceOps(undefined)
    unregisterBuiltinHarnessTools(notesToolContributions)
  }
})

test('MCP 资源工具：只挂给声明了 resources 的服务器，且只能读本轮勾选的服务器', async () => {
  registerBuiltinHarnessTools(notesToolContributions)
  /** 连着的服务器固定 a / b；capable 决定谁声明了 resources 能力 */
  const ops = (capable: string[]): McpResourceOps => ({
    servers: () => ['a', 'b'],
    resourceCapableServers: () => capable,
    listResources: async () => ({ resources: [] }),
    listTemplates: async () => ({ templates: [] }),
    read: async (server, uri) => ({
      contents: [{ uri, mimeType: 'text/plain', text: `read ${server}` }]
    })
  })
  try {
    // 两台都没声明 resources：勾了也不挂（连展开结果里都不该出现）
    setMcpResourceOps(ops([]))
    assert.deepEqual(expandSelectionToolNames(['mcp@a']), [])
    assert.deepEqual(
      buildTools(['mcp@a']).map((tool) => tool.name),
      []
    )

    // 只有 a 声明：勾 a 挂资源三件套；勾 b（不支持）不挂
    setMcpResourceOps(ops(['a']))
    assert.deepEqual(
      buildTools(['mcp@a'])
        .map((tool) => tool.name)
        .sort(),
      ['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource']
    )
    assert.deepEqual(
      buildTools(['mcp@b']).map((tool) => tool.name),
      []
    )

    // 作用域：勾 a 时读 b 会被拒，并告诉模型本轮能用哪几台
    setMcpResourceOps(ops(['a', 'b']))
    const read = buildTools(['mcp@a']).find((tool) => tool.name === 'read_mcp_resource')
    assert.ok(read, 'read_mcp_resource should be mounted for the selected server')
    const rejected = String(await read.invoke({ server: 'b', uri: 'x://y' }))
    assert.match(rejected, /不在本轮启用/)
    const accepted = String(await read.invoke({ server: 'a', uri: 'x://y' }))
    assert.match(accepted, /read a/)
  } finally {
    setMcpResourceOps(undefined)
    unregisterBuiltinHarnessTools(notesToolContributions)
  }
})

test('manage_materials：名字、描述与命令枚举齐全', () => {
  const tool = buildManageMaterialsTool()
  assert.equal(tool.name, MATERIALS_TOOL_NAME)
  assert.match(tool.description, /doc\.replace_lines/)
  assert.match(tool.description, /todo\.bulk_update/)
  assert.match(tool.description, /graph\.entity/)

  const schema = tool.getJsonSchema!() as {
    properties?: Record<string, { enum?: string[]; type?: string }>
    required?: string[]
  }
  const command = schema.properties?.command
  assert.ok(command, 'schema.properties.command exists')
  assert.equal(command.type, 'string')
  assert.ok(command.enum?.includes('doc.get'))
  assert.ok(command.enum?.includes('doc.replace_lines'))
  assert.ok(command.enum?.includes('doc.patch'))
  assert.ok(command.enum?.includes('todo.bulk_update'))
  assert.ok(command.enum?.includes('kb.archive'))
  assert.ok(command.enum?.includes('kb.move_doc'))
  assert.ok(command.enum?.includes('graph.entity'))
  assert.deepEqual(schema.required, ['command'])
  assert.ok(schema.properties?.edits, 'doc.patch edits array is declared')
})

test('manage_materials：缺参守卫返回可读提示且不触发 DB', async () => {
  const tool = buildManageMaterialsTool()
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ command: 'doc.get' }, 'docId'],
    [{ command: 'doc.replace_lines', docId: 1 }, 'startLine'],
    [{ command: 'doc.replace_text', docId: 1 }, 'oldText'],
    [{ command: 'todo.get' }, 'todoId'],
    [{ command: 'todo.bulk_update' }, 'ids'],
    [{ command: 'kb.create_dir', wikiId: 1 }, 'name'],
    [{ command: 'kb.move_doc' }, 'docId'],
    [{ command: 'graph.search' }, 'query']
  ]
  for (const [args, expected] of cases) {
    const result = await tool.invoke(args as never)
    assert.equal(typeof result, 'string', `${String(args.command)} should return text`)
    assert.ok(
      String(result).includes(expected),
      `${String(args.command)}: expected "${expected}" in ${String(result)}`
    )
  }
})

test('manage_materials：未知命令被 schema 拒绝', async () => {
  const tool = buildManageMaterialsTool()
  await assert.rejects(
    () => tool.invoke({ command: 'doc.unknown' } as never),
    /input validation failed/
  )
})
