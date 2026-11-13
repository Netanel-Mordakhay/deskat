// The speech bubble: a small transparent window that floats above the character and follows
// it. It shows notices (calendar reminders, agenda) and the "Ask …" chat.
import { BrowserWindow, clipboard, ipcMain, shell, screen } from 'electron'
import type { AssistantSettings, BubbleState, ChatMsg, ClipAction, Notice, NoticeAction } from '../shared/types'
import { runCommands, visibleText } from './memory'
import { ask, systemPrompt, type Turn } from './assistant'
import { getEvents } from './calendar'

const WIDTH = 340
const MAX_TURNS = 20

const CLIP_PROMPTS: Record<ClipAction, string> = {
  summarize: 'Summarize my clipboard text.',
  translate: 'Translate my clipboard text (to English, or to Hebrew if it is already English).',
  grammar: 'Fix the grammar and spelling of my clipboard text. Reply with just the corrected text.',
  polite: 'Rewrite my clipboard text to sound polite and friendly. Reply with just the rewritten text.'
}
const SNOOZE_MIN = 2

interface Host {
  overlay(): BrowserWindow | null
  /** Fraction of the overlay's height where the character's head is. */
  headLine(): number
  name(): string
  persona(): string | undefined
  assistant(): AssistantSettings
  loadPage(win: BrowserWindow): void
  /** Show a notice again with the full treatment (character reaction + line), used by snooze. */
  onNotice(n: Notice): void
  /** Any other button (e.g. "Summarize"); dismiss/url are already handled. */
  onAction(n: Notice, a: NoticeAction): void
  hideFromCapture(): boolean
  preload: string
}

let host: Host
let win: BrowserWindow | null = null
let loaded = false
let height = 0
const state: BubbleState = { name: '', notices: [], chat: null }
const timers = new Map<string, NodeJS.Timeout>()
let abort: AbortController | null = null

export function bubbleWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null
}

/** Dev demo hook: type a message into the chat. */
export function demoSend(text: string): void {
  openChat()
  setTimeout(() => void send(text), 800)
}

export function initBubble(h: Host): void {
  host = h
  ipcMain.on('bubble:ready', () => {
    loaded = true
    push()
  })
  ipcMain.on('bubble:resize', (_e, hgt: number) => {
    if (process.env['DESKAT_DEBUG_DIR']) console.log(`bubble resize ${hgt} visible=${win?.isVisible()}`)
    height = Math.ceil(hgt)
    if (height <= 0) win?.hide()
    reposition()
  })
  ipcMain.on('bubble:dismiss', (_e, id: string) => dismiss(id))
  ipcMain.on('bubble:notice-action', (_e, noticeId: string, a: NoticeAction) => {
    if (a.url && /^https?:\/\//.test(a.url)) void shell.openExternal(a.url)
    const n = state.notices.find((x) => x.id === noticeId)
    dismiss(noticeId)
    if (a.id === 'snooze' && n) setTimeout(() => host.onNotice({ ...n, quip: undefined }), (a.snoozeMin ?? SNOOZE_MIN) * 60_000)
    else if (n) host.onAction(n, a)
  })
  ipcMain.on('bubble:send', (_e, text: string) => void send(text))
  ipcMain.on('bubble:copy', (_e, text: string) => clipboard.writeText(text))
  ipcMain.on('bubble:clip-action', (_e, kind: ClipAction) => {
    const clip = clipboard.readText().trim()
    if (!clip) {
      state.chat?.messages.push({ role: 'assistant', text: 'Your clipboard is empty. Copy some text first.', error: true })
      return push()
    }
    void send(CLIP_PROMPTS[kind], { context: clip.slice(0, 20_000), tag: 'clipboard' })
  })
  ipcMain.on('bubble:clip', () => {
    if (!state.chat) return
    const t = clipboard.readText().trim()
    state.chat.clip = t ? t.slice(0, 20_000) : undefined
    push()
  })
  ipcMain.on('bubble:clear-clip', () => {
    if (state.chat) state.chat.clip = undefined
    push()
  })
  ipcMain.on('bubble:close-chat', () => closeChat())
  ipcMain.on('bubble:new-chat', () => {
    abort?.abort()
    if (state.chat) state.chat = { open: true, messages: [], busy: false }
    push()
  })
}

function ensureWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  loaded = false
  height = 0
  win = new BrowserWindow({
    width: WIDTH,
    height: 10,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    roundedCorners: false,
    alwaysOnTop: true,
    // keep rendering while hidden, or it never re-measures and can't show itself again
    webPreferences: { preload: host.preload, sandbox: false, backgroundThrottling: false }
  })
  win.setContentProtection(host.hideFromCapture())
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.on('closed', () => {
    win = null
    loaded = false
  })
  // Esc / clicking elsewhere doesn't close the chat; the × does.
  if (process.env['DESKAT_DEBUG_DIR']) win.webContents.on('console-message', (_e, _l, m) => console.log(`[bubble] ${m}`))
  host.loadPage(win)
  return win
}

/** Keep the bubble centred above the character's head (and on screen). */
export function reposition(): void {
  const o = host?.overlay()
  if (!win || win.isDestroyed() || !o || !height) return
  const ob = o.getBounds()
  const wa = screen.getDisplayMatching(ob).workArea
  const headY = ob.y + ob.height * host.headLine()
  let x = Math.round(ob.x + ob.width / 2 - WIDTH / 2)
  x = Math.min(Math.max(x, wa.x + 6), wa.x + wa.width - WIDTH - 6)
  let y = Math.round(headY - height + 6)
  y = Math.max(y, wa.y + 6)
  win.setBounds({ x, y, width: WIDTH, height })
  if (!win.isVisible()) {
    if (state.chat?.open) {
      win.show()
      win.focus()
    } else win.showInactive()
  }
}

function push(): void {
  state.name = host.name()
  const empty = !state.notices.length && !state.chat?.open
  if (empty) {
    win?.hide()
    if (win && !win.isDestroyed()) win.webContents.send('bubble:state', state)
    return
  }
  const w = ensureWindow()
  if (loaded) w.webContents.send('bubble:state', state)
}

/** Update a notice in place (e.g. the character's line streaming in). */
export function patchNotice(id: string, patch: Partial<Notice>): void {
  const n = state.notices.find((x) => x.id === id)
  if (!n) return
  Object.assign(n, patch)
  push()
}

export function showNotice(n: Notice): void {
  state.notices = [...state.notices.filter((x) => x.id !== n.id), n].slice(-3)
  clearTimeout(timers.get(n.id))
  if (n.ttlSec) timers.set(n.id, setTimeout(() => dismiss(n.id), n.ttlSec * 1000))
  push()
}

function dismiss(id: string): void {
  clearTimeout(timers.get(id))
  timers.delete(id)
  state.notices = state.notices.filter((n) => n.id !== id)
  push()
}

export function setBubbleCaptureProtection(on: boolean): void {
  if (win && !win.isDestroyed()) win.setContentProtection(on)
}

/** Global shortcut: open (and focus) the chat, or close it if it's already in front. */
export function toggleChat(): void {
  if (state.chat?.open && win?.isVisible() && win.isFocused()) return closeChat()
  openChat()
  if (win && !win.isDestroyed() && win.isVisible()) {
    win.show()
    win.focus()
  }
}

export function openChat(): void {
  if (!state.chat) state.chat = { open: true, messages: [], busy: false }
  state.chat.open = true
  push()
  if (win?.isVisible()) {
    win.show()
    win.focus()
  }
}

function closeChat(): void {
  abort?.abort()
  state.chat = null
  push()
}

/** Character changed: the old conversation was with someone else. */
export function resetBubble(): void {
  abort?.abort()
  state.chat = null
  push()
}

/** Open the chat and ask about some text (e.g. an email to summarize). */
export function askAbout(text: string, context: string, tag: string): void {
  openChat()
  void send(text, { context, tag })
}

async function send(text: string, extra?: { context: string; tag: string }): Promise<void> {
  const chat = state.chat
  if (!chat || chat.busy || !text.trim()) return
  const ctx = extra ?? (chat.clip ? { context: chat.clip, tag: 'clipboard' } : undefined)
  chat.clip = undefined
  const icon = ctx?.tag === 'email' ? '✉️' : '📋'
  chat.messages.push({ role: 'user', text: ctx ? `${text}\n${icon} (with ${ctx.tag} text)` : text })
  const reply: ChatMsg = { role: 'assistant', text: '', streaming: true }
  chat.messages.push(reply)
  chat.busy = true
  push()

  // turns for the model: earlier good exchanges + this message (with the clipboard inline)
  const turns: Turn[] = []
  const msgs = chat.messages.slice(0, -2)
  for (let i = 0; i + 1 < msgs.length; i += 2) {
    const [u, a] = [msgs[i], msgs[i + 1]]
    if (u.role === 'user' && a.role === 'assistant' && !a.error && a.text) turns.push({ role: 'user', text: u.text }, { role: 'assistant', text: a.text })
  }
  turns.push({ role: 'user', text: ctx ? `${text}\n\n<${ctx.tag}>\n${ctx.context}\n</${ctx.tag}>` : text })

  abort = new AbortController()
  const mine = abort
  let pending = false
  let raw = ''
  try {
    const events = await getEvents().catch(() => null)
    await ask(host.assistant(), systemPrompt({ name: host.name(), persona: host.persona(), events, chat: true }), turns.slice(-MAX_TURNS), (chunk) => {
      raw += chunk
      reply.text = visibleText(raw)
      // coalesce rapid chunks into ~30 updates/s
      if (!pending) {
        pending = true
        setTimeout(() => {
          pending = false
          push()
        }, 33)
      }
    }, mine.signal)
    const receipts = runCommands(raw)
    if (receipts.length) reply.meta = receipts
    reply.text = visibleText(raw)
  } catch (e) {
    if (mine.signal.aborted) return
    reply.text = (e as Error).message
    reply.error = true
  } finally {
    if (state.chat === chat) {
      reply.streaming = false
      chat.busy = false
      push()
    }
  }
}
