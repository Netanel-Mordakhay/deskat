import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Brain, STOP_ID, type BrainEnv } from './brain.ts'
import type { CatManifest } from '../../../shared/types.ts'

const m: CatManifest = {
  id: 't', name: 'T', kind: 'pet', canvas: [720, 480], pawLine: 0.9, nativeFacing: 'left', idle: 'idle',
  clips: {
    idle: { file: 'idle.webm', from: 'sit', to: 'sit' },
    yawn: { file: 'yawn.webm', from: 'sit', to: 'sit', variant: 1 },
    pet: { file: 'pet.webm', from: 'sit', to: 'sit' },
    sit_to_lie: { file: 'a.webm', from: 'sit', to: 'lie' },
    lie_idle: { file: 'b.webm', from: 'lie', to: 'lie' },
    lie_to_sit: { file: 'c.webm', from: 'lie', to: 'sit' },
    sit_to_walk: { file: 'd.webm', from: 'sit', to: 'walk' },
    walk: { file: 'e.webm', from: 'walk', to: 'walk', move: { speed: 100 } },
    walk_to_sit: { file: 'f.webm', from: 'walk', to: 'sit' }
  },
  actions: {
    pet: { label: 'Pet', steps: [{ clip: 'pet' }] },
    lie: { label: 'Lie', steps: [{ clip: 'sit_to_lie' }, { clip: 'lie_idle', repeat: { seconds: [10, 10] }, stopLabel: 'Get up' }, { clip: 'lie_to_sit' }] },
    walkLeft: { label: 'Walk left', facing: 'left', stroll: true, steps: [{ clip: 'sit_to_walk' }, { clip: 'walk', repeat: { distance: [1000, 1000] } }, { clip: 'walk_to_sit' }] },
    walkRight: { label: 'Walk right', facing: 'right', stroll: true, steps: [{ clip: 'sit_to_walk' }, { clip: 'walk', repeat: { distance: [1000, 1000] } }, { clip: 'walk_to_sit' }] }
  }
}

function env(over: Partial<BrainEnv> = {}): BrainEnv & { t: number } {
  const e: BrainEnv & { t: number } = {
    t: 0,
    now: (): number => e.t,
    random: () => 0.5,
    room: () => 10_000,
    travel: (c: string) => (c === 'walk' ? 250 : 0),
    ...over
  }
  return e
}
const opts = { variantEverySec: [8, 8] as [number, number], strolls: false, strollEveryMin: [3, 3] as [number, number] }

test('idles, then plays a variant when due', () => {
  const e = env()
  const b = new Brain(m, e, opts)
  assert.equal(b.next().clip, 'idle')
  e.t = 9000
  assert.equal(b.next().clip, 'yawn')
  assert.equal(b.next().clip, 'idle')
})

test('lie action loops for its time, stop label ends it early', () => {
  const e = env()
  const b = new Brain(m, e, opts)
  b.next()
  assert.ok(b.request('lie'))
  assert.equal(b.next().clip, 'sit_to_lie')
  assert.equal(b.next().clip, 'lie_idle')
  assert.equal(b.next().clip, 'lie_idle')
  assert.deepEqual(b.menu()[0], { id: STOP_ID, label: 'Get up' })
  b.request(STOP_ID)
  assert.equal(b.next().clip, 'lie_to_sit')
  assert.equal(b.pose, 'sit')
  assert.equal(b.next().clip, 'idle')
})

test('walk repeats by distance, limited by room, and keeps facing', () => {
  const e = env({ room: (d) => (d === 'right' ? 600 : 0) })
  const b = new Brain(m, e, opts)
  b.next()
  assert.equal(b.request('walkLeft'), false, 'no room on the left')
  assert.ok(b.request('walkRight'))
  const seq = [b.next(), b.next(), b.next(), b.next()]
  assert.deepEqual(seq.map((p) => p.clip), ['sit_to_walk', 'walk', 'walk', 'walk_to_sit'])
  assert.ok(seq.every((p) => p.facing === 'right'))
  assert.equal(b.next().facing, 'right', 'stays facing right while idling')
})

test('menu lists every action even while busy, and greys out walks with no room', () => {
  const e = env({ room: () => 100 })
  const b = new Brain(m, e, opts)
  b.next()
  const menu = b.menu()
  assert.deepEqual(menu.map((i) => i.id), ['pet', 'lie', 'walkLeft', 'walkRight'])
  assert.deepEqual(menu.filter((i) => i.enabled === false).map((i) => i.id), ['walkLeft', 'walkRight'])
  assert.equal(b.request('walkLeft'), false)
  b.request('pet')
  b.next()
  assert.ok(b.busy)
  assert.deepEqual(b.menu().map((i) => i.id), ['pet', 'lie', 'walkLeft', 'walkRight'])
  b.request('lie')
  b.next() // sit_to_lie
  b.next() // lie_idle (has a stop label)
  assert.deepEqual(b.menu().map((i) => i.id), [STOP_ID, 'pet', 'lie', 'walkLeft', 'walkRight'])
})

test('request while lying routes through lie_to_sit, then runs the action', () => {
  const e = env()
  const b = new Brain(m, e, opts)
  b.next()
  b.request('lie')
  assert.equal(b.next().clip, 'sit_to_lie')
  assert.equal(b.next().clip, 'lie_idle')
  assert.ok(b.request('pet'), 'accepted while busy')
  assert.deepEqual([b.next().clip, b.next().clip, b.next().clip], ['lie_to_sit', 'pet', 'idle'])
})

test('request mid-walk replaces the walk and bridges via walk_to_sit', () => {
  const e = env()
  const b = new Brain(m, e, opts)
  b.next()
  b.request('walkLeft')
  b.next() // sit_to_walk
  assert.equal(b.next().clip, 'walk')
  assert.ok(b.request('pet'))
  assert.deepEqual([b.next().clip, b.next().clip], ['walk_to_sit', 'pet'])
})

test('interruptMode: blend for loops, rush for variants/transitions/one-offs, manifest override', () => {
  const e = env()
  const b = new Brain(m, e, opts)
  b.next()
  assert.equal(b.interruptMode(), 'blend', 'idle')
  e.t = 9000
  assert.equal(b.next().clip, 'yawn')
  assert.equal(b.interruptMode(), 'rush', 'variant')
  b.request('lie')
  assert.equal(b.next().clip, 'sit_to_lie')
  assert.equal(b.interruptMode(), 'rush', 'transition')
  assert.equal(b.next().clip, 'lie_idle')
  assert.equal(b.interruptMode(), 'blend', 'repeating step on one pose')
  b.request('pet')
  b.next() // lie_to_sit
  assert.equal(b.next().clip, 'pet')
  assert.equal(b.interruptMode(), 'rush', 'one-off action')

  const m2: CatManifest = { ...m, clips: { ...m.clips, pet: { ...m.clips.pet, interrupt: 'blend' } } }
  const b2 = new Brain(m2, env(), opts)
  b2.next()
  b2.request('pet')
  b2.next()
  assert.equal(b2.interruptMode(), 'blend', 'override')
})

test('walk slows down to fit tight space instead of being refused', () => {
  // one walk play travels 250px; 200px of room -> 0.8 speed (above MIN_SPEED)
  const e = env({ room: () => 200 })
  const b = new Brain(m, e, opts)
  b.next()
  assert.ok(b.request('walkLeft'))
  const seq = [b.next(), b.next(), b.next()]
  assert.deepEqual(seq.map((p) => p.clip), ['sit_to_walk', 'walk', 'walk_to_sit'])
  assert.ok(seq.every((p) => Math.abs(p.speed - 0.8) < 1e-9))
  assert.equal(b.next().speed, 1, 'back to normal speed when idle')
})

test('quiet: no random variants while focus mode is on, resumes after', () => {
  const e = env()
  const b = new Brain(m, e, opts)
  b.next()
  b.setOptions({ ...opts, quiet: true })
  e.t = 60_000
  assert.equal(b.next().clip, 'idle')
  assert.equal(b.next().clip, 'idle')
  b.setOptions({ ...opts, quiet: false })
  assert.equal(b.next().clip, 'yawn')
})

test('bridges poses automatically', () => {
  const e = env()
  const b = new Brain(m, e, opts)
  b.next()
  b.request('lie')
  b.next() // sit_to_lie, now pose=lie
  // force-clear the queue like an interrupted action: next() must walk home via lie_to_sit
  ;(b as unknown as { queue: unknown[] }).queue = []
  ;(b as unknown as { current: { stopped: boolean } }).current.stopped = true
  assert.equal(b.next().clip, 'lie_to_sit')
})
