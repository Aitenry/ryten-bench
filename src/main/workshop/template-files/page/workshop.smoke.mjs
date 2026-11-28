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
    'plugin:${vars.id}:state-get': {
      args: [],
      expect: (value) => value && typeof value === "object"
    },
    'plugin:${vars.id}:state-set': {
      args: ['smoke-value'],
      expect: (value) => value && value.value === 'smoke-value'
    }
  },
  cleanup: [
    {
      channel: 'plugin:${vars.id}:state-set',
      args: ['$result:plugin:${vars.id}:state-get#value']
    }
  ],
}
