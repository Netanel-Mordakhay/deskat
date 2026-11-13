// Focus mode: the character stays quiet (no random moments or strolls, mail and the morning
// brief wait) while a calendar meeting is in progress or a Zoom/Teams/Webex call is running.
// Hiding from screen sharing is separate: windows use setContentProtection.
import { execFile } from 'child_process'
import type { CalEvent } from '../shared/types'

/** Processes that only exist during a call. */
const CALL_PROCESSES = ['CptHost', 'aomhost', 'MSTeams Helper (Call)', 'webexmta']

let quiet = false
let reason = ''

export const isQuiet = (): boolean => quiet
export const quietReason = (): string => reason

function callRunning(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-Ao', 'comm'], (err, out) => {
      if (err) return resolve(null)
      const names = out.split('\n').map((l) => l.trim().split('/').pop() ?? '')
      resolve(CALL_PROCESSES.find((p) => names.includes(p)) ?? null)
    })
  })
}

export function startFocus(
  enabled: () => boolean,
  events: () => Promise<CalEvent[] | null>,
  onChange: (quiet: boolean, reason: string) => void
): void {
  const check = async (): Promise<void> => {
    let r = ''
    if (enabled()) {
      const now = Date.now()
      const ev = (await events().catch(() => null))?.find((e) => !e.allDay && e.start <= now && now < e.end)
      if (ev) r = `In “${ev.title}”`
      else if (await callRunning()) r = 'On a call'
    }
    const q = !!r
    if (q !== quiet || r !== reason) {
      quiet = q
      reason = r
      onChange(q, r)
    }
  }
  void check()
  setInterval(() => void check(), 30_000)
}
