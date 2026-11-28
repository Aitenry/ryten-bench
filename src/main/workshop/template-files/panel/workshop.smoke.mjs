/**
 * Smoke cases shipped with the draft (the workshop acceptance battery runs them).
 *
 * Semantics: each entry in `channels` calls the matching IPC handler on the **really loaded
 * plugin**; its arguments are the args array and the return value goes to the expect
 * assertion (true = pass, a string = failure reason).
 * `cleanup` runs **no matter what** after all cases, restoring whatever the acceptance run
 * wrote into the user's database/settings — the `$result:<channel>#<field>` argument refers
 * to an earlier case's return value.
 *
 * Without this file the workshop only runs contract-level smoke checks (loads, legal channel
 * naming, rolls back).
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
