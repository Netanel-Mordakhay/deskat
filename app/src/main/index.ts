import {
  app, BrowserWindow, Menu, Tray, dialog, globalShortcut, ipcMain, powerMonitor, shell, nativeImage, net, protocol, screen, type Display
} from 'electron'
import { readFileSync } from 'fs'
import { join, normalize, sep } from 'path'
import { pathToFileURL } from 'url'
import type { CalEvent, CatManifest, ConnectionStatus, DisplayInfo, MenuItem, Notice, OverlayInit, Room, Settings } from '../shared/types'
import { CATS_ROOT, listCats, loadSettings, readManifest, saveSettings } from './store'
import {
  askAbout, bubbleWindow, demoSend, initBubble, openChat, patchNotice, reposition, resetBubble, setBubbleCaptureProtection,
  showNotice, toggleChat
} from './bubble'
import { isQuiet, quietReason, startFocus } from './focus'
import { mailError, mailNotice, startMail } from './mail'
import { localDay, startReminders, store, type Reminder } from './memory'
import { agendaNotice, calendarError, getEvents, reminderNotice, startCalendar } from './calendar'
import * as google from './google'
import { LINE_MODEL, ask, hasApiKey, systemPrompt } from './assistant'
import { gmailText } from './google'
import { getSecrets, setSecrets } from './secrets'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'deskat',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true }
  }
])

let settings: Settings
let manifest: CatManifest
let overlay: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let tray: Tray | null = null
/** Sub-pixel x position while walking (setPosition only takes integers). */
let exactX = 0

const preload = join(__dirname, '../preload/index.js')

function rendererUrl(win: BrowserWindow, page: 'overlay' | 'settings' | 'bubble'): void {
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${page}.html`)
  else win.loadFile(join(__dirname, `../renderer/${page}.html`))
}

// ------------------------------------------------------------------ geometry

function targetDisplay(): Display {
  const all = screen.getAllDisplays()
  return all.find((d) => d.id === settings.displayId) ?? screen.getPrimaryDisplay()
}

function overlaySize(): { w: number; h: number } {
  const h = Math.round(settings.size)
  return { w: Math.round((h * manifest.canvas[0]) / manifest.canvas[1]), h }
}

/** Window bounds that put the cat's paws on the bottom edge of the display's work area. */
function overlayBounds(): Electron.Rectangle {
  const wa = targetDisplay().workArea
  const { w, h } = overlaySize()
  const saved = settings.positions[String(targetDisplay().id)]
  const x = clampX(saved ?? wa.x + wa.width - w - Math.round(w * 0.1), w, wa)
  const y = Math.round(wa.y + wa.height - h * manifest.pawLine)
  return { x, y, width: w, height: h }
}

/** The cat may hang partly off-canvas (transparent margins), but its middle stays on screen. */
function clampX(x: number, w: number, wa: Electron.Rectangle): number {
  const margin = w * 0.25
  return Math.round(Math.min(Math.max(x, wa.x - margin), wa.x + wa.width - w + margin))
}

function room(): Room {
  if (!overlay) return { left: 0, right: 0 }
  const wa = targetDisplay().workArea
  const b = overlay.getBounds()
  const margin = b.width * 0.25
  return {
    left: Math.max(0, b.x - (wa.x - margin)),
    right: Math.max(0, wa.x + wa.width - b.width + margin - b.x)
  }
}

// ------------------------------------------------------------------ windows

function createOverlay(): void {
  manifest = readManifest(settings.cat)
  const b = overlayBounds()
  exactX = b.x
  overlay = new BrowserWindow({
    ...b,
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
    webPreferences: { preload, sandbox: false, backgroundThrottling: false }
  })
  applyLayer()
  overlay.setIgnoreMouseEvents(true, { forward: true })
  overlay.once('ready-to-show', () => overlay?.showInactive())
  overlay.on('closed', () => (overlay = null))
  overlay.on('move', reposition)
  overlay.setContentProtection(settings.hideFromCapture)
  rendererUrl(overlay, 'overlay')
  debugHooks(overlay)
}

/**
 * Dev-only verification hooks (inactive unless the env vars are set):
 *  DESKAT_DEBUG_DIR=<dir>   save a PNG of the cat window every 1.5s and log the renderer console
 *  DESKAT_DEMO="pet:8,lieOnBack:20"  trigger actions at N seconds after start
 */
function debugHooks(win: BrowserWindow): void {
  const dir = process.env['DESKAT_DEBUG_DIR']
  const demo = process.env['DESKAT_DEMO']
  if (!dir && !demo) return
  win.webContents.on('console-message', (_e, _lvl, msg) => console.log(`[overlay] ${msg}`))
  if (dir) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdirSync, writeFileSync } = require('fs') as typeof import('fs')
    mkdirSync(dir, { recursive: true })
    let n = 0
    const t = setInterval(async () => {
      if (win.isDestroyed()) return clearInterval(t)
      const img = await win.webContents.capturePage().catch(() => null)
      if (!img || win.isDestroyed()) return
      const b = win.getBounds()
      const i = String(n++).padStart(4, '0')
      writeFileSync(join(dir, `snap-${i}_x${b.x}.png`), img.toPNG())
      const bw = bubbleWindow()
      if (bw?.isVisible()) {
        const bi = await bw.webContents.capturePage().catch(() => null)
        const bb = bw.getBounds()
        if (bi) writeFileSync(join(dir, `bubble-${i}_${bb.x},${bb.y},${bb.width}x${bb.height}_cat${b.x},${b.y},${b.width}x${b.height}.png`), bi.toPNG())
      }
    }, 1500)
  }
  for (const item of (demo ?? '').split(',').filter(Boolean)) {
    const [id, sec] = item.split(':')
    setTimeout(() => {
      console.log(`[demo] trigger ${id}`)
      // app-level demo items: app.notice, app.ask, app.agenda, app.say=<text>
      if (id === 'app.notice') return notify(reminderNotice(demoEvent()))
      if (id === 'app.ask') return openChat()
      if (id === 'app.close') return resetBubble()
      if (id === 'app.toggle') return toggleChat()
      if (id === 'app.brief') return void morningBrief(true)
      if (id === 'app.list') return showNotice(listNotice())
      if (id === 'app.remind') return reminderDue({ id: 'r0', text: 'Call mom back', at: Date.now() })
      if (id === 'app.mail') return notify(mailNotice([{ id: 'm0', threadId: 't0', from: 'Dana Levi', fromEmail: 'dana@example.com', subject: 'Q4 planning — quick question', snippet: 'Hey! Can you send me the numbers from last week before tomorrow’s sync? Thanks', date: Date.now() }]), { deferrable: true })
      if (id === 'app.agenda') return void showAgenda()
      if (id === 'app.settings') {
        openSettings()
        if (dir) setTimeout(async () => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const img = await settingsWin?.webContents.executeJavaScript('new Promise(r => setTimeout(() => { window.scrollTo(0, 99999); setTimeout(r, 300) }, 1500))').then(() => settingsWin!.webContents.capturePage())
          if (img) require('fs').writeFileSync(join(dir, 'settings.png'), img.toPNG())
        }, 3000)
        return
      }
      if (id.startsWith('app.say=')) return demoSend(id.slice(8).replace(/_/g, ' '))
      if (!win.isDestroyed()) win.webContents.send('overlay:menu-action', id)
    }, Number(sec) * 1000)
  }
}

function applyLayer(): void {
  if (!overlay) return
  if (settings.layer === 'top') {
    overlay.setAlwaysOnTop(true, 'floating')
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } else {
    // "Behind": an ordinary window, so app windows cover it and it shows on the desktop.
    overlay.setAlwaysOnTop(false)
    overlay.setVisibleOnAllWorkspaces(false)
  }
}

function recreateOverlay(): void {
  overlay?.destroy()
  overlay = null
  createOverlay()
  reposition()
}

/** Notices held back while focus mode is on (mail, morning brief). */
let deferred: { n: Notice; line?: string }[] = []

/**
 * Show a notice: speech bubble + the character's reaction (if it has one) + optionally a line
 * in the character's own voice. `deferrable` notices wait while focus mode is on.
 */
function notify(n: Notice, o: { deferrable?: boolean; line?: string } = {}): void {
  if (o.deferrable && isQuiet()) {
    deferred = [...deferred.filter((d) => d.n.id !== n.id), { n, line: o.line }]
    return
  }
  showNotice(n)
  const react = manifest.reactions?.notice
  if (react && !isQuiet() && overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay:menu-action', react)
  const line = o.line ?? (n.meeting ? meetingSituation(n) : undefined)
  if (line) void characterLine(n.id, line)
}

function meetingSituation(n: Notice): string {
  const mins = Math.round((n.meeting!.start - Date.now()) / 60_000)
  const when = mins <= 0 ? 'is starting right now' : `starts in ${mins} minute${mins === 1 ? '' : 's'}`
  return `The meeting "${n.title}" ${when}. Nudge them to get ready (max 14 words, no time details).`
}

/** The character says one short line about a notice, in its own voice (fast model, best effort). */
async function characterLine(id: string, situation: string): Promise<void> {
  const system = systemPrompt({ name: manifest.name, persona: manifest.persona, events: null })
  let text = ''
  try {
    if (!hasApiKey()) return // no key: notices just show without the character's line
    await ask({ model: LINE_MODEL }, system, [{
      role: 'user',
      text: `(Not a chat message: the app is showing the user a notification card from you.) ${situation} ` +
        'Write ONE short line, in character, that you say alongside it. No quotes.'
    }], (t) => {
      text += t
      patchNotice(id, { quip: text })
    })
  } catch (e) {
    console.error('character line failed:', (e as Error).message)
  }
}

function reminderDue(r: Reminder): void {
  notify({
    id: `rem:${r.id}`,
    title: '⏰ Reminder',
    body: r.text,
    actions: [
      { id: 'snooze', label: 'Snooze 10 min', snoozeMin: 10 },
      { id: 'dismiss', label: 'Done' }
    ]
  }, { line: `You're reminding the user, as they asked earlier: "${r.text}". Max 14 words.` })
}

/** "Good morning" on the first time at the Mac each day. */
async function morningBrief(force = false): Promise<void> {
  const today = localDay()
  const hour = new Date().getHours()
  if (!force) {
    if (!settings.morningBrief || store.get().lastBrief === today || hour < 5) return
    if (powerMonitor.getSystemIdleTime() > 120) return // not actually at the Mac
  }
  store.setLastBrief(today)
  const endOfDay = new Date(new Date().setHours(24, 0, 0, 0)).getTime()
  const events = (await getEvents(0).catch(() => null))
  const todays = events?.filter((e) => !e.allDay && e.end > Date.now() && e.start < endOfDay) ?? null
  const hm = (t: number): string => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const todos = store.openTodos()
  const rems = store.upcoming().filter((r) => r.at < endOfDay)
  const lines: string[] = []
  if (todays) lines.push(...(todays.length ? todays.slice(0, 4).map((e) => `📅 ${hm(e.start)}  ${e.title}`) : ['📅 No more meetings today']))
  if (todays && todays.length > 4) lines.push(`   …and ${todays.length - 4} more`)
  lines.push(...rems.slice(0, 3).map((r) => `⏰ ${hm(r.at)}  ${r.text}`))
  if (todos.length) lines.push(`✅ ${todos.length} open to-do${todos.length > 1 ? 's' : ''}: ${todos.slice(0, 3).map((t) => t.text).join(', ')}${todos.length > 3 ? '…' : ''}`)
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  notify({
    id: 'brief',
    title: `${greeting} ${hour < 12 ? '☀️' : hour < 18 ? '🌤️' : '🌙'}`,
    body: lines.join('\n') || 'Nothing on the schedule. Have a great day!',
    actions: [{ id: 'chat', label: 'Chat' }, { id: 'dismiss', label: 'Thanks' }]
  }, {
    deferrable: true,
    line: `It's the user's first time at the computer today (${greeting.toLowerCase()}). Their day: ${lines.join('; ') || 'nothing scheduled'}. ` +
      'Greet them warmly in one short line (max 18 words), maybe pointing at the most notable thing.'
  })
}

function listNotice(): Notice {
  const todos = store.openTodos()
  const rems = store.upcoming()
  const notes = store.get().notes
  const when = (t: number): string => new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  const lines = [
    ...todos.slice(0, 8).map((t) => `☐ ${t.text}`),
    ...rems.slice(0, 4).map((r) => `⏰ ${when(r.at)} — ${r.text}`),
    ...notes.slice(-4).map((n) => `📝 ${n.text}`)
  ]
  return {
    id: 'list',
    title: 'Your list',
    body: lines.join('\n') || 'Nothing saved yet. Tell me "remind me…", "note…" or "add a to-do…" in the chat.',
    actions: [{ id: 'chat', label: 'Chat' }, { id: 'dismiss', label: 'OK' }],
    ttlSec: 40
  }
}

async function onNoticeAction(n: Notice, a: { id: string }): Promise<void> {
  if (a.id === 'chat') return openChat()
  if (a.id.startsWith('summarize:')) {
    try {
      const text = await gmailText(a.id.slice('summarize:'.length))
      askAbout('Summarize this email in 2-3 sentences, and tell me if it needs a reply from me.', text, 'email')
    } catch (e) {
      showNotice({ id: n.id + ':err', title: "Couldn't open that email", body: (e as Error).message, ttlSec: 12 })
    }
  }
}

function setShortcut(acc: string): string | undefined {
  globalShortcut.unregisterAll()
  if (!acc) return undefined
  try {
    if (globalShortcut.register(acc, toggleChat)) {
      console.log(`shortcut ${acc} registered`)
      return undefined
    }
    return `${acc.replace(/\+/g, ' + ')} is already used by another app. Pick another one.`
  } catch {
    return `"${acc}" isn't a valid shortcut.`
  }
}
let shortcutError: string | undefined

async function showAgenda(): Promise<void> {
  try {
    const events = await getEvents(0)
    if (events) showNotice(agendaNotice(events))
  } catch (e) {
    showNotice({ id: 'agenda', title: "Couldn't read your calendar", body: (e as Error).message, ttlSec: 15 })
  }
}

/** A pretend meeting 5 minutes from now, for "Show a test reminder". */
function demoEvent(): CalEvent {
  const start = Date.now() + 5 * 60_000
  return { id: 'demo', title: 'Team standup', start, end: start + 15 * 60_000, allDay: false, joinUrl: 'https://meet.google.com/' }
}

function connStatus(): ConnectionStatus {
  const g = getSecrets().google
  return {
    google: { hasClient: !!g?.clientId, connected: !!g?.refreshToken, gmail: google.gmailAllowed(), email: g?.email, error: calendarError(), mailError: mailError() },
    focus: { quiet: isQuiet(), reason: quietReason() },
    shortcutError,
    claude: { hasKey: hasApiKey() }
  }
}

function openSettings(): void {
  if (settingsWin) return settingsWin.focus()
  settingsWin = new BrowserWindow({
    width: 460,
    height: 780,
    title: 'Deskat Settings',
    resizable: false,
    webPreferences: { preload, sandbox: false }
  })
  settingsWin.on('closed', () => (settingsWin = null))
  // links (Google Cloud, Anthropic console) open in the real browser
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  rendererUrl(settingsWin, 'settings')
  if (process.platform === 'darwin') app.dock?.show()
  settingsWin.on('closed', () => process.platform === 'darwin' && app.dock?.hide())
}

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty())
  if (process.platform === 'darwin') tray.setTitle('🐾')
  tray.setToolTip('Deskat')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Settings…', click: openSettings },
      { label: 'Bring cat here', click: () => recreateOverlay() },
      { type: 'separator' },
      { label: 'Quit Deskat', role: 'quit' }
    ])
  )
}

function displays(): DisplayInfo[] {
  const primary = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: `${d.label || `Display ${i + 1}`} (${d.size.width}×${d.size.height})`,
    primary: d.id === primary
  }))
}

function rememberPosition(): void {
  if (!overlay) return
  settings.positions[String(targetDisplay().id)] = overlay.getBounds().x
  saveSettings(settings)
}

// ------------------------------------------------------------------ IPC

function registerIpc(): void {
  ipcMain.handle('overlay:init', (): OverlayInit => ({
    settings,
    manifest,
    assetBase: `deskat://cats/${encodeURIComponent(manifest.id)}/`
  }))

  ipcMain.on('overlay:click-through', (_e, through: boolean) => {
    overlay?.setIgnoreMouseEvents(through, { forward: true })
  })

  ipcMain.on('overlay:move-by', (_e, dx: number) => {
    if (!overlay) return
    const b = overlay.getBounds()
    exactX = Math.abs(exactX - b.x) > 2 ? b.x + dx : exactX + dx
    const x = clampX(exactX, b.width, targetDisplay().workArea)
    if (x !== b.x) overlay.setPosition(x, b.y)
  })

  ipcMain.on('overlay:moved', () => rememberPosition())

  ipcMain.handle('overlay:room', () => room())

  ipcMain.on('overlay:menu', (_e, items: MenuItem[]) => {
    if (!overlay) return
    const template: Electron.MenuItemConstructorOptions[] = []
    template.push({ label: manifest.kind === 'pet' ? `Talk to ${manifest.name}…` : `Ask ${manifest.name}…`, click: openChat })
    if (google.googleConnected()) template.push({ label: "What's next today?", click: () => void showAgenda() })
    template.push({ label: 'My to-dos & reminders', click: () => showNotice(listNotice()) })
    if (template.length) template.push({ type: 'separator' })
    template.push(...items.map((i) => ({
      label: i.label,
      enabled: i.enabled !== false,
      click: () => overlay?.webContents.send('overlay:menu-action', i.id)
    })))
    if (items.length) template.push({ type: 'separator' })
    template.push({ label: 'Settings…', click: openSettings })
    Menu.buildFromTemplate(template).popup({ window: overlay })
  })

  ipcMain.handle('settings:get', () => ({ settings, cats: listCats(), displays: displays() }))

  ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => {
    const before = settings
    settings = { ...settings, ...patch }
    saveSettings(settings)
    if (patch.shortcut !== undefined && patch.shortcut !== before.shortcut) {
      shortcutError = setShortcut(settings.shortcut)
      if (shortcutError) {
        settings.shortcut = before.shortcut
        saveSettings(settings)
        setShortcut(before.shortcut)
        throw new Error(shortcutError)
      }
    }
    if (patch.hideFromCapture !== undefined) {
      overlay?.setContentProtection(settings.hideFromCapture)
      setBubbleCaptureProtection(settings.hideFromCapture)
    }
    if (patch.cat !== undefined && patch.cat !== before.cat) {
      resetBubble()
      recreateOverlay()
    }
    else if (patch.displayId !== undefined && patch.displayId !== before.displayId) recreateOverlay()
    else if (patch.size !== undefined && patch.size !== before.size) {
      // keep the cat's middle where it was
      const old = overlay?.getBounds()
      const b = overlayBounds()
      if (old) b.x = clampX(old.x + (old.width - b.width) / 2, b.width, targetDisplay().workArea)
      overlay?.setBounds(b)
      exactX = b.x
      overlay?.webContents.send('overlay:settings', settings)
    } else {
      if (patch.layer !== undefined) applyLayer()
      overlay?.webContents.send('overlay:settings', settings)
    }
    return settings
  })

  // ---- connections (secrets stay in main; the settings window only sees status)
  ipcMain.handle('conn:status', () => connStatus())
  ipcMain.handle('conn:google-client-file', async () => {
    const r = await dialog.showOpenDialog(settingsWin!, {
      title: 'Choose the OAuth client JSON you downloaded from Google Cloud',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (!r.canceled && r.filePaths[0]) {
      const c = google.parseClientJson(readFileSync(r.filePaths[0], 'utf8'))
      google.setGoogleClient(c.clientId, c.clientSecret)
    }
    return connStatus()
  })
  ipcMain.handle('conn:google-client', (_e, id: string, secret: string) => {
    google.setGoogleClient(id.trim(), secret.trim())
    return connStatus()
  })
  ipcMain.handle('conn:google-connect', async () => {
    await google.googleConnect()
    settingsWin?.focus()
    await getEvents(0).catch(() => null)
    return connStatus()
  })
  ipcMain.handle('conn:google-disconnect', () => {
    google.googleDisconnect()
    return connStatus()
  })
  ipcMain.handle('conn:claude-key', (_e, key: string) => {
    setSecrets({ anthropicKey: key.trim() || undefined })
    return connStatus()
  })
  ipcMain.handle('conn:claude-test', async () => {
    let out = ''
    const system = systemPrompt({ name: manifest.name, persona: manifest.persona, events: null })
    await ask(settings.assistant, system, [{ role: 'user', text: 'Hi! Say hello in under 12 words.' }], (t) => (out += t))
    return out.trim()
  })
  ipcMain.handle('conn:test-reminder', async () => {
    const events = await getEvents(0).catch(() => null)
    const next = events?.find((e) => !e.allDay && e.start > Date.now())
    notify(reminderNotice(next ?? demoEvent()))
  })
}

// ------------------------------------------------------------------ lifecycle

// Dev test runs (DESKAT_DEBUG_DIR) get their own profile, so they can run next to your real
// Deskat without taking over its single-instance lock; settings are copied, secrets are not.
if (process.env['DESKAT_DEBUG_DIR']) {
  const real = app.getPath('userData')
  const test = join(process.env['DESKAT_DEBUG_DIR'], 'profile')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs')
  fs.mkdirSync(test, { recursive: true })
  if (fs.existsSync(join(real, 'settings.json'))) fs.copyFileSync(join(real, 'settings.json'), join(test, 'settings.json'))
  app.setPath('userData', test)
}

// One cat at a time: a second launch just quits.
if (!app.requestSingleInstanceLock()) app.quit()

app.whenReady().then(() => {
  protocol.handle('deskat', async (req) => {
    // deskat://cats/<cat>/<file> -> CATS_ROOT/<cat>/final/<file>
    const u = new URL(req.url)
    const [cat, ...rest] = decodeURIComponent(u.pathname).replace(/^\/+/, '').split('/')
    const file = normalize(join(CATS_ROOT, cat, 'final', ...rest))
    if (!file.startsWith(CATS_ROOT + sep)) return new Response('forbidden', { status: 403 })
    const res = await net.fetch(pathToFileURL(file).toString())
    // CORS header so the overlay can read frame pixels (click hit-testing) without tainting
    const headers = new Headers(res.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    if (file.endsWith('.webm')) headers.set('Content-Type', 'video/webm')
    return new Response(res.body, { status: res.status, headers })
  })

  settings = loadSettings()
  if (!listCats().some((c) => c.id === settings.cat)) settings.cat = listCats()[0]?.id ?? settings.cat
  if (process.platform === 'darwin') app.dock?.hide()
  registerIpc()
  initBubble({
    overlay: () => overlay,
    headLine: () => manifest.headLine ?? 0.1,
    name: () => manifest.name,
    persona: () => manifest.persona,
    assistant: () => settings.assistant,
    loadPage: (w) => rendererUrl(w, 'bubble'),
    onNotice: (n) => notify(n),
    onAction: (n, a) => void onNoticeAction(n, a),
    hideFromCapture: () => settings.hideFromCapture,
    preload
  })
  createTray()
  createOverlay()
  startCalendar(() => settings.calendarLeadMin, (n) => notify(n))
  startReminders(reminderDue)
  startMail(() => settings.mail, (items) => notify(mailNotice(items), { deferrable: true }))
  startFocus(() => settings.quietInMeetings, () => getEvents(), (quiet, reason) => {
    console.log(`focus: ${quiet ? reason : 'off'}`)
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay:quiet', quiet)
    if (!quiet) {
      const held = deferred
      deferred = []
      for (const d of held) notify(d.n, { line: d.line })
    }
  })
  shortcutError = setShortcut(settings.shortcut)
  // morning brief: on start, on unlock/wake, and a periodic check (first activity of the day)
  setTimeout(() => void morningBrief(), 15_000)
  powerMonitor.on('unlock-screen', () => setTimeout(() => void morningBrief(), 5_000))
  powerMonitor.on('resume', () => setTimeout(() => void morningBrief(), 20_000))
  setInterval(() => void morningBrief(), 5 * 60_000)

  const reflow = (): void => recreateOverlay()
  screen.on('display-added', reflow)
  screen.on('display-removed', reflow)
  screen.on('display-metrics-changed', () => overlay?.setBounds(overlayBounds()))
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  // keep running in the tray
})
