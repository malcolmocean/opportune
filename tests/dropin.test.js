// triggers/porchlightProximity + queries/dropin, the Grocery Outlet story.
// Runs with the Judge in pass-through mode (no ANTHROPIC_API_KEY), so every opportunity becomes a nudge.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../core/context.js'
import { porchlight, localNow } from '../queries/dropin/porchlight.js'

const HOME = { lat: 37.7745, lng: -122.4365 }            // Eileen's
const GO = { lat: 37.7738, lng: -122.4372 }              // Grocery Outlet, ~100m away
const FAR = { lat: 37.80, lng: -122.40 }                 // Jess's home, across town
const env = { ...process.env, ANTHROPIC_API_KEY: '' }

async function setup({ tier = 'friend', grants = {} } = {}) {
  const ctx = await buildContext(env, { dbPath: ':memory:' })
  const jess = ctx.people.create({ displayName: 'Jess' })
  const eileen = ctx.people.create({ displayName: 'Eileen' })
  ctx.people.setRel(jess.id, eileen.id, { tier, wantMore: true })
  ctx.people.setRel(eileen.id, jess.id, { tier, wantMore: true, grants })
  ctx.people.addPlace(eileen.id, { name: 'home', ...HOME, radiusM: 120 })
  ctx.people.addPlace(jess.id, { name: 'home', ...FAR, radiusM: 120 })
  ctx.sources.connect(eileen.id, 'locationPost', { app: 'OwnTracks' })
  const obs = (p, o) => ctx.observations.ingest(p.id, 'test', [o])
  const eileenHome = () => obs(eileen, { kind: 'location', data: { ...HOME, placeName: 'home' } })
  const jessAtGO = () => obs(jess, { kind: 'location', data: { ...GO, placeName: 'Grocery Outlet' } })
  const status = (p, porchlightState, hours = 4) => obs(p, { kind: 'status', until: new Date(Date.now() + hours * 3600e3).toISOString(), data: { porchlight: porchlightState } })
  const ask = () => ctx.query.ask({ from: jess.id, to: eileen.id, kind: 'dropin', text: 'Jess is a block away, ok to drop by?' })
  return { ctx, jess, eileen, obs, eileenHome, jessAtGO, status, ask }
}

// Opportunities are judged on an un-awaited queue; wait for it to empty.
async function settle(ctx) {
  for (let i = 0; i < 200; i++) {
    if (!ctx.db.get(`select 1 from opportunities where status = 'pending'`)) return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('opportunities never settled')
}
const opps = ctx => ctx.db.all(`select * from opportunities where kind = 'dropin'`).map(r => ({ ...r, participants: JSON.parse(r.participants), evidence: JSON.parse(r.evidence) }))
const nudgesFor = (ctx, p) => ctx.db.all('select * from nudges where person_id = ? order by created_at', p.id)

// ---- trigger ----

test('location: Jess at GO, Eileen home with porchlight open → dropin opportunity for Jess', async () => {
  const { ctx, jess, eileen, eileenHome, jessAtGO, status } = await setup()
  await eileenHome()
  await status(eileen, 'open')
  await jessAtGO()
  await settle(ctx)
  const [o, ...rest] = opps(ctx)
  assert.ok(o, 'one dropin opportunity')
  assert.equal(rest.length, 0)
  assert.equal(o.trigger_id, 'porchlightProximity')
  assert.equal(o.primary_id, jess.id)
  assert.deepEqual(o.participants, [jess.id, eileen.id])
  assert.match(o.summary, /^Jess is \d+m from Eileen's place \(at Grocery Outlet\) and Eileen is home\./)
  assert.match(o.summary, /porchlight is open/)
  const light = o.evidence.find(e => e.kind === 'porchlight')
  assert.deepEqual({ state: light.state, source: light.source }, { state: 'open', source: 'status' })
  assert.ok(!JSON.stringify(o.evidence).includes('"lat"'), 'evidence carries no coordinates')
  const exp = new Date(o.expires_at) - Date.now()
  assert.ok(exp > 38 * 60e3 && exp <= 40 * 60e3, 'expires in ~40 min')
  // pass-through Judge: a 'nudge' decision for Jess on this opportunity, with its nudge; nothing for Eileen
  // (the separate `nearby` trigger also fires for this pair, so count by opportunity, not per person)
  const d = ctx.db.get('select * from decisions where person_id = ? and opportunity_id = ?', jess.id, o.id)
  assert.equal(d.verdict, 'nudge')
  assert.equal(ctx.db.get('select count(*) c from nudges where decision_id = ?', d.id).c, 1)
  assert.equal(ctx.db.get('select count(*) c from decisions where person_id = ? and opportunity_id = ?', eileen.id, o.id).c, 0)
})

test('location: deduped per pair per 2h bucket; porchlight falls back to policy when no status', async () => {
  const { ctx, eileen, eileenHome, jessAtGO } = await setup()
  await eileenHome()
  await jessAtGO()
  await jessAtGO()
  await settle(ctx)
  const all = opps(ctx)
  assert.equal(all.length, 1)
  const light = all[0].evidence.find(e => e.kind === 'porchlight')
  assert.deepEqual({ state: light.state, source: light.source }, { state: 'ask', source: 'default' })
  assert.match(all[0].summary, /porchlight is ask \(default\)/)
  assert.equal(ctx.people.policy(eileen.id).dropinDefault, 'ask')
})

test('location: no opportunity when Eileen is not home, Jess is at her own home, or Jess is far away', async () => {
  const { ctx, jess, eileen, obs, eileenHome, jessAtGO } = await setup()
  await jessAtGO()                                  // Eileen has no location yet
  await settle(ctx)
  assert.equal(opps(ctx).length, 0, 'Eileen not known to be home')
  await obs(eileen, { kind: 'location', data: { lat: 37.76, lng: -122.41 } })   // Eileen out
  await jessAtGO()
  await settle(ctx)
  assert.equal(opps(ctx).length, 0, 'Eileen out')
  await eileenHome()
  await obs(jess, { kind: 'location', data: { ...FAR } })                          // Jess at own home (by radius, no placeName)
  await obs(jess, { kind: 'location', data: { lat: 37.70, lng: -122.50, placeName: 'Ocean Beach' } })
  await settle(ctx)
  assert.equal(opps(ctx).length, 0, 'Jess elsewhere')
  // Eileen's own home arrival never makes her the primary of a drop-in at her own place
  assert.equal(ctx.db.get(`select count(*) c from opportunities where primary_id = ?`, eileen.id).c, 0)
})

test('status: Eileen flips porchlight open while Jess is already within 400m → opportunity, primary Jess', async () => {
  const { ctx, jess, eileen, eileenHome, jessAtGO, status } = await setup()
  await jessAtGO()
  await eileenHome()                                 // Eileen arriving home is not a drop-in on herself
  await settle(ctx)
  assert.equal(opps(ctx).length, 0)
  await status(eileen, 'closed')
  await settle(ctx)
  assert.equal(opps(ctx).length, 0, 'closed porchlight does not fire')
  await status(eileen, 'open')
  await settle(ctx)
  const [o] = opps(ctx)
  assert.ok(o)
  assert.equal(o.primary_id, jess.id)
  assert.match(o.summary, /Jess is \d+m from Eileen's place \(at Grocery Outlet\) and Eileen is home/)
  assert.equal(o.evidence.find(e => e.kind === 'porchlight').state, 'open')
})

test('location: trigger only considers wantMore pairs', async () => {
  const { ctx, jess, eileen, eileenHome, jessAtGO } = await setup()
  ctx.people.setRel(jess.id, eileen.id, { wantMore: false })
  ctx.people.setRel(eileen.id, jess.id, { wantMore: false })
  await eileenHome()
  await jessAtGO()
  await settle(ctx)
  assert.equal(opps(ctx).length, 0)
})

// ---- porchlight derivation ----

test('porchlight(): status within until > dropinWindows > dropinDefault', async () => {
  const { ctx, eileen, status } = await setup()
  const p = () => porchlight(ctx, ctx.people.get(eileen.id))
  assert.deepEqual(p(), { state: 'ask', source: 'default' })
  ctx.people.update(eileen.id, { policy: { dropinDefault: 'closed' } })
  assert.deepEqual(p(), { state: 'closed', source: 'default' })
  const { day, hour } = localNow(eileen.tz)
  ctx.people.update(eileen.id, { policy: { dropinDefault: 'closed', dropinWindows: [{ days: [day], start: hour, end: (hour + 1) % 24 }] } })
  assert.deepEqual(p(), { state: 'open', source: 'window' })
  ctx.people.update(eileen.id, { policy: { dropinDefault: 'closed', dropinWindows: [{ days: [(day + 1) % 7], start: hour, end: (hour + 1) % 24 }] } })
  assert.equal(p().state, 'closed', 'window on another day does not apply')
  await status(eileen, 'ask')
  assert.equal(p().source, 'status')
  assert.equal(p().state, 'ask')
  // an expired status is ignored
  await ctx.observations.ingest(eileen.id, 'test', [{ kind: 'status', at: new Date(Date.now() + 1000).toISOString(), until: new Date(Date.now() - 1000).toISOString(), data: { porchlight: 'open' } }])
  assert.equal(p().state, 'ask')
})

// ---- query ----

test('query: closed → no, "not a good time"', async () => {
  const { eileen, eileenHome, status, ask } = await setup()
  await eileenHome()
  await status(eileen, 'closed')
  const a = await ask()
  assert.equal(a.answer, 'no')
  assert.equal(a.reason, 'not a good time')
})

test('query: not home → unlikely, revealed says only "not home"', async () => {
  const { eileen, obs, status, ask } = await setup()
  await status(eileen, 'open')
  let a = await ask()
  assert.equal(a.answer, 'unlikely')
  assert.equal(a.reason, 'not home right now')
  assert.equal(a.revealed.presence, 'not home')
  await obs(eileen, { kind: 'location', data: { lat: 37.76, lng: -122.41, placeName: 'Dolores Park' } })
  a = await ask()
  assert.equal(a.answer, 'unlikely')
  assert.ok(!JSON.stringify(a).includes('Dolores'), 'place name never revealed')
  assert.ok(!JSON.stringify(a).includes('lat'), 'coords never revealed')
})

test('query: calendar event right now → unlikely with tier-safe reason', async () => {
  const { ctx, jess, eileen, obs, eileenHome, status, ask } = await setup()
  await eileenHome()
  await status(eileen, 'open')
  await obs(eileen, { kind: 'event', at: new Date(Date.now() - 600e3).toISOString(), until: new Date(Date.now() + 1800e3).toISOString(), data: { title: 'Therapy', provider: 'test' } })
  let a = await ask()
  assert.equal(a.answer, 'unlikely')
  assert.equal(a.reason, 'has something on right now')
  ctx.people.setRel(eileen.id, jess.id, { tier: 'trusted' })
  a = await ask()
  assert.equal(a.reason, 'has "Therapy" on right now')
})

test('query: open → yes; revealed is home/not home only', async () => {
  const { ctx, eileen, eileenHome, status, ask } = await setup()
  await eileenHome()
  await status(eileen, 'open')
  const a = await ask()
  assert.equal(a.answer, 'yes')
  assert.deepEqual(a.revealed, { porchlight: 'open', presence: 'home' })
  assert.equal(nudgesFor(ctx, eileen).length, 0, 'no veto nudge needed when open')
  assert.equal(ctx.db.get(`select answer from query_log where kind = 'dropin'`).answer, 'yes')
})

test('query: ask → likely + veto nudge to Eileen; veto closes porchlight for 2h and tells Jess', async () => {
  const { ctx, jess, eileen, eileenHome, ask } = await setup()
  await eileenHome()
  let a = await ask()
  assert.equal(a.answer, 'likely')
  assert.equal(a.reason, 'probably fine, checking')
  const [n] = nudgesFor(ctx, eileen)
  assert.ok(n)
  assert.equal(n.text, "Jess is a block away and might drop by in the next little while. I said it's probably fine.")
  const keys = JSON.parse(n.actions).map(x => x.key)
  assert.deepEqual(keys.slice(0, 2), ['yes', 'veto'])
  // asking again inside the window does not re-nudge
  a = await ask()
  assert.equal(a.answer, 'likely')
  assert.equal(nudgesFor(ctx, eileen).length, 1)
  // Eileen vetoes
  await ctx.nudges.respond(n.id, 'veto')
  await new Promise(r => setTimeout(r, 20))
  const st = ctx.observations.latest(eileen.id, 'status')
  assert.equal(st.source_id, 'dropin')
  assert.equal(st.data.porchlight, 'closed')
  const closeFor = new Date(st.until) - Date.now()
  assert.ok(closeFor > 118 * 60e3 && closeFor <= 120 * 60e3, 'closed for ~2h')
  a = await ask()
  assert.equal(a.answer, 'no')
  assert.equal(a.reason, 'not a good time')
  const jn = nudgesFor(ctx, jess)
  assert.equal(jn.at(-1).text, "Eileen's not up for it right now, another time.")
  assert.equal(opps(ctx).length, 0, 'the veto status did not trigger a new opportunity')
})

test('query: ask → Eileen taps yes → next ask is yes and Jess hears', async () => {
  const { ctx, jess, eileen, eileenHome, ask } = await setup()
  await eileenHome()
  await ask()
  const [n] = nudgesFor(ctx, eileen)
  await ctx.nudges.respond(n.id, 'yes')
  await new Promise(r => setTimeout(r, 20))
  const a = await ask()
  assert.equal(a.answer, 'yes')
  assert.equal(nudgesFor(ctx, jess).at(-1).text, 'Eileen says come on by.')
})

test('query: ask + autoYesDropin → likely, no nudge', async () => {
  const { ctx, eileen, eileenHome, ask } = await setup({ tier: 'trusted' })
  await eileenHome()
  const a = await ask()
  assert.equal(a.answer, 'likely')
  assert.equal(nudgesFor(ctx, eileen).length, 0)
})

test('query: acquaintance lacks askDropin → core refuses before the plugin runs', async () => {
  const { eileen, eileenHome, status, ask } = await setup({ tier: 'acquaintance' })
  await eileenHome()
  await status(eileen, 'open')
  const a = await ask()
  assert.equal(a.answer, 'no')
  assert.equal(a.reason, 'not permitted')
})

test('query: unsupported when Eileen has no home, no location and no sources', async () => {
  const ctx = await buildContext(env, { dbPath: ':memory:' })
  const jess = ctx.people.create({ displayName: 'Jess' }), eileen = ctx.people.create({ displayName: 'Eileen' })
  ctx.people.setRel(eileen.id, jess.id, { tier: 'friend' })
  const a = await ctx.query.ask({ from: jess.id, to: eileen.id, kind: 'dropin' })
  assert.equal(a.answer, 'unsupported')
  assert.equal(a.suggest.plugin, 'queries/dropin')
})

test('graduation: 3rd yes offers autoYesDropin; accepting grants it and stops the veto nudges', async () => {
  const { ctx, jess, eileen, eileenHome, ask } = await setup()
  await eileenHome()
  const vetoNudges = () => nudgesFor(ctx, eileen).filter(n => JSON.parse(n.actions).some(a => a.key === 'veto'))
  const offers = () => nudgesFor(ctx, eileen).filter(n => JSON.parse(n.actions).some(a => a.key.startsWith('grant:autoYesDropin:')))
  for (let i = 1; i <= 3; i++) {
    assert.equal((await ask()).answer, 'likely')
    const n = vetoNudges().at(-1)
    assert.equal(vetoNudges().length, i)
    await ctx.nudges.respond(n.id, 'yes')
    await new Promise(r => setTimeout(r, 20))
    assert.equal(ctx.db.kvGet(`dropin:yes:${eileen.id}:${jess.id}`), i)
    assert.equal(offers().length, i === 3 ? 1 : 0, `offer only after the 3rd yes (round ${i})`)
    // close the window so the next ask sends a fresh veto nudge
    ctx.db.kvSet(`dropin:pending:${eileen.id}:${jess.id}`, { nudgeId: n.id, until: new Date(Date.now() - 1000).toISOString() })
  }
  const [offer] = offers()
  assert.equal(offer.text, "You've said yes to Jess dropping by 3 times. Want me to just say yes for them from now on? You can always flip your porchlight to closed.")
  const acts = JSON.parse(offer.actions)
  assert.equal(acts[0].key, `grant:autoYesDropin:${jess.id}`)
  assert.deepEqual(acts[1], { key: 'no', label: 'Keep asking me' })
  assert.equal(ctx.people.rel(eileen.id, jess.id).effectiveGrants.autoYesDropin, false)
  await ctx.nudges.respond(offer.id, acts[0].key)
  const rel = ctx.people.rel(eileen.id, jess.id)
  assert.equal(rel.grants.autoYesDropin, true)
  assert.equal(rel.effectiveGrants.autoYesDropin, true)
  assert.equal(rel.tier, 'friend', 'tier unchanged; only the grant')
  // next ask: likely with no nudge to Eileen at all
  const before = nudgesFor(ctx, eileen).length
  const a = await ask()
  assert.equal(a.answer, 'likely')
  assert.equal(a.reason, 'probably fine')
  assert.equal(nudgesFor(ctx, eileen).length, before)
})
