import type { zhCN } from '../zh-CN'
import { enUSCommon } from './common'
import { enUSSettings } from './settings'
import { enUSModelSettings } from './modelSettings'
import { enUSSystemInfo } from './systemInfo'
import { enUSShell } from './shell'
import { enUSMarkdown } from './markdown'
import { harnessEnUS } from './harness'
import { notesEnUS } from './notes'
import { enUSLattice } from './lattice'

/**
 * `typeof zhCN` constraint: keys align one-to-one with the Chinese source language, so a missing
 * or extra key fails at compile time.
 * harness / notes have moved out of the plugin; their entries ship statically with the system
 * features.
 */
export const enUS: typeof zhCN = {
  common: enUSCommon,
  settings: enUSSettings,
  modelSettings: enUSModelSettings,
  systemInfo: enUSSystemInfo,
  shell: enUSShell,
  markdown: enUSMarkdown,
  ...harnessEnUS,
  ...notesEnUS,
  /* Login / account / Lattice plugin hub / sync */
  ...enUSLattice
}
