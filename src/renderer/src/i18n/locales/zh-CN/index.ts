import { zhCNCommon } from './common'
import { zhCNSettings } from './settings'
import { zhCNModelSettings } from './modelSettings'
import { zhCNSystemInfo } from './systemInfo'
import { zhCNShell } from './shell'
import { zhCNMarkdown } from './markdown'
import { harnessZhCN } from './harness'
import { notesZhCN } from './notes'
import { zhCNLattice } from './lattice'

/**
 * Simplified Chinese is the **source language**: entry structure and copy are defined here.
 * Other locale files must be declared as `typeof zhCN`; a missing or extra key is a compile error.
 *
 * harness / notes are no longer plugins; their entries are now bundled statically with system
 * features (no longer registered by plugin install).
 */
export const zhCN = {
  common: zhCNCommon,
  settings: zhCNSettings,
  modelSettings: zhCNModelSettings,
  systemInfo: zhCNSystemInfo,
  shell: zhCNShell,
  markdown: zhCNMarkdown,
  ...harnessZhCN,
  ...notesZhCN,
  /* Login / account / Lattice plugin hub / sync (login.*, lattice.*, plugins.hub.*, sync.*) */
  ...zhCNLattice
}
