/**
 * 草稿自带的冒烟用例（工坊验收电池会执行它）。
 *
 * 语义：`channels` 里的每一项都会用**真实装载的插件**调用对应 IPC 处理器，
 * 参数是 args 数组，返回值交给 expect 断言（返回 true = 通过，返回字符串 = 失败原因）。
 * `cleanup` 在全部用例之后**无论如何都会执行**，用来把验收写进用户库/设置里的东西
 * 还原——参数里的 `$result:<通道名>#<字段>` 指向前面的用例返回值。
 *
 * 没写这个文件时工坊只做契约级冒烟（能装载、通道命名合法、可回滚）。
 */
export default {
  channels: {
    'plugin:${vars.id}:settings-get': {
      args: [],
      expect: (value) => value && typeof value === "object"
    },
    'plugin:${vars.id}:settings-set': {
      args: [{ enabled: true, note: 'smoke' }],
      expect: (value) => value && value.enabled === true && value.note === 'smoke'
    }
  },
  cleanup: [
    {
      channel: 'plugin:${vars.id}:settings-set',
      args: ['$result:plugin:${vars.id}:settings-get']
    }
  ],
}
