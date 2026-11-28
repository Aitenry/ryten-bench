import type { RemixiconComponentType } from '@remixicon/react'
import {
  RiBracesLine,
  RiCodeBoxLine,
  RiCodeSSlashLine,
  RiCss3Fill,
  RiDatabase2Line,
  RiFileCodeLine,
  RiFileExcelLine,
  RiFileLine,
  RiFilePaper2Line,
  RiFileTextLine,
  RiFileZipLine,
  RiGitBranchLine,
  RiHtml5Fill,
  RiImageLine,
  RiJavaFill,
  RiJavascriptFill,
  RiMarkdownLine,
  RiPaletteLine,
  RiReactjsLine,
  RiSettings3Line,
  RiTerminalBoxLine,
  RiVuejsLine
} from '@remixicon/react'
import { getLanguageId } from './fileLang'

/**
 * File-type icons: shared by the file explorer and tabs.
 *
 * Previously every file used the same generic file icon, so you couldn't tell what a file was.
 * Here icons and **restrained** accent colors are assigned by language/purpose: the icon is
 * tinted and the filename keeps the body color, with no full rainbow (users explicitly asked for
 * nothing flashy).
 *
 * Anything unmatched falls back to the plain-text icon; an odd extension never throws.
 */
export interface FileIconSpec {
  Icon: RemixiconComponentType
  /** Icon color (one each for light and dark, so contrast holds on both backgrounds) */
  color: string
}

/** Special cases keyed directly by extension/file name (take priority over language detection) */
const SPECIAL: Record<string, { icon: FileIconSpec['Icon']; light: string; dark: string }> = {
  'package.json': { icon: RiSettings3Line, light: '#b3452f', dark: '#e08a70' },
  'package-lock.json': { icon: RiSettings3Line, light: '#8a8f96', dark: '#8b9098' },
  'pnpm-lock.yaml': { icon: RiSettings3Line, light: '#8a8f96', dark: '#8b9098' },
  'tsconfig.json': { icon: RiSettings3Line, light: '#2f5f8f', dark: '#8ab4d8' },
  '.gitignore': { icon: RiGitBranchLine, light: '#b3452f', dark: '#e08a70' },
  '.gitattributes': { icon: RiGitBranchLine, light: '#b3452f', dark: '#e08a70' },
  dockerfile: { icon: RiTerminalBoxLine, light: '#2f7f8f', dark: '#5fb3c4' },
  makefile: { icon: RiTerminalBoxLine, light: '#6b7280', dark: '#a8adb8' },
  license: { icon: RiFileTextLine, light: '#8a8f96', dark: '#8b9098' },
  readme: { icon: RiFileTextLine, light: '#2f5f8f', dark: '#8ab4d8' }
}

/** Language id → icon and colors */
const BY_LANGUAGE: Record<string, { icon: FileIconSpec['Icon']; light: string; dark: string }> = {
  javascript: { icon: RiJavascriptFill, light: '#b58900', dark: '#e0c46c' },
  typescript: { icon: RiJavascriptFill, light: '#2f6f9f', dark: '#7fb2e5' },
  jsx: { icon: RiReactjsLine, light: '#2f8fa8', dark: '#5fc4dc' },
  tsx: { icon: RiReactjsLine, light: '#2f8fa8', dark: '#5fc4dc' },
  json: { icon: RiBracesLine, light: '#b58900', dark: '#e0c46c' },
  html: { icon: RiHtml5Fill, light: '#c0562f', dark: '#e08a70' },
  vue: { icon: RiVuejsLine, light: '#2f8f5b', dark: '#7fd0a0' },
  css: { icon: RiCss3Fill, light: '#2f6fbf', dark: '#7fb2e5' },
  scss: { icon: RiCss3Fill, light: '#b04a8a', dark: '#e0a0c8' },
  less: { icon: RiCss3Fill, light: '#2f5f8f', dark: '#8ab4d8' },
  markdown: { icon: RiMarkdownLine, light: '#5a6b7f', dark: '#9aa7b8' },
  python: { icon: RiFileCodeLine, light: '#2f6b4f', dark: '#7fc79a' },
  rust: { icon: RiFileCodeLine, light: '#a05a2c', dark: '#e0a06a' },
  go: { icon: RiFileCodeLine, light: '#2f8fa8', dark: '#5fc4dc' },
  java: { icon: RiJavaFill, light: '#b3452f', dark: '#e08a70' },
  cpp: { icon: RiCodeSSlashLine, light: '#2f5f8f', dark: '#8ab4d8' },
  ruby: { icon: RiCodeSSlashLine, light: '#b3452f', dark: '#e08a70' },
  php: { icon: RiCodeSSlashLine, light: '#6a5aa8', dark: '#a89ce0' },
  sql: { icon: RiDatabase2Line, light: '#2f7f8f', dark: '#5fb3c4' },
  shell: { icon: RiTerminalBoxLine, light: '#4a7c59', dark: '#8fc7a0' },
  powershell: { icon: RiTerminalBoxLine, light: '#2f6fbf', dark: '#7fb2e5' },
  yaml: { icon: RiSettings3Line, light: '#8a6d3b', dark: '#d9b06a' },
  toml: { icon: RiSettings3Line, light: '#8a6d3b', dark: '#d9b06a' },
  ini: { icon: RiSettings3Line, light: '#8a6d3b', dark: '#d9b06a' },
  xml: { icon: RiCodeBoxLine, light: '#2f7f8f', dark: '#5fb3c4' },
  dockerfile: { icon: RiTerminalBoxLine, light: '#2f7f8f', dark: '#5fb3c4' },
  plaintext: { icon: RiFileTextLine, light: '#8a8f96', dark: '#8b9098' }
}

/** Extension fallback for images / archives / documents etc. (not part of any language package) */
const BY_EXT: Record<string, { icon: FileIconSpec['Icon']; light: string; dark: string }> = {
  png: { icon: RiImageLine, light: '#a06a4a', dark: '#e0a884' },
  jpg: { icon: RiImageLine, light: '#a06a4a', dark: '#e0a884' },
  jpeg: { icon: RiImageLine, light: '#a06a4a', dark: '#e0a884' },
  gif: { icon: RiImageLine, light: '#a06a4a', dark: '#e0a884' },
  webp: { icon: RiImageLine, light: '#a06a4a', dark: '#e0a884' },
  ico: { icon: RiImageLine, light: '#a06a4a', dark: '#e0a884' },
  svg: { icon: RiPaletteLine, light: '#a06a4a', dark: '#e0a884' },
  pdf: { icon: RiFilePaper2Line, light: '#b3452f', dark: '#e08a70' },
  doc: { icon: RiFilePaper2Line, light: '#2f5f8f', dark: '#8ab4d8' },
  docx: { icon: RiFilePaper2Line, light: '#2f5f8f', dark: '#8ab4d8' },
  xls: { icon: RiFileExcelLine, light: '#2f6b4f', dark: '#7fc79a' },
  xlsx: { icon: RiFileExcelLine, light: '#2f6b4f', dark: '#7fc79a' },
  csv: { icon: RiFileExcelLine, light: '#2f6b4f', dark: '#7fc79a' },
  zip: { icon: RiFileZipLine, light: '#8a6d3b', dark: '#d9b06a' },
  gz: { icon: RiFileZipLine, light: '#8a6d3b', dark: '#d9b06a' },
  tar: { icon: RiFileZipLine, light: '#8a6d3b', dark: '#d9b06a' },
  '7z': { icon: RiFileZipLine, light: '#8a6d3b', dark: '#d9b06a' },
  lock: { icon: RiFileTextLine, light: '#8a8f96', dark: '#8b9098' },
  log: { icon: RiFileTextLine, light: '#8a8f96', dark: '#8b9098' },
  txt: { icon: RiFileTextLine, light: '#8a8f96', dark: '#8b9098' }
}

/** Get the icon and color for a path */
export function getFileIcon(filePath: string, isDarkMode: boolean): FileIconSpec {
  const name = (filePath.split(/[\\/]/).pop() ?? '').toLowerCase()
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  const pick = (spec?: {
    icon: FileIconSpec['Icon']
    light: string
    dark: string
  }): FileIconSpec => ({
    Icon: spec ? spec.icon : RiFileLine,
    color: spec ? (isDarkMode ? spec.dark : spec.light) : isDarkMode ? '#8b9098' : '#8a8f96'
  })
  if (SPECIAL[name]) return pick(SPECIAL[name])
  if (BY_EXT[ext]) return pick(BY_EXT[ext])
  return pick(BY_LANGUAGE[getLanguageId(filePath)])
}
