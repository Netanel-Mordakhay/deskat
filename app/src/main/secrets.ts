// Secrets (API key, Google OAuth tokens) live apart from settings.json, encrypted with the
// macOS Keychain via Electron's safeStorage. They never reach a renderer.
import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'

export interface Secrets {
  /** The user's own Anthropic API key (console.anthropic.com). */
  anthropicKey?: string
  google?: {
    clientId: string
    clientSecret: string
    refreshToken?: string
    email?: string
    /** Scopes the user granted (space-separated). */
    scopes?: string
  }
}

const file = (): string => join(app.getPath('userData'), 'secrets.bin')
let cache: Secrets | null = null

export function getSecrets(): Secrets {
  if (cache) return cache
  cache = {}
  try {
    if (existsSync(file())) {
      const buf = readFileSync(file())
      cache = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString())
    }
  } catch (e) {
    console.error('secrets unreadable, starting empty', e)
  }
  return cache!
}

export function setSecrets(patch: Partial<Secrets>): Secrets {
  cache = { ...getSecrets(), ...patch }
  for (const k of Object.keys(cache) as (keyof Secrets)[]) if (cache[k] === undefined) delete cache[k]
  mkdirSync(app.getPath('userData'), { recursive: true })
  if (!Object.keys(cache).length) {
    rmSync(file(), { force: true })
    return cache
  }
  const json = JSON.stringify(cache)
  writeFileSync(file(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : json, { mode: 0o600 })
  return cache
}
