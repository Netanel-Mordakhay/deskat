// The cat's "brain": decides which clip plays next. Pure logic, no DOM, cat-agnostic.
//
// Every clip goes from one pose to another. The brain only ever chains clips whose poses
// match (current pose == next clip's `from`), which is what makes transitions seamless.
// When an action starts from a different pose, the shortest chain of transition clips is
// inserted automatically (pose-graph search).

import type { ActionDef, CatManifest, Facing, MenuItem, Range, StepDef } from '../../../shared/types'

export interface Play {
  clip: string
  facing: Facing
  /** Movement speed factor (1 = the clip's natural speed). Lower when space is tight. */
  speed: number
}

/** Slowest a walk may move (fraction of its natural speed) to fit the space available. */
export const MIN_SPEED = 0.55

interface RunStep {
  def: StepDef
  facing: Facing
  /** Remaining plays for distance-based repeats (null = not counted). */
  playsLeft: number | null
  /** Repeat until this timestamp (ms) for time-based repeats. */
  until: number | null
  started: boolean
  stopped: boolean
  speed: number
}

export interface BrainEnv {
  now(): number
  random(): number
  /** Screen px the cat can travel in a direction from where it is now. */
  room(dir: Facing): number
  /** Screen px travelled by one play of a clip (0 if it doesn't move). */
  travel(clip: string): number
}

export interface BrainOptions {
  variantEverySec: Range
  strolls: boolean
  strollEveryMin: Range
  /** Focus mode: no random strolls or idle moments (clicked actions still work). */
  quiet?: boolean
}

const STOP_ID = '__stop__'

export class Brain {
  pose: string
  facing: Facing
  private queue: RunStep[] = []
  private current: RunStep | null = null
  private nextVariantAt: number
  private nextStrollAt: number
  private m: CatManifest
  private env: BrainEnv
  private opts: BrainOptions

  constructor(m: CatManifest, env: BrainEnv, opts: BrainOptions) {
    this.m = m
    this.env = env
    this.opts = opts
    this.pose = m.clips[m.idle].from
    this.facing = m.nativeFacing
    this.nextVariantAt = this.schedule(opts.variantEverySec, 1000)
    this.nextStrollAt = this.schedule(opts.strollEveryMin, 60_000)
  }

  setOptions(opts: BrainOptions): void {
    const strollChanged = opts.strolls !== this.opts.strolls
    this.opts = opts
    this.nextVariantAt = Math.min(this.nextVariantAt, this.schedule(opts.variantEverySec, 1000))
    if (strollChanged) this.nextStrollAt = this.schedule(opts.strollEveryMin, 60_000)
  }

  get home(): string {
    return this.m.clips[this.m.idle].from
  }

  get busy(): boolean {
    return this.queue.length > 0 || (this.current !== null && !this.isIdleStep(this.current))
  }

  /** Decide the clip to play after the current one ends. */
  next(): Play {
    const cur = this.current
    if (cur && !cur.stopped && this.shouldRepeat(cur)) return this.emit(cur)

    if (this.queue.length === 0) this.planIdle()
    const step = this.queue.shift()!
    // Bridge poses if needed (e.g. an action requested while lying down).
    const clip = this.m.clips[step.def.clip]
    if (clip.from !== this.pose) {
      const path = this.path(this.pose, clip.from)
      if (path === null) throw new Error(`No transition from pose ${this.pose} to ${clip.from}`)
      this.queue.unshift(step)
      const bridge = path.map((c) => this.makeStep({ clip: c }, step.facing))
      this.queue.unshift(...bridge.slice(1))
      return this.start(bridge[0])
    }
    return this.start(step)
  }

  /**
   * Items for the click menu: every menu action (greyed out when there's no room), plus
   * the current step's stop label. Actions are offered even while busy; requesting one
   * interrupts what's playing and the pose graph routes to it.
   */
  menu(): MenuItem[] {
    const cur = this.current
    const items: MenuItem[] = []
    if (cur && cur.def.stopLabel && !cur.stopped) items.push({ id: STOP_ID, label: cur.def.stopLabel })
    for (const [id, a] of Object.entries(this.m.actions)) {
      if (a.menu === false) continue
      items.push(this.speedFor(a) !== null ? { id, label: a.label } : { id, label: `${a.label} (no room)`, enabled: false })
    }
    return items
  }

  /**
   * Run a named action (from the menu or a random stroll). Works while busy: the queue is
   * replaced and the current step won't repeat, so the next clip bridges to the new action.
   * Returns false if not possible now.
   */
  request(id: string): boolean {
    if (id === STOP_ID) {
      const cur = this.current
      if (!cur || !cur.def.stopLabel || cur.stopped) return false
      cur.stopped = true
      return true
    }
    const a = this.m.actions[id]
    if (!a) return false
    const speed = this.speedFor(a)
    if (speed === null) return false
    const facing = a.facing ?? this.facing
    this.queue = a.steps.map((s) => this.makeStep(s, facing, speed))
    if (this.current) this.current.stopped = true
    return true
  }

  /**
   * How the playing clip should give way to a just-requested action:
   * - 'blend': cut over now with a short cross-fade (calm loops that start and end on the
   *   same pose, e.g. idle, lie_idle, walk), so any frame is close to the next clip's start;
   * - 'rush': fast-forward to its end pose first (transitions, variants, one-off actions).
   * A clip can force either with `interrupt` in the manifest.
   */
  interruptMode(): 'blend' | 'rush' {
    const cur = this.current
    if (!cur) return 'blend'
    const c = this.m.clips[cur.def.clip]
    if (c.interrupt) return c.interrupt
    const loop = c.from === c.to && (this.isIdleStep(cur) || !!cur.def.repeat)
    return loop ? 'blend' : 'rush'
  }

  // ---------------------------------------------------------------- internals

  private planIdle(): void {
    if (this.pose !== this.home) {
      const path = this.path(this.pose, this.home) ?? []
      this.queue.push(...path.map((c) => this.makeStep({ clip: c }, this.facing)))
      if (this.queue.length) return
    }
    const now = this.env.now()
    if (!this.opts.quiet && this.opts.strolls && now >= this.nextStrollAt) {
      this.nextStrollAt = this.schedule(this.opts.strollEveryMin, 60_000)
      const strolls = Object.entries(this.m.actions).filter(([, a]) => a.stroll && this.speedFor(a) !== null)
      if (strolls.length) {
        const [, a] = strolls[Math.floor(this.env.random() * strolls.length)]
        const facing = a.facing ?? this.facing
        const speed = this.speedFor(a)!
        this.queue.push(...a.steps.map((s) => this.makeStep(s, facing, speed)))
        return
      }
    }
    if (!this.opts.quiet && now >= this.nextVariantAt) {
      this.nextVariantAt = this.schedule(this.opts.variantEverySec, 1000)
      const v = this.pickVariant()
      if (v) {
        this.queue.push(this.makeStep({ clip: v }, this.facing))
        return
      }
    }
    this.queue.push(this.makeStep({ clip: this.m.idle }, this.facing))
  }

  private pickVariant(): string | null {
    const opts = Object.entries(this.m.clips).filter(
      ([, c]) => c.variant && c.from === this.home && c.to === this.home
    )
    const total = opts.reduce((s, [, c]) => s + (c.variant ?? 0), 0)
    if (!total) return null
    let r = this.env.random() * total
    for (const [id, c] of opts) {
      r -= c.variant ?? 0
      if (r <= 0) return id
    }
    return opts[opts.length - 1][0]
  }

  /**
   * Speed factor an action can run at given the room available (one play of each step),
   * or null if it can't fit even at MIN_SPEED. Non-moving actions always run at 1.
   */
  private speedFor(a: ActionDef): number | null {
    const facing = a.facing ?? this.facing
    let travel = 0
    for (const s of a.steps) travel += this.env.travel(s.clip)
    if (travel === 0) return 1
    const speed = Math.min(1, this.env.room(facing) / travel)
    return speed >= MIN_SPEED ? speed : null
  }

  private makeStep(def: StepDef, facing: Facing, speed = 1): RunStep {
    return { def, facing, playsLeft: null, until: null, started: false, stopped: false, speed }
  }

  private start(step: RunStep): Play {
    const r = step.def.repeat
    if (r?.seconds) step.until = this.env.now() + this.rand(r.seconds) * 1000
    if (r?.distance) {
      const per = this.env.travel(step.def.clip) * step.speed
      if (per > 0) {
        // fixed travel of the rest of the queue (e.g. walk_to_sit) must still fit
        const tail = this.queue.reduce((s, q) => s + this.env.travel(q.def.clip) * q.speed, 0)
        const fits = Math.floor((this.env.room(step.facing) - tail) / per)
        const want = Math.round(this.rand(r.distance) / per)
        step.playsLeft = Math.max(1, Math.min(want, fits))
      } else step.playsLeft = 1
    }
    step.started = true
    this.current = step
    return this.emit(step)
  }

  private emit(step: RunStep): Play {
    if (step.playsLeft !== null) step.playsLeft--
    this.facing = step.facing
    this.pose = this.m.clips[step.def.clip].to
    return { clip: step.def.clip, facing: step.facing, speed: step.speed }
  }

  private shouldRepeat(s: RunStep): boolean {
    if (this.isIdleStep(s)) return false // idle is re-planned every loop (variants, strolls)
    if (s.until !== null) return this.env.now() < s.until
    if (s.playsLeft !== null) return s.playsLeft > 0
    return false
  }

  private isIdleStep(s: RunStep): boolean {
    return s.def.clip === this.m.idle && !s.def.repeat
  }

  /** Shortest chain of clips that goes from pose a to pose b (BFS over transition clips). */
  private path(a: string, b: string): string[] | null {
    if (a === b) return []
    const prev = new Map<string, { pose: string; clip: string }>()
    const seen = new Set([a])
    const q = [a]
    while (q.length) {
      const p = q.shift()!
      for (const [id, c] of Object.entries(this.m.clips)) {
        if (c.from !== p || c.to === p || seen.has(c.to)) continue
        seen.add(c.to)
        prev.set(c.to, { pose: p, clip: id })
        if (c.to === b) {
          const out: string[] = []
          for (let x = b; x !== a; x = prev.get(x)!.pose) out.unshift(prev.get(x)!.clip)
          return out
        }
        q.push(c.to)
      }
    }
    return null
  }

  private schedule(r: Range, unitMs: number): number {
    return this.env.now() + this.rand(r) * unitMs
  }

  private rand([lo, hi]: Range): number {
    return lo + this.env.random() * (hi - lo)
  }
}

export { STOP_ID }
