/**
 * 草稿自带的冒烟用例（工坊验收电池会执行它）。
 *
 * 语义：`channels` 里的每一项都会用**真实装载的插件**调用对应 IPC 处理器，
 * 参数是 args 数组，返回值交给 expect 断言（返回 true = 通过，返回字符串 = 失败原因）。
 * 加新通道时在这里补一条——它比「装上去点一下」更早发现问题。
 *
 * 这几条连起来就是一条业务路径：**建一条记录 → 列出来能看见它 → 设置能存住**。
 * `cleanup` 会把这些操作写进用户库/设置文件的东西还原（验收不该留下 smoke-item，
 * 也不该把用户的开关改成 false）：参数里的 `$result:<通道名>#<字段>` 指向前面的返回值。
 */
export default {
  channels: {
    'plugin:${vars.id}:settings-get': {
      args: [],
      expect: (value) => value && typeof value === 'object'
    },
    'plugin:${vars.id}:items-create': {
      args: [{ title: 'smoke-item', note: 'created by workshop smoke' }],
      expect: (value) => value && value.title === 'smoke-item' && typeof value.id === 'number'
    },
    'plugin:${vars.id}:items-list': {
      args: [],
      expect: (value) => Array.isArray(value) && value.some((item) => item.title === 'smoke-item')
    },
    'plugin:${vars.id}:settings-set': {
      args: [{ enabled: false, note: 'smoke' }],
      expect: (value) => value && value.enabled === false && value.note === 'smoke'
    }
  },
  cleanup: [
    {
      channel: 'plugin:${vars.id}:settings-set',
      args: ['$result:plugin:${vars.id}:settings-get']
    },
    {
      channel: 'plugin:${vars.id}:items-delete',
      args: ['$result:plugin:${vars.id}:items-create#id'],
      expect: (value) => value === true
    }
  ]
}
