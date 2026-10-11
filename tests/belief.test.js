// core/belief: the facts the home screen shows with "wrong" buttons, and corrections as observations.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../core/context.js'
import { belief, correct } from '../core/belief.js'
import { porchlight } from '../queries/dropin/porchlight.js'

const HOME = { lat: 37.7745, lng: -122.4365 }
const env = { ...process.env, ANTHROPIC_API_KEY: '', FIREBASE_SERVICE_ACCOUNT_JSON: '' }
const fact = (b, key) => b.facts.find(f => f.key === key)

test('belief: nothing known yet names what is missing, not a guess', async () => {
  const ctx = await buildContext(env, { dbPath: ':memory:' })
  const p = ctx.people.create({ displayName: 'Eileen' })
  const b = belief(ctx, ctx.people.get(p.id))
  assert.deepEqual(b.facts.map(f => f.key), ['where', 'moving', 'porchlight', 'calendar'])
  assert.equal(fact(b, 'where').value, 'no home set')
  assert.match(fact(b, 'where').basis, /no location/)
  assert.equal(fact(b, 'moving').value, 'unknown')
  assert.equal(fact(b, 'porchlight').value, 'ask')
  assert.match(fact(b, 'porchlight').basis, /default/)
  assert.equal(fact(b, 'calendar').value, 'no calendar connected')
})

test('belief: home from a fresh fix, walking from activity, porchlight from a status with its end time, calendar from events', async () => {
  const ctx = await buildContext(env, { dbPath: ':memory:' })
  const p = ctx.people.create({ displayName: 'Eileen', tz: 'America/Los_Angeles' })
  ctx.people.addPlace(p.id, { name: 'home', ...HOME, radiusM: 120 })
  await ctx.observations.ingest(p.id, 'test', [
    { kind: 'location', data: { ...HOME, placeName: 'home', speed: 0 } },
    { kind: 'motion', data: { state: 'walking' } },
    { kind: 'status', data: { porchlight: 'open' }, until: new Date(Date.now() + 2 * 3600e3).toISOString() },
  ])
  ctx.sources.connect(p.id, 'icsCalendar', { urls: ['https://example.test/cal.ics'] })
  const start = new Date(Date.now() + 3 * 3600e3).toISOString(), end = new Date(Date.now() + 4 * 3600e3).toISOString()
  await ctx.observations.ingest(p.id, 'icsCalendar', [{ kind: 'event', at: start, until: end, data: { title: 'Board games' }, dedupeKey: 'e1' }])
  const b = belief(ctx, ctx.people.get(p.id))
  assert.equal(fact(b, 'where').value, 'home')
  assert.match(fact(b, 'where').basis, /phone fix just now, near home/)
  assert.equal(fact(b, 'moving').value, 'walking')
  assert.equal(fact(b, 'porchlight').value, 'open')
  assert.match(fact(b, 'porchlight').basis, /you set it until \d.*, then ask/)
  assert.match(fact(b, 'calendar').value, /^free until Board games at \d/)
  assert.doesNotMatch(JSON.stringify(b), /37\.77|-122\.4/, 'no coordinates in the belief')
})

test('belief: a stale fix is said to be stale; during an event the calendar fact says so', async () => {
  const ctx = await buildContext(env, { dbPath: ':memory:' })
  const p = ctx.people.create({ displayName: 'Eileen' })
  ctx.people.addPlace(p.id, { name: 'home', ...HOME, radiusM: 120 })
  await ctx.observations.ingest(p.id, 'test', [{ kind: 'location', at: new Date(Date.now() - 3 * 3600e3).toISOString(), data: { ...HOME } }])
  ctx.sources.connect(p.id, 'icsCalendar', { urls: ['https://example.test/cal.ics'] })
  await ctx.observations.ingest(p.id, 'icsCalendar', [{ kind: 'event', at: new Date(Date.now() - 600e3).toISOString(), until: new Date(Date.now() + 1800e3).toISOString(), data: { title: 'Dinner at Nopa' }, dedupeKey: 'e2' }])
  const b = belief(ctx, ctx.people.get(p.id))
  assert.equal(fact(b, 'where').value, 'unknown')
  assert.match(fact(b, 'where').basis, /last fix 3h ago, too old/)
  assert.match(fact(b, 'calendar').value, /^at Dinner at Nopa until \d/)
})

test('corrections: stored as observations with the believed value and the free-text fix', async () => {
  const ctx = await buildContext(env, { dbPath: ':memory:' })
  const p = ctx.people.create({ displayName: 'Eileen' })
  const row = await correct(ctx, ctx.people.get(p.id), { key: 'where', believed: 'out', actually: 'I am home, phone was off' })
  assert.equal(row.kind, 'correction')
  const [r] = ctx.observations.recent(p.id, { kinds: ['correction'] })
  assert.deepEqual(r.data, { key: 'where', believed: 'out', actually: 'I am home, phone was off' })
})

test('default note never shows under a closed porchlight; a status note still does', async () => {
  const ctx = await buildContext(env, { dbPath: ':memory:' })
  const p = ctx.people.create({ displayName: 'Eileen' })
  ctx.people.setProfile(p.id, { dropinNote: 'come by the back' })
  await ctx.observations.ingest(p.id, 'test', [{ kind: 'status', data: { porchlight: 'closed' }, until: new Date(Date.now() + 3600e3).toISOString() }])
  assert.equal(porchlight(ctx, ctx.people.get(p.id)).note, undefined)
  await ctx.observations.ingest(p.id, 'test', [{ kind: 'status', data: { porchlight: 'closed', note: 'back at 9' }, until: new Date(Date.now() + 3600e3).toISOString() }])
  assert.equal(porchlight(ctx, ctx.people.get(p.id)).note, 'back at 9')
})
