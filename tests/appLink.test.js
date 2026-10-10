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
})
