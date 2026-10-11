import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../core/context.js'
import { handleAppPayload } from '../channels/fcm/index.js'

test('link code claims a source config once; app payload sets home and timed porchlight', async () => {
  const ctx = await buildContext({ ...process.env, ANTHROPIC_API_KEY: '' }, { dbPath: ':memory:' })
  const p = ctx.people.create({ displayName: 'Mal' })
  const sc = ctx.sources.connect(p.id, 'opportuneApp', {})
  const code = ctx.sources.linkCode(sc)
  assert.match(code, /^[A-Z0-9]{6}$/)
  const rec = ctx.db.kvGet(`applink:${code}`)
  assert.equal(rec.id, sc.id)
  const obs = await handleAppPayload(ctx, p, { home: { lat: 37.77, lng: -122.43 }, status: { porchlight: 'open', hours: 2 } })
  assert.ok(ctx.people.home(p.id))
  assert.equal(obs[0].data.porchlight, 'open')
  const mins = (new Date(obs[0].until) - Date.now()) / 60000
  assert.ok(mins > 118 && mins <= 120, `until ≈ 2h, got ${mins}`)
  // closed and ask are modes: no duration means no end
  const closed = await handleAppPayload(ctx, p, { status: { porchlight: 'closed' } })
  assert.equal(closed[0].until, null)
  const ask = await handleAppPayload(ctx, p, { status: { porchlight: 'ask' } })
  assert.equal(ask[0].until, null)
  // 'morning' ends at the next quiet-hours end in the person's tz (default 8:00)
  ctx.people.update(p.id, { tz: 'America/Toronto', policy: { ...ctx.people.policy(p.id), quietHours: { start: 23, end: 7 } } })
  const night = await handleAppPayload(ctx, p, { status: { porchlight: 'closed', until: 'morning' } })
  const end = new Date(night[0].until)
  assert.ok(end > new Date() && end - new Date() <= 24 * 3600e3, 'within the next day')
  assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }).format(end) % 24, 7)
  await ctx.observations.ingest(p.id, 'test', night)
  const light = (await import('../queries/dropin/porchlight.js')).porchlight(ctx, ctx.people.get(p.id))
  assert.equal(light.state, 'closed'); assert.equal(light.then, 'ask')
})
