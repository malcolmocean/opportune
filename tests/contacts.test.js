import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../core/context.js'

test('contact joins → opportunity for the owner', async () => {
  const ctx = await buildContext({ ...process.env, ANTHROPIC_API_KEY: '' }, { dbPath: ':memory:' })
  const mal = ctx.people.create({ displayName: 'Malcolm' })
  ctx.people.update(mal.id, { onboarding: { step: 'done' } })
  assert.equal(ctx.people.addContacts(mal.id, [{ name: 'Eileen K', emails: ['Eileen@Example.com'], phones: ['(415) 555-0100'] }]), 2)
  assert.equal(ctx.people.contactName(mal.id, { email: 'eileen@example.com' }), 'Eileen K')
  const eileen = ctx.people.create({ displayName: 'Eileen' })
  ctx.people.bind(eileen.id, 'email', 'eileen@example.com')
  await new Promise(r => setTimeout(r, 50))
  const opp = ctx.db.get(`select * from opportunities where kind = 'contactJoined'`)
  assert.ok(opp, 'opportunity created')
  assert.equal(opp.primary_id, mal.id)
  const d = ctx.db.get(`select * from decisions where opportunity_id = ?`, opp.id)
  assert.equal(d.verdict, 'nudge')
})
