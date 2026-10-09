// The whole chain, no LLM: Jess at Grocery Outlet → porchlightProximity → Judge asks Eileen's agent (dropin)
// → Eileen's porchlight is 'ask' → veto nudge to Eileen, 'likely' back → nudge to Jess. Then Eileen vetoes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../core/context.js'

test('grocery outlet chain with veto', async () => {
  const ctx = await buildContext({ ...process.env, ANTHROPIC_API_KEY: '', JUDGE_STUB: 'ask' }, { dbPath: ':memory:' })
  const jess = ctx.people.create({ displayName: 'Jess' }), eileen = ctx.people.create({ displayName: 'Eileen' })
  for (const p of [jess, eileen]) ctx.people.update(p.id, { onboarding: { step: 'done' }, policy: { quietHours: { start: 99, end: 99 }, dropinDefault: 'ask' } })
  ctx.people.setRel(jess.id, eileen.id, { wantMore: true }); ctx.people.setRel(eileen.id, jess.id, { wantMore: true })
  ctx.people.addPlace(eileen.id, { name: 'home', lat: 37.7745, lng: -122.4365 })
  ctx.sources.connect(eileen.id, 'locationPost', {})
  await ctx.observations.ingest(eileen.id, 'manual', [{ kind: 'location', data: { lat: 37.7745, lng: -122.4365, placeName: 'home' } }])
  await ctx.observations.ingest(jess.id, 'manual', [{ kind: 'location', data: { lat: 37.7738, lng: -122.4372, placeName: 'Grocery Outlet' } }])
  await new Promise(r => setTimeout(r, 100))
  const opp = ctx.db.get(`select * from opportunities where kind = 'dropin'`)
  assert.ok(opp, 'dropin opportunity')
  assert.equal(ctx.db.all(`select * from opportunities where kind = 'nearby'`).length, 0, 'nearby defers to porchlight')
  const ds = ctx.db.all(`select * from decisions where opportunity_id = ? order by created_at`, opp.id)
  assert.deepEqual(ds.map(d => d.verdict), ['ask', 'nudge'])
  const toEileen = ctx.db.get(`select * from nudges where person_id = ?`, eileen.id)
  assert.match(toEileen.text, /Jess is a block away/)
  const toJess = ctx.db.get(`select * from nudges where person_id = ? and decision_id is not null`, jess.id)
  assert.match(toJess.text, /Eileen is home/)
  await ctx.nudges.respond(toEileen.id, 'veto')
  await new Promise(r => setTimeout(r, 50))
  const again = await ctx.query.ask({ from: jess.id, to: eileen.id, kind: 'dropin', text: 'ok now?' })
  assert.equal(again.answer, 'no')
  assert.ok(ctx.db.get(`select * from nudges where person_id = ? and text like '%not up for it%'`, jess.id), 'Jess told')
})
