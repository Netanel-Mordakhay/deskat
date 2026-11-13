// Canvas clip player. Every clip has its own hidden, preloaded <video>; a frame loop copies
// the current video's frame onto one full-window <canvas>. The canvas is only redrawn when
// the video actually has a frame, otherwise it keeps its last image, so a blank frame can't
// show between clips. Consecutive clips share a pose keyframe, so a plain cut is invisible;
// 'blend' cross-fades for interruptions mid-clip, and mirroring is a canvas transform.

export type Transition = 'cut' | 'blend'

export interface PlayOptions {
  mirrored?: boolean
  transition?: Transition
  /** playbackRate for the new clip (default 1). */
  rate?: number
}

interface Layer {
  video: HTMLVideoElement
  mirrored: boolean
}

/** Cross-fade length. The incoming clip fades in over the first part, then the outgoing one fades out. */
const BLEND_MS = 250
const BLEND_IN = 0.6

export class ClipPlayer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private hidden: HTMLElement
  private vids = new Map<string, HTMLVideoElement>()
  private cur: Layer | null = null
  private out: Layer | null = null
  private blendStart = 0
  private dirty = true
  private ended: (() => void) | null = null
  private token = 0

  constructor(root: HTMLElement, urls: string[] = []) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'stage'
    root.appendChild(this.canvas)
    this.ctx = this.canvas.getContext('2d')!
    this.hidden = document.createElement('div')
    this.hidden.className = 'vids'
    root.appendChild(this.hidden)
    for (const u of urls) this.video(u)
    this.resize()
    window.addEventListener('resize', () => this.resize())
    requestAnimationFrame(this.draw)
  }

  /** The video on screen (for timing, playbackRate and the hit-test). */
  get current(): HTMLVideoElement {
    return this.cur?.video ?? this.hidden.querySelector('video')!
  }

  get mirrored(): boolean {
    return this.cur?.mirrored ?? false
  }

  onEnded(cb: () => void): void {
    this.ended = cb
  }

  /** Start `url`. The previous clip stays on the canvas until the new one has a frame. */
  async play(url: string, o: PlayOptions = {}): Promise<void> {
    const token = ++this.token
    const next = this.video(url)
    const prev = this.cur
    const blend = o.transition === 'blend' && prev !== null && prev.video !== next
    if (this.out) this.finishBlend()

    if (prev?.video === next || next.currentTime !== 0) {
      next.pause()
      next.currentTime = 0
    }
    next.playbackRate = o.rate ?? 1
    await ready(next)
    if (token !== this.token) return
    await next.play().catch(() => undefined)
    await firstFrame(next)
    if (token !== this.token) return

    if (blend) {
      this.out = prev
      this.blendStart = performance.now()
    } else if (prev && prev.video !== next) prev.video.pause()
    this.cur = { video: next, mirrored: !!o.mirrored }
    this.dirty = true
  }

  private video(url: string): HTMLVideoElement {
    let v = this.vids.get(url)
    if (v) return v
    v = document.createElement('video')
    v.crossOrigin = 'anonymous' // keeps the hit-test canvas readable
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.src = url
    const el = v
    el.addEventListener('ended', () => {
      if (el === this.cur?.video) this.ended?.()
    })
    this.hidden.appendChild(el)
    this.vids.set(url, el)
    return el
  }

  private finishBlend(): void {
    const o = this.out
    this.out = null
    if (o && o.video !== this.cur?.video) o.video.pause()
    this.dirty = true
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.max(1, Math.round(window.innerWidth * dpr))
    this.canvas.height = Math.max(1, Math.round(window.innerHeight * dpr))
    this.dirty = true
  }

  private draw = (now: number): void => {
    requestAnimationFrame(this.draw)
    const cur = this.cur
    if (!cur || !hasFrame(cur.video)) return // keep the last image
    const blending = this.out !== null
    if (!blending && !this.dirty && cur.video.paused) return
    let a = 1
    let outA = 1
    if (blending) {
      const t = Math.min(1, (now - this.blendStart) / BLEND_MS)
      a = Math.min(1, t / BLEND_IN)
      outA = t <= BLEND_IN ? 1 : 1 - (t - BLEND_IN) / (1 - BLEND_IN)
      if (t >= 1 || !hasFrame(this.out!.video)) this.finishBlend()
    }
    const { ctx, canvas } = this
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (this.out) this.paint(this.out, outA)
    this.paint(cur, a)
    this.dirty = false
  }

  private paint(l: Layer, alpha: number): void {
    const { ctx, canvas } = this
    const v = l.video
    // object-fit: contain
    const s = Math.min(canvas.width / v.videoWidth, canvas.height / v.videoHeight)
    const w = v.videoWidth * s
    const h = v.videoHeight * s
    const x = (canvas.width - w) / 2
    const y = (canvas.height - h) / 2
    ctx.setTransform(l.mirrored ? -1 : 1, 0, 0, 1, l.mirrored ? canvas.width : 0, 0)
    ctx.globalAlpha = alpha
    ctx.drawImage(v, x, y, w, h)
  }
}

function hasFrame(v: HTMLVideoElement): boolean {
  return v.readyState >= 2 && !v.seeking && v.videoWidth > 0
}

function once(el: HTMLElement, ev: string): Promise<void> {
  return new Promise((r) => el.addEventListener(ev, () => r(), { once: true }))
}

/** Resolves once the element has a decodable current frame (after a load or a rewind). */
function ready(v: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    if (hasFrame(v)) return resolve()
    const check = (): void => {
      if (!hasFrame(v)) return
      for (const e of evs) v.removeEventListener(e, check)
      resolve()
    }
    const evs = ['loadeddata', 'canplay', 'seeked']
    for (const e of evs) v.addEventListener(e, check)
  })
}

/** Resolves when the playing video has presented a frame (with a fallback timeout). */
function firstFrame(v: HTMLVideoElement): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, 100)
    const done = (): void => {
      clearTimeout(t)
      r()
    }
    if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(done)
    else requestAnimationFrame(done)
  })
}

/** Read clip durations up front (needed to know how far a walk clip travels). */
export async function probeDuration(url: string): Promise<number> {
  const v = document.createElement('video')
  v.preload = 'metadata'
  v.muted = true
  v.src = url
  await once(v, 'loadedmetadata')
  const d = v.duration
  v.removeAttribute('src')
  v.load()
  return d
}
