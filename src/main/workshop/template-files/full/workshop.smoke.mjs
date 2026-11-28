/**
 * Smoke cases shipped with the draft (the workshop acceptance battery runs them).
 *
 * Semantics: every entry in `channels` calls the matching IPC handler on the **actually loaded
 * plugin**; the argument is the args array and the return value goes to the expect assertion
 * (true = pass, a string = failure reason). When adding a channel, add an entry here - it catches
 * problems earlier than "install it and click around".
 *
 * Together these form one business path: **create a record -> list it and see it -> settings
 * persist**. `cleanup` restores whatever these operations wrote into the user database / settings
 * file (acceptance must not leave a smoke-item behind, nor turn the user's configuration into
 * smoke): `$result:<channel>#<field>` in the arguments refers to an earlier return value.
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
      args: [{ hideDone: true, note: 'smoke' }],
      expect: (value) => value && value.hideDone === true && value.note === 'smoke'
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
