// Checks Gmail every 2 minutes for new unread mail worth a bubble (important / chosen senders / all).
// On the first check after start, existing unread mail is only remembered, not announced.
import type { MailSettings, Notice } from '../shared/types'
import { gmailAllowed, gmailItem, gmailSearch, type MailItem } from './google'

const EVERY_MS = 2 * 60_000
const seen = new Set<string>()
let primed = false
let lastError: string | undefined

export const mailError = (): string | undefined => lastError

export function mailQuery(s: MailSettings): string | null {
  const base = 'in:inbox is:unread newer_than:2d'
  if (s.mode === 'important') return `${base} is:important`
  if (s.mode === 'all') return base
  if (s.mode === 'senders') {
    const who = s.senders.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)
    return who.length ? `${base} {${who.map((w) => `from:${w}`).join(' ')}}` : null
  }
  return null
}

export function startMail(cfg: () => MailSettings, onMail: (items: MailItem[]) => void): void {
  let lastQuery = ''
  const check = async (): Promise<void> => {
    const q = gmailAllowed() ? mailQuery(cfg()) : null
    if (!q) return
    if (q !== lastQuery) {
      // settings changed: don't announce the backlog the new filter now matches
      lastQuery = q
      primed = false
    }
    try {
      const ids = await gmailSearch(q)
      const fresh = ids.filter((id) => !seen.has(id))
      fresh.forEach((id) => seen.add(id))
      lastError = undefined
      if (!primed) {
        primed = true
        return
      }
      if (fresh.length) onMail(await Promise.all(fresh.slice(0, 5).map(gmailItem)))
    } catch (e) {
      lastError = (e as Error).message
      console.error('mail check failed:', lastError)
    }
  }
  setTimeout(() => void check(), 8_000)
  setInterval(() => void check(), EVERY_MS)
}

export function mailNotice(items: MailItem[]): Notice {
  const openUrl = (m: MailItem): string => `https://mail.google.com/mail/u/0/#inbox/${m.threadId}`
  if (items.length === 1) {
    const m = items[0]
    return {
      id: `mail:${m.id}`,
      title: `✉️ ${m.from}`,
      body: `${m.subject}\n${m.snippet.slice(0, 140)}${m.snippet.length > 140 ? '…' : ''}`,
      actions: [
        { id: 'open', label: 'Open', url: openUrl(m) },
        { id: `summarize:${m.id}`, label: 'Summarize' },
        { id: 'dismiss', label: 'Later' }
      ]
    }
  }
  return {
    id: `mail:${items.map((m) => m.id).join(',')}`,
    title: `✉️ ${items.length} new emails`,
    body: items.map((m) => `${m.from} — ${m.subject}`).join('\n'),
    actions: [
      { id: 'open', label: 'Open inbox', url: 'https://mail.google.com/mail/u/0/#inbox' },
      { id: 'dismiss', label: 'Later' }
    ]
  }
}
