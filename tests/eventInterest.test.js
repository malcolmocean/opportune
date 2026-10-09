import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../core/context.js'

// No ANTHROPIC_API_KEY → Judge passes everything through, so we can assert on nudges rows.
const env = { ...process.env, ANTHROPIC_API_KEY: '' }
const d = (days, hour = 20) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + days); t.setUTCHours(hour, 0, 0, 0); return t }
const ev = (title, start, hours = 3, extra = {}) => ({ kind: 'event', at: start.toISOString(), until: new Date(start.getTime() + hours * 3600e3).toISOString(), dedupeKey: `${title}@${start.toISOString()}`, data: { title, provider: 'test', ...extra } })
const settle = async ctx => { for (let i = 0; i < 100; i++) { if (!ctx.db.get(`select 1 from opportunities where status = 'pending'`)) return; await new Promise(r => setTimeout(r, 5)) } }
const noLlm = ctx => new Proxy({}, { get(_, k) { if (k === 'enabled') return false; throw new Error(`trigger touched ctx.llm.${String(k)}`) } })

async function setup() {
  const ctx = await buildContext(env, { dbPath: ':memory:' })
  const jess = ctx.people.create({ displayName: 'Jess' })
  const eileen = ctx.people.create({ displayName: 'Eileen' })
  for (const p of [jess, eileen]) ctx.people.update(p.id, { policy: { quietHours: null } })   // tests run at any hour
  ctx.people.setRel(jess.id, eileen.id, { wantMore: true })
  ctx.people.setRel(eileen.id, jess.id, { wantMore: false })
  return { ctx, jess, eileen, trigger: ctx.plugins.triggers.eventInterest }
}

test('eventInterest plugin loads with cron manifest', async () => {
  const { trigger } = await setup()
  assert.ok(trigger, 'triggers/eventInterest discovered by loader')
  assert.equal(trigger.intervalMin, 360)
  assert.equal(typeof trigger.runCron, 'function')
  assert.equal(trigger.on, undefined)
})

test('emits when a friend\'s calendar history shares words with my upcoming event', async () => {
  const { ctx, jess, eileen, trigger } = await setup()
  const show = d(5)
  await ctx.observations.ingest(jess.id, 'test', [
    ev('Vulfpeck at the Fillmore', show, 3, { location: 'The Fillmore, 1805 Geary Blvd, San Francisco, CA', url: 'https://example.com/vulf' }),
    ev('Team standup', d(2, 17), 1),                    // noise title
    ev('Coffee w/ Sam', d(3, 16), 0.5),                 // too short
    ev('Dentist', d(4, 15), 1),                         // noise title
  ])
  await ctx.observations.ingest(eileen.id, 'test', [
    ev('Cory Wong at the Fillmore', d(-40)),
    ev('Lettuce at the Fillmore', d(-90)),
    ev('Vulfpeck live in Oakland', d(-300)),            // outside 180-day window
    ev('Weekly sync', d(-3, 17), 1),
  ])
  ctx.llm = noLlm(ctx)
  const opps = trigger.runCron(ctx)
  ctx.llm = { enabled: false }
  assert.equal(opps.length, 1)
  const o = opps[0]
  assert.equal(o.kind, 'eventInterest')
  assert.deepEqual(o.participants, [jess.id, eileen.id])
  assert.equal(o.primary, jess.id)
  assert.equal(o.dedupeKey, `evint:${jess.id}:${eileen.id}:https://example.com/vulf`)
  assert.equal(o.expiresAt, show.toISOString())
  assert.ok(o.evidence.overlappingTokens.includes('fillmore'))
  assert.ok(!o.evidence.overlappingTokens.includes('vulfpeck'), 'old event outside window must not count')
  assert.ok(!o.evidence.overlappingTokens.includes('san'), 'address boilerplate is stopworded')
  assert.deepEqual(o.evidence.fPastEventTitles.sort(), ['Cory Wong at the Fillmore', 'Lettuce at the Fillmore'])
  assert.equal(o.evidence.event.title, 'Vulfpeck at the Fillmore')
  assert.match(o.summary, /Jess is going to "Vulfpeck at the Fillmore"/)
  assert.match(o.summary, /Eileen's calendar has had 2 events/)
  assert.match(o.summary, /worth inviting Eileen\?/)

  // through the pipeline: opportunity row + pass-through nudge to Jess only
  for (const x of opps) await ctx.opportunities.add(trigger.id, x)
  await settle(ctx)
  const rows = ctx.db.all(`select * from opportunities where kind = 'eventInterest'`)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'judged')
  const nudges = ctx.db.all(`select * from nudges`)
  assert.equal(nudges.length, 1)
  assert.equal(nudges[0].person_id, jess.id)
  // second run is a no-op thanks to dedupeKey
  const again = trigger.runCron(ctx)
  assert.equal(again.length, 1)
  assert.equal(await ctx.opportunities.add(trigger.id, again[0]), null)
  assert.equal(ctx.db.all(`select * from opportunities where kind = 'eventInterest'`).length, 1)
})

test('a stated intent sharing a token is worth +1 on its own', async () => {
  const { ctx, jess, eileen, trigger } = await setup()
  await ctx.observations.ingest(jess.id, 'test', [ev('Funk night at Bottom of the Hill', d(6))])
  await ctx.observations.ingest(eileen.id, 'test', [{ kind: 'intent', data: { text: 'want to catch more funk shows this fall', kind: 'attend' } }])
  const opps = trigger.runCron(ctx)
  assert.equal(opps.length, 1)
  assert.equal(opps[0].evidence.score, 1)
  assert.equal(opps[0].evidence.fIntent, 'want to catch more funk shows this fall')
  assert.deepEqual(opps[0].evidence.fPastEventTitles, [])
  assert.match(opps[0].summary, /Eileen said "want to catch more funk shows this fall"/)
})

test('skips friends already going, friends without wantMore either way, and caps at 3 per person', async () => {
  const { ctx, jess, eileen, trigger } = await setup()
  const bob = ctx.people.create({ displayName: 'Bob' })
  ctx.people.setRel(jess.id, bob.id, { wantMore: false })
  ctx.people.setRel(bob.id, jess.id, { wantMore: false })
  const shared = d(2)
  await ctx.observations.ingest(jess.id, 'test', [
    ev('Climbing at Mission Cliffs', shared, 2, { url: 'https://example.com/climb' }),
    ev('Bouldering comp', d(3)), ev('Climbing film night', d(4)), ev('Bouldering social', d(5)), ev('Climbing gym opening', d(6)),
  ])
  await ctx.observations.ingest(eileen.id, 'test', [
    ev('Climbing at Mission Cliffs', shared, 2, { url: 'https://example.com/climb' }),   // same event → coAttendance's territory
    ev('Climbing', d(-10)), ev('Bouldering', d(-20)),
  ])
  await ctx.observations.ingest(bob.id, 'test', [ev('Climbing', d(-10)), ev('Bouldering', d(-20))])
  const opps = trigger.runCron(ctx).filter(o => o.participants[0] === jess.id)
  assert.equal(opps.length, 3, 'at most 3 per person')
  assert.ok(opps.every(o => o.participants[1] === eileen.id), 'Bob has no wantMore on either side')
  assert.ok(!opps.some(o => o.evidence.event.url === 'https://example.com/climb'), 'friend already has that event')
})

test('ignores events further out than 14 days and tokens the friend has on nearly everything', async () => {
  const { ctx, jess, eileen, trigger } = await setup()
  await ctx.observations.ingest(jess.id, 'test', [ev('Zoom book club', d(20)), ev('Zoom poetry reading', d(3))])
  await ctx.observations.ingest(eileen.id, 'test', [1, 2, 3, 4, 5, 6].map(i => ev(`Zoom therapy ${i}`, d(-i * 7))))
  assert.equal(trigger.runCron(ctx).length, 0)
})
