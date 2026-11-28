/**
 * Cross-process contract for ${vars.title} (shared by the main-process mapper and the renderer
 * components).
 *
 * Rule: **do not import drizzle / electron / node** - the renderer imports this as well, and
 * pulling in anything from one side bundles that side into the other side's output.
 */

/** One record (a row of the ${vars.itemsToolName} table) */
export interface ${vars.pascal}Item {
  id: number
  title: string
  note: string
  done: boolean
  createdAt: string | null
  updatedAt: string | null
}

/** Create/update input (id and timestamps are managed by the database) */
export interface ${vars.pascal}ItemInput {
  title: string
  note?: string
}

/**
 * Configuration from the settings page (stored separately from application data: it is
 * configuration, not a record).
 *
 * Both fields must **actually be read** (on the page: `hideDone` filters the list, `note` shows in
 * the overview panel) - do not leave settings that are only persisted and never consumed; users
 * will toggle them first.
 */
export interface ${vars.pascal}Settings {
  /** Hide completed records in the list (display only, data is not deleted) */
  hideDone: boolean
  /** Note for the overview panel on the right of the page (empty string = hidden) */
  note: string
}

/** Everything the page loads in one go (records + settings) */
export interface ${vars.pascal}State {
  items: ${vars.pascal}Item[]
  settings: ${vars.pascal}Settings
}
