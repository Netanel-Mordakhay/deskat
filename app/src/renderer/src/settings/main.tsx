import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AssistantSettings, CatInfo, ConnectionStatus, DeskatApi, DisplayInfo, Range, Settings } from '../../../shared/types'
import './settings.css'

declare global {
  interface Window {
    deskat: DeskatApi
  }
}
const api = window.deskat

function App(): JSX.Element {
  const [s, setS] = useState<Settings | null>(null)
  const [cats, setCats] = useState<CatInfo[]>([])
  const [displays, setDisplays] = useState<DisplayInfo[]>([])

  useEffect(() => {
    api.getSettingsData().then((d) => {
      setS(d.settings)
      setCats(d.cats)
      setDisplays(d.displays)
    })
  }, [])

  if (!s) return <p className="muted">Loading…</p>

  const update = async (patch: Partial<Settings>): Promise<void> => {
    setS({ ...s, ...patch })
    setS(await api.updateSettings(patch))
  }

  return (
    <main>
      <h1>Deskat</h1>

      <section>
        <h2>Character</h2>
        {([['pet', 'Pets'], ['assistant', 'Assistants']] as const).map(([kind, label]) => {
          const group = cats.filter((c) => c.kind === kind)
          if (!group.length) return null
          return (
            <div key={kind} className="group">
              <div className="group-label">{label}</div>
              <div className="choices">
                {group.map((c) => (
                  <button key={c.id} className={c.id === s.cat ? 'on' : ''} onClick={() => update({ cat: c.id })}>
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </section>

      <section>
        <h2>Size</h2>
        <label className="row">
          <input
            type="range" min={120} max={480} step={10} value={s.size}
            onChange={(e) => setS({ ...s, size: +e.target.value })}
            onPointerUp={(e) => update({ size: +(e.target as HTMLInputElement).value })}
            onKeyUp={(e) => update({ size: +(e.target as HTMLInputElement).value })}
          />
          <span className="value">{s.size}px</span>
        </label>
      </section>

      <section>
        <h2>Where it lives</h2>
        <div className="choices">
          <button className={s.layer === 'top' ? 'on' : ''} onClick={() => update({ layer: 'top' })}>
            Above all windows
          </button>
          <button className={s.layer === 'behind' ? 'on' : ''} onClick={() => update({ layer: 'behind' })}>
            On the desktop
          </button>
        </div>
        <p className="hint">"On the desktop" lets your app windows cover it.</p>
      </section>

      {displays.length > 1 && (
        <section>
          <h2>Monitor</h2>
          <select
            value={s.displayId ?? displays.find((d) => d.primary)?.id}
            onChange={(e) => update({ displayId: +e.target.value })}
          >
            {displays.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}{d.primary ? ' — main' : ''}
              </option>
            ))}
          </select>
        </section>
      )}

      <section>
        <h2>Behavior</h2>
        <label className="row check">
          <input type="checkbox" checked={s.strolls} onChange={(e) => update({ strolls: e.target.checked })} />
          Goes for a stroll on its own
        </label>
        <RangeRow
          label="Stroll every" unit="min" min={1} max={30} disabled={!s.strolls}
          value={s.strollEveryMin} onChange={(r) => update({ strollEveryMin: r })}
        />
        <RangeRow
          label="Little idle moments every" unit="s" min={5} max={120}
          value={s.variantEverySec} onChange={(r) => update({ variantEverySec: r })}
        />
      </section>

      <Connections s={s} update={update} />
    </main>
  )
}

const MODELS: [string, string][] = [
  ['claude-haiku-5-5', 'Haiku 5.5 — fast, cheapest ($0.10 / $0.50 per M tokens)'],
  ['claude-sonnet-5-5', 'Sonnet 5.5 — smarter ($2 / $10)'],
  ['claude-opus-5-5', 'Opus 5.5 — smartest ($4 / $20)']
]

function Connections({ s, update }: { s: Settings; update: (p: Partial<Settings>) => Promise<void> }): JSX.Element {
  const [c, setC] = useState<ConnectionStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [manual, setManual] = useState(false)
  const [key, setKey] = useState('')
  const [cid, setCid] = useState('')
  const [csecret, setCsecret] = useState('')

  useEffect(() => {
    api.connStatus().then(setC)
  }, [])
  if (!c) return <></>

  const run = async (id: string, f: () => Promise<ConnectionStatus | string | void>): Promise<void> => {
    setBusy(id)
    setMsg((m) => ({ ...m, [id]: '' }))
    try {
      const r = await f()
      if (r && typeof r === 'object') setC(r)
      if (typeof r === 'string') setMsg((m) => ({ ...m, [id]: `✓ "${r}"` }))
    } catch (e) {
      setMsg((m) => ({ ...m, [id]: `⚠️ ${String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}` }))
    } finally {
      setBusy(null)
    }
  }
  const setAssistant = (p: Partial<AssistantSettings>): Promise<void> => update({ assistant: { ...s.assistant, ...p } })

  return (
    <>
      <section>
        <h2>Google Calendar & Gmail</h2>
        {c.google.connected ? (
          <>
            <div className="row">
              <span className="grow">✅ Google Calendar{c.google.email ? ` — ${c.google.email}` : ''}</span>
              <button className="small" onClick={() => run('g', api.googleDisconnect)}>Disconnect</button>
            </div>
            {c.google.error && <p className="hint warn">Last sync failed: {c.google.error}</p>}
            <label className="row">
              <span className="grow">Remind me before meetings</span>
              <select className="inline" value={s.calendarLeadMin} onChange={(e) => update({ calendarLeadMin: +e.target.value })}>
                {[0, 1, 2, 5, 10, 15].map((m) => (
                  <option key={m} value={m}>{m ? `${m} min` : 'Off'}</option>
                ))}
              </select>
            </label>
            <div className="row">
              <button className="small" onClick={() => run('t', api.testReminder)}>Show a test reminder</button>
            </div>
            <p className="hint">Click the character → "What's next today?" for your agenda.</p>
            <div className="sub">
              <div className="sub-title">✉️ Mail alerts</div>
              {c.google.gmail ? (
                <>
                  <label className="row">
                    <span className="grow">Tell me about new mail</span>
                    <select className="inline" value={s.mail.mode} onChange={(e) => update({ mail: { ...s.mail, mode: e.target.value as Settings['mail']['mode'] } })}>
                      <option value="important">Marked important by Gmail</option>
                      <option value="senders">Only from people I choose</option>
                      <option value="all">All new mail</option>
                      <option value="off">Off</option>
                    </select>
                  </label>
                  {s.mail.mode === 'senders' && (
                    <SendersInput value={s.mail.senders} onSave={(v) => update({ mail: { ...s.mail, senders: v } })} />
                  )}
                  {c.google.mailError && <p className="hint warn">Last check failed: {c.google.mailError}</p>}
                  <p className="hint">Checked every 2 minutes. Each alert has Open and Summarize.</p>
                </>
              ) : (
                <>
                  <p className="hint first">Your connection was made before mail alerts existed. Reconnect once to allow reading Gmail (read-only).</p>
                  <div className="row">
                    <button className="small" disabled={busy === 'g'} onClick={() => run('g', api.googleConnect)}>
                      {busy === 'g' ? 'Waiting for you in the browser…' : 'Reconnect with Gmail'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        ) : c.google.hasClient ? (
          <>
            <div className="row">
              <button className="primary" disabled={busy === 'g'} onClick={() => run('g', api.googleConnect)}>
                {busy === 'g' ? 'Waiting for you in the browser…' : 'Connect Google Calendar'}
              </button>
              <button className="link" onClick={() => setManual(true)}>change client</button>
            </div>
            <p className="hint">Opens Google in your browser. Deskat only asks to <b>read</b> your calendar and mail.</p>
          </>
        ) : (
          <>
            <p className="hint first">
              Google needs a (free) OAuth client of your own, one time:
            </p>
            <ol className="steps">
              <li>In <a href="https://console.cloud.google.com/projectcreate" target="_blank">Google Cloud</a>, create a project, then enable the <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank">Google Calendar API</a> and the <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank">Gmail API</a>.</li>
              <li><a href="https://console.cloud.google.com/auth/overview" target="_blank">Google Auth Platform</a>: get started as <b>External</b>, and add yourself under <b>Audience → Test users</b>.</li>
              <li><a href="https://console.cloud.google.com/auth/clients" target="_blank">Clients</a> → Create client → <b>Desktop app</b> → download the JSON.</li>
            </ol>
            <div className="row">
              <button className="primary" onClick={() => run('g', api.googleLoadClientFile)}>Load client JSON…</button>
              <button className="link" onClick={() => setManual(!manual)}>or paste ID & secret</button>
            </div>
          </>
        )}
        {manual && !c.google.connected && (
          <div className="stack">
            <input placeholder="Client ID" value={cid} onChange={(e) => setCid(e.target.value)} />
            <input placeholder="Client secret" type="password" value={csecret} onChange={(e) => setCsecret(e.target.value)} />
            <button className="small" disabled={!cid || !csecret} onClick={() => run('g', async () => {
              const r = await api.googleSetClient(cid, csecret)
              setManual(false)
              return r
            })}>Save client</button>
          </div>
        )}
        {msg.g && <p className="hint warn">{msg.g}</p>}
        {msg.t && <p className="hint warn">{msg.t}</p>}
      </section>

      <section>
        <h2>Assistant chat (Claude)</h2>
        <p className="hint first">
          Uses your own Anthropic API key from <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a> (pay as
          you go, separate from a Claude.ai subscription). The key is stored encrypted in your Mac's Keychain and only sent to Anthropic.
        </p>
        <div className="row">
          <input
            className="grow" type="password" value={key} onChange={(e) => setKey(e.target.value)}
            placeholder={c.claude.hasKey ? '•••••••• key saved — paste to replace' : 'sk-ant-…'}
          />
          <button className="small" disabled={!key} onClick={() => run('k', async () => {
            const r = await api.claudeSetKey(key)
            setKey('')
            return r
          })}>Save</button>
          {c.claude.hasKey && <button className="link" onClick={() => run('k', () => api.claudeSetKey(''))}>remove</button>}
        </div>
        {msg.k && <p className="hint warn">{msg.k}</p>}
        <label className="row">
          <span>Model</span>
          <select className="grow" value={s.assistant.model} onChange={(e) => setAssistant({ model: e.target.value })}>
            {MODELS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <div className="row">
          <button className="small" disabled={busy === 'c'} onClick={() => run('c', api.claudeTest)}>
            {busy === 'c' ? 'Asking…' : 'Test'}
          </button>
          {msg.c && <span className="hint inline">{msg.c}</span>}
        </div>
        <p className="hint">Click any character → "Ask …" / "Talk to …" to chat in their own style.</p>
        <div className="sub">
          <div className="sub-title">⌨️ Chat shortcut</div>
          <ShortcutRow value={s.shortcut} error={c.shortcutError} onSave={async (acc) => {
            await update({ shortcut: acc })
            setC(await api.connStatus())
          }} />
        </div>
        <label className="row check">
          <input type="checkbox" checked={s.morningBrief} onChange={(e) => update({ morningBrief: e.target.checked })} />
          Morning brief: greet me with the day's agenda the first time I'm at the Mac
        </label>
      </section>

      <section>
        <h2>Focus</h2>
        <label className="row check">
          <input type="checkbox" checked={s.quietInMeetings} onChange={(e) => update({ quietInMeetings: e.target.checked })} />
          Stay quiet during meetings and calls
        </label>
        <p className="hint">
          While a calendar meeting is on, or a Zoom / Teams / Webex call is running: no random moments or strolls,
          and mail alerts and the morning brief wait. Meeting reminders and your own reminders still show.
          {c.focus.quiet && <><br /><b>Quiet now:</b> {c.focus.reason}</>}
        </p>
        <label className="row check">
          <input type="checkbox" checked={s.hideFromCapture} onChange={(e) => update({ hideFromCapture: e.target.checked })} />
          Hide from screen sharing, recordings and screenshots
        </label>
      </section>
    </>
  )
}

/** macOS shortcuts we never take (Spotlight, input sources, Dock, screenshots, force quit, ...). */
const RESERVED = new Set([
  'Command+Space', 'Control+Space', 'Control+Alt+Space', 'Command+Alt+Space', 'Command+Control+Space',
  'Command+Alt+D', 'Command+Shift+3', 'Command+Shift+4', 'Command+Shift+5', 'Command+Alt+Escape',
  'Command+Control+Q', 'Command+Control+F', 'Command+Shift+Q', 'Command+Shift+A', 'Command+Shift+U',
  'Command+Shift+D', 'Command+Shift+O', 'Command+Shift+G', 'Command+Shift+N', 'Command+Shift+Delete'
])

const SYM: Record<string, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘', Space: 'Space' }
const pretty = (acc: string): string => acc.split('+').map((k) => SYM[k] ?? k).join('')

function accelerator(e: React.KeyboardEvent): string | null {
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Command'].filter(Boolean) as string[]
  const c = e.code
  const key = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : /^F\d{1,2}$/.test(c) ? c
    : c === 'Space' ? 'Space' : c === 'Slash' ? '/' : c === 'Period' ? '.' : c === 'Comma' ? ',' : null
  if (!key) return null
  return [...mods, key].join('+')
}

function ShortcutRow(p: { value: string; error?: string; onSave: (acc: string) => Promise<void> }): JSX.Element {
  const [rec, setRec] = useState(false)
  const [msg, setMsg] = useState('')
  const save = async (acc: string): Promise<void> => {
    setRec(false)
    try {
      await p.onSave(acc)
      setMsg('')
    } catch (e) {
      setMsg(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }
  return (
    <>
      <div className="row">
        <button
          className={`keycap ${rec ? 'rec' : ''}`}
          onClick={() => setRec(true)}
          onBlur={() => setRec(false)}
          onKeyDown={(e) => {
            if (!rec) return
            e.preventDefault()
            if (e.key === 'Escape') return setRec(false)
            const acc = accelerator(e)
            if (!acc) return
            const mods = acc.split('+').length - 1
            if (mods < 2 && !(mods === 1 && /^F\d/.test(acc.split('+').pop()!))) return setMsg('Use at least two modifier keys (like ⌃⌥), so it won\'t clash with app shortcuts.')
            if (RESERVED.has(acc)) return setMsg(`${pretty(acc)} is a macOS shortcut. Pick another one.`)
            void save(acc)
          }}
        >
          {rec ? 'Press keys…' : p.value ? pretty(p.value) : 'Off'}
        </button>
        <span className="hint inline grow">{rec ? 'Esc to cancel' : 'Opens the chat from anywhere'}</span>
        {p.value && !rec && <button className="link" onClick={() => void save('')}>turn off</button>}
        {!p.value && !rec && <button className="link" onClick={() => void save('Control+Alt+D')}>use ⌃⌥D</button>}
      </div>
      {(msg || p.error) && <p className="hint warn">⚠️ {msg || p.error}</p>}
    </>
  )
}

function SendersInput(p: { value: string; onSave: (v: string) => void }): JSX.Element {
  const [v, setV] = useState(p.value)
  return (
    <div className="row">
      <input className="grow" placeholder="boss@company.com, mom@gmail.com, @company.com" value={v}
        onChange={(e) => setV(e.target.value)} onBlur={() => v !== p.value && p.onSave(v)}
        onKeyDown={(e) => e.key === 'Enter' && p.onSave(v)} />
    </div>
  )
}

function RangeRow(p: {
  label: string; unit: string; min: number; max: number; value: Range; disabled?: boolean
  onChange: (r: Range) => void
}): JSX.Element {
  const [lo, hi] = p.value
  const num = (v: string): number => Math.min(p.max, Math.max(p.min, Math.round(+v || p.min)))
  return (
    <label className={`row ${p.disabled ? 'disabled' : ''}`}>
      <span className="grow">{p.label}</span>
      <input type="number" min={p.min} max={hi} value={lo} disabled={p.disabled}
        onChange={(e) => p.onChange([Math.min(num(e.target.value), hi), hi])} />
      <span>–</span>
      <input type="number" min={lo} max={p.max} value={hi} disabled={p.disabled}
        onChange={(e) => p.onChange([lo, Math.max(num(e.target.value), lo)])} />
      <span className="unit">{p.unit}</span>
    </label>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
