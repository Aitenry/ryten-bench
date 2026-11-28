import type { ${vars.pascal}ZhCN } from './zh-CN'

/**
 * English entries for ${vars.title}: **aligned key for key** with zh-CN (that is where the type
 * comes from; a missing or extra key fails to compile).
 *
 * Wording follows the same "label + what it affects" pattern: do not paste the Chinese in just to
 * match keys, or it reads wrong once the UI switches to English.
 */
export const ${vars.pascal}EnUS: typeof ${vars.pascal}ZhCN = {
  '${vars.id}': {
    menu: { title: ${vars.titleJson} },
    settings: { title: ${vars.titleJson} },
    page: {
      title: ${vars.titleJson},
      add: 'New',
      empty: 'Nothing here yet - hit "New" to add one.',
      emptyFiltered: 'Nothing left to do.',
      deleteConfirm: 'Delete this record?',
      moreItems: '{{count}} more (widen the window to see them)',
      overview: 'Overview',
      records: 'Records',
      pending: 'Pending',
      loading: 'Loading…'
    },
    form: {
      createTitle: 'New record',
      editTitle: 'Edit record',
      titleLabel: 'Title',
      titlePlaceholder: 'Write something',
      noteLabel: 'Note',
      notePlaceholder: 'optional'
    },
    settingsPage: {
      section: { list: 'List' },
      hideDoneLabel: 'Hide completed',
      hideDoneHint: 'Only affects the list; records are not deleted.',
      noteLabel: 'Page note',
      notePlaceholder: 'A short note to yourself',
      noteHint: 'Shown in the overview panel on the page; leave empty to hide it.',
      saveFailed: 'Could not save. Try again.',
      storageHint: 'Records live in the app database; settings live under plugin-state in userData.'
    }
  }
}

export default ${vars.pascal}EnUS
