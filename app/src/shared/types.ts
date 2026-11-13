// Shared between main, preload and renderer. Everything cat-specific lives in cat.json,
// so a new cat (e.g. Linux) needs only a folder with clips + a manifest.

export type Facing = 'left' | 'right'
export type Range = [number, number]

/** One video file. Every clip starts on pose `from` and ends on pose `to`. */
export interface ClipDef {
  file: string
  from: string
  to: string
  /** Weight for random idle variants (only for clips that start and end on the idle pose). */
  variant?: number
  /** Move the window while this clip plays (canvas px/s), optionally only within [fromSec, toSec]. */
  move?: { speed: number; fromSec?: number; toSec?: number }
  /**
   * How this clip yields to a clicked action: 'blend' cross-fades straight into the next
   * clip, 'rush' fast-forwards to its end pose first. Default: blend for looping steps
   * (idle or a repeating step on one pose), rush otherwise.
   */
  interrupt?: 'blend' | 'rush'
}

/** How long a looping step repeats. */
export interface RepeatDef {
  /** Repeat until this many seconds have passed (random in range). */
  seconds?: Range
  /** Repeat until the cat has moved roughly this far (screen px, random in range). */
  distance?: Range
}

export interface StepDef {
  clip: string
  repeat?: RepeatDef
  /** Menu label that ends this step early (e.g. "Get up"). */
  stopLabel?: string
}

export interface ActionDef {
  label: string
  /** Which way the cat faces for this action. Omit to keep the current facing. */
  facing?: Facing
  steps: StepDef[]
  /** Show in the click menu (default true). */
  menu?: boolean
  /** Can be chosen randomly as a "stroll" behavior. */
  stroll?: boolean
}

/** Pets (cats) and assistants (people) get different command sets via their actions. */
export type CharacterKind = 'pet' | 'assistant'

export interface CatManifest {
  id: string
  name: string
  kind: CharacterKind
  /** Pixel size of the clip videos (all clips share it). */
  canvas: [number, number]
  /** Fraction of canvas height where the paws touch the ground. */
  pawLine: number
  /** Fraction of canvas height of the top of the head (where the speech bubble points). */
  headLine?: number
  /** Who this character is and how they talk in the chat bubble (added to the system prompt). */
  persona?: string
  /** Direction the cat faces in the unmirrored clips. */
  nativeFacing: Facing
  /** The default looping clip. Its `from` pose is the home pose. */
  idle: string
  clips: Record<string, ClipDef>
  actions: Record<string, ActionDef>
  /** Actions the character plays in response to app events (e.g. a calendar reminder). */
  reactions?: { notice?: string }
}

export type Layer = 'top' | 'behind'

export interface Settings {
  cat: string
  /** Overlay height in screen px. */
  size: number
  layer: Layer
  displayId: number | null
  strolls: boolean
  /** Minutes between random strolls. */
  strollEveryMin: Range
  /** Seconds between random idle variants (yawn, lick, ...). */
  variantEverySec: Range
  /** Remembered horizontal position per display (window x). */
  positions: Record<string, number>
  /** Minutes before a calendar event to remind (0 = no reminders). */
  calendarLeadMin: number
  assistant: AssistantSettings
  /** Global shortcut that opens the chat (Electron accelerator, '' = off). */
  shortcut: string
  /** Keep the character and bubbles out of screen shares, recordings and screenshots. */
  hideFromCapture: boolean
  /** Focus mode during meetings/calls: no random moments, mail and brief wait. */
  quietInMeetings: boolean
  mail: MailSettings
  /** Greeting with the day's agenda on your first time at the Mac each day. */
  morningBrief: boolean
}

export interface MailSettings {
  mode: 'off' | 'important' | 'senders' | 'all'
  /** For 'senders': addresses or domains, comma separated. */
  senders: string
}

/** The chat uses the Anthropic API with the user's own API key (kept in the Keychain, not here). */
export interface AssistantSettings {
  /** Claude model id, e.g. 'claude-haiku-5-5'. */
  model: string
}

// ------------------------------------------------------------------ connections

/** What the settings window may know about connections (never the secrets themselves). */
export interface ConnectionStatus {
  google: { hasClient: boolean; connected: boolean; gmail: boolean; email?: string; error?: string; mailError?: string }
  focus: { quiet: boolean; reason: string }
  shortcutError?: string
  claude: { hasKey: boolean }
}

export interface CalEvent {
  id: string
  title: string
  start: number
  end: number
  allDay: boolean
  location?: string
  /** Video-call link (Meet/Zoom/...) when the event has one. */
  joinUrl?: string
  htmlLink?: string
}

// ------------------------------------------------------------------ bubble

export interface NoticeAction {
  id: string
  label: string
  /** Opened in the browser when clicked. */
  url?: string
  /** For id 'snooze': show the notice again after this many minutes (default 2). */
  snoozeMin?: number
}

export interface Notice {
  id: string
  title: string
  body?: string
  actions?: NoticeAction[]
  /** Auto-dismiss after this many seconds (default: stays until dismissed). */
  ttlSec?: number
  /** A meeting reminder: drawn as the special meeting bubble with a live countdown. */
  meeting?: { start: number; end: number; location?: string; joinUrl?: string }
  /** The character's own one-liner about it (streams in after the notice appears). */
  quip?: string
}

export interface ChatMsg {
  role: 'user' | 'assistant'
  text: string
  /** Pending assistant reply still streaming in. */
  streaming?: boolean
  error?: boolean
  /** Small receipts under a reply ("⏰ Fri 16:20 — call mom"). */
  meta?: string[]
}

export type ClipAction = 'summarize' | 'translate' | 'grammar' | 'polite'

export interface BubbleState {
  name: string
  notices: Notice[]
  chat: { open: boolean; messages: ChatMsg[]; busy: boolean; clip?: string } | null
}

export interface BubbleApi {
  onState(cb: (s: BubbleState) => void): void
  ready(): void
  resize(height: number): void
  dismiss(id: string): void
  noticeAction(noticeId: string, action: NoticeAction): void
  send(text: string): void
  attachClipboard(): void
  /** One-click clipboard action (reads the clipboard in main and asks). */
  clipAction(kind: ClipAction): void
  copy(text: string): void
  clearClip(): void
  closeChat(): void
  newChat(): void
}

export interface CatInfo {
  id: string
  name: string
  kind: CharacterKind
}

export interface DisplayInfo {
  id: number
  label: string
  primary: boolean
}

export interface OverlayInit {
  settings: Settings
  manifest: CatManifest
  assetBase: string
}

export interface MenuItem {
  id: string
  label: string
  /** Shown greyed out when false (e.g. a walk with no room). */
  enabled?: boolean
}

export interface Room {
  left: number
  right: number
}

export interface DeskatApi {
  // overlay
  getInit(): Promise<OverlayInit>
  setClickThrough(through: boolean): void
  moveBy(dx: number): void
  /** Tell main the cat stopped moving so it can remember the position. */
  moved(): void
  getRoom(): Promise<Room>
  showMenu(items: MenuItem[]): void
  onMenuAction(cb: (id: string) => void): void
  onSettingsChanged(cb: (s: Settings) => void): void
  onQuiet(cb: (quiet: boolean) => void): void
  // settings window
  getSettingsData(): Promise<{ settings: Settings; cats: CatInfo[]; displays: DisplayInfo[] }>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  connStatus(): Promise<ConnectionStatus>
  googleLoadClientFile(): Promise<ConnectionStatus>
  googleSetClient(clientId: string, clientSecret: string): Promise<ConnectionStatus>
  googleConnect(): Promise<ConnectionStatus>
  googleDisconnect(): Promise<ConnectionStatus>
  claudeSetKey(key: string): Promise<ConnectionStatus>
  /** Sends a tiny test prompt with the saved key; resolves to the reply or throws. */
  claudeTest(): Promise<string>
  testReminder(): Promise<void>
}
