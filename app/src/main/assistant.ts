// "Ask the assistant": a short chat in the speech bubble, answered by Claude through the
// Anthropic API with the user's own API key (each person who installs Deskat uses their own
// key and pays for their own usage). The chat is stateless: the conversation so far is sent
// with every message.
import Anthropic from '@anthropic-ai/sdk'
import type { AssistantSettings, CalEvent } from '../shared/types'
import { COMMANDS_PROMPT, memoryPrompt } from './memory'
import { getSecrets } from './secrets'

export const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const
export const DEFAULT_MODEL = 'claude-haiku-5-5'
/** Fast model for the character's one-liners on notices. */
export const LINE_MODEL = 'claude-haiku-5-5'

export interface Turn {
  role: 'user' | 'assistant'
  text: string
}

export interface AskContext {
  name: string
  /** The character's own voice (cat.json `persona`). */
  persona?: string
  events: CalEvent[] | null
  /** The chat (not a one-line quip): include saved to-dos/notes/reminders and the commands. */
  chat?: boolean
}

export function systemPrompt(ctx: AskContext): string {
  const now = new Date()
  const lines = [
    `You are ${ctx.name}. You appear as a small animated character on the user's Mac desktop (an app called Deskat); don't mention that unless they ask.`,
    'Your replies appear in a small speech bubble: at most 3 short sentences, plain text, no markdown.',
    'Use a short list only when it really helps. Give a genuinely useful, correct answer.',
    'Apart from saving to-dos, notes and reminders, you cannot take actions on the computer; if asked to, say what the user could do instead.',
    `Current local time: ${now.toLocaleString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })} (${localIso(now)}).`
  ]
  if (ctx.events) {
    lines.push(
      ctx.events.length
        ? `The user's upcoming calendar events (next ~36h):\n${ctx.events.map(fmtEvent).join('\n')}`
        : "The user's calendar has no events in the next ~36 hours."
    )
  } else lines.push("The user's calendar is not connected.")
  if (ctx.chat) lines.push(memoryPrompt(), COMMANDS_PROMPT)
  if (ctx.persona) {
    lines.push(
      `\n# Your character\n${ctx.persona.trim()}`,
      `\nThis describes ${ctx.name}'s personality and style, not lines to recite. Let it shape your voice and attitude`,
      'so you clearly sound like this character rather than a generic assistant, but vary your wording, bring up',
      'interests only when they fit naturally, and never repeat a phrase or joke you already used in this conversation.'
    )
  }
  return lines.filter(Boolean).join('\n')
}

function localIso(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtEvent(e: CalEvent): string {
  const d = new Date(e.start)
  const when = e.allDay
    ? `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} (all day)`
    : `${d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}-${new Date(e.end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
  return `- ${when}: ${e.title}${e.location ? ` @ ${e.location}` : ''}${e.joinUrl ? ' (video call)' : ''}`
}


export function hasApiKey(): boolean {
  return !!getSecrets().anthropicKey
}

/** Streams the reply; `onText` gets each chunk. Resolves to the full text. */
export async function ask(
  cfg: AssistantSettings,
  system: string,
  turns: Turn[],
  onText: (chunk: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const apiKey = getSecrets().anthropicKey
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings → Assistant to chat.')
  const model = (MODELS as readonly string[]).includes(cfg.model) ? cfg.model : DEFAULT_MODEL
  const client = new Anthropic({ apiKey })
  const stream = client.beta.messages.stream(
    {
      model,
      max_tokens: 16000,
      system,
      // chat in a bubble: low effort keeps answers quick and cheap
      output_config: { effort: 'low' },
      messages: turns.map((t) => ({ role: t.role, content: t.text })),
      // if a safety classifier declines on Sonnet/Opus, the server retries on a suitable model
      ...(model === 'claude-haiku-5-5' ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const })
    },
    { signal }
  )
  let text = ''
  try {
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        text += ev.delta.text
        onText(ev.delta.text)
      }
    }
    const final = await stream.finalMessage()
    if (final.stop_reason === 'refusal' && !text) throw new Error("Sorry, I can't help with that one.")
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Your Anthropic API key was rejected. Check it in Settings → Assistant.')
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error('This API key has no access to that model.')
    if (e instanceof Anthropic.RateLimitError) throw new Error('Too many requests right now. Try again in a moment.')
    if (e instanceof Anthropic.BadRequestError && /credit|balance/i.test(e.message)) throw new Error('Your Anthropic API balance is empty. Add credits at console.anthropic.com.')
    if (e instanceof Anthropic.APIConnectionError) throw new Error("Can't reach Anthropic. Check your internet connection.")
    if (e instanceof Anthropic.APIError) throw new Error(`Claude API error ${e.status ?? ''}: ${e.message}`)
    throw e
  }
  return text
}
