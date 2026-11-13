// The assistant's small memory on disk: notes, to-dos and reminders the user asked for in chat.
// The chat itself stays stateless; Claude sees this list in its system prompt and changes it
// by ending a reply with commands like [[todo|buy milk]], which we execute and strip.
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface Note { id: string; text: string; created: number }
export interface Todo { id: string; text: string; created: number; done?: number }
export interface Reminder { id: string; text: string; at: number; fired?: boolean }

interface Data {
  notes: Note[]
  todos: Todo[]
  reminders: Reminder[]
  seq: number
  /** Local date (YYYY-MM-DD) of the last morning brief. */
  lastBrief?: string
}

const file = (): string => join(app.getPath('userData'), 'assistant-data.json')
let data: Data | null = null

function load(): Data {
  if (data) return data
  data = { notes: [], todos: [], reminders: [], seq: 0 }
  try {
    if (existsSync(file())) data = { ...data, ...JSON.parse(readFileSync(file(), 'utf8')) }
  } catch (e) {
    console.error('assistant data unreadable, starting empty', e)
  }
  return data!
}

function save(): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(load(), null, 2))
}

const nextId = (prefix: string): string => `${prefix}${++load().seq}`

export const store = {
  get: (): Readonly<Data> => load(),
  openTodos: (): Todo[] => load().todos.filter((t) => !t.done),
  upcoming: (): Reminder[] => load().reminders.filter((r) => !r.fired).sort((a, b) => a.at - b.at),
  setLastBrief(day: string): void {
    load().lastBrief = day
    save()
  },
  markFired(id: string): void {
    const r = load().reminders.find((x) => x.id === id)
    if (r) r.fired = true
    save()
  },
  completeTodo(id: string): boolean {
    const t = load().todos.find((x) => x.id === id)
    if (!t || t.done) return false
    t.done = Date.now()
    save()
    return true
  }
}

/** What Claude knows about the user's saved stuff (goes in the system prompt). */
export function memoryPrompt(): string {
  const d = load()
  const fmt = (t: number): string =>
    new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const todos = store.openTodos()
  const rems = store.upcoming()
  const notes = d.notes.slice(-25)
  return [
    todos.length ? `Open to-dos:\n${todos.map((t) => `- [${t.id}] ${t.text}`).join('\n')}` : 'Open to-dos: none.',
    rems.length ? `Upcoming reminders:\n${rems.map((r) => `- [${r.id}] ${fmt(r.at)}: ${r.text}`).join('\n')}` : 'Upcoming reminders: none.',
    notes.length ? `Saved notes:\n${notes.map((n) => `- [${n.id}] ${n.text}`).join('\n')}` : 'Saved notes: none.'
  ].join('\n')
}

export const COMMANDS_PROMPT = `
# Saving things for the user
You can keep to-dos, notes and reminders for the user. Only when the user clearly asks you to remind them,
note/remember something, add a to-do, mark one done, or delete something, add the matching command on its own
line at the very END of your reply (the user never sees commands; still confirm in your own words, briefly):
[[remind|YYYY-MM-DDTHH:MM|what to remind]]   (local time; work out relative times like "in 20 min" from the current time)
[[note|text]]
[[todo|text]]
[[done|<to-do id>]]
[[delete|<note, to-do or reminder id>]]
Use ids exactly as listed (like t4). Never output a command the user didn't ask for. If a time is ambiguous, ask instead.`

const CMD = /\[\[(remind|note|todo|done|delete)\|([^\]]*)\]\]/g

/** Reply text without commands, also hiding a half-streamed "[[..." at the end. */
export function visibleText(raw: string): string {
  return raw.replace(CMD, '').replace(/\[\[[^\]]*$/, '').replace(/\[$/, '').trimEnd()
}

/** Execute the commands in a finished reply; returns short receipts for the chat ("⏰ 16:20 — call mom"). */
export function runCommands(raw: string): string[] {
  const d = load()
  const out: string[] = []
  for (const [, cmd, arg] of raw.matchAll(CMD)) {
    const a = arg.trim()
    if (cmd === 'note' && a) {
      d.notes.push({ id: nextId('n'), text: a, created: Date.now() })
      out.push(`📝 Noted`)
    } else if (cmd === 'todo' && a) {
      d.todos.push({ id: nextId('t'), text: a, created: Date.now() })
      out.push(`✅ To-do added: ${a}`)
    } else if (cmd === 'remind') {
      const [when, ...rest] = a.split('|')
      const at = parseLocal(when)
      const text = rest.join('|').trim()
      if (at && text) {
        d.reminders.push({ id: nextId('r'), text, at })
        out.push(`⏰ ${new Date(at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} — ${text}`)
      }
    } else if (cmd === 'done') {
      const t = d.todos.find((x) => x.id === a)
      if (t && !t.done) {
        t.done = Date.now()
        out.push(`☑️ Done: ${t.text}`)
      }
    } else if (cmd === 'delete') {
      for (const list of [d.notes, d.todos, d.reminders] as { id: string; text: string }[][]) {
        const i = list.findIndex((x) => x.id === a)
        if (i >= 0) out.push(`🗑 Deleted: ${list.splice(i, 1)[0].text}`)
      }
    }
  }
  if (out.length) save()
  return out
}

/** "2026-11-12T16:20" as local time. */
function parseLocal(s: string): number | null {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
  if (!m) return null
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime()
  return Number.isFinite(t) ? t : null
}

/** Fires due reminders (checked every 15s; reminders up to 6h overdue still fire, e.g. after sleep). */
export function startReminders(onDue: (r: Reminder) => void): void {
  setInterval(() => {
    const now = Date.now()
    for (const r of store.upcoming()) {
      if (r.at > now) break
      store.markFired(r.id)
      if (now - r.at < 6 * 3600_000) onDue(r)
    }
  }, 15_000)
}

export const localDay = (t = Date.now()): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
