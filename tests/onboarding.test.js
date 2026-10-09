import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../core/context.js'
import { inferHomes } from '../core/cron.js'

test('inferHomes: median overnight fixes become home; scattered sleepers are skipped', async () => {
  const ctx = await buildContext({ ...process.env, ANTHROPIC_API_KEY: '' }, { dbPath: ':memory:' })
  const p = ctx.people.create({ displayName: 'Night' }); ctx.people.update(p.id, { onboarding: { step: 'done' } })
  const q = ctx.people.create({ displayName: 'Nomad' }); ctx.people.update(q.id, { onboarding: { step: 'done' } })
  const at = (d, h) => { const t = new Date(); t.setDate(t.getDate() - d); return new Date(`${t.toISOString().slice(0, 10)}T${String(h).padStart(2, '0')}:30:00-07:00`).toISOString() }
  const obs = []
  for (let d = 1; d <= 7; d++) { obs.push({ kind: 'location', at: at(d, 3), data: { lat: 37.77 + d * 0.0001, lng: -122.43 } }); obs.push({ kind: 'location', at: at(d, 14), data: { lat: 37.9, lng: -122.3 } }) }
  await ctx.observations.ingest(p.id, 'test', obs)
  await ctx.observations.ingest(q.id, 'test', [1, 2, 3, 4, 5, 6].map(d => ({ kind: 'location', at: at(d, 3), data: { lat: 37 + d * 0.5, lng: -122 } })))
  assert.equal(inferHomes(ctx), 1)
  const home = ctx.people.home(p.id)
  assert.ok(home); assert.ok(Math.abs(home.lat - 37.7704) < 0.001)
  assert.equal(ctx.people.home(q.id), null)
})
