// Drive-by isn't drop-in, but cars exist: triggers/porchlightProximity and triggers/nearby with motion + speed.
// Judge in pass-through mode (no ANTHROPIC_API_KEY).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../core/context.js'
import { inVehicle, motionAt, lastVehicleAt, VEHICLE_SPEED_MPS, MOTION_FRESH_MS } from '../core/motion.js'
import { DWELL_MS, TRAVEL_WOULD_DRIVE } from '../triggers/porchlightProximity/index.js'

const HOME = { lat: 37.7745, lng: -122.4365 }            // Eileen's
const GO = { lat: 37.7738, lng: -122.4372 }              // Grocery Outlet, ~100m away
const PARK = { lat: 37.7700, lng: -122.4340 }            // a park ~550m from Eileen's, where nearby (600m) but not porchlight (400m) applies
const FAR = { lat: 37.80, lng: -122.40 }                 // Jess's home
const env = { ...process.env, ANTHROPIC_API_KEY: '' }
const ago = min => new Date(Date.now() - min * 60e3).toISOString()

async function setup({ travel = 1 } = {}) {
  const ctx = await buildContext(env, { dbPath: ':memory:' })
  const jess = ctx.people.create({ displayName: 'Jess' })
  const eileen = ctx.people.create({ displayName: 'Eileen' })
  ctx.people.setRel(jess.id, eileen.id, { wantMore: true, travel })
  ctx.people.setRel(eileen.id, jess.id, { wantMore: true })
  ctx.people.addPlace(eileen.id, { name: 'home', ...HOME, radiusM: 120 })
  ctx.people.addPlace(jess.id, { name: 'home', ...FAR, radiusM: 120 })
  const obs = (p, o) => ctx.observations.ingest(p.id, 'test', [o])
  const eileenHome = () => obs(eileen, { kind: 'location', data: { ...HOME, placeName: 'home' } })
  // a fix for Jess at `where`, `min` minutes ago, with optional speed (m/s) and motion state (posted alongside, like the app does)
  const jess_ = async ({ where = GO, min = 0, speed = null, motion = null, placeName = 'Grocery Outlet' } = {}) => {
    const at = ago(min)
    const list = [{ kind: 'location', at, data: { ...where, speed, placeName } }]
    if (motion) list.unshift({ kind: 'motion', at, data: { state: motion } })
    return ctx.observations.ingest(jess.id, 'test', list)
  }
  return { ctx, jess, eileen, obs, eileenHome, jess_ }
}
async function settle(ctx) {
  for (let i = 0; i < 200; i++) {
    if (!ctx.db.get(`select 1 from opportunities where status = 'pending'`)) return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('opportunities never settled')
}
const opps = (ctx, kind = 'dropin') => ctx.db.all(`select * from opportunities where kind = ?`, kind).map(r => ({ ...r, evidence: JSON.parse(r.evidence) }))
const jessEvidence = o => o.evidence.find(e => e.kind === 'location' && e.distanceToHomeM != null)

// ---- core/motion ----

test('motion: speed or a fresh motion state says vehicle; a stale state says nothing', () => {
  const motions = [{ at: ago(2), data: { state: 'driving' } }, { at: ago(30), data: { state: 'walking' } }]
  assert.equal(motionAt(motions, ago(0)), 'driving')
  assert.equal(motionAt(motions, ago(3)), null, 'nothing in force 3 min ago: the walking state is older than MOTION_FRESH_MS')
  assert.equal(motionAt(motions, ago(25)), 'walking')
  assert.equal(inVehicle({ at: ago(0), data: { speed: VEHICLE_SPEED_MPS } }, []), true)
  assert.equal(inVehicle({ at: ago(0), data: { speed: 1.2 } }, []), false)
  assert.equal(inVehicle({ at: ago(0), data: { speed: 0 } }, motions), true, 'stopped at a light is still in the car')
  assert.equal(inVehicle({ at: ago(0), data: {} }, [{ at: ago(MOTION_FRESH_MS / 60e3 + 1), data: { state: 'driving' } }]), false)
  assert.equal(inVehicle({ at: ago(0), data: { speed: 1 } }, [{ at: ago(1), data: { state: 'transit' } }]), true)
  const fix = { at: ago(0), data: { speed: 0 } }, t4 = ago(4)
  assert.equal(lastVehicleAt({ motions: [], fixes: [fix, { at: t4, data: { speed: 9 } }] }, fix), t4)
  assert.equal(lastVehicleAt({ motions: [{ at: ago(30), data: { state: 'driving' } }], fixes: [fix] }, fix), null, 'older than RECENT_VEHICLE_MS does not count')
})

// ---- porchlightProximity ----

test('driving past at speed: no opportunity (speed alone, and motion alone)', async () => {
  const { ctx, eileenHome, jess_ } = await setup()
  await eileenHome()
  await jess_({ speed: 12 })
  await settle(ctx)
  assert.equal(opps(ctx).length, 0, 'speed says vehicle')
  await jess_({ speed: 0, motion: 'driving' })
  await settle(ctx)
  assert.equal(opps(ctx).length, 0, 'motion says vehicle even at 0 m/s')
  await jess_({ speed: null, motion: 'transit' })
  await settle(ctx)
  assert.equal(opps(ctx).length, 0, 'a bus is a vehicle too')
})

test('driving, then parking and dwelling within the radius: opportunity with arrivedBy car', async () => {
  const { ctx, jess, eileenHome, jess_ } = await setup()
  await eileenHome()
  await jess_({ min: 6, speed: 12, motion: 'driving' })
  await jess_({ min: 3.5, speed: 0, motion: 'still' })
  await settle(ctx)
  assert.equal(opps(ctx).length, 0, 'one stationary fix right after driving is not a dwell yet')
  await jess_({ min: 0, speed: 0, motion: 'still' })
  await settle(ctx)
  const [o, ...rest] = opps(ctx)
  assert.ok(o, 'dwell satisfied: two fixes, >= DWELL_MS apart')
  assert.equal(rest.length, 0)
  assert.equal(o.primary_id, jess.id)
  assert.equal(jessEvidence(o).arrivedBy, 'car')
  assert.match(o.summary, /^Jess is \d+m from Eileen's place \(at Grocery Outlet\), just parked, and Eileen is home\./)
  assert.ok(!JSON.stringify(o.evidence).includes('"lat"'), 'evidence carries no coordinates')
  assert.ok(DWELL_MS <= 3.5 * 60e3)
})

test('parking with speed only (no motion source, e.g. OwnTracks): the dwell still works', async () => {
  const { ctx, eileenHome, jess_ } = await setup()
  await eileenHome()
  await jess_({ min: 5, speed: 11 })
  await jess_({ min: 4, speed: 0.3 })
  await settle(ctx)
  assert.equal(opps(ctx).length, 0)
  await jess_({ min: 0, speed: 0 })
  await settle(ctx)
  assert.equal(opps(ctx).length, 1)
  assert.equal(jessEvidence(opps(ctx)[0]).arrivedBy, 'car')
})

test('parked but still moving around in the car (red light, circling): no dwell, no opportunity', async () => {
  const { ctx, eileenHome, jess_ } = await setup()
  await eileenHome()
  await jess_({ min: 6, speed: 12, motion: 'driving' })
  await jess_({ min: 3, speed: 0, motion: 'driving' })
  await jess_({ min: 0, speed: 0, motion: 'driving' })
  await settle(ctx)
  assert.equal(opps(ctx).length, 0)
})

test('driving with travel >= TRAVEL_WOULD_DRIVE toward the friend: immediate opportunity, arrivedBy car, "in a car"', async () => {
  const { ctx, jess, eileenHome, jess_ } = await setup({ travel: TRAVEL_WOULD_DRIVE })
  await eileenHome()
  await jess_({ speed: 12, motion: 'driving' })
  await settle(ctx)
  const [o] = opps(ctx)
  assert.ok(o)
  assert.equal(o.primary_id, jess.id)
  assert.equal(jessEvidence(o).arrivedBy, 'car')
  assert.match(o.summary, /, in a car, and Eileen is home/)
  assert.ok(!JSON.stringify(o).includes('travel'), 'the travel number itself never appears in the opportunity')
  assert.ok(!JSON.stringify(o.evidence).includes('"lat"'))
})

test('walking: unchanged behaviour, fires on the first fix with no arrivedBy', async () => {
  const { ctx, eileenHome, jess_ } = await setup()
  await eileenHome()
  await jess_({ speed: 1.3, motion: 'walking' })
  await settle(ctx)
  const [o] = opps(ctx)
  assert.ok(o)
  assert.equal('arrivedBy' in jessEvidence(o), false)
  assert.match(o.summary, /^Jess is \d+m from Eileen's place \(at Grocery Outlet\) and Eileen is home\./)
})

test('status flip while the friend is driving past: no opportunity; while parked: opportunity', async () => {
  const { ctx, eileen, obs, eileenHome, jess_ } = await setup()
  await eileenHome()
  await jess_({ min: 1, speed: 13, motion: 'driving' })
  await settle(ctx)
  const open = () => obs(eileen, { kind: 'status', until: new Date(Date.now() + 3600e3).toISOString(), data: { porchlight: 'open' } })
  await open()
  await settle(ctx)
  assert.equal(opps(ctx).length, 0)
  const { ctx: c2, eileen: e2, obs: obs2, eileenHome: eh2, jess_: j2 } = await setup()
  await eh2()
  await j2({ min: 8, speed: 13, motion: 'driving' })
  await j2({ min: 4, speed: 0, motion: 'still' })
  await j2({ min: 0.5, speed: 0, motion: 'still' })
  await settle(c2)
  assert.equal(opps(c2).length, 1, 'the dwell itself fired')
  await obs2(e2, { kind: 'status', until: new Date(Date.now() + 3600e3).toISOString(), data: { porchlight: 'open' } })
  await settle(c2)
  assert.equal(opps(c2).length, 1, 'deduped per pair per bucket')
})

// ---- nearby ----

test('nearby: a fix taken in a vehicle never counts, on either side; on foot it does', async () => {
  const { ctx, jess, eileen, obs, jess_ } = await setup()
  await obs(eileen, { kind: 'location', data: { ...PARK, placeName: 'Alamo Square' } })
  await jess_({ where: GO, speed: 12, motion: 'driving' })
  await settle(ctx)
  assert.equal(opps(ctx, 'nearby').length, 0, 'Jess driving past Eileen in the park')
  await jess_({ where: GO, speed: 1, motion: 'walking' })
  await settle(ctx)
  assert.equal(opps(ctx, 'nearby').length, 2, 'one per recipient once on foot')
  // the other side driving: Eileen's fix in a bus, Jess on foot
  const { ctx: c2, eileen: e2, jess_: j2 } = await setup()
  await c2.observations.ingest(e2.id, 'test', [{ kind: 'motion', data: { state: 'transit' } }, { kind: 'location', data: { ...PARK, placeName: 'Alamo Square' } }])
  await j2({ where: GO, speed: 1, motion: 'walking' })
  await settle(c2)
  assert.equal(opps(c2, 'nearby').length, 0)
  assert.ok(jess && eileen)
})
