import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { BubbleApi, BubbleState, ClipAction, Notice } from '../../../shared/types'
import './bubble.css'

declare global {
  interface Window {
    bubble: BubbleApi
  }
}
const api = window.bubble

function App(): JSX.Element {
  const [s, setS] = useState<BubbleState>({ name: '', notices: [], chat: null })
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.onState(setS)
    api.ready()
  }, [])

  // the window is sized to whatever we render: measure on every change (ResizeObserver can
  // miss changes made while the window is hidden) and on later resizes (images, textarea)
  useLayoutEffect(() => {
    api.resize(root.current!.offsetHeight)
  }, [s])
  useLayoutEffect(() => {
    const el = root.current!
    const ro = new ResizeObserver(() => api.resize(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const any = s.notices.length > 0 || !!s.chat?.open
  // keep the stack short: with the chat open only the newest notice shows above it
  const shown = s.notices.slice(s.chat?.open ? -1 : -2)
  const hidden = s.notices.length - shown.length
  return (
    <div ref={root} className={any ? 'wrap' : ''}>
      {any && (
        <div className="stack">
          {hidden > 0 && <div className="more">+{hidden} more notification{hidden > 1 ? 's' : ''}</div>}
          {shown.map((n) => (n.meeting ? <Meeting key={n.id} n={n} name={s.name} /> : <Plain key={n.id} n={n} name={s.name} />))}
          {s.chat?.open && <Chat s={s} />}
        </div>
      )}
    </div>
  )
}

function Actions({ n }: { n: Notice }): JSX.Element | null {
  if (!n.actions?.length) return null
  return (
    <div className="actions">
      {n.actions.map((a, i) => (
        <button key={a.id} className={`btn ${i === 0 && n.actions!.length > 1 ? 'primary' : ''}`} onClick={() => api.noticeAction(n.id, a)}>
          {a.label}
        </button>
      ))}
    </div>
  )
}

function Quip({ n, name }: { n: Notice; name: string }): JSX.Element | null {
  if (!n.quip) return null
  return (
    <div className="quip">
      <span className="who">{name}</span>
      {n.quip}
    </div>
  )
}

function Plain({ n, name }: { n: Notice; name: string }): JSX.Element {
  return (
    <div className="balloon">
      <button className="close" title="Dismiss" onClick={() => api.dismiss(n.id)}>×</button>
      <div className="ntitle">{n.title}</div>
      {n.body && <div className="nbody">{n.body}</div>}
      <Quip n={n} name={name} />
      <Actions n={n} />
    </div>
  )
}

const hm = (t: number): string => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

function Meeting({ n, name }: { n: Notice; name: string }): JSX.Element {
  const m = n.meeting!
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])
  const mins = Math.ceil((m.start - now) / 60_000)
  const count = now >= m.end ? 'Ended' : mins <= 0 ? 'Now' : mins === 1 ? 'in 1 min' : `in ${mins} min`
  return (
    <div className="balloon">
      <button className="close" title="Dismiss" onClick={() => api.dismiss(n.id)}>×</button>
      <div className="meet-top">
        <span className="meet-tag">📅 Meeting</span>
        <span className={`count ${mins <= 1 ? 'hot' : ''}`}>{count}</span>
      </div>
      <div className="meet-title">{n.title}</div>
      <div className="meet-when">
        {hm(m.start)}–{hm(m.end)}
        {m.location ? ` · ${m.location}` : ''}
      </div>
      <Quip n={n} name={name} />
      <Actions n={n} />
    </div>
  )
}

const CLIP: [ClipAction, string][] = [
  ['summarize', 'Summarize'],
  ['translate', 'Translate'],
  ['grammar', 'Fix grammar'],
  ['polite', 'Make polite']
]

function Chat({ s }: { s: BubbleState }): JSX.Element {
  const chat = s.chat!
  const [text, setText] = useState('')
  const [clipOpen, setClipOpen] = useState(false)
  const log = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight })
  }, [chat.messages])
  useEffect(() => {
    if (!chat.busy) input.current?.focus()
  }, [chat.busy])
  useEffect(() => {
    const onFocus = (): void => input.current?.focus()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const send = (): void => {
    if (!text.trim() || chat.busy) return
    api.send(text.trim())
    setText('')
    if (input.current) input.current.style.height = 'auto'
  }

  return (
    <div className="balloon">
      <div className="chat-head">
        <span className="who">{s.name}</span>
        <button className="icon" title="New conversation" onClick={api.newChat} disabled={chat.busy || !chat.messages.length}>↺</button>
        <button className="icon" title="Close" onClick={api.closeChat}>×</button>
      </div>
      <div className="log" ref={log}>
        {!chat.messages.length && <div className="hello">Hi! Ask me anything, or tell me to remind you, note something or add a to-do.</div>}
        {chat.messages.map((m, i) => (
          <div key={i} className={`row ${m.role}`}>
            <div className={`msg ${m.role} ${m.error ? 'error' : ''}`}>
              {m.text || (m.streaming ? <span className="typing"><i /><i /><i /></span> : '')}
              {m.role === 'assistant' && !m.streaming && !m.error && m.text && (
                <button className="copy" title="Copy" onClick={(e) => {
                  api.copy(m.text)
                  const b = e.currentTarget
                  b.textContent = '✓'
                  setTimeout(() => (b.textContent = '⧉'), 1200)
                }}>⧉</button>
              )}
            </div>
            {m.meta?.map((x, j) => <div key={j} className="receipt">{x}</div>)}
          </div>
        ))}
      </div>
      {(clipOpen || !chat.messages.length) && !chat.busy && (
        <div className="clip-actions">
          <span className="clip-label">📋 Clipboard:</span>
          {CLIP.map(([k, label]) => (
            <button key={k} className="chipbtn" onClick={() => {
              setClipOpen(false)
              api.clipAction(k)
            }}>{label}</button>
          ))}
          <button className="chipbtn ghost" title="Attach clipboard and ask your own question" onClick={() => {
            setClipOpen(false)
            api.attachClipboard()
            input.current?.focus()
          }}>Ask…</button>
        </div>
      )}
      {chat.clip && (
        <div className="chip">
          📋 Clipboard attached ({chat.clip.length.toLocaleString()} chars)
          <button className="link" onClick={api.clearClip}>remove</button>
        </div>
      )}
      <div className="composer">
        <button className={`icon ${clipOpen ? 'on' : ''}`} title="Clipboard actions" onClick={() => setClipOpen(!clipOpen)} disabled={chat.busy}>📋</button>
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={chat.busy ? `${s.name} is typing…` : `Message ${s.name}`}
          onChange={(e) => {
            setText(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = `${e.target.scrollHeight}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
            if (e.key === 'Escape') api.closeChat()
          }}
        />
        <button className="send" title="Send" onClick={send} disabled={chat.busy || !text.trim()}>↑</button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
