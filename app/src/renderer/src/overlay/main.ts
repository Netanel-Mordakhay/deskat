import type { CatManifest, ClipDef, DeskatApi, Facing, Room, Settings } from '../../../shared/types'
import { Brain, type Play } from '../engine/brain'
import { ClipPlayer, probeDuration, type Transition } from './player'

declare global {
  interface Window {
    deskat: DeskatApi
  }
}
const api = window.deskat

/** A rushed clip is sped up to reach its end pose in about this long. */
const RUSH_SEC = 0.6

async function start(): Promise<void> {
  const { settings: initial, manifest: m, assetBase } = await api.getInit()
  let settings: Settings = initial
  const url = (clip: string): string => assetBase + m.clips[clip].file

  const durations: Record<string, number> = {}
  await Promise.all(Object.keys(m.clips).map(async (c) => (durations[c] = await probeDuration(url(c)))))

  /** canvas px -> screen px */
  const scale = (): number => window.innerHeight / m.canvas[1]
  const moveSpan = (c: ClipDef, dur: number): number =>
    c.move ? Math.max(0, Math.min(c.move.toSec ?? dur, dur) - (c.move.fromSec ?? 0)) : 0
  const travel = (clip: string): number => {
    const c = m.clips[clip]
    return c.move ? c.move.speed * scale() * moveSpan(c, durations[clip]) : 0
  }

  let room: Room = await api.getRoom()
  const brainOpts = (s: Settings) => ({
    variantEverySec: s.variantEverySec,
    strolls: s.strolls,
    strollEveryMin: s.strollEveryMin
  })
  const brain = new Brain(
    m,
    { now: () => performance.now(), random: Math.random, room: (d: Facing) => room[d], travel },
    brainOpts(settings)
  )
  let quiet = false
  api.onSettingsChanged((s) => {
    settings = s
    brain.setOptions({ ...brainOpts(s), quiet })
  })
  api.onQuiet((q) => {
    quiet = q
    brain.setOptions({ ...brainOpts(settings), quiet })
  })

  const player = new ClipPlayer(
    document.getElementById('cat')!,
    Object.keys(m.clips).map((c) => url(c))
  )
  let playing: Play = { clip: m.idle, facing: m.nativeFacing, speed: 1 }

  // One advance at a time. `picked` = this advance already asked the brain for its clip, so
  // an action that arrives now must interrupt that clip once it has started.
  let advancing = false
  let picked = false
  let reinterrupt = false
  async function advance(transition: Transition = 'cut'): Promise<void> {
    if (advancing) return
    advancing = true
    picked = false
    try {
      const wasMoving = !!m.clips[playing.clip].move
      room = await api.getRoom()
      playing = brain.next()
      picked = true
      console.log(`${(performance.now()/1000).toFixed(2)}s play ${playing.clip} (${transition}) facing=${playing.facing} speed=${playing.speed.toFixed(2)} pose=${brain.pose} room=${Math.round(room.left)}/${Math.round(room.right)}`)
      await player.play(url(playing.clip), { mirrored: playing.facing !== m.nativeFacing, transition })
      if (wasMoving && !m.clips[playing.clip].move) api.moved()
    } finally {
      advancing = false
    }
    if (reinterrupt) {
      reinterrupt = false
      interrupt()
    }
  }
  player.onEnded(() => void advance())

  /** Make a just-accepted action start now: cross-fade out of calm loops, fast-forward the rest. */
  function interrupt(): void {
    if (advancing) {
      if (picked) reinterrupt = true // else the pending brain.next() already sees the request
      return
    }
    const mode = brain.interruptMode()
    if (mode === 'blend') {
      void advance('blend')
      return
    }
    const v = player.current
    const remaining = Math.max(0, (v.duration || 0) - v.currentTime)
    v.playbackRate = Math.min(4, Math.max(1, remaining / RUSH_SEC))
    console.log(`${(performance.now()/1000).toFixed(2)}s rush ${playing.clip} remaining=${remaining.toFixed(2)}s rate=${v.playbackRate.toFixed(2)}`)
  }

  // walking: slide the window while a moving clip plays
  let last = performance.now()
  let carry = 0
  const tick = (now: number): void => {
    const dt = (now - last) / 1000
    last = now
    const c = m.clips[playing.clip]
    const v = player.current
    if (c.move && !v.paused && dt < 0.25) {
      const t = v.currentTime
      if (t >= (c.move.fromSec ?? 0) && t <= (c.move.toSec ?? Infinity)) {
        carry += c.move.speed * playing.speed * v.playbackRate * scale() * dt * (playing.facing === 'left' ? -1 : 1)
        const step = Math.trunc(carry)
        if (step) {
          api.moveBy(step)
          carry -= step
        }
      }
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  setupPointer(player, brain, () => room, async () => (room = await api.getRoom()))
  api.onMenuAction(async (id) => {
    room = await api.getRoom()
    const busy = brain.busy
    const ok = brain.request(id)
    console.log(`${(performance.now()/1000).toFixed(2)}s action ${id} -> ${ok ? 'accepted' : 'refused'} (busy=${busy} mode=${brain.interruptMode()} cur=${playing.clip} t=${player.current.currentTime.toFixed(2)}/${player.current.duration.toFixed(2)})`)
    if (ok) interrupt()
  })

  playing = brain.next()
  await player.play(url(playing.clip), { mirrored: playing.facing !== m.nativeFacing })
}

// ---------------------------------------------------------------- pointer: hit-test, click, drag

function setupPointer(
  player: ClipPlayer,
  brain: Brain,
  _room: () => Room,
  refreshRoom: () => Promise<Room>
): void {
  const probe = document.createElement('canvas')
  const ctx = probe.getContext('2d', { willReadFrequently: true })!
  let over = false
  let down: { x: number; moved: boolean } | null = null

  const hit = (cx: number, cy: number): boolean => {
    const v = player.current
    if (!v.videoWidth) return false
    const w = (probe.width = 96)
    const h = (probe.height = Math.round((96 * v.videoHeight) / v.videoWidth))
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(v, 0, 0, w, h)
    let x = (cx / window.innerWidth) * w
    if (player.mirrored) x = w - x
    const y = (cy / window.innerHeight) * h
    return ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] > 40
  }

  const setOver = (o: boolean): void => {
    if (o === over) return
    over = o
    document.body.classList.toggle('over', o)
    api.setClickThrough(!o)
  }

  window.addEventListener('mousemove', (e) => {
    if (down) {
      const dx = e.screenX - down.x
      if (Math.abs(dx) > 4 || down.moved) {
        down.moved = true
        if (dx) api.moveBy(dx)
        down.x = e.screenX
      }
      return
    }
    setOver(hit(e.clientX, e.clientY))
  })
  window.addEventListener('mouseleave', () => {
    if (!down) setOver(false)
  })
  window.addEventListener('mousedown', (e) => {
    if (e.button === 0 && over) down = { x: e.screenX, moved: false }
  })
  window.addEventListener('mouseup', async () => {
    const d = down
    down = null
    if (!d) return
    if (d.moved) return api.moved()
    await refreshRoom()
    api.showMenu(brain.menu())
  })
  window.addEventListener('contextmenu', async (e) => {
    e.preventDefault()
    if (!over) return
    await refreshRoom()
    api.showMenu(brain.menu())
  })
}

start().catch((e) => {
  console.error(e)
  document.body.textContent = String(e)
})

export type { CatManifest }
