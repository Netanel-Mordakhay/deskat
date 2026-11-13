// Keeps a fresh copy of upcoming events and fires a reminder `leadMin` before each one.
import type { CalEvent, Notice } from '../shared/types'
import { googleConnected, upcomingEvents } from './google'

const REFRESH_MS = 5 * 60_000
const CHECK_MS = 20_000

let events: CalEvent[] = []
let fetchedAt = 0
let lastError: string | undefined
const reminded = new Set<string>()

export function calendarError(): string | undefined {
  return lastError
}

/** Cached events, refreshed if older than a minute (null when not connected). */
export async function getEvents(maxAgeMs = 60_000): Promise<CalEvent[] | null> {
  if (!googleConnected()) return null
  if (Date.now() - fetchedAt > maxAgeMs) await refresh()
  return events
}

async function refresh(): Promise<void> {
  if (!googleConnected()) {
    events = []
    return
  }
  try {
    events = await upcomingEvents()
    fetchedAt = Date.now()
    lastError = undefined
  } catch (e) {
    lastError = (e as Error).message
    console.error('calendar refresh failed:', lastError)
  }
}

export function startCalendar(leadMin: () => number, onReminder: (n: Notice) => void): void {
  void refresh()
  setInterval(() => void refresh(), REFRESH_MS)
  setInterval(() => {
    const lead = leadMin()
    if (!lead || !googleConnected()) return
    const now = Date.now()
    for (const e of events) {
      if (e.allDay) continue
      const key = `${e.id}@${e.start}`
      if (reminded.has(key)) continue
      // due from `lead` minutes before the start until 1 minute after it
      if (now >= e.start - lead * 60_000 && now < e.start + 60_000) {
        reminded.add(key)
        onReminder(reminderNotice(e))
      }
    }
  }, CHECK_MS)
}

export function reminderNotice(e: CalEvent): Notice {
  return {
    id: `cal:${e.id}@${e.start}`,
    title: e.title,
    meeting: { start: e.start, end: e.end, location: e.location, joinUrl: e.joinUrl },
    actions: [
      ...(e.joinUrl ? [{ id: 'join', label: joinLabel(e.joinUrl), url: e.joinUrl }] : e.htmlLink ? [{ id: 'open', label: 'Open', url: e.htmlLink }] : []),
      { id: 'snooze', label: 'Snooze 2 min' },
      { id: 'dismiss', label: 'Got it' }
    ]
  }
}

/** "What's next?" bubble: the rest of today, or tomorrow's first events. */
export function agendaNotice(list: CalEvent[]): Notice {
  const now = new Date()
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
  const today = list.filter((e) => e.start < endOfToday)
  const shown = (today.length ? today : list).slice(0, 4)
  const label = today.length ? 'Rest of today' : list.length ? 'Tomorrow' : 'Nothing coming up'
  return {
    id: 'agenda',
    title: label,
    body: shown.length
      ? shown.map((e) => `${e.allDay ? 'All day' : e.start <= Date.now() ? 'Now' : time(e.start)}  ${e.title}`).join('\n')
      : 'Your calendar is clear for the next day and a half. 🎉',
    actions: [
      ...(shown[0]?.joinUrl && shown[0].start - Date.now() < 15 * 60_000 ? [{ id: 'join', label: 'Join next', url: shown[0].joinUrl }] : []),
      { id: 'dismiss', label: 'OK' }
    ],
    ttlSec: 25
  }
}

function joinLabel(url: string): string {
  if (/meet\.google/.test(url)) return 'Join Meet'
  if (/zoom\.us/.test(url)) return 'Join Zoom'
  if (/teams\.microsoft/.test(url)) return 'Join Teams'
  return 'Join'
}

const time = (t: number): string => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
