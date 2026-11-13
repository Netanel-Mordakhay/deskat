import { app } from 'electron'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import type { CatInfo, CatManifest, Settings } from '../shared/types'

/** Folder that holds one sub-folder per cat (each with cat.json + final/*.webm). */
export const CATS_ROOT = app.isPackaged
  ? join(process.resourcesPath, 'cats')
  : resolve(__dirname, '../../..') // app/out/main -> deskat

const DEFAULTS: Settings = {
  cat: 'grace',
  size: 220,
  layer: 'top',
  displayId: null,
  strolls: true,
  strollEveryMin: [3, 8],
  variantEverySec: [10, 25],
  positions: {},
  calendarLeadMin: 5,
  assistant: { model: 'claude-haiku-5-5' },
  shortcut: 'Control+Alt+D',
  hideFromCapture: true,
  quietInMeetings: true,
  mail: { mode: 'important', senders: '' },
  morningBrief: true
}

const file = () => join(app.getPath('userData'), 'settings.json')

export function loadSettings(): Settings {
  try {
    if (existsSync(file())) {
      const saved = JSON.parse(readFileSync(file(), 'utf8'))
      const model = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'].includes(saved.assistant?.model) ? saved.assistant.model : DEFAULTS.assistant.model
      return { ...DEFAULTS, ...saved, assistant: { model }, mail: { ...DEFAULTS.mail, ...saved.mail } }
    }
  } catch (e) {
    console.error('settings unreadable, using defaults', e)
  }
  return { ...DEFAULTS, assistant: { ...DEFAULTS.assistant }, mail: { ...DEFAULTS.mail } }
}

export function saveSettings(s: Settings): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(s, null, 2))
}

export function listCats(): CatInfo[] {
  return readdirSync(CATS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(CATS_ROOT, d.name, 'cat.json')))
    .map((d) => {
      const m = readManifest(d.name)
      return { id: m.id, name: m.name, kind: m.kind ?? 'pet' }
    })
}

export function readManifest(id: string): CatManifest {
  return JSON.parse(readFileSync(join(CATS_ROOT, id, 'cat.json'), 'utf8'))
}
