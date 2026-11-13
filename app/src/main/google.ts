// Google Calendar (read-only) for a desktop app: OAuth "installed app" flow with a loopback
// redirect + PKCE. The browser does the sign-in; we only ever see the code, then tokens.
// The refresh token is stored encrypted (secrets.ts); access tokens stay in memory.
import { shell } from 'electron'
import { createServer } from 'http'
import { createHash, randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import type { CalEvent } from '../shared/types'
import { getSecrets, setSecrets } from './secrets'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.readonly', GMAIL_SCOPE]

let access: { token: string; expires: number } | null = null

const b64url = (b: Buffer): string => b.toString('base64url')

export function googleClient(): { clientId: string; clientSecret: string } | null {
  const g = getSecrets().google
  return g?.clientId ? { clientId: g.clientId, clientSecret: g.clientSecret } : null
}

export function googleConnected(): boolean {
  return !!getSecrets().google?.refreshToken
}

/** Connected with Gmail read access (older connections were calendar-only and must reconnect). */
export function gmailAllowed(): boolean {
  const g = getSecrets().google
  return !!g?.refreshToken && !!g.scopes?.split(' ').includes(GMAIL_SCOPE)
}

export function setGoogleClient(clientId: string, clientSecret: string): void {
  const prev = getSecrets().google
  const same = prev?.clientId === clientId
  setSecrets({ google: { clientId, clientSecret, ...(same ? { refreshToken: prev?.refreshToken, email: prev?.email } : {}) } })
  if (!same) access = null
}

/** Parse the JSON file Google Cloud Console lets you download for a Desktop OAuth client. */
export function parseClientJson(text: string): { clientId: string; clientSecret: string } {
  const j = JSON.parse(text)
  const c = j.installed ?? j.web ?? j
  if (!c.client_id || !c.client_secret) throw new Error('No client_id/client_secret in that file')
  return { clientId: c.client_id, clientSecret: c.client_secret }
}

export function googleDisconnect(): void {
  const g = getSecrets().google
  const token = g?.refreshToken
  if (g) setSecrets({ google: { clientId: g.clientId, clientSecret: g.clientSecret } })
  access = null
  if (token) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => undefined)
  }
}

/** Opens the browser for consent and resolves once tokens are stored (5 min timeout). */
export async function googleConnect(): Promise<string | undefined> {
  const client = googleClient()
  if (!client) throw new Error('Add your Google OAuth client first')
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))

  const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (u.pathname !== '/') return res.writeHead(404).end()
      const err = u.searchParams.get('error')
      const c = u.searchParams.get('code')
      const ok = !err && c && u.searchParams.get('state') === state
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page(ok ? 'Deskat is connected to your calendar. You can close this tab.' : `Sign-in failed: ${err ?? 'bad response'}`))
      server.close()
      clearTimeout(timer)
      if (ok) resolve({ code: c!, redirect })
      else reject(new Error(err ?? 'Sign-in failed'))
    })
    let redirect = ''
    const timer = setTimeout(() => {
      server.close()
      reject(new Error('Timed out waiting for Google sign-in'))
    }, 5 * 60_000)
    server.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const q = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirect,
        response_type: 'code',
        scope: SCOPES.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
        state
      })
      void shell.openExternal(`${AUTH_URL}?${q}`)
    })
  })

  const tok = await tokenRequest({
    grant_type: 'authorization_code',
    code: code.code,
    redirect_uri: code.redirect,
    code_verifier: verifier,
    client_id: client.clientId,
    client_secret: client.clientSecret
  })
  if (!tok.refresh_token) throw new Error('Google returned no refresh token')
  const email = tok.id_token ? emailFromIdToken(tok.id_token) : undefined
  setSecrets({ google: { ...client, refreshToken: tok.refresh_token, email, scopes: tok.scope } })
  access = { token: tok.access_token, expires: Date.now() + (tok.expires_in - 60) * 1000 }
  return email
}

async function accessToken(): Promise<string> {
  if (access && access.expires > Date.now()) return access.token
  const g = getSecrets().google
  if (!g?.refreshToken) throw new Error('Calendar not connected')
  const tok = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: g.refreshToken,
    client_id: g.clientId,
    client_secret: g.clientSecret
  })
  access = { token: tok.access_token, expires: Date.now() + (tok.expires_in - 60) * 1000 }
  return access.token
}

interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  id_token?: string
  scope?: string
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  })
  const j = await res.json()
  if (!res.ok) {
    // invalid_grant = the refresh token was revoked or expired (7 days while the app is in "Testing")
    if (j.error === 'invalid_grant') googleDisconnect()
    throw new Error(j.error_description ?? j.error ?? `Google token error ${res.status}`)
  }
  return j
}

function emailFromIdToken(idToken: string): string | undefined {
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString()).email
  } catch {
    return undefined
  }
}

/** Events on the primary calendar between now-ish and `hours` from now, soonest first. */
export async function upcomingEvents(hours = 36): Promise<CalEvent[]> {
  const now = Date.now()
  const q = new URLSearchParams({
    timeMin: new Date(now - 60 * 60_000).toISOString(),
    timeMax: new Date(now + hours * 3600_000).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '30'
  })
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, {
    headers: { Authorization: `Bearer ${await accessToken()}` }
  })
  if (res.status === 401) access = null
  if (!res.ok) throw new Error(`Calendar error ${res.status}`)
  const j = await res.json()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (j.items ?? []).filter((e: any) => e.status !== 'cancelled' && !declined(e)).map((e: any): CalEvent => {
    const allDay = !e.start?.dateTime
    const start = Date.parse(e.start?.dateTime ?? `${e.start?.date}T00:00:00`)
    const end = Date.parse(e.end?.dateTime ?? `${e.end?.date}T00:00:00`)
    const video = e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p: { entryPointType: string }) => p.entryPointType === 'video')?.uri
    return {
      id: e.id,
      title: e.summary ?? '(no title)',
      start,
      end,
      allDay,
      location: e.location,
      joinUrl: video ?? zoomLink(e.location) ?? zoomLink(e.description),
      htmlLink: e.htmlLink
    }
  }).filter((e: CalEvent) => e.end > now)
}

// ------------------------------------------------------------------ gmail (read-only)

export interface MailItem {
  id: string
  threadId: string
  from: string
  fromEmail: string
  subject: string
  snippet: string
  date: number
}

async function gmail(path: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${await accessToken()}` }
  })
  if (res.status === 401) access = null
  if (!res.ok) throw new Error(`Gmail error ${res.status}`)
  return res.json()
}

/** Message ids matching a Gmail search (newest first). */
export async function gmailSearch(q: string, max = 15): Promise<string[]> {
  const j = await gmail(`messages?${new URLSearchParams({ q, maxResults: String(max) })}`)
  return (j.messages ?? []).map((m: { id: string }) => m.id)
}

export async function gmailItem(id: string): Promise<MailItem> {
  const q = new URLSearchParams({ format: 'metadata' })
  q.append('metadataHeaders', 'From')
  q.append('metadataHeaders', 'Subject')
  const j = await gmail(`messages/${id}?${q}`)
  const h = (n: string): string => j.payload?.headers?.find((x: { name: string }) => x.name.toLowerCase() === n.toLowerCase())?.value ?? ''
  const from = h('From')
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/)
  return {
    id,
    threadId: j.threadId,
    from: (m?.[1] || m?.[2] || from).trim(),
    fromEmail: (m?.[2] ?? from).trim().toLowerCase(),
    subject: h('Subject') || '(no subject)',
    snippet: decodeEntities(j.snippet ?? ''),
    date: Number(j.internalDate) || Date.now()
  }
}

/** Plain text of a message (for "Summarize"). */
export async function gmailText(id: string): Promise<string> {
  const j = await gmail(`messages/${id}?format=full`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts: any[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (p: any): void => {
    if (!p) return
    parts.push(p)
    for (const c of p.parts ?? []) walk(c)
  }
  walk(j.payload)
  const dec = (d?: string): string => (d ? Buffer.from(d, 'base64url').toString('utf8') : '')
  const plain = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data)
  const html = parts.find((p) => p.mimeType === 'text/html' && p.body?.data)
  const text = plain
    ? dec(plain.body.data)
    : decodeEntities(dec(html?.body?.data).replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, ''))
  const h = (n: string): string => j.payload?.headers?.find((x: { name: string }) => x.name.toLowerCase() === n)?.value ?? ''
  return `From: ${h('from')}\nSubject: ${h('subject')}\n\n${text.replace(/\n{3,}/g, '\n\n').trim()}`.slice(0, 15_000)
}

function decodeEntities(s: string): string {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function declined(e: any): boolean {
  return !!e.attendees?.some((a: { self?: boolean; responseStatus?: string }) => a.self && a.responseStatus === 'declined')
}

function zoomLink(text?: string): string | undefined {
  return text?.match(/https:\/\/[\w.-]*(zoom\.us|teams\.microsoft\.com|meet\.google\.com)\/[^\s"<>]+/)?.[0]
}

function page(msg: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Deskat</title><body style="font:16px -apple-system,sans-serif;display:grid;place-items:center;height:90vh;color:#2b2724;background:#f7f4ef"><p>🐾 ${msg}</p></body>`
}
