import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../core/context.js'

const mk = async () => {
  const ctx = await buildContext({ ...process.env, ANTHROPIC_API_KEY: '' }, { dbPath: ':memory:' })
  const jess = ctx.people.create({ displayName: 'Jess' }), eileen = ctx.people.create({ displayName: 'Eileen' })
  for (const p of [jess, eileen]) ctx.people.update(p.id, { onboarding: { step: 'done' }, policy: { quietHours: { start: 99, end: 99 } } })
  ctx.people.setRel(jess.id, eileen.id, { wantMore: true }); ctx.people.setRel(eileen.id, jess.id, { wantMore: false })
  ctx.people.addPlace(eileen.id, { name: 'home', lat: 37.7745, lng: -122.4365 })
  return { ctx, jess, eileen }
}

test('nearby: location near a friend creates one opportunity per recipient, each judged once', async () => {
  const { ctx, jess, eileen } = await mk()
  await ctx.observations.ingest(eileen.id, 'manual', [{ kind: 'location', data: { lat: 37.7745, lng: -122.4365, placeName: 'Duboce Park' } }])
  await ctx.observations.ingest(jess.id, 'manual', [{ kind: 'location', data: { lat: 37.7738, lng: -122.4372 } }])
  const opps = ctx.db.all(`select * from opportunities where kind = 'nearby'`)
  assert.equal(opps.length, 2)
  const forJess = opps.find(o => o.primary_id === jess.id), forEileen = opps.find(o => o.primary_id === eileen.id)
  assert.match(forJess.summary, /^Jess and Eileen are \d+m apart right now \(Eileen is at Duboce Park\)\.$/, 'friend tier grants askWhereabouts, so Jess hears the place')
  assert.match(forEileen.summary, /^Eileen and Jess are \d+m apart right now \(Eileen is at Duboce Park\)\.$/, 'her own place is hers to see; Jess sent none')
  for (const o of opps) assert.equal(ctx.db.all(`select * from decisions where opportunity_id = ?`, o.id).length, 1)
})

test('nearby: the other person\'s place is withheld without askWhereabouts (summary and evidence)', async () => {
  const { ctx, jess, eileen } = await mk()
  ctx.people.setRel(eileen.id, jess.id, { tier: 'acquaintance' })   // Eileen does not let Jess ask whereabouts
  await ctx.observations.ingest(eileen.id, 'manual', [{ kind: 'location', data: { lat: 37.7745, lng: -122.4365, placeName: 'Duboce Park' } }])
  await ctx.observations.ingest(jess.id, 'manual', [{ kind: 'location', data: { lat: 37.7738, lng: -122.4372, placeName: 'Cafe' } }])
  const forJess = ctx.db.get(`select * from opportunities where kind = 'nearby' and primary_id = ?`, jess.id)
  assert.match(forJess.summary, /^Jess and Eileen are \d+m apart right now \(Jess is at Cafe\)\.$/)
  assert.ok(!forJess.summary.includes('Duboce'))
  assert.equal(JSON.parse(forJess.evidence).find(e => e.who === eileen.id).placeName, null)
  const forEileen = ctx.db.get(`select * from opportunities where kind = 'nearby' and primary_id = ?`, eileen.id)
  assert.match(forEileen.summary, /\(Jess is at Cafe\) \(Eileen is at Duboce Park\)\.$/, 'Jess (friend tier) grants it, so Eileen hears Jess\'s place')
})

test('nearby: dedupes within the hour', async () => {
  const { ctx, jess, eileen } = await mk()
  await ctx.observations.ingest(eileen.id, 'manual', [{ kind: 'location', data: { lat: 37.7745, lng: -122.4365, placeName: 'Duboce Park' } }])
  await ctx.observations.ingest(jess.id, 'manual', [{ kind: 'location', data: { lat: 37.7738, lng: -122.4372 } }, { kind: 'location', data: { lat: 37.7739, lng: -122.4371 } }])
  assert.equal(ctx.db.all(`select * from opportunities where kind = 'nearby'`).length, 2, 'one per recipient, not per fix')
})

test('coAttendance: same url on two calendars', async () => {
  const { ctx, jess, eileen } = await mk()
  const at = new Date(Date.now() + 2 * 864e5).toISOString()
  await ctx.observations.ingest(eileen.id, 'ics', [{ kind: 'event', at, dedupeKey: 'a', data: { title: 'Party', url: 'https://partiful.com/e/x' } }])
  await ctx.observations.ingest(jess.id, 'ics', [{ kind: 'event', at, dedupeKey: 'b', data: { title: 'Party', url: 'https://partiful.com/e/x' } }])
  const opp = ctx.db.get(`select * from opportunities where kind = 'coAttendance'`)
  assert.ok(opp); assert.equal(opp.primary_id, null, 'both on the system: tell both, the Judge decides each')
  await new Promise(r => setTimeout(r, 20))
  assert.equal(ctx.db.all(`select * from decisions where opportunity_id = ?`, opp.id).length, 2)
})

test('judge gate: no wantMore either side → suppress, logged', async () => {
  const { ctx, jess, eileen } = await mk()
  ctx.people.setRel(jess.id, eileen.id, { wantMore: false })
  await ctx.observations.ingest(eileen.id, 'manual', [{ kind: 'location', data: { lat: 37.7745, lng: -122.4365, placeName: 'Duboce Park' } }])
  await ctx.observations.ingest(jess.id, 'manual', [{ kind: 'location', data: { lat: 37.7738, lng: -122.4372 } }])
  const d = ctx.db.get(`select * from decisions`)
  assert.equal(d.verdict, 'suppress'); assert.match(d.reasoning, /wantMore for (Jess|Eileen)$/, 'names, not ids')
  assert.ok(!d.reasoning.includes(jess.id) && !d.reasoning.includes(eileen.id))
})

test('query: availability respects grants and rate limit; plans needs trusted', async () => {
  const { ctx, jess, eileen } = await mk()
  ctx.sources.connect(eileen.id, 'icsCalendar', { urls: [] })
  const a = await ctx.query.ask({ from: jess.id, to: eileen.id, kind: 'availability', text: 'free tonight?' })
  assert.ok(['likely', 'unlikely'].includes(a.answer))
  const p = await ctx.query.ask({ from: jess.id, to: eileen.id, kind: 'plans', text: 'what are you up to?' })
  assert.equal(p.answer, 'no'); assert.equal(p.reason, 'not permitted')
  ctx.people.setRel(eileen.id, jess.id, { tier: 'trusted' })
  const p2 = await ctx.query.ask({ from: jess.id, to: eileen.id, kind: 'plans' })
  assert.ok(p2.revealed)
  for (let i = 0; i < 6; i++) await ctx.query.ask({ from: jess.id, to: eileen.id, kind: 'availability' })
  const rl = await ctx.query.ask({ from: jess.id, to: eileen.id, kind: 'availability' })
  assert.match(rl.reason, /rate limited/)
})

test('invite: one-time, creates both edges with wantMore on inviter side', async () => {
  const { ctx, jess } = await mk()
  const { code } = ctx.people.invite(jess.id, { inviteeName: 'Sam' })
  const sam = ctx.people.create({ displayName: 'Sam' })
  assert.equal(ctx.people.acceptInvite(code, sam.id).id, jess.id)
  assert.equal(ctx.people.rel(jess.id, sam.id).want_more, 1)
  assert.equal(ctx.people.rel(sam.id, jess.id).want_more, 0)
  assert.equal(ctx.people.acceptInvite(code, sam.id), null)
})
